extern crate std;

use crate::{
    adapters::blend::Request,
    shares::{PRICE_SCALE, VIRTUAL_SHARES},
    testutils::{
        blend::{BlendMock, BlendMockClient, RATE},
        Echo, Lazy, Router, RouterClient, Skimmer,
    },
    AdapterKind, AgentVault, AgentVaultClient, Error, Executed, NavSnapshot,
};
use oracle_router::{
    testutils::{MockChainlink, MockReflector},
    OracleRouter,
};
use policy_registry::{
    ArgRule, CallRule, Limits, PolicyChange, PolicyRegistry, PolicyRegistryClient, PolicyV2,
};
use soroban_sdk::{
    contract, contractimpl, symbol_short,
    testutils::{Address as _, Events, Ledger},
    token, vec, Address, Env, IntoVal, Map, Symbol, Val, Vec,
};

pub(crate) const UNIT: i128 = 10_000_000;

pub(crate) struct Fixture {
    pub(crate) env: Env,
    pub(crate) vault: Address,
    pub(crate) asset: Address,
    pub(crate) owner: Address,
    pub(crate) protocol: Address,
    pub(crate) alice: Address,
    pub(crate) bob: Address,
    pub(crate) agent: Address,
    /// Oracle router quoting in the base asset; the owner is its admin.
    pub(crate) oracle: Address,
    pub(crate) reflector: Address,
    /// Policy registry without timelock, so loosening applies on `apply_policy`.
    pub(crate) registry: Address,
}

impl Fixture {
    pub(crate) fn new() -> Self {
        Self::build(true)
    }

    /// The vault points at an address where no oracle contract exists.
    pub(crate) fn without_oracle() -> Self {
        Self::build(false)
    }

    fn build(oracle_deployed: bool) -> Self {
        let env = Env::default();
        let owner = Address::generate(&env);
        let agent = Address::generate(&env);
        let protocol = Address::generate(&env);
        let alice = Address::generate(&env);
        let bob = Address::generate(&env);
        let asset = env
            .register_stellar_asset_contract_v2(owner.clone())
            .address();
        let reflector = env.register(MockReflector, ());
        let oracle = if oracle_deployed {
            let chainlink = env.register(MockChainlink, ());
            env.register(
                OracleRouter,
                (owner.clone(), asset.clone(), reflector.clone(), chainlink),
            )
        } else {
            Address::generate(&env)
        };
        let registry = env.register(PolicyRegistry, (0_u64,));
        let vault = env.register(
            AgentVault,
            (
                owner.clone(),
                agent.clone(),
                asset.clone(),
                protocol.clone(),
                oracle.clone(),
                registry.clone(),
            ),
        );
        let f = Self {
            env,
            vault,
            asset,
            owner,
            protocol,
            alice,
            bob,
            agent,
            oracle,
            reflector,
            registry,
        };
        let initial = PolicyV2 {
            calls: Map::new(&f.env),
            protocols: Vec::new(&f.env),
            guards: Map::new(&f.env),
            assets: vec![&f.env, f.asset.clone()],
            limits: Limits::default(),
            exposure_caps: None,
        };
        f.registry_client()
            .mock_all_auths()
            .register(&f.vault, &initial);
        f.mint(&f.alice, 10_000 * UNIT);
        f.mint(&f.bob, 10_000 * UNIT);
        f
    }

    pub(crate) fn client(&self) -> AgentVaultClient<'_> {
        AgentVaultClient::new(&self.env, &self.vault)
    }

    pub(crate) fn mint(&self, to: &Address, amount: i128) {
        token::StellarAssetClient::new(&self.env, &self.asset)
            .mock_all_auths()
            .mint(to, &amount);
    }

    pub(crate) fn deposit(&self, user: &Address, amount: i128) -> i128 {
        self.client().mock_all_auths().deposit(user, &amount)
    }

    pub(crate) fn withdraw(&self, user: &Address, shares: i128) -> i128 {
        self.client().mock_all_auths().withdraw(user, &shares)
    }

    pub(crate) fn token_balance(&self, user: &Address) -> i128 {
        token::Client::new(&self.env, &self.asset).balance(user)
    }

    pub(crate) fn allow(&self, target: &Address, fn_name: &str, args: Vec<ArgRule>, approve: bool) {
        self.allow_with_loss(target, fn_name, args, approve, 5);
    }

    pub(crate) fn allow_with_loss(
        &self,
        target: &Address,
        fn_name: &str,
        args: Vec<ArgRule>,
        approve: bool,
        max_loss_bps: u32,
    ) {
        let rule = CallRule {
            args,
            max_loss_bps,
            approve,
        };
        let call = (target.clone(), Symbol::new(&self.env, fn_name));
        self.update_policy(|policy| policy.calls.set(call, rule));
    }

    pub(crate) fn registry_client(&self) -> PolicyRegistryClient<'_> {
        PolicyRegistryClient::new(&self.env, &self.registry)
    }

    pub(crate) fn policy(&self) -> PolicyV2 {
        self.registry_client().policy(&self.vault).unwrap()
    }

    /// Applies `change` to the vault's policy, going through `apply_policy` when it loosens.
    pub(crate) fn update_policy(&self, change: impl FnOnce(&mut PolicyV2)) {
        let mut policy = self.policy();
        change(&mut policy);
        let registry = self.registry_client();
        if let PolicyChange::Proposed(_) = registry
            .mock_all_auths()
            .propose_policy(&self.vault, &policy)
        {
            registry.mock_all_auths().apply_policy(&self.vault);
        }
    }

    pub(crate) fn allow_protocol(&self, protocol: &Address) {
        self.update_policy(|policy| policy.protocols.push_back(protocol.clone()));
    }

    pub(crate) fn set_assets(&self, assets: Vec<Address>) {
        self.update_policy(|policy| policy.assets = assets);
    }

    pub(crate) fn approve_noop(&self) {
        self.allow(
            &self.asset,
            "approve",
            vec![
                &self.env,
                ArgRule::Vault,
                ArgRule::Any,
                ArgRule::Amount,
                ArgRule::Any,
            ],
            false,
        );
        self.client().mock_all_auths().execute(
            &self.asset,
            &symbol_short!("approve"),
            &(
                self.vault.clone(),
                self.owner.clone(),
                0_i128,
                self.env.ledger().sequence(),
            )
                .into_val(&self.env),
        );
    }

    /// Registers an allowlisted Blend-like pool without investing.
    pub(crate) fn blend_pool(&self) -> Address {
        let pool = self.env.register(BlendMock, (self.asset.clone(),));
        self.allow_protocol(&pool);
        self.client()
            .mock_all_auths()
            .set_adapter(&AdapterKind::Blend, &pool);
        self.allow(
            &pool,
            "submit_with_allowance",
            vec![
                &self.env,
                ArgRule::Vault,
                ArgRule::Vault,
                ArgRule::Vault,
                ArgRule::BlendRequests,
            ],
            true,
        );
        pool
    }

    pub(crate) fn submit(
        &self,
        pool: &Address,
        amount: i128,
        request_type: u32,
    ) -> Result<(), Error> {
        let requests = vec![
            &self.env,
            Request {
                address: self.asset.clone(),
                amount,
                request_type,
            },
        ];
        outcome(
            self.client().mock_all_auths().try_execute(
                pool,
                &Symbol::new(&self.env, "submit_with_allowance"),
                &(
                    self.vault.clone(),
                    self.vault.clone(),
                    self.vault.clone(),
                    requests,
                )
                    .into_val(&self.env),
            ),
        )
    }

    /// Single-protocol tests invest the whole vault, above the default exposure cap.
    pub(crate) fn invest(&self, amount: i128, request_type: u32) -> Address {
        self.update_policy(|policy| policy.limits.max_exposure_bps = 10_000);
        let pool = self.blend_pool();
        self.submit(&pool, amount, request_type).unwrap();
        pool
    }
}

#[test]
fn first_deposit_mints_offset_shares_and_reports_price() {
    let f = Fixture::new();
    let shares = f.deposit(&f.alice, 1_000 * UNIT);
    assert_eq!(shares, 1_000 * UNIT * VIRTUAL_SHARES);
    assert_eq!(f.client().balance(&f.alice), shares);
    assert_eq!(f.client().total_shares(), shares);
    assert_eq!(f.client().nav(), 1_000 * UNIT);
    assert_eq!(f.client().price_per_share(), PRICE_SCALE / VIRTUAL_SHARES);
}

#[test]
fn equal_deposits_receive_equal_claims_without_fees() {
    let f = Fixture::new();
    let first = f.deposit(&f.alice, 1_000 * UNIT);
    let second = f.deposit(&f.bob, 1_000 * UNIT);
    assert_eq!(first, second);
    assert_eq!(f.client().balance(&f.owner), 0);
    assert_eq!(f.client().balance(&f.protocol), 0);
    assert_eq!(f.client().nav(), 2_000 * UNIT);
}

#[test]
fn donation_inflation_does_not_make_attacker_profitable() {
    let f = Fixture::new();
    let attacker_shares = f.deposit(&f.alice, 1);
    f.mint(&f.vault, 1_000 * UNIT);
    let victim_shares = f.deposit(&f.bob, 1_000 * UNIT);
    assert!(victim_shares > 0);
    let attacker_out = f.withdraw(&f.alice, attacker_shares);
    let victim_out = f.withdraw(&f.bob, victim_shares);
    assert!(attacker_out < 1_000 * UNIT + 1);
    assert!((1_000 * UNIT - victim_out).abs() <= 2_000);
}

#[test]
fn deposit_that_rounds_to_zero_reverts_without_taking_funds() {
    let f = Fixture::new();
    f.mint(&f.vault, 10_000 * UNIT);
    let before = f.token_balance(&f.alice);
    assert_eq!(
        f.client().mock_all_auths().try_deposit(&f.alice, &1),
        Err(Ok(Error::ZeroShares))
    );
    assert_eq!(f.token_balance(&f.alice), before);
    assert_eq!(f.client().total_shares(), 0);
}

#[test]
fn invalid_deposits_and_redemptions_preserve_balances() {
    let f = Fixture::new();
    for amount in [0, -1] {
        assert_eq!(
            f.client().mock_all_auths().try_deposit(&f.alice, &amount),
            Err(Ok(Error::InvalidAmount))
        );
        assert_eq!(
            f.client().mock_all_auths().try_withdraw(&f.alice, &amount),
            Err(Ok(Error::InvalidAmount))
        );
    }
    let shares = f.deposit(&f.alice, UNIT);
    assert_eq!(
        f.client()
            .mock_all_auths()
            .try_withdraw(&f.alice, &(shares + 1)),
        Err(Ok(Error::InsufficientShares))
    );
    assert_eq!(f.client().balance(&f.alice), shares);
    assert_eq!(f.client().nav(), UNIT);
}

#[test]
fn deposit_and_withdraw_require_holder_authorization() {
    let f = Fixture::new();
    assert!(f.client().try_deposit(&f.alice, &UNIT).is_err());
    let shares = f.deposit(&f.alice, UNIT);
    assert!(f.client().try_withdraw(&f.alice, &shares).is_err());
    assert_eq!(f.client().balance(&f.alice), shares);
    assert_eq!(f.client().nav(), UNIT);
}

#[test]
fn paused_vault_rejects_deposit_but_allows_idle_withdrawal() {
    let f = Fixture::new();
    let shares = f.deposit(&f.alice, 1_000 * UNIT);
    f.client().mock_all_auths().set_paused(&true);
    assert_eq!(
        f.client().mock_all_auths().try_deposit(&f.bob, &UNIT),
        Err(Ok(Error::Paused))
    );
    let received = f.withdraw(&f.alice, shares);
    assert!((1_000 * UNIT - received).abs() <= 1);
    assert_eq!(f.client().balance(&f.alice), 0);
    assert_eq!(f.client().total_shares(), 0);
}

#[test]
fn partial_redemption_preserves_other_holders_value() {
    let f = Fixture::new();
    let alice = f.deposit(&f.alice, 1_000 * UNIT);
    let bob = f.deposit(&f.bob, 1_000 * UNIT);
    let received = f.withdraw(&f.alice, alice / 2);
    assert!((received - 500 * UNIT).abs() <= 1);
    assert_eq!(f.client().balance(&f.bob), bob);
    let bob_out = f.withdraw(&f.bob, bob);
    assert!((bob_out - 1_000 * UNIT).abs() <= 1);
    assert_eq!(f.client().balance(&f.alice), alice / 2);
}

#[test]
fn fees_take_ten_percent_of_profit_and_one_percent_of_fee_for_protocol() {
    let f = Fixture::new();
    f.deposit(&f.alice, 1_000 * UNIT);
    f.mint(&f.vault, 100 * UNIT);
    f.approve_noop();
    let creator = f.client().balance(&f.owner);
    let protocol = f.client().balance(&f.protocol);
    assert_eq!(protocol, (creator + protocol) / 100);
    let effective = f.client().total_shares() + VIRTUAL_SHARES;
    let value = (creator + protocol) * (f.client().nav() + 1) / effective;
    assert!((value - 10 * UNIT).abs() <= 1);
    assert!(f.client().high_water_mark() > PRICE_SCALE / VIRTUAL_SHARES);
    assert_eq!(f.token_balance(&f.owner), 0);
    assert_eq!(f.token_balance(&f.protocol), 0);
}

#[test]
fn deposits_crystallize_old_profit_before_pricing_new_shares() {
    let f = Fixture::new();
    f.deposit(&f.alice, 1_000 * UNIT);
    f.mint(&f.vault, 100 * UNIT);
    let bob = f.deposit(&f.bob, 1_000 * UNIT);
    assert!(f.client().balance(&f.owner) > 0);
    let out = f.withdraw(&f.bob, bob);
    assert!((out - 1_000 * UNIT).abs() <= 2);
}

#[test]
fn withdrawal_crystallizes_profit_before_redeeming() {
    let f = Fixture::new();
    let shares = f.deposit(&f.alice, 1_000 * UNIT);
    f.mint(&f.vault, 100 * UNIT);
    let received = f.withdraw(&f.alice, shares);
    assert!((received - 1_090 * UNIT).abs() <= 2);
    assert!(f.client().balance(&f.owner) > 0);
    assert!(f.client().balance(&f.protocol) > 0);
}

#[test]
fn unchanged_nav_and_loss_recovery_do_not_charge_twice() {
    let f = Fixture::new();
    f.deposit(&f.alice, 1_000 * UNIT);
    let pool = f.invest(1_000 * UNIT, 0);
    f.mint(&pool, 100 * UNIT);
    BlendMockClient::new(&f.env, &pool).set_rate(&(RATE * 11 / 10));
    f.approve_noop();
    let fees = f.client().balance(&f.owner);
    let mark = f.client().high_water_mark();
    f.approve_noop();
    assert_eq!(f.client().balance(&f.owner), fees);
    BlendMockClient::new(&f.env, &pool).set_rate(&RATE);
    f.approve_noop();
    assert_eq!(f.client().high_water_mark(), mark);
    assert_eq!(f.client().balance(&f.owner), fees);
    BlendMockClient::new(&f.env, &pool).set_rate(&(RATE * 11 / 10));
    f.approve_noop();
    assert_eq!(f.client().balance(&f.owner), fees);
    f.mint(&pool, 50 * UNIT);
    BlendMockClient::new(&f.env, &pool).set_rate(&(RATE * 115 / 100));
    f.approve_noop();
    let additional = f.client().balance(&f.owner) - fees;
    assert!(additional > 0);
    let value = additional * (f.client().nav() + 1) / (f.client().total_shares() + VIRTUAL_SHARES);
    assert!((value - 49_500_000).abs() < 2);
}

#[test]
fn paused_withdrawal_unwinds_blend_supply_without_session_key() {
    let f = Fixture::new();
    let shares = f.deposit(&f.alice, 1_000 * UNIT);
    let pool = f.invest(800 * UNIT, 0);
    f.client().mock_all_auths().set_paused(&true);
    let before = f.token_balance(&f.alice);
    let received = f.withdraw(&f.alice, shares / 2);
    assert!((received - 500 * UNIT).abs() <= 3);
    assert_eq!(f.token_balance(&f.alice) - before, received);
    assert!((f.token_balance(&pool) - 400 * UNIT).abs() <= 2);
    assert!((f.client().nav() - 500 * UNIT).abs() <= 3);
}

#[test]
fn paused_withdrawal_unwinds_blend_collateral() {
    let f = Fixture::new();
    let shares = f.deposit(&f.alice, 1_000 * UNIT);
    let pool = f.invest(1_000 * UNIT, 2);
    f.client().mock_all_auths().set_paused(&true);
    let received = f.withdraw(&f.alice, shares);
    assert!((received - 1_000 * UNIT).abs() <= 2);
    assert!(f.token_balance(&pool) <= 2);
    assert_eq!(f.client().balance(&f.alice), 0);
}

#[test]
fn blend_yield_is_in_nav_and_fees_before_redemption() {
    let f = Fixture::new();
    let shares = f.deposit(&f.alice, 1_000 * UNIT);
    let pool = f.invest(1_000 * UNIT, 0);
    f.mint(&pool, 100 * UNIT);
    BlendMockClient::new(&f.env, &pool).set_rate(&(RATE * 11 / 10));
    assert_eq!(f.client().nav(), 1_100 * UNIT);
    let received = f.withdraw(&f.alice, shares);
    assert!((received - 1_090 * UNIT).abs() <= 3);
    assert!(f.client().balance(&f.protocol) > 0);
}

#[test]
fn snapshots_report_post_action_nav_price_and_timestamp() {
    use soroban_sdk::events::Event;
    let f = Fixture::new();
    f.env.ledger().with_mut(|ledger| ledger.timestamp = 1234);
    let shares = f.deposit(&f.alice, 1_000 * UNIT);
    let expected = NavSnapshot {
        nav: 1_000 * UNIT,
        pps: PRICE_SCALE / VIRTUAL_SHARES,
        ts: 1234,
    };
    assert_eq!(
        f.env.events().all().events().last().unwrap(),
        &expected.to_xdr(&f.env, &f.vault)
    );
    f.withdraw(&f.alice, shares / 2);
    let after_withdraw = f.env.events().all();
    let expected = NavSnapshot {
        nav: f.client().nav(),
        pps: f.client().price_per_share(),
        ts: 1234,
    };
    assert_eq!(
        after_withdraw.events().last().unwrap(),
        &expected.to_xdr(&f.env, &f.vault)
    );
    f.approve_noop();
    let after_execute = f.env.events().all();
    let executed = Executed {
        target: f.asset.clone(),
        fn_name: symbol_short!("approve"),
        nav_before: expected.nav,
        nav_after: expected.nav,
    };
    assert!(after_execute
        .events()
        .contains(&executed.to_xdr(&f.env, &f.vault)));
    assert_eq!(
        after_execute.events().last().unwrap(),
        &expected.to_xdr(&f.env, &f.vault)
    );
}

#[test]
fn large_deposits_use_wide_intermediates_without_overflow() {
    let f = Fixture::new();
    let amount = 10_i128.pow(25);
    f.mint(&f.alice, amount);
    let shares = f.deposit(&f.alice, amount);
    assert_eq!(shares, amount * VIRTUAL_SHARES);
    assert_eq!(f.client().price_per_share(), PRICE_SCALE / VIRTUAL_SHARES);
    let received = f.withdraw(&f.alice, shares / 2);
    assert!((received - amount / 2).abs() <= 1);
}

#[test]
fn withdrawal_reduces_blend_collateral_and_debt_in_same_call() {
    let f = Fixture::new();
    let shares = f.deposit(&f.alice, 1_000 * UNIT);
    let pool = f.invest(1_000 * UNIT, 2);
    BlendMockClient::new(&f.env, &pool)
        .mock_all_auths()
        .submit_with_allowance(
            &f.vault,
            &f.vault,
            &f.vault,
            &vec![
                &f.env,
                Request {
                    address: f.asset.clone(),
                    amount: 200 * UNIT,
                    request_type: 4,
                },
            ],
        );
    assert_eq!(f.client().nav(), 1_000 * UNIT);
    f.client().mock_all_auths().set_paused(&true);
    let received = f.withdraw(&f.alice, shares / 2);
    assert!((received - 500 * UNIT).abs() <= 3);
    let positions = BlendMockClient::new(&f.env, &pool).get_positions(&f.vault);
    let debt: Map<u32, i128> = positions
        .get(Symbol::new(&f.env, "liabilities"))
        .unwrap()
        .into_val(&f.env);
    let collateral: Map<u32, i128> = positions
        .get(Symbol::new(&f.env, "collateral"))
        .unwrap()
        .into_val(&f.env);
    assert!((debt.get(3).unwrap() - 100 * UNIT).abs() <= 1);
    assert!((collateral.get(3).unwrap() - 500 * UNIT).abs() <= 1);
    assert_eq!(
        token::Client::new(&f.env, &f.asset).allowance(&f.vault, &pool),
        0
    );
    assert!((f.client().nav() - 500 * UNIT).abs() <= 3);
}

#[test]
fn rejected_execute_rolls_back_asset_loss_and_fee_state() {
    let f = Fixture::new();
    let shares = f.deposit(&f.alice, 1_000 * UNIT);
    f.allow(
        &f.asset,
        "burn",
        vec![&f.env, ArgRule::Vault, ArgRule::Amount],
        false,
    );
    let mark = f.client().high_water_mark();
    assert!(matches!(
        f.client().mock_all_auths().try_execute(
            &f.asset,
            &symbol_short!("burn"),
            &(f.vault.clone(), 100 * UNIT).into_val(&f.env),
        ),
        Err(Ok(Error::NavDropped))
    ));
    assert_eq!(f.client().nav(), 1_000 * UNIT);
    assert_eq!(f.client().balance(&f.alice), shares);
    assert_eq!(f.client().balance(&f.owner), 0);
    assert_eq!(f.client().balance(&f.protocol), 0);
    assert_eq!(f.client().high_water_mark(), mark);
}

fn configure_approval(f: &Fixture) {
    f.allow_protocol(&f.owner);
    f.allow(
        &f.asset,
        "approve",
        vec![
            &f.env,
            ArgRule::Vault,
            ArgRule::Protocol,
            ArgRule::Amount,
            ArgRule::Any,
        ],
        false,
    );
}

fn approval(f: &Fixture, amount: i128) -> Vec<Val> {
    (
        f.vault.clone(),
        f.owner.clone(),
        amount,
        f.env.ledger().sequence() + 100,
    )
        .into_val(&f.env)
}

pub(crate) fn outcome<T>(
    result: Result<
        Result<T, soroban_sdk::ConversionError>,
        Result<Error, soroban_sdk::InvokeError>,
    >,
) -> Result<(), Error> {
    match result {
        Ok(_) => Ok(()),
        Err(Ok(error)) => Err(error),
        Err(Err(error)) => panic!("unexpected host error {error:?}"),
    }
}

/// Allowlists the neutral `Echo` protocol, which pulls and returns a budgeted amount.
fn configure_probe(f: &Fixture) -> Address {
    let echo = f.env.register(Echo, ());
    f.allow_protocol(&echo);
    f.allow(
        &echo,
        "take",
        vec![&f.env, ArgRule::Any, ArgRule::Vault, ArgRule::Amount],
        true,
    );
    echo
}

fn probe(f: &Fixture, echo: &Address, amount: i128) -> Result<(), Error> {
    outcome(f.client().mock_all_auths().try_execute(
        echo,
        &symbol_short!("take"),
        &(f.asset.clone(), f.vault.clone(), amount).into_val(&f.env),
    ))
}

#[test]
fn call_not_allowed_blocks_direct_exfiltration() {
    let f = Fixture::new();
    f.deposit(&f.alice, 100 * UNIT);
    assert_eq!(
        f.client()
            .mock_all_auths()
            .try_execute(
                &f.asset,
                &symbol_short!("transfer"),
                &(f.vault.clone(), f.bob.clone(), UNIT).into_val(&f.env),
            )
            .err(),
        Some(Ok(Error::CallNotAllowed))
    );
    assert_eq!(f.client().nav(), 100 * UNIT);
}

#[test]
fn destination_not_vault_rejects_address_and_type_substitution() {
    let f = Fixture::new();
    configure_approval(&f);
    for from in [f.bob.clone().into_val(&f.env), 1i128.into_val(&f.env)] {
        assert_eq!(
            f.client()
                .mock_all_auths()
                .try_execute(
                    &f.asset,
                    &symbol_short!("approve"),
                    &vec![
                        &f.env,
                        from,
                        f.owner.clone().into_val(&f.env),
                        0i128.into_val(&f.env),
                        100u32.into_val(&f.env)
                    ],
                )
                .err(),
            Some(Ok(Error::DestinationNotVault))
        );
    }
}

#[test]
fn spender_not_protocol_blocks_untrusted_allowance() {
    let f = Fixture::new();
    configure_approval(&f);
    assert_eq!(
        f.client()
            .mock_all_auths()
            .try_execute(
                &f.asset,
                &symbol_short!("approve"),
                &(f.vault.clone(), f.bob.clone(), UNIT, 100u32).into_val(&f.env),
            )
            .err(),
        Some(Ok(Error::SpenderNotProtocol))
    );
    assert_eq!(
        token::Client::new(&f.env, &f.asset).allowance(&f.vault, &f.bob),
        0
    );
}

#[test]
fn arg_count_mismatch_rejects_missing_and_extra_arguments() {
    let f = Fixture::new();
    configure_approval(&f);
    for args in [
        vec![&f.env],
        (f.vault.clone(), f.owner.clone(), 0i128, 100u32, 1u32).into_val(&f.env),
    ] {
        assert_eq!(
            f.client()
                .mock_all_auths()
                .try_execute(&f.asset, &symbol_short!("approve"), &args)
                .err(),
            Some(Ok(Error::ArgCountMismatch))
        );
    }
}

#[test]
fn tx_cap_exceeded_rejects_one_unit_above_boundary() {
    let f = Fixture::new();
    f.deposit(&f.alice, 100 * UNIT);
    let echo = configure_probe(&f);
    f.update_policy(|policy| policy.limits.tx_cap_bps = 1_000);
    assert_eq!(probe(&f, &echo, 10 * UNIT + 1), Err(Error::TxCapExceeded));
    assert_eq!(f.client().usage().calls, 0);
    probe(&f, &echo, 10 * UNIT).unwrap();
    // The vault-issued approval was fully consumed within the call.
    assert_eq!(
        token::Client::new(&f.env, &f.asset).allowance(&f.vault, &echo),
        0
    );
    assert_eq!(f.client().usage().spent, 10 * UNIT);
    assert_eq!(f.client().nav(), 100 * UNIT);
}

#[test]
fn daily_cap_exceeded_accumulates_and_resets_only_at_utc_day() {
    let f = Fixture::new();
    f.deposit(&f.alice, 100 * UNIT);
    let echo = configure_probe(&f);
    f.update_policy(|policy| policy.limits.daily_cap_bps = 1_000);
    probe(&f, &echo, 6 * UNIT).unwrap();
    assert_eq!(probe(&f, &echo, 4 * UNIT + 1), Err(Error::DailyCapExceeded));
    probe(&f, &echo, 4 * UNIT).unwrap();
    f.env.ledger().with_mut(|ledger| ledger.timestamp = 86_399);
    assert_eq!(probe(&f, &echo, 1), Err(Error::DailyCapExceeded));
    f.env.ledger().with_mut(|ledger| ledger.timestamp = 86_400);
    probe(&f, &echo, 10 * UNIT).unwrap();
    assert_eq!(f.client().usage().spent, 10 * UNIT);
    assert_eq!(f.client().usage().day, 1);
}

#[test]
fn rate_limited_counts_zero_amount_calls_and_resets_at_hour() {
    let f = Fixture::new();
    let echo = configure_probe(&f);
    f.update_policy(|policy| policy.limits.calls_per_hour = 2);
    probe(&f, &echo, 0).unwrap();
    probe(&f, &echo, 0).unwrap();
    f.env.ledger().with_mut(|ledger| ledger.timestamp = 3_599);
    assert_eq!(probe(&f, &echo, 0), Err(Error::RateLimited));
    assert_eq!(f.client().usage().calls, 2);
    f.env.ledger().with_mut(|ledger| ledger.timestamp = 3_600);
    probe(&f, &echo, 0).unwrap();
    assert_eq!(f.client().usage().calls, 1);
}

#[test]
fn paused_execution_and_revoked_session_leave_withdrawals_open() {
    let f = Fixture::new();
    let shares = f.deposit(&f.alice, 100 * UNIT);
    let echo = configure_probe(&f);
    f.client().mock_all_auths().set_paused(&true);
    assert_eq!(probe(&f, &echo, 0), Err(Error::Paused));
    f.client().mock_all_auths().set_paused(&false);
    f.client().mock_all_auths().revoke_session();
    assert_eq!(f.client().session(), None);
    assert_eq!(probe(&f, &echo, 0), Err(Error::SessionRevoked));
    assert!((f.withdraw(&f.alice, shares) - 100 * UNIT).abs() <= 1);
}

#[test]
fn rotation_requires_owner_and_old_session_cannot_execute() {
    use soroban_sdk::testutils::{MockAuth, MockAuthInvoke};
    let f = Fixture::new();
    configure_approval(&f);
    let next = Address::generate(&f.env);
    assert!(f.client().try_rotate_session(&next).is_err());
    f.client().mock_all_auths().revoke_session();
    f.client().mock_all_auths().rotate_session(&next);
    assert_eq!(f.client().session(), Some(next.clone()));
    let args = approval(&f, 0);
    let invoke = MockAuthInvoke {
        contract: &f.vault,
        fn_name: "execute",
        args: (f.asset.clone(), symbol_short!("approve"), args.clone()).into_val(&f.env),
        sub_invokes: &[],
    };
    assert!(f
        .client()
        .mock_auths(&[MockAuth {
            address: &f.agent,
            invoke: &invoke
        }])
        .try_execute(&f.asset, &symbol_short!("approve"), &args)
        .is_err());
    f.client()
        .mock_auths(&[MockAuth {
            address: &next,
            invoke: &invoke,
        }])
        .execute(&f.asset, &symbol_short!("approve"), &args);
    assert_eq!(f.client().usage().calls, 1);
}

#[test]
fn health_factor_too_low_reverts_new_debt_and_budget() {
    let f = Fixture::new();
    f.deposit(&f.alice, 1_000 * UNIT);
    let pool = f.invest(1_000 * UNIT, 2);
    let before = f.client().usage();
    let requests = vec![
        &f.env,
        Request {
            address: f.asset.clone(),
            amount: 700 * UNIT,
            request_type: 4,
        },
    ];
    assert_eq!(
        f.client()
            .mock_all_auths()
            .try_execute(
                &pool,
                &Symbol::new(&f.env, "submit_with_allowance"),
                &(f.vault.clone(), f.vault.clone(), f.vault.clone(), requests).into_val(&f.env),
            )
            .err(),
        Some(Ok(Error::HealthFactorTooLow))
    );
    assert_eq!(f.client().health_factor(), i128::MAX);
    assert_eq!(f.client().usage(), before);
    assert_eq!(f.token_balance(&f.vault), 0);
    assert_eq!(f.token_balance(&pool), 1_000 * UNIT);
}

#[test]
fn blend_health_factor_uses_risk_weights_not_raw_collateral() {
    let f = Fixture::new();
    f.deposit(&f.alice, 1_000 * UNIT);
    let pool = f.invest(1_000 * UNIT, 2);
    f.client().mock_all_auths().execute(
        &pool,
        &Symbol::new(&f.env, "submit_with_allowance"),
        &(
            f.vault.clone(),
            f.vault.clone(),
            f.vault.clone(),
            vec![
                &f.env,
                Request {
                    address: f.asset.clone(),
                    amount: 600 * UNIT,
                    request_type: 4,
                },
            ],
        )
            .into_val(&f.env),
    );
    let risk_adjusted_debt = (600 * UNIT * 10_000_000 + 9_000_000 - 1) / 9_000_000;
    assert_eq!(
        f.client().health_factor(),
        900 * UNIT * 10_000 / risk_adjusted_debt
    );
    assert_eq!(f.client().nav(), 1_000 * UNIT);
}

#[contract]
struct Exfiltrator;

#[contractimpl]
impl Exfiltrator {
    pub fn steal(env: Env, asset: Address, vault: Address, to: Address, amount: i128) {
        token::Client::new(&env, &asset).transfer_from(
            &env.current_contract_address(),
            &vault,
            &to,
            &amount,
        );
        env.storage()
            .instance()
            .set(&symbol_short!("stolen"), &amount);
    }
    pub fn stolen(env: Env) -> i128 {
        env.storage()
            .instance()
            .get(&symbol_short!("stolen"))
            .unwrap_or(0)
    }
}

#[test]
fn nav_dropped_rolls_back_malicious_protocol_state_allowance_and_usage() {
    let f = Fixture::new();
    f.deposit(&f.alice, 100 * UNIT);
    let thief = f.env.register(Exfiltrator, ());
    f.allow_protocol(&thief);
    // The vault itself grants the allowance; the thief uses it to pay a third party.
    f.allow(
        &thief,
        "steal",
        vec![
            &f.env,
            ArgRule::Any,
            ArgRule::Vault,
            ArgRule::Any,
            ArgRule::Amount,
        ],
        true,
    );
    let usage = f.client().usage();
    let attacker_balance = f.token_balance(&f.bob);
    assert_eq!(
        f.client()
            .mock_all_auths()
            .try_execute(
                &thief,
                &symbol_short!("steal"),
                &(f.asset.clone(), f.vault.clone(), f.bob.clone(), 10 * UNIT).into_val(&f.env),
            )
            .err(),
        Some(Ok(Error::NavDropped))
    );
    assert_eq!(ExfiltratorClient::new(&f.env, &thief).stolen(), 0);
    assert_eq!(f.token_balance(&f.bob), attacker_balance);
    assert_eq!(f.client().nav(), 100 * UNIT);
    assert_eq!(f.client().usage(), usage);
    assert_eq!(
        token::Client::new(&f.env, &f.asset).allowance(&f.vault, &thief),
        0
    );
}

#[test]
fn drawdown_pauses_permissionlessly_and_redemption_does_not_trigger_it() {
    let f = Fixture::new();
    let shares = f.deposit(&f.alice, 1_000 * UNIT);
    let pool = f.invest(1_000 * UNIT, 0);
    f.withdraw(&f.alice, shares / 2);
    assert!(!f.client().check_drawdown());
    BlendMockClient::new(&f.env, &pool).set_rate(&(RATE * 79 / 100));
    assert!(f.client().check_drawdown());
    assert!(f.client().paused());
    assert!(f.withdraw(&f.alice, f.client().balance(&f.alice)) > 0);
    assert!(f.client().paused());
}

#[test]
fn drawdown_peak_expires_at_exactly_twenty_four_hours() {
    let f = Fixture::new();
    f.env.ledger().with_mut(|ledger| ledger.timestamp = 100);
    f.deposit(&f.alice, 1_000 * UNIT);
    let pool = f.invest(1_000 * UNIT, 0);
    BlendMockClient::new(&f.env, &pool).set_rate(&(RATE / 2));
    f.env.ledger().with_mut(|ledger| ledger.timestamp = 86_499);
    assert!(f.client().check_drawdown());
    f.client().mock_all_auths().set_paused(&false);
    f.env.ledger().with_mut(|ledger| ledger.timestamp = 86_500);
    assert!(!f.client().check_drawdown());
}

#[test]
fn drawdown_handles_ring_wrap_multiple_epochs_and_deposits() {
    let f = Fixture::new();
    f.env.ledger().with_mut(|ledger| ledger.timestamp = 131_070);
    f.deposit(&f.alice, 1_000 * UNIT);
    let pool = f.invest(1_000 * UNIT, 0);
    f.env.ledger().with_mut(|ledger| ledger.timestamp = 131_073);
    assert!(!f.client().check_drawdown());
    BlendMockClient::new(&f.env, &pool).set_rate(&(RATE / 2));
    // A new deposit must not mask the price-per-share loss.
    f.deposit(&f.bob, 1_000 * UNIT);
    assert!(f.client().check_drawdown());
    f.client().mock_all_auths().set_paused(&false);
    f.env
        .ledger()
        .with_mut(|ledger| ledger.timestamp = 4 * 131_072);
    assert!(!f.client().check_drawdown());
}

#[test]
fn amount_rules_reject_negative_malformed_and_foreign_asset_requests() {
    let f = Fixture::new();
    f.deposit(&f.alice, 100 * UNIT);
    configure_approval(&f);
    assert_eq!(
        outcome(f.client().mock_all_auths().try_execute(
            &f.asset,
            &symbol_short!("approve"),
            &approval(&f, -1)
        )),
        Err(Error::InvalidAmount)
    );
    assert_eq!(
        f.client()
            .mock_all_auths()
            .try_execute(
                &f.asset,
                &symbol_short!("approve"),
                &(f.vault.clone(), f.owner.clone(), f.bob.clone(), 100u32).into_val(&f.env),
            )
            .err(),
        Some(Ok(Error::InvalidAmount))
    );
    let pool = f.invest(UNIT, 0);
    // An allowed asset the oracle cannot price is refused: its position would be invisible.
    let other = f
        .env
        .register_stellar_asset_contract_v2(f.owner.clone())
        .address();
    f.set_assets(vec![&f.env, f.asset.clone(), other.clone()]);
    assert_eq!(
        f.client()
            .mock_all_auths()
            .try_execute(
                &pool,
                &Symbol::new(&f.env, "submit_with_allowance"),
                &(
                    f.vault.clone(),
                    f.vault.clone(),
                    f.vault.clone(),
                    vec![
                        &f.env,
                        Request {
                            address: other.clone(),
                            amount: UNIT,
                            request_type: 0
                        }
                    ]
                )
                    .into_val(&f.env),
            )
            .err(),
        Some(Ok(Error::OracleUnavailable))
    );
}

#[test]
fn blend_request_amounts_are_summed_without_netting() {
    let f = Fixture::new();
    f.deposit(&f.alice, 100 * UNIT);
    let pool = f.invest(50 * UNIT, 0);
    f.update_policy(|policy| policy.limits.tx_cap_bps = 1_000);
    assert_eq!(
        f.client()
            .mock_all_auths()
            .try_execute(
                &pool,
                &Symbol::new(&f.env, "submit_with_allowance"),
                &(
                    f.vault.clone(),
                    f.vault.clone(),
                    f.vault.clone(),
                    vec![
                        &f.env,
                        Request {
                            address: f.asset.clone(),
                            amount: 6 * UNIT,
                            request_type: 1
                        },
                        Request {
                            address: f.asset.clone(),
                            amount: 6 * UNIT,
                            request_type: 0
                        }
                    ]
                )
                    .into_val(&f.env),
            )
            .err(),
        Some(Ok(Error::TxCapExceeded))
    );
    assert_eq!(f.token_balance(&pool), 50 * UNIT);
}

#[test]
fn risk_configuration_requires_owner_and_rejects_unsafe_values() {
    let f = Fixture::new();
    assert!(f.client().try_set_paused(&true).is_err());
    assert!(f.client().try_revoke_session().is_err());
    assert!(f.client().try_rotate_session(&f.bob).is_err());
    assert!(f
        .client()
        .try_set_adapter(&AdapterKind::Blend, &f.bob)
        .is_err());
    let policy = f.policy();
    assert!(f
        .registry_client()
        .try_propose_policy(&f.vault, &policy)
        .is_err());
    let limits = policy.limits.clone();
    let mut invalid_policies = std::vec::Vec::new();
    for invalid in [
        Limits {
            tx_cap_bps: 10_001,
            ..limits.clone()
        },
        Limits {
            calls_per_hour: 0,
            ..limits.clone()
        },
        Limits {
            daily_cap_bps: 0,
            ..limits.clone()
        },
        Limits {
            min_health_factor_bps: 9_999,
            ..limits.clone()
        },
        Limits {
            max_drawdown_bps: 10_001,
            ..limits.clone()
        },
        Limits {
            daily_loss_bps: 10_001,
            ..limits.clone()
        },
        Limits {
            max_exposure_bps: 0,
            ..limits.clone()
        },
    ] {
        invalid_policies.push(PolicyV2 {
            limits: invalid,
            ..policy.clone()
        });
    }
    let mut lossy = policy.clone();
    lossy.calls.set(
        (f.asset.clone(), symbol_short!("approve")),
        CallRule {
            args: vec![&f.env],
            max_loss_bps: 10_001,
            approve: false,
        },
    );
    invalid_policies.push(lossy);
    // The base asset must stay first so Blend requests and NAV keep their unit.
    invalid_policies.push(PolicyV2 {
        assets: vec![&f.env, f.bob.clone()],
        ..policy.clone()
    });
    for invalid in invalid_policies {
        assert_eq!(
            f.registry_client()
                .mock_all_auths()
                .try_propose_policy(&f.vault, &invalid),
            Err(Ok(policy_registry::Error::InvalidPolicy))
        );
    }
    assert_eq!(f.policy(), policy);
}

#[test]
fn asset_not_allowed_blocks_fake_token_route_and_foreign_blend_request() {
    let f = Fixture::new();
    f.deposit(&f.alice, 100 * UNIT);
    let xlm = f
        .env
        .register_stellar_asset_contract_v2(f.owner.clone())
        .address();
    let fake = f
        .env
        .register_stellar_asset_contract_v2(f.bob.clone())
        .address();
    f.set_assets(vec![&f.env, f.asset.clone(), xlm.clone()]);
    let router = f.env.register(Router, ());
    f.allow_protocol(&router);
    f.allow(
        &router,
        "swap_exact_tokens_for_tokens",
        vec![
            &f.env,
            ArgRule::Amount,
            ArgRule::Any,
            ArgRule::Assets,
            ArgRule::Vault,
            ArgRule::Any,
        ],
        false,
    );
    let swap = |path: Vec<Address>| {
        outcome(f.client().mock_all_auths().try_execute(
            &router,
            &Symbol::new(&f.env, "swap_exact_tokens_for_tokens"),
            &(UNIT, 0_i128, path, f.vault.clone(), 0_u64).into_val(&f.env),
        ))
    };
    let usage = f.client().usage();
    assert_eq!(
        swap(vec![&f.env, f.asset.clone(), fake.clone(), xlm.clone()]),
        Err(Error::AssetNotAllowed)
    );
    assert_eq!(f.client().usage(), usage);
    assert_eq!(RouterClient::new(&f.env, &router).last_path(), None);
    swap(vec![&f.env, f.asset.clone(), xlm.clone()]).unwrap();
    assert_eq!(
        RouterClient::new(&f.env, &router).last_path(),
        Some(vec![&f.env, f.asset.clone(), xlm])
    );
    let pool = f.blend_pool();
    let requests = vec![
        &f.env,
        Request {
            address: fake,
            amount: UNIT,
            request_type: 0,
        },
    ];
    assert_eq!(
        outcome(f.client().mock_all_auths().try_execute(
            &pool,
            &Symbol::new(&f.env, "submit_with_allowance"),
            &(f.vault.clone(), f.vault.clone(), f.vault.clone(), requests).into_val(&f.env),
        )),
        Err(Error::AssetNotAllowed)
    );
}

#[test]
fn daily_loss_exceeded_stops_repeated_skims_under_per_call_tolerance() {
    let f = Fixture::new();
    f.deposit(&f.alice, 1_000 * UNIT);
    let skimmer = f.env.register(Skimmer, ());
    f.allow_protocol(&skimmer);
    f.allow_with_loss(
        &skimmer,
        "skim",
        vec![
            &f.env,
            ArgRule::Any,
            ArgRule::Vault,
            ArgRule::Amount,
            ArgRule::Any,
        ],
        true,
        50,
    );
    let skim = |amount: i128| {
        outcome(f.client().mock_all_auths().try_execute(
            &skimmer,
            &symbol_short!("skim"),
            &(f.asset.clone(), f.vault.clone(), amount, f.bob.clone()).into_val(&f.env),
        ))
    };
    let bob = f.token_balance(&f.bob);
    // 0.49% passes the 0.50% per-call tolerance once...
    skim(1_000 * UNIT).unwrap();
    assert_eq!(f.client().daily_loss(), 49 * UNIT / 10);
    // ...but a second skim would take the 24 h total to 0.98%.
    let nav = f.client().nav();
    assert_eq!(skim(nav), Err(Error::DailyLossExceeded));
    assert_eq!(f.client().nav(), nav);
    assert_eq!(f.client().daily_loss(), 49 * UNIT / 10);
    // The window slides hour by hour: still blocked at 23 h, free again at 24 h.
    f.env
        .ledger()
        .with_mut(|ledger| ledger.timestamp = 23 * 3_600);
    assert_eq!(skim(nav), Err(Error::DailyLossExceeded));
    f.env
        .ledger()
        .with_mut(|ledger| ledger.timestamp = 24 * 3_600);
    assert_eq!(f.client().daily_loss(), 0);
    skim(nav).unwrap();
    assert_eq!(
        f.token_balance(&f.bob) - bob,
        49 * UNIT / 10 + nav * 49 / 10_000
    );
}

#[test]
fn allowance_not_cleared_when_protocol_leaves_approval_unspent() {
    let f = Fixture::new();
    f.deposit(&f.alice, 100 * UNIT);
    let lazy = f.env.register(Lazy, ());
    f.allow_protocol(&lazy);
    f.allow(
        &lazy,
        "deposit",
        vec![&f.env, ArgRule::Any, ArgRule::Vault, ArgRule::Amount],
        true,
    );
    let token = token::Client::new(&f.env, &f.asset);
    assert_eq!(
        outcome(f.client().mock_all_auths().try_execute(
            &lazy,
            &symbol_short!("deposit"),
            &(f.asset.clone(), f.vault.clone(), 10 * UNIT).into_val(&f.env),
        )),
        Err(Error::AllowanceNotCleared)
    );
    assert_eq!(token.allowance(&f.vault, &lazy), 0);
    // A standing approval chosen by the agent is refused the same way.
    configure_approval(&f);
    assert_eq!(
        outcome(f.client().mock_all_auths().try_execute(
            &f.asset,
            &symbol_short!("approve"),
            &approval(&f, UNIT)
        )),
        Err(Error::AllowanceNotCleared)
    );
    assert_eq!(token.allowance(&f.vault, &f.owner), 0);
    assert_eq!(f.client().usage().calls, 0);
}

#[test]
fn value_left_perimeter_when_pool_misreports_positions() {
    let f = Fixture::new();
    f.deposit(&f.alice, 1_000 * UNIT);
    let pool = f.invest(100 * UNIT, 0);
    let bob = f.token_balance(&f.bob);
    // The pool credits the supply in get_positions but sends the tokens away.
    BlendMockClient::new(&f.env, &pool).set_sink(&f.bob);
    assert_eq!(
        f.submit(&pool, 100 * UNIT, 0),
        Err(Error::ValueLeftPerimeter)
    );
    assert_eq!(f.token_balance(&f.bob), bob);
    assert_eq!(f.token_balance(&f.vault), 900 * UNIT);
    assert_eq!(f.client().nav(), 1_000 * UNIT);
    // Funds moved to a custody contract the owner declared stay inside the perimeter.
    let custody = Address::generate(&f.env);
    BlendMockClient::new(&f.env, &pool).set_sink(&custody);
    f.update_policy(|policy| {
        policy
            .guards
            .set(pool.clone(), vec![&f.env, custody.clone()])
    });
    f.submit(&pool, 100 * UNIT, 0).unwrap();
    assert_eq!(f.token_balance(&custody), 100 * UNIT);
}

#[test]
fn exposure_cap_exceeded_on_over_concentration_in_one_protocol() {
    let f = Fixture::new();
    f.deposit(&f.alice, 1_000 * UNIT);
    let pool = f.blend_pool();
    assert_eq!(f.policy().limits.max_exposure_bps, 5_000);
    assert_eq!(
        f.submit(&pool, 500 * UNIT + 1, 2),
        Err(Error::ExposureCapExceeded)
    );
    assert_eq!(f.token_balance(&pool), 0);
    f.submit(&pool, 500 * UNIT, 2).unwrap();
    assert_eq!(f.token_balance(&pool), 500 * UNIT);
    // Collateral counts gross: borrowing against it does not free capacity.
    f.submit(&pool, 200 * UNIT, 4).unwrap();
    assert_eq!(f.submit(&pool, 1, 2), Err(Error::ExposureCapExceeded));
    // Above a tightened cap, shrinking the position stays possible; growing it does not.
    f.update_policy(|policy| policy.limits.max_exposure_bps = 3_000);
    f.submit(&pool, 100 * UNIT, 3).unwrap();
    assert_eq!(f.token_balance(&pool), 200 * UNIT);
    assert_eq!(f.submit(&pool, 1, 2), Err(Error::ExposureCapExceeded));
}
