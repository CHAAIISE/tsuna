extern crate std;

use crate::{
    adapters::{blend::Request, xoxno::HubAssetKey},
    test::{outcome, Fixture, UNIT},
    testutils::{
        aquarius::{AquariusMock, AquariusMockClient},
        blend::{BlendMock, BlendMockClient},
        defindex::{DeFindexMock, DeFindexMockClient},
        soroswap::{PairMock, SoroswapRouterMock},
        xoxno::{XoxnoMock, XoxnoMockClient, THRESHOLD},
    },
    AdapterKind, Error, Withdrawn, MAX_POSITIONS,
};
use oracle_router::{testutils::MockReflectorClient, Feed, OracleRouterClient, ReflectorAsset};
use policy_registry::ArgRule;
use soroban_sdk::{
    testutils::{Address as _, Events, Ledger, MockAuth, MockAuthInvoke},
    token, vec, Address, Env, Event, IntoVal, Map, Symbol, Val, Vec,
};

const START: u64 = 1_800_000_000;
/// One USD with Reflector's 14 decimals.
const R_USD: i128 = 100_000_000_000_000;

/// Vault on USDC (base) allowed to hold XLM at 0.20 USDC, with 1,000 USDC from alice and
/// exposure caps lifted so a single protocol may hold everything.
struct Lab {
    f: Fixture,
    xlm: Address,
}

impl Lab {
    fn new() -> Self {
        let f = Fixture::new();
        // Native test execution meters mocks and harness too; testnet cost is measured separately.
        f.env.cost_estimate().budget().reset_unlimited();
        f.env.ledger().set_timestamp(START);
        let xlm = f
            .env
            .register_stellar_asset_contract_v2(f.owner.clone())
            .address();
        f.set_assets(vec![&f.env, f.asset.clone(), xlm.clone()]);
        f.update_policy(|policy| policy.limits.max_exposure_bps = 10_000);
        let router = OracleRouterClient::new(&f.env, &f.oracle);
        for (asset, ticker) in [(&f.asset, "USDC"), (&xlm, "XLM")] {
            router.mock_all_auths().set_feed(
                asset,
                &Feed {
                    reflector: ReflectorAsset::Other(Symbol::new(&f.env, ticker)),
                    chainlink: None,
                },
            );
        }
        let lab = Self { f, xlm };
        lab.quote(R_USD / 5, START);
        lab.f.deposit(&lab.f.alice, 1_000 * UNIT);
        lab
    }

    fn env(&self) -> &Env {
        &self.f.env
    }

    /// Publishes USDC at 1 USD and XLM at `xlm` (Reflector units) at `timestamp`.
    fn quote(&self, xlm: i128, timestamp: u64) {
        let reflector = MockReflectorClient::new(self.env(), &self.f.reflector);
        for (ticker, price) in [("USDC", R_USD), ("XLM", xlm)] {
            reflector.push(
                &ReflectorAsset::Other(Symbol::new(self.env(), ticker)),
                &price,
                &timestamp,
            );
        }
    }

    fn mint(&self, asset: &Address, to: &Address, amount: i128) {
        token::StellarAssetClient::new(self.env(), asset)
            .mock_all_auths()
            .mint(to, &amount);
    }

    fn balance(&self, asset: &Address, owner: &Address) -> i128 {
        token::Client::new(self.env(), asset).balance(owner)
    }

    fn adapter(&self, kind: AdapterKind, protocol: &Address) {
        self.f.allow_protocol(protocol);
        self.f
            .client()
            .mock_all_auths()
            .set_adapter(&kind, protocol);
    }

    fn any(&self, target: &Address, fn_name: &str, count: u32) {
        let mut rules = Vec::new(self.env());
        for _ in 0..count {
            rules.push_back(ArgRule::Any);
        }
        self.f.allow(target, fn_name, rules, false);
    }

    /// Only the session key's signature on `execute` is provided: every other authorization
    /// a protocol needs must come from the vault itself.
    fn call(&self, target: &Address, fn_name: &str, args: Vec<Val>) -> Result<(), Error> {
        let fn_name = Symbol::new(self.env(), fn_name);
        outcome(
            self.f
                .client()
                .mock_auths(&[MockAuth {
                    address: &self.f.agent,
                    invoke: &MockAuthInvoke {
                        contract: &self.f.vault,
                        fn_name: "execute",
                        args: (target.clone(), fn_name.clone(), args.clone()).into_val(self.env()),
                        sub_invokes: &[],
                    },
                }])
                .try_execute(target, &fn_name, &args),
        )
    }

    fn nav(&self) -> i128 {
        self.f.client().nav()
    }

    fn blend(&self) -> (Address, u32) {
        let pool = self.env().register(BlendMock, (self.f.asset.clone(),));
        let index =
            BlendMockClient::new(self.env(), &pool).add_reserve(&self.xlm, &7_500_000, &9_000_000);
        self.adapter(AdapterKind::Blend, &pool);
        // Lending liquidity from other suppliers.
        self.mint(&self.f.asset, &pool, 10_000 * UNIT);
        self.f.allow(
            &pool,
            "submit_with_allowance",
            vec![
                self.env(),
                ArgRule::Vault,
                ArgRule::Vault,
                ArgRule::Vault,
                ArgRule::BlendRequests,
            ],
            true,
        );
        (pool, index)
    }

    fn submit(&self, pool: &Address, requests: Vec<Request>) -> Result<(), Error> {
        let me = self.f.vault.clone();
        self.call(
            pool,
            "submit_with_allowance",
            (me.clone(), me.clone(), me, requests).into_val(self.env()),
        )
    }

    fn request(&self, asset: &Address, amount: i128, request_type: u32) -> Request {
        Request {
            address: asset.clone(),
            amount,
            request_type,
        }
    }

    fn defindex(&self) -> Address {
        let vault = self.env().register(DeFindexMock, (self.f.asset.clone(),));
        self.adapter(AdapterKind::DeFindex, &vault);
        self.any(&vault, "deposit", 4);
        self.any(&vault, "withdraw", 3);
        vault
    }

    fn df_deposit(&self, vault: &Address, amount: i128) -> Result<(), Error> {
        self.call(
            vault,
            "deposit",
            (
                vec![self.env(), amount],
                vec![self.env(), 0_i128],
                self.f.vault.clone(),
                false,
            )
                .into_val(self.env()),
        )
    }

    /// Pool USDC/XLM seeded by bob with 1,000 USDC and 5,000 XLM, i.e. at the oracle price.
    fn aquarius(&self) -> (Address, Address) {
        let pool = self
            .env()
            .register(AquariusMock, (self.f.asset.clone(), self.xlm.clone()));
        let share = self
            .env()
            .register_stellar_asset_contract_v2(pool.clone())
            .address();
        let client = AquariusMockClient::new(self.env(), &pool);
        client.set_share(&share);
        self.mint(&self.xlm, &self.f.bob, 5_000 * UNIT);
        client.mock_all_auths().deposit(
            &self.f.bob,
            &vec![self.env(), (1_000 * UNIT) as u128, (5_000 * UNIT) as u128],
            &0,
        );
        self.adapter(AdapterKind::Aquarius, &pool);
        self.any(&pool, "deposit", 3);
        self.any(&pool, "withdraw", 3);
        (pool, share)
    }

    fn lp_deposit(&self, pool: &Address, usdc: i128, xlm: i128) -> Result<(), Error> {
        self.call(
            pool,
            "deposit",
            (
                self.f.vault.clone(),
                vec![self.env(), usdc as u128, xlm as u128],
                0_u128,
            )
                .into_val(self.env()),
        )
    }
}

#[test]
fn blend_values_every_reserve_at_oracle_prices_with_weighted_health_factor() {
    let lab = Lab::new();
    let (pool, xlm_index) = lab.blend();
    lab.mint(&lab.xlm, &lab.f.vault, 1_000 * UNIT);
    assert_eq!(lab.nav(), 1_200 * UNIT);
    // XLM collateral and a USDC loan in one submission: the vault approves only the XLM it pays.
    lab.submit(
        &pool,
        vec![
            lab.env(),
            lab.request(&lab.xlm, 1_000 * UNIT, 2),
            lab.request(&lab.f.asset, 100 * UNIT, 4),
        ],
    )
    .unwrap();
    assert_eq!(lab.balance(&lab.xlm, &lab.f.vault), 0);
    assert_eq!(lab.balance(&lab.xlm, &pool), 1_000 * UNIT);
    assert_eq!(lab.balance(&lab.f.asset, &lab.f.vault), 1_100 * UNIT);
    assert_eq!(
        token::Client::new(lab.env(), &lab.xlm).allowance(&lab.f.vault, &pool),
        0
    );
    let positions = BlendMockClient::new(lab.env(), &pool).get_positions(&lab.f.vault);
    let collateral: Map<u32, i128> = positions
        .get(Symbol::new(lab.env(), "collateral"))
        .unwrap()
        .into_val(lab.env());
    assert_eq!(collateral.get(xlm_index), Some(1_000 * UNIT));
    // 1,100 idle USDC + 1,000 XLM collateral at 0.20 − 100 USDC debt.
    assert_eq!(lab.nav(), 1_200 * UNIT);
    // Blend's weights: 200 × 0.75 against 100 ÷ 0.9 (rounded up).
    let weighted_debt = (100 * UNIT * 10_000_000 + 9_000_000 - 1) / 9_000_000;
    assert_eq!(
        lab.f.client().health_factor(),
        150 * UNIT * 10_000 / weighted_debt
    );
    // XLM falls 20%: the same position is now below the 1.3 floor and the agent is stopped.
    lab.env().ledger().set_timestamp(START + 1_000);
    lab.quote(4 * R_USD / 25, START + 1_000);
    assert_eq!(
        lab.f.client().health_factor(),
        120 * UNIT * 10_000 / weighted_debt
    );
    assert_eq!(lab.nav(), 1_160 * UNIT);
    assert_eq!(
        lab.submit(&pool, Vec::new(lab.env())),
        Err(Error::HealthFactorTooLow)
    );
}

#[test]
fn blend_requests_in_other_assets_are_budgeted_at_oracle_value() {
    let lab = Lab::new();
    let (pool, _) = lab.blend();
    lab.mint(&lab.xlm, &lab.f.vault, 4_000 * UNIT);
    // NAV 1,800: a 50% cap allows 900 USDC of value, i.e. 4,500 XLM but not 4,500 + 1 USDC.
    lab.f
        .update_policy(|policy| policy.limits.tx_cap_bps = 5_000);
    assert_eq!(
        lab.submit(
            &pool,
            vec![
                lab.env(),
                lab.request(&lab.xlm, 4_000 * UNIT, 2),
                lab.request(&lab.f.asset, 100 * UNIT + 1, 4),
            ]
        ),
        Err(Error::TxCapExceeded)
    );
    lab.submit(
        &pool,
        vec![
            lab.env(),
            lab.request(&lab.xlm, 4_000 * UNIT, 2),
            lab.request(&lab.f.asset, 100 * UNIT, 4),
        ],
    )
    .unwrap();
    assert_eq!(lab.f.client().usage().spent, 900 * UNIT);
}

#[test]
fn defindex_deposit_is_authorized_by_the_vault_and_valued_from_its_shares() {
    let lab = Lab::new();
    let df = lab.defindex();
    lab.df_deposit(&df, 400 * UNIT).unwrap();
    let client = DeFindexMockClient::new(lab.env(), &df);
    assert_eq!(client.balance(&lab.f.vault), 400 * UNIT);
    assert_eq!(lab.balance(&lab.f.asset, &df), 400 * UNIT);
    assert_eq!(lab.nav(), 1_000 * UNIT);
    // The adapter's value replaces the unbudgeted `Any` amount vector.
    assert_eq!(lab.f.client().usage().spent, 400 * UNIT);
    // Strategy yield shows up through the vault's own redemption quote.
    lab.mint(&lab.f.asset, &df, 40 * UNIT);
    assert_eq!(lab.nav(), 1_040 * UNIT);
    // `from` must be the vault even though the rule leaves it unconstrained.
    assert_eq!(
        lab.call(
            &df,
            "deposit",
            (
                vec![lab.env(), UNIT],
                vec![lab.env(), 0_i128],
                lab.f.bob.clone(),
                false,
            )
                .into_val(lab.env()),
        ),
        Err(Error::DestinationNotVault)
    );
    lab.call(
        &df,
        "withdraw",
        (200 * UNIT, vec![lab.env(), 0_i128], lab.f.vault.clone()).into_val(lab.env()),
    )
    .unwrap();
    assert_eq!(lab.balance(&lab.f.asset, &lab.f.vault), 820 * UNIT);
    assert_eq!(lab.nav(), 1_040 * UNIT);
}

#[test]
fn deposit_into_a_protocol_without_adapter_lacks_the_vault_authorization() {
    let lab = Lab::new();
    let df = lab.env().register(DeFindexMock, (lab.f.asset.clone(),));
    lab.f.allow_protocol(&df);
    lab.any(&df, "deposit", 4);
    let fn_name = Symbol::new(lab.env(), "deposit");
    let args: Vec<Val> = (
        vec![lab.env(), 400 * UNIT],
        vec![lab.env(), 0_i128],
        lab.f.vault.clone(),
        false,
    )
        .into_val(lab.env());
    let result = lab
        .f
        .client()
        .mock_auths(&[MockAuth {
            address: &lab.f.agent,
            invoke: &MockAuthInvoke {
                contract: &lab.f.vault,
                fn_name: "execute",
                args: (df.clone(), fn_name.clone(), args.clone()).into_val(lab.env()),
                sub_invokes: &[],
            },
        }])
        .try_execute(&df, &fn_name, &args);
    assert!(matches!(result, Err(Err(_))));
    assert_eq!(lab.balance(&lab.f.asset, &lab.f.vault), 1_000 * UNIT);
}

#[test]
fn aquarius_lp_is_valued_at_the_pool_invariant_so_skew_cannot_inflate_nav() {
    let lab = Lab::new();
    let (pool, share) = lab.aquarius();
    lab.mint(&lab.xlm, &lab.f.vault, 500 * UNIT);
    assert_eq!(lab.nav(), 1_100 * UNIT);
    lab.lp_deposit(&pool, 100 * UNIT, 500 * UNIT).unwrap();
    assert_eq!(lab.balance(&share, &lab.f.vault), 100 * UNIT);
    // 100 of 1,100 shares of a pool worth 2 × 1,100 USDC.
    assert_eq!(lab.nav(), 1_100 * UNIT);
    // Bob dumps 1,000 USDC into the pool: reserves are now worth 2,676 USDC at the oracle,
    // but the invariant still values them at 2,200.
    AquariusMockClient::new(lab.env(), &pool)
        .mock_all_auths()
        .swap(&lab.f.bob, &0, &1, &((1_000 * UNIT) as u128));
    let skewed = lab.nav();
    assert!(
        skewed <= 1_100 * UNIT && 1_100 * UNIT - skewed <= 2,
        "{skewed}"
    );
    // Withdrawal burns LP shares with an authorization only the vault builds.
    lab.call(
        &pool,
        "withdraw",
        (
            lab.f.vault.clone(),
            (50 * UNIT) as u128,
            vec![lab.env(), 0_u128, 0_u128],
        )
            .into_val(lab.env()),
    )
    .unwrap();
    assert_eq!(lab.balance(&share, &lab.f.vault), 50 * UNIT);
}

#[test]
fn soroswap_swap_needs_an_oracle_bounded_minimum_and_a_declared_pair() {
    let lab = Lab::new();
    // 5 XLM per USDC, the oracle rate.
    let pair = lab.env().register(PairMock, (5 * UNIT,));
    lab.mint(&lab.xlm, &pair, 10_000 * UNIT);
    let router = lab.env().register(SoroswapRouterMock, (pair.clone(),));
    lab.adapter(AdapterKind::Soroswap, &router);
    lab.f.allow_with_loss(
        &router,
        "swap_exact_tokens_for_tokens",
        vec![
            lab.env(),
            ArgRule::Any,
            ArgRule::Any,
            ArgRule::Assets,
            ArgRule::Any,
            ArgRule::Any,
        ],
        false,
        50,
    );
    let swap = |min_out: i128| {
        lab.call(
            &router,
            "swap_exact_tokens_for_tokens",
            (
                100 * UNIT,
                min_out,
                vec![lab.env(), lab.f.asset.clone(), lab.xlm.clone()],
                lab.f.vault.clone(),
                0_u64,
            )
                .into_val(lab.env()),
        )
    };
    // 100 USDC quote 500 XLM; 50 bps tolerance → at least 497.5 XLM.
    let floor = 4_975 * UNIT / 10;
    assert_eq!(swap(floor - 1), Err(Error::SlippageTooLoose));
    // The pair must be a declared custody contract of the router.
    assert_eq!(swap(floor), Err(Error::SpenderNotProtocol));
    lab.f.update_policy(|policy| {
        policy
            .guards
            .set(router.clone(), vec![lab.env(), pair.clone()])
    });
    swap(floor).unwrap();
    assert_eq!(lab.balance(&lab.xlm, &lab.f.vault), 500 * UNIT);
    assert_eq!(lab.balance(&lab.f.asset, &pair), 100 * UNIT);
    assert_eq!(lab.nav(), 1_000 * UNIT);
    assert_eq!(lab.f.client().usage().spent, 100 * UNIT);
}

#[test]
fn xoxno_account_is_opened_once_valued_and_kept_to_the_vault() {
    let lab = Lab::new();
    let ctl = lab.env().register(XoxnoMock, ());
    lab.mint(&lab.f.asset, &ctl, 1_000 * UNIT);
    lab.adapter(AdapterKind::Xoxno, &ctl);
    lab.any(&ctl, "supply", 4);
    lab.any(&ctl, "borrow", 4);
    lab.any(&ctl, "repay", 3);
    lab.any(&ctl, "withdraw", 4);
    lab.mint(&lab.xlm, &lab.f.vault, 1_000 * UNIT);
    let xlm = HubAssetKey {
        asset: lab.xlm.clone(),
        hub_id: 1,
    };
    let usdc = HubAssetKey {
        asset: lab.f.asset.clone(),
        hub_id: 1,
    };
    let me = lab.f.vault.clone();
    let supply = |account: u64, amount: i128| {
        lab.call(
            &ctl,
            "supply",
            (
                me.clone(),
                account,
                1_u32,
                vec![lab.env(), (xlm.clone(), amount)],
            )
                .into_val(lab.env()),
        )
    };
    supply(0, 1_000 * UNIT).unwrap();
    let client = XoxnoMockClient::new(lab.env(), &ctl);
    assert_eq!(client.get_collateral_amount(&1, &xlm), 1_000 * UNIT);
    assert_eq!(lab.nav(), 1_200 * UNIT);
    // A second account would be invisible to the NAV.
    assert_eq!(supply(0, 10 * UNIT), Err(Error::DestinationNotVault));
    let borrow = |to: Option<Address>| {
        lab.call(
            &ctl,
            "borrow",
            (
                me.clone(),
                1_u64,
                vec![lab.env(), (usdc.clone(), 50 * UNIT)],
                to,
            )
                .into_val(lab.env()),
        )
    };
    assert_eq!(
        borrow(Some(lab.f.bob.clone())),
        Err(Error::DestinationNotVault)
    );
    borrow(None).unwrap();
    assert_eq!(lab.nav(), 1_200 * UNIT);
    // 1,000 XLM × 0.20 × 80% against 50 USDC.
    assert_eq!(
        lab.f.client().health_factor(),
        (200 * UNIT * i128::from(THRESHOLD) / 10_000) * 10_000 / (50 * UNIT)
    );
    // Repaying someone else's account would gift value away.
    assert_eq!(
        lab.call(
            &ctl,
            "repay",
            (me.clone(), 2_u64, vec![lab.env(), (usdc.clone(), UNIT)]).into_val(lab.env()),
        ),
        Err(Error::DestinationNotVault)
    );
    lab.call(
        &ctl,
        "repay",
        (
            me.clone(),
            1_u64,
            vec![lab.env(), (usdc.clone(), 20 * UNIT)],
        )
            .into_val(lab.env()),
    )
    .unwrap();
    assert_eq!(client.get_borrow_amount(&1, &usdc), 30 * UNIT);
    assert_eq!(lab.nav(), 1_200 * UNIT);
}

#[test]
fn withdrawal_exits_every_position_pro_rata_while_paused() {
    let lab = Lab::new();
    let f = &lab.f;
    f.deposit(&f.bob, 1_000 * UNIT);
    let (pool, _) = lab.blend();
    let df = lab.defindex();
    let (amm, share) = lab.aquarius();
    let ctl = lab.env().register(XoxnoMock, ());
    lab.adapter(AdapterKind::Xoxno, &ctl);
    lab.any(&ctl, "supply", 4);
    lab.mint(&lab.xlm, &f.vault, 1_000 * UNIT);
    lab.submit(&pool, vec![lab.env(), lab.request(&f.asset, 600 * UNIT, 0)])
        .unwrap();
    lab.df_deposit(&df, 600 * UNIT).unwrap();
    lab.lp_deposit(&amm, 100 * UNIT, 500 * UNIT).unwrap();
    let xlm_key = HubAssetKey {
        asset: lab.xlm.clone(),
        hub_id: 1,
    };
    lab.call(
        &ctl,
        "supply",
        (
            f.vault.clone(),
            0_u64,
            1_u32,
            vec![lab.env(), (xlm_key.clone(), 500 * UNIT)],
        )
            .into_val(lab.env()),
    )
    .unwrap();
    // 700 idle USDC + 600 Blend + 600 DeFindex + 200 LP + 100 XOXNO.
    assert_eq!(lab.nav(), 2_200 * UNIT);
    f.client().mock_all_auths().set_paused(&true);
    // The XLM airdrop was profit: fee shares already dilute both holders.
    let shares = f.client().balance(&f.alice) / 2;
    let supply = f.client().total_shares() + crate::shares::VIRTUAL_SHARES;
    let bob = f.client().balance(&f.bob);
    let bob_value = (2_200 * UNIT + 1) * bob / supply;
    let usdc_before = f.token_balance(&f.alice);
    let received = f.withdraw(&f.alice, shares);
    // About a quarter of every position leaves, less protocol rounding.
    let blend: Map<u32, i128> = BlendMockClient::new(lab.env(), &pool)
        .get_positions(&f.vault)
        .get(Symbol::new(lab.env(), "supply"))
        .unwrap()
        .into_val(lab.env());
    let remaining = |amount: i128| amount - amount * shares / supply;
    assert!((blend.get(3).unwrap() - remaining(600 * UNIT)).abs() <= 1);
    assert!(
        (DeFindexMockClient::new(lab.env(), &df).balance(&f.vault) - remaining(600 * UNIT)).abs()
            <= 1
    );
    assert!((lab.balance(&share, &f.vault) - remaining(100 * UNIT)).abs() <= 1);
    assert!(
        (XoxnoMockClient::new(lab.env(), &ctl).get_collateral_amount(&1, &xlm_key)
            - remaining(500 * UNIT))
        .abs()
            <= 1
    );
    // Alice is paid her NAV claim in base: the vault buys her XLM proceeds back at the oracle.
    assert_eq!(f.token_balance(&f.alice) - usdc_before, received);
    assert_eq!(lab.balance(&lab.xlm, &f.alice), 0);
    let entitlement = (2_200 * UNIT + 1) * shares / supply;
    assert!(
        received <= entitlement && entitlement - received <= 10,
        "{received}"
    );
    // Bob's shares keep their value.
    let left = f.client().total_shares() + crate::shares::VIRTUAL_SHARES;
    let bob_after = (lab.nav() + 1) * bob / left;
    assert!(bob_after >= bob_value - 2, "{bob_after} {bob_value}");
}

#[test]
fn leveraged_exit_redeems_only_what_idle_balances_can_repay() {
    let lab = Lab::new();
    let f = &lab.f;
    let (pool, _) = lab.blend();
    let df = lab.defindex();
    lab.mint(&lab.xlm, &f.vault, 2_000 * UNIT);
    lab.submit(
        &pool,
        vec![
            lab.env(),
            lab.request(&lab.xlm, 2_000 * UNIT, 2),
            lab.request(&f.asset, 200 * UNIT, 4),
        ],
    )
    .unwrap();
    lab.df_deposit(&df, 1_150 * UNIT).unwrap();
    // 50 idle USDC + 1,150 DeFindex + 400 XLM collateral − 200 USDC debt.
    assert_eq!(lab.nav(), 1_400 * UNIT);
    let shares = f.client().balance(&f.alice);
    let supply = f.client().total_shares() + crate::shares::VIRTUAL_SHARES;
    let received = f.withdraw(&f.alice, shares);
    let events = lab.env().events().all();
    // Only the part of the 200 USDC debt that 50 idle USDC (less rounding margin) repays.
    let redeemed = (50 * UNIT - 6) * supply / (200 * UNIT);
    assert_eq!(f.client().balance(&f.alice), shares - redeemed);
    assert!(events.events().contains(
        &Withdrawn {
            user: f.alice.clone(),
            amount: received,
            shares: redeemed,
        }
        .to_xdr(lab.env(), &f.vault)
    ));
    let debt: Map<u32, i128> = BlendMockClient::new(lab.env(), &pool)
        .get_positions(&f.vault)
        .get(Symbol::new(lab.env(), "liabilities"))
        .unwrap()
        .into_val(lab.env());
    let repaid = 200 * UNIT - debt.get(3).unwrap();
    assert!((repaid - (200 * UNIT * redeemed + supply - 1) / supply).abs() <= 1);
    assert!(lab.balance(&f.asset, &f.vault) <= 6);
    // Nothing left to repay with: the next attempt is refused rather than leaving others short.
    let rest = f.client().balance(&f.alice);
    assert_eq!(
        f.client()
            .mock_all_auths()
            .try_withdraw(&f.alice, &rest)
            .err(),
        Some(Ok(Error::RepaymentUnavailable))
    );
}

#[test]
fn leveraged_exit_sells_collateral_to_repay_its_debt() {
    let lab = Lab::new();
    let f = &lab.f;
    let (pool, _) = lab.blend();
    let df = lab.defindex();
    lab.mint(&lab.xlm, &f.vault, 2_000 * UNIT);
    lab.submit(
        &pool,
        vec![
            lab.env(),
            lab.request(&lab.xlm, 2_000 * UNIT, 2),
            lab.request(&f.asset, 200 * UNIT, 4),
        ],
    )
    .unwrap();
    lab.df_deposit(&df, 1_150 * UNIT).unwrap();
    // The vault's Soroswap pair pays the oracle rate: 0.2 USDC per XLM.
    let pair = lab.env().register(PairMock, (UNIT / 5,));
    lab.mint(&f.asset, &pair, 10_000 * UNIT);
    let router = lab.env().register(SoroswapRouterMock, (pair.clone(),));
    lab.adapter(AdapterKind::Soroswap, &router);
    f.update_policy(|policy| {
        policy
            .guards
            .set(router.clone(), vec![lab.env(), pair.clone()])
    });
    let nav = lab.nav();
    assert_eq!(nav, 1_400 * UNIT);
    let shares = f.client().balance(&f.alice);
    let held = |lab: &Lab| lab.balance(&f.asset, &f.alice) + lab.balance(&lab.xlm, &f.alice) / 5;
    let before = held(&lab);
    // 50 idle USDC cannot repay 200 of debt: the exit sells collateral instead of stopping short.
    f.withdraw(&f.alice, shares);
    assert_eq!(f.client().balance(&f.alice), 0);
    // Performance-fee shares minted on exit stay; the debt left is exactly theirs.
    let remaining = f.client().total_shares() + crate::shares::VIRTUAL_SHARES;
    let supply = remaining + shares;
    let debt: Map<u32, i128> = BlendMockClient::new(lab.env(), &pool)
        .get_positions(&f.vault)
        .get(Symbol::new(lab.env(), "liabilities"))
        .unwrap()
        .into_val(lab.env());
    let left = debt.get(3).unwrap_or(0);
    assert!(
        (left - 200 * UNIT * remaining / supply).abs() <= 2,
        "{left}"
    );
    // Paid in USDC, the rest in XLM at the oracle price: the holder's full share of NAV.
    let received = held(&lab) - before;
    let entitled = nav * shares / supply;
    assert!(
        (received - entitled).abs() <= UNIT / 100,
        "{received} vs {entitled}"
    );
}

#[test]
fn strained_leveraged_exit_falls_back_to_what_idle_balances_repay() {
    let lab = Lab::new();
    let f = &lab.f;
    let (pool, _) = lab.blend();
    let df = lab.defindex();
    lab.mint(&lab.xlm, &f.vault, 2_000 * UNIT);
    lab.submit(
        &pool,
        vec![
            lab.env(),
            lab.request(&lab.xlm, 2_000 * UNIT, 2),
            lab.request(&f.asset, 200 * UNIT, 4),
        ],
    )
    .unwrap();
    lab.df_deposit(&df, 1_150 * UNIT).unwrap();
    let pair = lab.env().register(PairMock, (UNIT / 5,));
    lab.mint(&f.asset, &pair, 10_000 * UNIT);
    let router = lab.env().register(SoroswapRouterMock, (pair.clone(),));
    lab.adapter(AdapterKind::Soroswap, &router);
    f.update_policy(|policy| {
        policy
            .guards
            .set(router.clone(), vec![lab.env(), pair.clone()])
    });
    // Near liquidation, Blend refuses to release collateral on its own: the exit must not
    // revert, it redeems what the 50 idle USDC can repay, as without a router.
    BlendMockClient::new(lab.env(), &pool).set_strained(&true);
    let shares = f.client().balance(&f.alice);
    let supply = f.client().total_shares() + crate::shares::VIRTUAL_SHARES;
    f.withdraw(&f.alice, shares);
    let redeemed = (50 * UNIT - 6) * supply / (200 * UNIT);
    assert_eq!(f.client().balance(&f.alice), shares - redeemed);
    assert_eq!(lab.balance(&lab.xlm, &pair), 0);
}

#[test]
fn leveraged_exit_keeps_the_collateral_when_the_swap_misses_its_minimum() {
    let lab = Lab::new();
    let f = &lab.f;
    let (pool, _) = lab.blend();
    let df = lab.defindex();
    lab.mint(&lab.xlm, &f.vault, 2_000 * UNIT);
    lab.submit(
        &pool,
        vec![
            lab.env(),
            lab.request(&lab.xlm, 2_000 * UNIT, 2),
            lab.request(&f.asset, 200 * UNIT, 4),
        ],
    )
    .unwrap();
    lab.df_deposit(&df, 1_150 * UNIT).unwrap();
    // The pair pays 10 % under the oracle: below the exit's 3 % minimum.
    let pair = lab.env().register(PairMock, (UNIT * 18 / 100,));
    lab.mint(&f.asset, &pair, 10_000 * UNIT);
    let router = lab.env().register(SoroswapRouterMock, (pair.clone(),));
    lab.adapter(AdapterKind::Soroswap, &router);
    f.update_policy(|policy| {
        policy
            .guards
            .set(router.clone(), vec![lab.env(), pair.clone()])
    });
    let nav = lab.nav();
    let shares = f.client().balance(&f.alice);
    let supply = f.client().total_shares() + crate::shares::VIRTUAL_SHARES;
    // The failed swap is rolled back and the exit falls back to what 50 idle USDC repays.
    f.withdraw(&f.alice, shares);
    let redeemed = (50 * UNIT - 6) * supply / (200 * UNIT);
    assert_eq!(f.client().balance(&f.alice), shares - redeemed);
    assert_eq!(lab.balance(&lab.xlm, &pair), 0);
    // Nothing was sold below the oracle: those who stay keep their share of NAV.
    let left = supply - redeemed;
    assert!((lab.nav() - nav * left / supply).abs() <= UNIT / 100);
}

#[test]
fn adapters_are_limited_to_allowlisted_protocols_and_bounded_positions() {
    let lab = Lab::new();
    let f = &lab.f;
    let stranger = Address::generate(lab.env());
    assert_eq!(
        f.client()
            .mock_all_auths()
            .try_set_adapter(&AdapterKind::Blend, &stranger)
            .err(),
        Some(Ok(Error::ProtocolNotAllowed))
    );
    let (pool, _) = lab.blend();
    assert_eq!(
        f.client()
            .mock_all_auths()
            .try_set_adapter(&AdapterKind::DeFindex, &pool)
            .err(),
        Some(Ok(Error::AdapterInUse))
    );
    for _ in 1..MAX_POSITIONS {
        lab.defindex();
    }
    let router = lab.env().register(SoroswapRouterMock, (pool.clone(),));
    // Swap venues hold no position and do not count.
    lab.adapter(AdapterKind::Soroswap, &router);
    let extra = lab.env().register(DeFindexMock, (f.asset.clone(),));
    f.allow_protocol(&extra);
    assert_eq!(
        f.client()
            .mock_all_auths()
            .try_set_adapter(&AdapterKind::DeFindex, &extra)
            .err(),
        Some(Ok(Error::TooManyPositions))
    );
    // A position holding value cannot disappear from the NAV.
    lab.submit(&pool, vec![lab.env(), lab.request(&f.asset, UNIT, 0)])
        .unwrap();
    assert_eq!(
        f.client().mock_all_auths().try_remove_adapter(&pool).err(),
        Some(Ok(Error::AdapterInUse))
    );
    f.client().mock_all_auths().remove_adapter(&router);
    assert_eq!(f.client().adapters().len(), MAX_POSITIONS);
    assert!(f.client().try_remove_adapter(&pool).is_err());
}
