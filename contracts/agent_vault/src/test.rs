extern crate std;

use crate::{
    adapters::blend::Request,
    shares::{PRICE_SCALE, VIRTUAL_SHARES},
    AgentVault, AgentVaultClient, ArgRule, Error, Executed, NavSnapshot,
};
use soroban_sdk::{
    contract, contractimpl, contracttype, map, symbol_short,
    testutils::{Address as _, Events, Ledger},
    token, vec, Address, Env, IntoVal, Map, Symbol, Val, Vec,
};

const UNIT: i128 = 10_000_000;
const RATE: i128 = 1_000_000_000_000;

struct Fixture {
    env: Env,
    vault: Address,
    asset: Address,
    owner: Address,
    protocol: Address,
    alice: Address,
    bob: Address,
    agent: Address,
}

impl Fixture {
    fn new() -> Self {
        let env = Env::default();
        let owner = Address::generate(&env);
        let agent = Address::generate(&env);
        let protocol = Address::generate(&env);
        let alice = Address::generate(&env);
        let bob = Address::generate(&env);
        let asset = env
            .register_stellar_asset_contract_v2(owner.clone())
            .address();
        let vault = env.register(
            AgentVault,
            (
                owner.clone(),
                agent.clone(),
                asset.clone(),
                protocol.clone(),
                5u32,
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
        };
        f.mint(&f.alice, 10_000 * UNIT);
        f.mint(&f.bob, 10_000 * UNIT);
        f
    }

    fn client(&self) -> AgentVaultClient<'_> {
        AgentVaultClient::new(&self.env, &self.vault)
    }

    fn mint(&self, to: &Address, amount: i128) {
        token::StellarAssetClient::new(&self.env, &self.asset)
            .mock_all_auths()
            .mint(to, &amount);
    }

    fn deposit(&self, user: &Address, amount: i128) -> i128 {
        self.client().mock_all_auths().deposit(user, &amount)
    }

    fn withdraw(&self, user: &Address, shares: i128) -> i128 {
        self.client().mock_all_auths().withdraw(user, &shares)
    }

    fn token_balance(&self, user: &Address) -> i128 {
        token::Client::new(&self.env, &self.asset).balance(user)
    }

    fn approve_noop(&self) {
        self.client().mock_all_auths().allow_call(
            &self.asset,
            &symbol_short!("approve"),
            &vec![
                &self.env,
                ArgRule::Vault,
                ArgRule::Any,
                ArgRule::Amount,
                ArgRule::Any,
            ],
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

    fn invest(&self, amount: i128, request_type: u32) -> Address {
        let pool = self.env.register(BlendMock, (self.asset.clone(),));
        self.client().mock_all_auths().set_blend(&pool, &3);
        self.client().mock_all_auths().allow_protocol(&pool);
        self.client().mock_all_auths().allow_call(
            &self.asset,
            &symbol_short!("approve"),
            &vec![
                &self.env,
                ArgRule::Vault,
                ArgRule::Protocol,
                ArgRule::Amount,
                ArgRule::Any,
            ],
        );
        self.client().mock_all_auths().allow_call(
            &pool,
            &Symbol::new(&self.env, "submit_with_allowance"),
            &vec![
                &self.env,
                ArgRule::Vault,
                ArgRule::Vault,
                ArgRule::Vault,
                ArgRule::BlendRequests,
            ],
        );
        self.client().mock_all_auths().execute(
            &self.asset,
            &symbol_short!("approve"),
            &(
                self.vault.clone(),
                pool.clone(),
                amount,
                self.env.ledger().sequence() + 10,
            )
                .into_val(&self.env),
        );
        self.client().mock_all_auths().execute(
            &pool,
            &Symbol::new(&self.env, "submit_with_allowance"),
            &(
                self.vault.clone(),
                self.vault.clone(),
                self.vault.clone(),
                vec![
                    &self.env,
                    Request {
                        address: self.asset.clone(),
                        amount,
                        request_type,
                    },
                ],
            )
                .into_val(&self.env),
        );
        pool
    }
}

#[contract]
struct BlendMock;

#[contracttype]
#[derive(Clone)]
enum MockKey {
    Asset,
    Supply(Address),
    Collateral(Address),
    Debt(Address),
    Rate,
}

#[contractimpl]
impl BlendMock {
    pub fn __constructor(env: Env, asset: Address) {
        env.storage().instance().set(&MockKey::Asset, &asset);
        env.storage().instance().set(&MockKey::Rate, &RATE);
    }

    pub fn set_rate(env: Env, rate: i128) {
        env.storage().instance().set(&MockKey::Rate, &rate);
    }

    pub fn get_positions(env: Env, address: Address) -> Map<Symbol, Val> {
        let s = env.storage().instance();
        map![
            &env,
            (
                symbol_short!("supply"),
                map![
                    &env,
                    (
                        3u32,
                        s.get::<_, i128>(&MockKey::Supply(address.clone()))
                            .unwrap_or(0)
                    )
                ]
                .into_val(&env)
            ),
            (
                Symbol::new(&env, "collateral"),
                map![
                    &env,
                    (
                        3u32,
                        s.get::<_, i128>(&MockKey::Collateral(address.clone()))
                            .unwrap_or(0)
                    )
                ]
                .into_val(&env)
            ),
            (
                Symbol::new(&env, "liabilities"),
                map![
                    &env,
                    (3u32, s.get::<_, i128>(&MockKey::Debt(address)).unwrap_or(0))
                ]
                .into_val(&env)
            ),
        ]
    }

    pub fn get_reserve(env: Env, _asset: Address) -> Map<Symbol, Val> {
        let rate: i128 = env.storage().instance().get(&MockKey::Rate).unwrap();
        let data: Map<Symbol, i128> = map![
            &env,
            (symbol_short!("b_rate"), rate),
            (symbol_short!("d_rate"), RATE),
        ];
        let config = map![
            &env,
            (symbol_short!("c_factor"), 9_000_000u32),
            (symbol_short!("l_factor"), 9_000_000u32),
        ];
        map![
            &env,
            (symbol_short!("data"), data.into_val(&env)),
            (symbol_short!("config"), config.into_val(&env)),
        ]
    }

    pub fn submit_with_allowance(
        env: Env,
        from: Address,
        spender: Address,
        to: Address,
        requests: Vec<Request>,
    ) {
        spender.require_auth();
        if from != spender {
            from.require_auth();
        }
        let s = env.storage().instance();
        let asset: Address = s.get(&MockKey::Asset).unwrap();
        let rate: i128 = s.get(&MockKey::Rate).unwrap();
        let me = env.current_contract_address();
        let token = token::Client::new(&env, &asset);
        let mut net = 0;
        for request in requests {
            assert_eq!(request.address, asset);
            let key = match request.request_type {
                0 | 1 => MockKey::Supply(from.clone()),
                2 | 3 => MockKey::Collateral(from.clone()),
                4 | 5 => MockKey::Debt(from.clone()),
                _ => panic!("unsupported request"),
            };
            let previous: i128 = s.get(&key).unwrap_or(0);
            let (new, delta) = match request.request_type {
                0 | 2 => (previous + request.amount * RATE / rate, -request.amount),
                1 | 3 => {
                    let burnt = (request.amount * RATE + rate - 1) / rate;
                    assert!(burnt <= previous);
                    (previous - burnt, request.amount)
                }
                4 => (previous + request.amount, request.amount),
                5 => {
                    let repaid = request.amount.min(previous);
                    (previous - repaid, -repaid)
                }
                _ => unreachable!(),
            };
            s.set(&key, &new);
            net += delta;
        }
        if net < 0 {
            token.transfer_from(&me, &spender, &me, &-net);
        } else if net > 0 {
            token.transfer(&me, &to, &net);
        }
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
    f.client().mock_all_auths().allow_call(
        &f.asset,
        &symbol_short!("burn"),
        &vec![&f.env, ArgRule::Vault, ArgRule::Amount],
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
    f.client().mock_all_auths().allow_protocol(&f.owner);
    f.client().mock_all_auths().allow_call(
        &f.asset,
        &symbol_short!("approve"),
        &vec![
            &f.env,
            ArgRule::Vault,
            ArgRule::Protocol,
            ArgRule::Amount,
            ArgRule::Any,
        ],
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

fn approve(
    f: &Fixture,
    amount: i128,
) -> Result<Result<(), soroban_sdk::ConversionError>, Result<Error, soroban_sdk::InvokeError>> {
    f.client()
        .mock_all_auths()
        .try_execute(&f.asset, &symbol_short!("approve"), &approval(f, amount))
        .map(|result| result.map(|_| ()))
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
    configure_approval(&f);
    let mut limits = f.client().limits();
    limits.tx_cap_bps = 1_000;
    f.client().mock_all_auths().set_limits(&limits);
    assert_eq!(approve(&f, 10 * UNIT + 1), Err(Ok(Error::TxCapExceeded)));
    assert_eq!(f.client().usage().calls, 0);
    approve(&f, 10 * UNIT).unwrap().unwrap();
    assert_eq!(
        token::Client::new(&f.env, &f.asset).allowance(&f.vault, &f.owner),
        10 * UNIT
    );
    assert_eq!(f.client().usage().spent, 10 * UNIT);
}

#[test]
fn daily_cap_exceeded_accumulates_and_resets_only_at_utc_day() {
    let f = Fixture::new();
    f.deposit(&f.alice, 100 * UNIT);
    configure_approval(&f);
    let mut limits = f.client().limits();
    limits.daily_cap_bps = 1_000;
    f.client().mock_all_auths().set_limits(&limits);
    approve(&f, 6 * UNIT).unwrap().unwrap();
    assert_eq!(approve(&f, 4 * UNIT + 1), Err(Ok(Error::DailyCapExceeded)));
    approve(&f, 4 * UNIT).unwrap().unwrap();
    f.env.ledger().with_mut(|ledger| ledger.timestamp = 86_399);
    assert_eq!(approve(&f, 1), Err(Ok(Error::DailyCapExceeded)));
    f.env.ledger().with_mut(|ledger| ledger.timestamp = 86_400);
    approve(&f, 10 * UNIT).unwrap().unwrap();
    assert_eq!(f.client().usage().spent, 10 * UNIT);
    assert_eq!(f.client().usage().day, 1);
}

#[test]
fn rate_limited_counts_zero_amount_calls_and_resets_at_hour() {
    let f = Fixture::new();
    configure_approval(&f);
    let mut limits = f.client().limits();
    limits.calls_per_hour = 2;
    f.client().mock_all_auths().set_limits(&limits);
    approve(&f, 0).unwrap().unwrap();
    approve(&f, 0).unwrap().unwrap();
    f.env.ledger().with_mut(|ledger| ledger.timestamp = 3_599);
    assert_eq!(approve(&f, 0), Err(Ok(Error::RateLimited)));
    assert_eq!(f.client().usage().calls, 2);
    f.env.ledger().with_mut(|ledger| ledger.timestamp = 3_600);
    approve(&f, 0).unwrap().unwrap();
    assert_eq!(f.client().usage().calls, 1);
}

#[test]
fn paused_execution_and_revoked_session_leave_withdrawals_open() {
    let f = Fixture::new();
    let shares = f.deposit(&f.alice, 100 * UNIT);
    configure_approval(&f);
    f.client().mock_all_auths().set_paused(&true);
    assert_eq!(approve(&f, 0), Err(Ok(Error::Paused)));
    f.client().mock_all_auths().set_paused(&false);
    f.client().mock_all_auths().revoke_session();
    assert_eq!(f.client().session(), None);
    assert_eq!(approve(&f, 0), Err(Ok(Error::SessionRevoked)));
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
    f.client().mock_all_auths().allow_protocol(&thief);
    f.client().mock_all_auths().allow_call(
        &f.asset,
        &symbol_short!("approve"),
        &vec![
            &f.env,
            ArgRule::Vault,
            ArgRule::Protocol,
            ArgRule::Amount,
            ArgRule::Any,
        ],
    );
    f.client().mock_all_auths().execute(
        &f.asset,
        &symbol_short!("approve"),
        &(f.vault.clone(), thief.clone(), 10 * UNIT, 100u32).into_val(&f.env),
    );
    f.client().mock_all_auths().allow_call(
        &thief,
        &symbol_short!("steal"),
        &vec![
            &f.env,
            ArgRule::Any,
            ArgRule::Vault,
            ArgRule::Any,
            ArgRule::Amount,
        ],
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
        10 * UNIT
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
    assert_eq!(approve(&f, -1), Err(Ok(Error::InvalidAmount)));
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
                            address: f.bob.clone(),
                            amount: UNIT,
                            request_type: 0
                        }
                    ]
                )
                    .into_val(&f.env),
            )
            .err(),
        Some(Ok(Error::InvalidAmount))
    );
}

#[test]
fn blend_request_amounts_are_summed_without_netting() {
    let f = Fixture::new();
    f.deposit(&f.alice, 100 * UNIT);
    let pool = f.invest(50 * UNIT, 0);
    let mut limits = f.client().limits();
    limits.tx_cap_bps = 1_000;
    f.client().mock_all_auths().set_limits(&limits);
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
    let limits = f.client().limits();
    assert!(f.client().try_set_limits(&limits).is_err());
    for invalid in [
        crate::Limits {
            tx_cap_bps: 10_001,
            ..limits.clone()
        },
        crate::Limits {
            calls_per_hour: 0,
            ..limits.clone()
        },
        crate::Limits {
            daily_cap_bps: 0,
            ..limits.clone()
        },
        crate::Limits {
            min_health_factor_bps: 9_999,
            ..limits.clone()
        },
        crate::Limits {
            max_drawdown_bps: 10_001,
            ..limits.clone()
        },
    ] {
        assert_eq!(
            f.client().mock_all_auths().try_set_limits(&invalid),
            Err(Ok(Error::InvalidConfig))
        );
    }
}
