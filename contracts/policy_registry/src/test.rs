extern crate std;

use soroban_sdk::{
    contract, contractimpl, contracttype, map, symbol_short,
    testutils::{Address as _, Events, Ledger},
    vec, Address, Env, Event, Map, Symbol, Val,
};

use crate::{
    contract::Key, ArgRule, CallRule, Error, Limits, PolicyApplied, PolicyChange, PolicyProposed,
    PolicyRegistry, PolicyRegistryClient, PolicyTightened, PolicyV1, PolicyV2, Quota, Role,
    RoleApplied, RoleMode, RoleNarrowed, RoleProposed, RoleRevoked,
};

const TIMELOCK: u64 = 600;
const START: u64 = 1_000_000;

#[contracttype]
enum VaultKey {
    Owner,
    Asset,
    Shares,
}

/// The vault surface the registry reads when a vault registers.
#[contract]
struct MockVault;

#[contractimpl]
impl MockVault {
    pub fn __constructor(env: Env, owner: Address, asset: Address) {
        env.storage().instance().set(&VaultKey::Owner, &owner);
        env.storage().instance().set(&VaultKey::Asset, &asset);
        env.storage().instance().set(&VaultKey::Shares, &0_i128);
    }

    pub fn owner(env: Env) -> Address {
        env.storage().instance().get(&VaultKey::Owner).unwrap()
    }

    pub fn asset(env: Env) -> Address {
        env.storage().instance().get(&VaultKey::Asset).unwrap()
    }

    pub fn total_shares(env: Env) -> i128 {
        env.storage().instance().get(&VaultKey::Shares).unwrap()
    }

    pub fn set_total_shares(env: Env, shares: i128) {
        env.storage().instance().set(&VaultKey::Shares, &shares);
    }
}

struct Setup {
    env: Env,
    registry: Address,
    vault: Address,
    owner: Address,
    asset: Address,
    pool: Address,
}

impl Setup {
    /// A registered vault that already holds deposits.
    fn new() -> Self {
        let env = Env::default();
        env.ledger().with_mut(|ledger| ledger.timestamp = START);
        let registry = env.register(PolicyRegistry, (TIMELOCK,));
        let owner = Address::generate(&env);
        let asset = Address::generate(&env);
        let pool = Address::generate(&env);
        let vault = env.register(MockVault, (owner.clone(), asset.clone()));
        let s = Self {
            env,
            registry,
            vault,
            owner,
            asset,
            pool,
        };
        s.client().mock_all_auths().register(&s.vault, &s.policy());
        MockVaultClient::new(&s.env, &s.vault).set_total_shares(&1_000);
        s
    }

    fn client(&self) -> PolicyRegistryClient<'_> {
        PolicyRegistryClient::new(&self.env, &self.registry)
    }

    fn submit(&self) -> (Address, Symbol) {
        (self.pool.clone(), symbol_short!("submit"))
    }

    fn policy(&self) -> PolicyV2 {
        let env = &self.env;
        PolicyV2 {
            calls: map![
                env,
                (
                    self.submit(),
                    CallRule {
                        args: vec![env, ArgRule::Vault, ArgRule::Any, ArgRule::BlendRequests],
                        max_loss_bps: 10,
                        approve: false,
                    }
                )
            ],
            protocols: vec![env, self.pool.clone()],
            guards: map![env, (self.pool.clone(), vec![env, self.pool.clone()])],
            assets: vec![env, self.asset.clone()],
            limits: Limits::default(),
            exposure_caps: None,
            roles: None,
        }
    }

    fn current(&self) -> PolicyV2 {
        self.client().policy(&self.vault).unwrap()
    }

    fn propose(&self, policy: &PolicyV2) -> PolicyChange {
        self.client()
            .mock_all_auths()
            .propose_policy(&self.vault, policy)
    }

    fn apply(&self) -> Result<(), Error> {
        self.client()
            .mock_all_auths()
            .try_apply_policy(&self.vault)
            .map(|_| ())
            .map_err(|error| error.unwrap())
    }

    fn warp(&self, timestamp: u64) {
        self.env
            .ledger()
            .with_mut(|ledger| ledger.timestamp = timestamp);
    }

    fn last_event_is(&self, event: impl Event) {
        assert_eq!(
            self.env.events().all().events().last().unwrap(),
            &event.to_xdr(&self.env, &self.registry)
        );
    }
}

#[test]
fn v1_entry_read_as_v2() {
    let s = Setup::new();
    let current = s.policy();
    let v1 = PolicyV1 {
        calls: current.calls.clone(),
        protocols: current.protocols.clone(),
        guards: current.guards.clone(),
        assets: current.assets.clone(),
        limits: current.limits.clone(),
    };
    let key = Key::Policy(s.vault.clone());
    s.env.as_contract(&s.registry, || {
        s.env.storage().persistent().set(&key, &v1);
        let raw: Map<Symbol, Val> = s.env.storage().persistent().get(&key).unwrap();
        assert!(!raw.contains_key(Symbol::new(&s.env, "exposure_caps")));
    });

    assert_eq!(s.current(), current);
    assert_eq!(s.current().exposure_caps, None);
    assert_eq!(s.current().exposure_cap(&s.pool), 5_000);

    // The v2 field can be set on top of a v1 entry; capping a protocol below the global cap tightens.
    let mut capped = current.clone();
    capped.exposure_caps = Some(map![&s.env, (s.pool.clone(), 3_000)]);
    assert_eq!(s.propose(&capped), PolicyChange::Tightened);
    assert_eq!(s.current().exposure_cap(&s.pool), 3_000);
}

#[test]
fn tighten_is_immediate() {
    let s = Setup::new();
    let base = s.policy();
    let mut loosened = base.clone();
    loosened.limits.calls_per_hour += 1;
    assert!(matches!(s.propose(&loosened), PolicyChange::Proposed(_)));

    let mut tightened = base.clone();
    tightened.calls = Map::new(&s.env);
    tightened.protocols = vec![&s.env];
    tightened.guards = Map::new(&s.env);
    tightened.limits.tx_cap_bps = 1_000;
    tightened.limits.daily_loss_bps = 20;
    tightened.limits.min_health_factor_bps = 15_000;
    tightened.exposure_caps = Some(map![&s.env, (s.pool.clone(), 0)]);
    assert_eq!(s.propose(&tightened), PolicyChange::Tightened);
    s.last_event_is(PolicyTightened {
        vault: s.vault.clone(),
    });
    assert_eq!(s.current(), tightened);
    // A tightening supersedes the pending loosening, which could otherwise undo it.
    assert_eq!(s.client().pending_policy(&s.vault), None);

    let s = Setup::new();
    let mut constrained = s.policy();
    let mut rule = constrained.rule(&s.pool, &symbol_short!("submit")).unwrap();
    rule.args.set(1, ArgRule::Vault);
    rule.max_loss_bps = 5;
    constrained.calls.set(s.submit(), rule);
    assert_eq!(s.propose(&constrained), PolicyChange::Tightened);
    assert_eq!(s.current(), constrained);
}

#[test]
fn loosen_requires_timelock() {
    let s = Setup::new();
    let base = s.policy();
    let other = Address::generate(&s.env);
    let mut variants = std::vec::Vec::new();
    let mut p = base.clone();
    p.protocols.push_back(other.clone());
    variants.push(p);
    let mut p = base.clone();
    p.assets.push_back(other.clone());
    variants.push(p);
    let mut p = base.clone();
    p.calls.set(
        (other.clone(), symbol_short!("swap")),
        CallRule {
            args: vec![&s.env],
            max_loss_bps: 0,
            approve: false,
        },
    );
    variants.push(p);
    let mut p = base.clone();
    p.guards
        .set(s.pool.clone(), vec![&s.env, s.pool.clone(), other]);
    variants.push(p);
    let mut p = base.clone();
    let mut rule = p.rule(&s.pool, &symbol_short!("submit")).unwrap();
    rule.max_loss_bps = 50;
    p.calls.set(s.submit(), rule);
    variants.push(p);
    let mut p = base.clone();
    let mut rule = p.rule(&s.pool, &symbol_short!("submit")).unwrap();
    rule.approve = true;
    p.calls.set(s.submit(), rule);
    variants.push(p);
    let mut p = base.clone();
    p.limits.daily_cap_bps += 1;
    variants.push(p);
    let mut p = base.clone();
    p.limits.min_health_factor_bps = 11_000;
    variants.push(p);
    let mut p = base.clone();
    p.limits.max_drawdown_bps = 3_000;
    variants.push(p);
    let mut p = base.clone();
    p.exposure_caps = Some(map![&s.env, (s.pool.clone(), 8_000)]);
    variants.push(p);

    for (index, variant) in variants.iter().enumerate() {
        let now = START + index as u64;
        s.warp(now);
        assert_eq!(
            s.propose(variant),
            PolicyChange::Proposed(now + TIMELOCK),
            "variant {index}"
        );
        s.last_event_is(PolicyProposed {
            vault: s.vault.clone(),
            eta: now + TIMELOCK,
        });
        assert_eq!(s.current(), base, "variant {index}");
        let pending = s.client().pending_policy(&s.vault).unwrap();
        assert_eq!(
            (pending.policy, pending.eta),
            (variant.clone(), now + TIMELOCK)
        );
    }

    s.warp(START + variants.len() as u64 - 1 + TIMELOCK);
    s.apply().unwrap();
    s.last_event_is(PolicyApplied {
        vault: s.vault.clone(),
    });
    assert_eq!(&s.current(), variants.last().unwrap());
    assert_eq!(s.client().pending_policy(&s.vault), None);
}

#[test]
fn mixed_change_is_loosen() {
    let s = Setup::new();
    let base = s.policy();
    let mut mixed = base.clone();
    mixed.protocols = vec![&s.env];
    mixed.limits.tx_cap_bps = 500;
    mixed.limits.daily_loss_bps = 100;
    assert_eq!(s.propose(&mixed), PolicyChange::Proposed(START + TIMELOCK));
    assert_eq!(s.current(), base);

    // Within one rule: a lower tolerance does not offset a constraint swapped for another.
    let mut swapped = base.clone();
    let mut rule = swapped.rule(&s.pool, &symbol_short!("submit")).unwrap();
    rule.max_loss_bps = 1;
    rule.args.set(0, ArgRule::Protocol);
    swapped.calls.set(s.submit(), rule);
    assert_eq!(
        s.propose(&swapped),
        PolicyChange::Proposed(START + TIMELOCK)
    );
    assert_eq!(s.current(), base);
    assert_eq!(s.client().pending_policy(&s.vault).unwrap().policy, swapped);

    // A lower global cap does not offset a protocol override raised above the old global cap.
    let mut shifted = base.clone();
    shifted.limits.max_exposure_bps = 2_000;
    shifted.exposure_caps = Some(map![&s.env, (s.pool.clone(), 6_000)]);
    assert_eq!(
        s.propose(&shifted),
        PolicyChange::Proposed(START + TIMELOCK)
    );
    assert_eq!(s.current(), base);
}

#[test]
fn apply_before_timelock_fails() {
    let s = Setup::new();
    assert_eq!(s.apply(), Err(Error::NoPendingPolicy));
    let mut loosened = s.policy();
    loosened.limits.tx_cap_bps = 10_000;
    loosened.limits.calls_per_hour = 120;
    assert_eq!(
        s.propose(&loosened),
        PolicyChange::Proposed(START + TIMELOCK)
    );
    assert_eq!(s.apply(), Err(Error::TimelockActive));
    s.warp(START + TIMELOCK - 1);
    assert_eq!(s.apply(), Err(Error::TimelockActive));
    assert_eq!(s.current(), s.policy());
    s.warp(START + TIMELOCK);
    s.apply().unwrap();
    assert_eq!(s.current(), loosened);
    assert_eq!(s.apply(), Err(Error::NoPendingPolicy));
}

#[test]
fn register_binds_vault_owner_before_deposits() {
    let s = Setup::new();
    assert_eq!(s.client().creator(&s.vault), Some(s.owner.clone()));
    assert_eq!(
        s.client()
            .mock_all_auths()
            .try_register(&s.vault, &s.policy()),
        Err(Ok(Error::AlreadyRegistered))
    );

    let fresh = s
        .env
        .register(MockVault, (s.owner.clone(), s.asset.clone()));
    assert!(s.client().try_register(&fresh, &s.policy()).is_err());
    let mut foreign_base = s.policy();
    foreign_base.assets = vec![&s.env, s.pool.clone(), s.asset.clone()];
    assert_eq!(
        s.client()
            .mock_all_auths()
            .try_register(&fresh, &foreign_base),
        Err(Ok(Error::InvalidPolicy))
    );
    let mut invalid = s.policy();
    invalid.limits.max_exposure_bps = 0;
    assert_eq!(
        s.client().mock_all_auths().try_register(&fresh, &invalid),
        Err(Ok(Error::InvalidPolicy))
    );
    MockVaultClient::new(&s.env, &fresh).set_total_shares(&1);
    assert_eq!(
        s.client()
            .mock_all_auths()
            .try_register(&fresh, &s.policy()),
        Err(Ok(Error::VaultHasDeposits))
    );

    // Changes are signed by the creator only, and the base asset cannot be swapped out.
    assert!(s
        .client()
        .try_propose_policy(&s.vault, &s.policy())
        .is_err());
    let mut rebased = s.policy();
    rebased.assets = vec![&s.env, s.pool.clone()];
    assert_eq!(
        s.client()
            .mock_all_auths()
            .try_propose_policy(&s.vault, &rebased),
        Err(Ok(Error::InvalidPolicy))
    );
}

impl Setup {
    fn name(&self, name: &str) -> Symbol {
        Symbol::new(&self.env, name)
    }

    fn role(&self, member: &Address, mode: RoleMode) -> Role {
        let env = &self.env;
        Role {
            member: member.clone(),
            mode,
            calls: map![
                env,
                (
                    self.submit(),
                    CallRule {
                        args: vec![env, ArgRule::Vault, ArgRule::Any, ArgRule::BlendRequests],
                        max_loss_bps: 5,
                        approve: false,
                    }
                )
            ],
            quota: Quota {
                tx_cap_bps: 2_000,
                daily_cap_bps: 5_000,
                calls_per_hour: 10,
                daily_loss_bps: 20,
            },
        }
    }

    fn propose_role(&self, name: &str, role: &Role) -> PolicyChange {
        self.client()
            .mock_all_auths()
            .propose_role(&self.vault, &self.name(name), role)
    }

    /// Adds `role` through the timelock and returns the time it was applied at.
    fn with_role(&self, name: &str, role: &Role) -> u64 {
        let PolicyChange::Proposed(eta) = self.propose_role(name, role) else {
            panic!("adding a role must wait for the timelock");
        };
        self.warp(eta);
        self.apply().unwrap();
        eta
    }
}

#[test]
fn adding_role_requires_timelock() {
    let s = Setup::new();
    let keeper = Address::generate(&s.env);
    let riskoff = s.role(&keeper, RoleMode::RiskOff);
    let name = s.name("riskoff");
    assert_eq!(
        s.propose_role("riskoff", &riskoff),
        PolicyChange::Proposed(START + TIMELOCK)
    );
    s.last_event_is(RoleProposed {
        vault: s.vault.clone(),
        role: name.clone(),
        eta: START + TIMELOCK,
    });
    assert_eq!(s.current().role(&name), None);
    assert_eq!(s.apply(), Err(Error::TimelockActive));
    s.warp(START + TIMELOCK - 1);
    assert_eq!(s.apply(), Err(Error::TimelockActive));
    assert_eq!(s.current().role(&name), None);
    s.warp(START + TIMELOCK);
    s.apply().unwrap();
    s.last_event_is(RoleApplied {
        vault: s.vault.clone(),
        role: name.clone(),
    });
    assert_eq!(s.current().role(&name), Some(riskoff.clone()));

    // Widening a role in any way waits too.
    let other = Address::generate(&s.env);
    let mut variants = std::vec::Vec::new();
    let mut r = riskoff.clone();
    r.member = other.clone();
    variants.push(r);
    // RiskOff to Normal: no longer acts in pause, but may now raise risk.
    let mut r = riskoff.clone();
    r.mode = RoleMode::Normal;
    variants.push(r);
    let mut r = riskoff.clone();
    r.calls.set(
        (other.clone(), symbol_short!("swap")),
        CallRule {
            args: vec![&s.env],
            max_loss_bps: 0,
            approve: false,
        },
    );
    variants.push(r);
    let mut r = riskoff.clone();
    let mut rule = r.calls.get(s.submit()).unwrap();
    rule.max_loss_bps = 6;
    r.calls.set(s.submit(), rule);
    variants.push(r);
    for widen in [
        |q: &mut Quota| q.tx_cap_bps += 1,
        |q: &mut Quota| q.daily_cap_bps += 1,
        |q: &mut Quota| q.calls_per_hour += 1,
        |q: &mut Quota| q.daily_loss_bps += 1,
    ] {
        let mut r = riskoff.clone();
        widen(&mut r.quota);
        variants.push(r);
    }
    for (index, variant) in variants.iter().enumerate() {
        let now = START + TIMELOCK + 1 + index as u64;
        s.warp(now);
        assert_eq!(
            s.propose_role("riskoff", variant),
            PolicyChange::Proposed(now + TIMELOCK),
            "variant {index}"
        );
        assert_eq!(s.current().role(&name), Some(riskoff.clone()));
    }

    // Normal to RiskOff: the role could act while the vault is paused.
    let trader = s.role(&keeper, RoleMode::Normal);
    s.with_role("trader", &trader);
    let mut promoted = trader.clone();
    promoted.mode = RoleMode::RiskOff;
    assert!(matches!(
        s.propose_role("trader", &promoted),
        PolicyChange::Proposed(_)
    ));

    // A whole-policy proposal that adds a role is classified the same way.
    let mut policy = s.current();
    let mut roles = policy.roles.clone().unwrap();
    roles.set(s.name("extra"), s.role(&other, RoleMode::Normal));
    policy.roles = Some(roles);
    assert!(matches!(s.propose(&policy), PolicyChange::Proposed(_)));
    assert_eq!(s.current().role(&s.name("extra")), None);
}

#[test]
fn narrowing_role_is_immediate() {
    let s = Setup::new();
    let keeper = Address::generate(&s.env);
    let riskoff = s.role(&keeper, RoleMode::RiskOff);
    s.with_role("riskoff", &riskoff);
    let mut narrowed = riskoff.clone();
    narrowed.quota.tx_cap_bps = 1_000;
    narrowed.quota.calls_per_hour = 1;
    let mut rule = narrowed.calls.get(s.submit()).unwrap();
    rule.max_loss_bps = 1;
    rule.args.set(1, ArgRule::Vault);
    narrowed.calls.set(s.submit(), rule);
    assert_eq!(
        s.propose_role("riskoff", &narrowed),
        PolicyChange::Tightened
    );
    s.last_event_is(RoleNarrowed {
        vault: s.vault.clone(),
        role: s.name("riskoff"),
    });
    assert_eq!(s.current().role(&s.name("riskoff")), Some(narrowed.clone()));
    narrowed.calls = Map::new(&s.env);
    assert_eq!(
        s.propose_role("riskoff", &narrowed),
        PolicyChange::Tightened
    );
    assert_eq!(s.current().role(&s.name("riskoff")), Some(narrowed));
}

#[test]
fn revoking_role_is_immediate() {
    let s = Setup::new();
    let keeper = Address::generate(&s.env);
    let riskoff = s.role(&keeper, RoleMode::RiskOff);
    let trader = s.role(&keeper, RoleMode::Normal);
    s.with_role("riskoff", &riskoff);
    s.with_role("trader", &trader);
    let name = s.name("riskoff");
    // A pending widening of the same role must not bring it back once applied.
    let mut widened = riskoff.clone();
    widened.quota.calls_per_hour += 1;
    assert!(matches!(
        s.propose_role("riskoff", &widened),
        PolicyChange::Proposed(_)
    ));

    // Only the creator can revoke.
    assert!(s.client().try_revoke_role(&s.vault, &name).is_err());
    s.client().mock_all_auths().revoke_role(&s.vault, &name);
    s.last_event_is(RoleRevoked {
        vault: s.vault.clone(),
        role: name.clone(),
    });
    assert_eq!(s.current().role(&name), None);
    assert_eq!(s.current().role(&s.name("trader")), Some(trader));
    assert_eq!(s.client().pending_policy(&s.vault), None);
    assert_eq!(s.apply(), Err(Error::NoPendingPolicy));
    assert_eq!(
        s.client().mock_all_auths().try_revoke_role(&s.vault, &name),
        Err(Ok(Error::RoleNotFound))
    );

    let fresh = Setup::new();
    assert_eq!(
        fresh
            .client()
            .mock_all_auths()
            .try_revoke_role(&fresh.vault, &name),
        Err(Ok(Error::RoleNotFound))
    );
}

#[test]
fn invalid_roles_are_refused() {
    let s = Setup::new();
    let keeper = Address::generate(&s.env);
    let role = s.role(&keeper, RoleMode::RiskOff);
    let rejected = |name: &str, role: &Role| {
        s.client()
            .mock_all_auths()
            .try_propose_role(&s.vault, &s.name(name), role)
    };
    // `default` is the vault's own session key and rules.
    assert_eq!(rejected("default", &role), Err(Ok(Error::InvalidPolicy)));
    let mut idle = role.clone();
    idle.quota.calls_per_hour = 0;
    assert_eq!(rejected("riskoff", &idle), Err(Ok(Error::InvalidPolicy)));
    let mut uncapped = role.clone();
    uncapped.quota.tx_cap_bps = 10_001;
    assert_eq!(
        rejected("riskoff", &uncapped),
        Err(Ok(Error::InvalidPolicy))
    );
    let mut lossy = role.clone();
    let mut rule = lossy.calls.get(s.submit()).unwrap();
    rule.max_loss_bps = 10_001;
    lossy.calls.set(s.submit(), rule.clone());
    assert_eq!(rejected("riskoff", &lossy), Err(Ok(Error::InvalidPolicy)));
    let mut busy = role.clone();
    for _ in 0..crate::MAX_ROLE_CALLS {
        busy.calls.set(
            (Address::generate(&s.env), symbol_short!("call")),
            rule.clone(),
        );
    }
    assert_eq!(rejected("riskoff", &busy), Err(Ok(Error::InvalidPolicy)));

    for index in 0..crate::MAX_ROLES {
        s.with_role(&std::format!("role{index}"), &role);
    }
    assert_eq!(rejected("onemore", &role), Err(Ok(Error::InvalidPolicy)));
}
