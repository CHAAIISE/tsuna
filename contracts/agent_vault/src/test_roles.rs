extern crate std;

use crate::{
    adapters::blend::Request,
    test::{outcome, Fixture, UNIT},
    testutils::{blend::BlendMockClient, Skimmer},
    Error, Executed, RoleExecuted,
};
use oracle_router::{testutils::MockReflectorClient, Feed, OracleRouterClient, ReflectorAsset};
use policy_registry::{ArgRule, CallRule, PolicyChange, Quota, Role, RoleMode};
use soroban_sdk::{
    contract, contractimpl, map,
    testutils::{Address as _, Events, Ledger, MockAuth, MockAuthInvoke},
    token, vec, Address, Env, Event, IntoVal, Map, Symbol, Val, Vec,
};

const SUBMIT: &str = "submit_with_allowance";
const START: u64 = 1_800_000_000;
/// One USD with Reflector's 14 decimals.
const R_USD: i128 = 100_000_000_000_000;

/// Takes an approved amount of one asset and pays a fixed amount of another back.
#[contract]
struct Swapper;

#[contractimpl]
impl Swapper {
    pub fn swap(
        env: Env,
        asset_in: Address,
        from: Address,
        amount_in: i128,
        asset_out: Address,
        amount_out: i128,
    ) {
        let me = env.current_contract_address();
        token::Client::new(&env, &asset_in).transfer_from(&me, &from, &me, &amount_in);
        token::Client::new(&env, &asset_out).transfer(&me, &from, &amount_out);
    }
}

/// A vault with 1,000 USDC of Blend collateral and 600 USDC borrowed and held idle
/// (health factor 1.35), plus a RiskOff role held by `keeper`.
struct Desk {
    f: Fixture,
    pool: Address,
    keeper: Address,
}

impl Desk {
    fn new() -> Self {
        let f = Fixture::new();
        f.env.cost_estimate().budget().reset_unlimited();
        f.deposit(&f.alice, 1_000 * UNIT);
        let pool = f.invest(1_000 * UNIT, 2);
        f.submit(&pool, 600 * UNIT, 4).unwrap();
        let desk = Self {
            keeper: Address::generate(&f.env),
            f,
            pool,
        };
        desk.grant("riskoff", &desk.role(&desk.keeper, RoleMode::RiskOff));
        desk
    }

    fn env(&self) -> &Env {
        &self.f.env
    }

    fn symbol(&self, name: &str) -> Symbol {
        Symbol::new(self.env(), name)
    }

    fn quota(&self) -> Quota {
        Quota {
            tx_cap_bps: 10_000,
            daily_cap_bps: 100_000,
            calls_per_hour: 10,
            daily_loss_bps: 50,
        }
    }

    /// May submit any Blend request to the pool: the outcome decides what a RiskOff role may do.
    fn role(&self, member: &Address, mode: RoleMode) -> Role {
        Role {
            member: member.clone(),
            mode,
            calls: map![
                self.env(),
                (
                    (self.pool.clone(), self.symbol(SUBMIT)),
                    CallRule {
                        args: vec![
                            self.env(),
                            ArgRule::Vault,
                            ArgRule::Vault,
                            ArgRule::Vault,
                            ArgRule::BlendRequests,
                        ],
                        max_loss_bps: 5,
                        approve: true,
                    }
                )
            ],
            quota: self.quota(),
        }
    }

    /// Adds or changes a role, going through `apply_policy` when it widens (no timelock here).
    fn grant(&self, name: &str, role: &Role) {
        let registry = self.f.registry_client();
        if let PolicyChange::Proposed(_) =
            registry
                .mock_all_auths()
                .propose_role(&self.f.vault, &self.symbol(name), role)
        {
            registry.mock_all_auths().apply_policy(&self.f.vault);
        }
    }

    fn pause(&self, paused: bool) {
        self.f.client().mock_all_auths().set_paused(&paused);
    }

    fn requests(&self, requests: &[(i128, u32)]) -> Vec<Val> {
        let mut list = Vec::new(self.env());
        for (amount, request_type) in requests {
            list.push_back(Request {
                address: self.f.asset.clone(),
                amount: *amount,
                request_type: *request_type,
            });
        }
        let me = self.f.vault.clone();
        (me.clone(), me.clone(), me, list).into_val(self.env())
    }

    /// `execute_as` signed by `member` only.
    fn act_on(
        &self,
        member: &Address,
        role: &str,
        target: &Address,
        fn_name: &str,
        args: Vec<Val>,
    ) -> Result<(), Error> {
        let role = self.symbol(role);
        let fn_name = self.symbol(fn_name);
        outcome(
            self.f
                .client()
                .mock_auths(&[MockAuth {
                    address: member,
                    invoke: &MockAuthInvoke {
                        contract: &self.f.vault,
                        fn_name: "execute_as",
                        args: (
                            member.clone(),
                            role.clone(),
                            target.clone(),
                            fn_name.clone(),
                            args.clone(),
                        )
                            .into_val(self.env()),
                        sub_invokes: &[],
                    },
                }])
                .try_execute_as(member, &role, target, &fn_name, &args),
        )
    }

    fn act(&self, member: &Address, role: &str, requests: &[(i128, u32)]) -> Result<(), Error> {
        self.act_on(member, role, &self.pool, SUBMIT, self.requests(requests))
    }

    /// `execute` signed by the session key only.
    fn execute(&self, requests: &[(i128, u32)]) -> Result<(), Error> {
        let fn_name = self.symbol(SUBMIT);
        let args = self.requests(requests);
        outcome(
            self.f
                .client()
                .mock_auths(&[MockAuth {
                    address: &self.f.agent,
                    invoke: &MockAuthInvoke {
                        contract: &self.f.vault,
                        fn_name: "execute",
                        args: (self.pool.clone(), fn_name.clone(), args.clone())
                            .into_val(self.env()),
                        sub_invokes: &[],
                    },
                }])
                .try_execute(&self.pool, &fn_name, &args),
        )
    }

    fn debt(&self) -> i128 {
        let positions = BlendMockClient::new(self.env(), &self.pool).get_positions(&self.f.vault);
        let debt: Map<u32, i128> = positions
            .get(self.symbol("liabilities"))
            .unwrap()
            .into_val(self.env());
        debt.get(crate::testutils::blend::BASE_INDEX).unwrap_or(0)
    }

    fn published(&self, event: impl Event) -> bool {
        self.env()
            .events()
            .all()
            .events()
            .contains(&event.to_xdr(self.env(), &self.f.vault))
    }
}

#[test]
fn risk_off_repays_while_paused() {
    let d = Desk::new();
    d.pause(true);
    let health = d.f.client().health_factor();
    let default_usage = d.f.client().usage();

    d.act(&d.keeper, "riskoff", &[(300 * UNIT, 5)]).unwrap();

    assert!(d.published(RoleExecuted {
        role: d.symbol("riskoff"),
        target: d.pool.clone(),
        fn_name: d.symbol(SUBMIT),
        nav_before: 1_000 * UNIT,
        nav_after: 1_000 * UNIT,
    }));
    assert_eq!(d.debt(), 300 * UNIT);
    assert_eq!(d.f.token_balance(&d.f.vault), 300 * UNIT);
    assert!(d.f.client().health_factor() > health);
    assert_eq!(d.f.client().nav(), 1_000 * UNIT);
    assert_eq!(
        token::Client::new(d.env(), &d.f.asset).allowance(&d.f.vault, &d.pool),
        0
    );
    assert!(d.f.client().paused());
    // The role's budget is its own: the default role's counters did not move.
    assert_eq!(d.f.client().role_usage(&d.symbol("riskoff")).calls, 1);
    assert_eq!(d.f.client().usage(), default_usage);

    // Once the debt is cleared, withdrawing collateral no longer lowers the health factor.
    d.act(&d.keeper, "riskoff", &[(300 * UNIT, 5)]).unwrap();
    assert_eq!(d.debt(), 0);
    assert_eq!(d.f.client().health_factor(), i128::MAX);
    d.act(&d.keeper, "riskoff", &[(400 * UNIT, 3)]).unwrap();
    assert_eq!(d.f.token_balance(&d.f.vault), 400 * UNIT);
}

#[test]
fn risk_off_cannot_increase_exposure() {
    let d = Desk::new();
    d.pause(true);
    let health = d.f.client().health_factor();
    for requests in [
        // More collateral: the pool's exposure grows.
        &[(100 * UNIT, 2)][..],
        // More supply.
        &[(100 * UNIT, 0)][..],
        // New debt: the health factor falls.
        &[(50 * UNIT, 4)][..],
        // Collateral out while in debt: the health factor falls.
        &[(50 * UNIT, 3)][..],
        // A repayment does not pay for a larger position in the same submission.
        &[(300 * UNIT, 5), (100 * UNIT, 2)][..],
    ] {
        assert_eq!(
            d.act(&d.keeper, "riskoff", requests),
            Err(Error::RiskIncreased),
            "{requests:?}"
        );
    }
    assert_eq!(d.debt(), 600 * UNIT);
    assert_eq!(d.f.client().health_factor(), health);
    assert_eq!(d.f.client().role_usage(&d.symbol("riskoff")).calls, 0);

    // The outcome checks hold whether or not the vault is paused. A small loan keeps the
    // health factor above the floor: within the default role's rules, not the RiskOff ones.
    d.pause(false);
    assert_eq!(
        d.act(&d.keeper, "riskoff", &[(10 * UNIT, 4)]),
        Err(Error::RiskIncreased)
    );
    d.execute(&[(10 * UNIT, 4)]).unwrap();
}

#[test]
fn risk_off_cannot_swap_into_another_asset() {
    let f = Fixture::new();
    f.env.cost_estimate().budget().reset_unlimited();
    f.env.ledger().set_timestamp(START);
    let xlm = f
        .env
        .register_stellar_asset_contract_v2(f.owner.clone())
        .address();
    f.set_assets(vec![&f.env, f.asset.clone(), xlm.clone()]);
    let router = OracleRouterClient::new(&f.env, &f.oracle);
    let reflector = MockReflectorClient::new(&f.env, &f.reflector);
    // USDC at 1 USD, XLM at 0.20 USD.
    for (asset, ticker, price) in [(&f.asset, "USDC", R_USD), (&xlm, "XLM", R_USD / 5)] {
        router.mock_all_auths().set_feed(
            asset,
            &Feed {
                reflector: ReflectorAsset::Other(Symbol::new(&f.env, ticker)),
                chainlink: None,
            },
        );
        reflector.push(
            &ReflectorAsset::Other(Symbol::new(&f.env, ticker)),
            &price,
            &START,
        );
    }
    f.deposit(&f.alice, 1_000 * UNIT);
    let swapper = f.env.register(Swapper, ());
    token::StellarAssetClient::new(&f.env, &xlm)
        .mock_all_auths()
        .mint(&swapper, &(10_000 * UNIT));
    let rule = CallRule {
        args: vec![
            &f.env,
            ArgRule::Any,
            ArgRule::Vault,
            ArgRule::Amount,
            ArgRule::Any,
            ArgRule::Any,
        ],
        max_loss_bps: 50,
        approve: true,
    };
    let swap = (swapper.clone(), Symbol::new(&f.env, "swap"));
    f.update_policy(|policy| policy.calls.set(swap.clone(), rule.clone()));
    let keeper = Address::generate(&f.env);
    let role = Role {
        member: keeper.clone(),
        mode: RoleMode::RiskOff,
        calls: map![&f.env, (swap.clone(), rule)],
        quota: Quota {
            tx_cap_bps: 10_000,
            daily_cap_bps: 100_000,
            calls_per_hour: 10,
            daily_loss_bps: 50,
        },
    };
    let riskoff = Symbol::new(&f.env, "riskoff");
    let registry = f.registry_client();
    registry
        .mock_all_auths()
        .propose_role(&f.vault, &riskoff, &role);
    registry.mock_all_auths().apply_policy(&f.vault);
    // 100 USDC for 500 XLM: a fair trade that keeps NAV but leaves the base asset.
    let args: Vec<Val> = (
        f.asset.clone(),
        f.vault.clone(),
        100 * UNIT,
        xlm.clone(),
        500 * UNIT,
    )
        .into_val(&f.env);
    let as_keeper = || {
        outcome(
            f.client()
                .mock_all_auths()
                .try_execute_as(&keeper, &riskoff, &swapper, &swap.1, &args),
        )
    };

    // XLM is a new asset for the vault.
    assert_eq!(as_keeper(), Err(Error::RiskIncreased));
    f.client()
        .mock_all_auths()
        .execute(&swapper, &swap.1, &args);
    assert_eq!(f.client().nav(), 1_000 * UNIT);
    // Once XLM is held, buying more still moves value out of the base asset.
    assert_eq!(as_keeper(), Err(Error::RiskIncreased));
    assert_eq!(
        token::Client::new(&f.env, &xlm).balance(&f.vault),
        500 * UNIT
    );
}

#[test]
fn risk_off_cannot_move_value_out() {
    let d = Desk::new();
    d.pause(true);
    let attacker = Address::generate(d.env());

    // A compromised pool books the repayment but keeps the funds elsewhere: Blend's own
    // accounting still shows the same NAV, the token balances do not.
    BlendMockClient::new(d.env(), &d.pool).set_sink(&attacker);
    assert_eq!(
        d.act(&d.keeper, "riskoff", &[(300 * UNIT, 5)]),
        Err(Error::RiskIncreased)
    );
    assert_eq!(d.f.token_balance(&attacker), 0);
    assert_eq!(d.debt(), 600 * UNIT);

    // A protocol that skims more than the rule's tolerance loses NAV.
    let skimmer = d.env().register(Skimmer, ());
    let skim = (skimmer.clone(), d.symbol("skim"));
    let mut role = d.role(&d.keeper, RoleMode::RiskOff);
    role.calls.set(
        skim.clone(),
        CallRule {
            args: vec![
                d.env(),
                ArgRule::Any,
                ArgRule::Vault,
                ArgRule::Amount,
                ArgRule::Any,
            ],
            max_loss_bps: 5,
            approve: true,
        },
    );
    d.grant("riskoff", &role);
    let args: Vec<Val> = (
        d.f.asset.clone(),
        d.f.vault.clone(),
        500 * UNIT,
        attacker.clone(),
    )
        .into_val(d.env());
    assert_eq!(
        d.act_on(&d.keeper, "riskoff", &skimmer, "skim", args),
        Err(Error::RiskIncreased)
    );
    assert_eq!(d.f.token_balance(&attacker), 0);

    // Calls outside the role's allowlist are refused before running.
    let transfer: Vec<Val> = (d.f.vault.clone(), attacker.clone(), 100 * UNIT).into_val(d.env());
    assert_eq!(
        d.act_on(&d.keeper, "riskoff", &d.f.asset, "transfer", transfer),
        Err(Error::CallNotAllowed)
    );
    assert_eq!(d.f.token_balance(&d.f.vault), 600 * UNIT);
}

#[test]
fn default_role_blocked_while_paused() {
    let d = Desk::new();
    let trader = Address::generate(d.env());
    d.grant("trader", &d.role(&trader, RoleMode::Normal));
    d.pause(true);

    assert_eq!(d.execute(&[(100 * UNIT, 5)]), Err(Error::Paused));
    assert_eq!(
        d.act(&d.f.agent, "default", &[(100 * UNIT, 5)]),
        Err(Error::Paused)
    );
    assert_eq!(
        d.act(&trader, "trader", &[(100 * UNIT, 5)]),
        Err(Error::Paused)
    );
    d.act(&d.keeper, "riskoff", &[(100 * UNIT, 5)]).unwrap();

    d.pause(false);
    d.execute(&[(100 * UNIT, 5)]).unwrap();
    d.act(&trader, "trader", &[(100 * UNIT, 5)]).unwrap();
    assert_eq!(d.debt(), 300 * UNIT);
}

#[test]
fn execute_is_the_default_role() {
    let d = Desk::new();
    let before = d.f.client().usage();

    // Same rules, same counters, same event for both entry points.
    d.execute(&[(10 * UNIT, 5)]).unwrap();
    d.act(&d.f.agent, "default", &[(10 * UNIT, 5)]).unwrap();
    assert!(d.published(Executed {
        target: d.pool.clone(),
        fn_name: d.symbol(SUBMIT),
        nav_before: 1_000 * UNIT,
        nav_after: 1_000 * UNIT,
    }));
    let usage = d.f.client().usage();
    assert_eq!(usage.calls, before.calls + 2);
    assert_eq!(d.f.client().role_usage(&d.symbol("default")), usage);
    assert_eq!(d.f.client().role_usage(&d.symbol("riskoff")).calls, 0);
    // The default role's rules are the policy's own: its health-factor floor still applies.
    assert_eq!(
        d.act(&d.f.agent, "default", &[(100 * UNIT, 4)]),
        Err(Error::HealthFactorTooLow)
    );
    let transfer: Vec<Val> = (d.f.vault.clone(), d.f.bob.clone(), UNIT).into_val(d.env());
    assert_eq!(
        d.act_on(&d.f.agent, "default", &d.f.asset, "transfer", transfer),
        Err(Error::CallNotAllowed)
    );

    // The session key's lifecycle drives the default role.
    let next = Address::generate(d.env());
    d.f.client().mock_all_auths().revoke_session();
    assert_eq!(
        d.act(&d.f.agent, "default", &[(10 * UNIT, 5)]),
        Err(Error::SessionRevoked)
    );
    d.f.client().mock_all_auths().rotate_session(&next);
    assert_eq!(
        d.act(&d.f.agent, "default", &[(10 * UNIT, 5)]),
        Err(Error::NotRoleMember)
    );
    d.act(&next, "default", &[(10 * UNIT, 5)]).unwrap();
    assert_eq!(d.debt(), 570 * UNIT);
}

#[test]
fn roles_are_reserved_to_their_member() {
    let d = Desk::new();
    d.pause(true);
    // The session key holds the default role, not the RiskOff one, and vice versa.
    assert_eq!(
        d.act(&d.f.agent, "riskoff", &[(10 * UNIT, 5)]),
        Err(Error::NotRoleMember)
    );
    d.pause(false);
    assert_eq!(
        d.act(&d.keeper, "default", &[(10 * UNIT, 5)]),
        Err(Error::NotRoleMember)
    );
    assert_eq!(
        d.act(&d.keeper, "ghost", &[(10 * UNIT, 5)]),
        Err(Error::RoleNotFound)
    );

    // Naming the member is not enough: the member must sign.
    let role = d.symbol("riskoff");
    let fn_name = d.symbol(SUBMIT);
    let args = d.requests(&[(10 * UNIT, 5)]);
    assert!(matches!(
        d.f.client()
            .try_execute_as(&d.keeper, &role, &d.pool, &fn_name, &args),
        Err(Err(_))
    ));
    let signed_by_agent =
        d.f.client()
            .mock_auths(&[MockAuth {
                address: &d.f.agent,
                invoke: &MockAuthInvoke {
                    contract: &d.f.vault,
                    fn_name: "execute_as",
                    args: (
                        d.keeper.clone(),
                        role.clone(),
                        d.pool.clone(),
                        fn_name.clone(),
                        args.clone(),
                    )
                        .into_val(d.env()),
                    sub_invokes: &[],
                },
            }])
            .try_execute_as(&d.keeper, &role, &d.pool, &fn_name, &args);
    assert!(matches!(signed_by_agent, Err(Err(_))));
    assert_eq!(d.debt(), 600 * UNIT);
}

#[test]
fn role_quotas_are_counted_apart() {
    let d = Desk::new();
    let mut role = d.role(&d.keeper, RoleMode::RiskOff);
    role.quota.calls_per_hour = 1;
    role.quota.tx_cap_bps = 100;
    d.grant("riskoff", &role);

    // 1% of a 1,000 NAV.
    assert_eq!(
        d.act(&d.keeper, "riskoff", &[(10 * UNIT + 1, 5)]),
        Err(Error::TxCapExceeded)
    );
    d.act(&d.keeper, "riskoff", &[(10 * UNIT, 5)]).unwrap();
    assert_eq!(
        d.act(&d.keeper, "riskoff", &[(10 * UNIT, 5)]),
        Err(Error::RateLimited)
    );
    // The default role's budget is untouched and still larger.
    d.execute(&[(100 * UNIT, 5)]).unwrap();
    assert_eq!(d.f.client().usage().calls, 3);
    assert_eq!(d.f.client().role_usage(&d.symbol("riskoff")).calls, 1);
    assert_eq!(d.f.client().role_daily_loss(&d.symbol("riskoff")), 0);

    // A new hour resets the role's rate limit.
    d.env()
        .ledger()
        .with_mut(|ledger| ledger.timestamp += 3_600);
    d.act(&d.keeper, "riskoff", &[(10 * UNIT, 5)]).unwrap();
}

#[test]
fn role_acts_once_applied_and_stops_when_revoked() {
    let d = Desk::new();
    let trader = Address::generate(d.env());
    let name = d.symbol("trader");
    let registry = d.f.registry_client();
    // Adding a role is a loosening: until applied, the vault does not know it.
    assert!(matches!(
        registry.mock_all_auths().propose_role(
            &d.f.vault,
            &name,
            &d.role(&trader, RoleMode::Normal)
        ),
        PolicyChange::Proposed(_)
    ));
    assert_eq!(
        d.act(&trader, "trader", &[(10 * UNIT, 5)]),
        Err(Error::RoleNotFound)
    );
    registry.mock_all_auths().apply_policy(&d.f.vault);
    d.act(&trader, "trader", &[(10 * UNIT, 5)]).unwrap();

    registry.mock_all_auths().revoke_role(&d.f.vault, &name);
    assert_eq!(
        d.act(&trader, "trader", &[(10 * UNIT, 5)]),
        Err(Error::RoleNotFound)
    );
    // Revoking one role leaves the others in force.
    d.act(&d.keeper, "riskoff", &[(10 * UNIT, 5)]).unwrap();
}
