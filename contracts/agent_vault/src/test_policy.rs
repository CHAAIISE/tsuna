use crate::{
    test::{outcome, Fixture, UNIT},
    AgentVault, AgentVaultClient, Error,
};
use policy_registry::{Limits, PolicyChange, PolicyV1};
use soroban_sdk::{map, symbol_short, Address, IntoVal, Symbol};

/// Zero-amount approval: a neutral call the policy allows once `approve_noop` ran.
fn approve(f: &Fixture) -> Result<(), Error> {
    outcome(
        f.client().mock_all_auths().try_execute(
            &f.asset,
            &symbol_short!("approve"),
            &(
                f.vault.clone(),
                f.owner.clone(),
                0_i128,
                f.env.ledger().sequence(),
            )
                .into_val(&f.env),
        ),
    )
}

fn approve_call(f: &Fixture) -> (Address, Symbol) {
    (f.asset.clone(), symbol_short!("approve"))
}

#[test]
fn unregistered_vault_blocks_agent_but_not_withdraw() {
    let f = Fixture::new();
    let vault = f.env.register(
        AgentVault,
        (
            f.owner.clone(),
            f.agent.clone(),
            f.asset.clone(),
            f.protocol.clone(),
            f.oracle.clone(),
            f.registry.clone(),
        ),
    );
    let client = AgentVaultClient::new(&f.env, &vault);
    assert_eq!(client.registry(), f.registry);
    let shares = client.mock_all_auths().deposit(&f.alice, &(100 * UNIT));
    assert_eq!(
        outcome(client.mock_all_auths().try_execute(
            &f.asset,
            &symbol_short!("approve"),
            &(vault.clone(), f.owner.clone(), 0_i128, 0_u32).into_val(&f.env),
        )),
        Err(Error::PolicyMissing)
    );
    assert_eq!(
        client.try_check_drawdown().err(),
        Some(Ok(Error::PolicyMissing))
    );
    // Virtual shares keep one unit of rounding dust in the vault.
    assert_eq!(
        client.mock_all_auths().withdraw(&f.alice, &shares),
        100 * UNIT - 1
    );
    // A policy installed after deposits would skip the timelock for those depositors.
    client.mock_all_auths().deposit(&f.alice, &(100 * UNIT));
    assert_eq!(
        f.registry_client()
            .mock_all_auths()
            .try_register(&vault, &f.policy()),
        Err(Ok(policy_registry::Error::VaultHasDeposits))
    );
}

#[test]
fn tightening_binds_next_execute_and_loosening_waits_for_apply() {
    let f = Fixture::new();
    f.deposit(&f.alice, 100 * UNIT);
    f.approve_noop();
    let allowed = f.policy();

    f.update_policy(|policy| {
        policy.calls.remove(approve_call(&f));
    });
    assert_eq!(approve(&f), Err(Error::CallNotAllowed));

    let registry = f.registry_client();
    let now = f.env.ledger().timestamp();
    assert_eq!(
        registry.mock_all_auths().propose_policy(&f.vault, &allowed),
        PolicyChange::Proposed(now)
    );
    // A pending loosening is public but grants nothing until applied.
    assert_eq!(registry.pending_policy(&f.vault).unwrap().policy, allowed);
    assert_eq!(approve(&f), Err(Error::CallNotAllowed));
    registry.mock_all_auths().apply_policy(&f.vault);
    approve(&f).unwrap();
}

#[test]
fn protocol_exposure_cap_overrides_global_cap() {
    let f = Fixture::new();
    f.deposit(&f.alice, 1_000 * UNIT);
    let pool = f.blend_pool();
    let registry = f.registry_client();
    let mut capped = f.policy();
    capped.exposure_caps = Some(map![&f.env, (pool.clone(), 2_000)]);
    assert_eq!(
        registry.mock_all_auths().propose_policy(&f.vault, &capped),
        PolicyChange::Tightened
    );
    f.submit(&pool, 200 * UNIT, 2).unwrap();
    assert_eq!(f.submit(&pool, 1, 2), Err(Error::ExposureCapExceeded));

    // Above the global cap, the override is a loosening.
    let mut raised = f.policy();
    raised.exposure_caps = Some(map![&f.env, (pool.clone(), 8_000)]);
    assert!(matches!(
        registry.mock_all_auths().propose_policy(&f.vault, &raised),
        PolicyChange::Proposed(_)
    ));
    assert_eq!(f.submit(&pool, 1, 2), Err(Error::ExposureCapExceeded));
    registry.mock_all_auths().apply_policy(&f.vault);
    f.submit(&pool, 600 * UNIT, 2).unwrap();
    assert_eq!(f.submit(&pool, 1, 2), Err(Error::ExposureCapExceeded));
}

#[test]
fn v1_policy_entry_drives_vault() {
    let f = Fixture::new();
    f.deposit(&f.alice, 100 * UNIT);
    f.approve_noop();
    let current = f.policy();
    let v1 = PolicyV1 {
        calls: current.calls.clone(),
        protocols: current.protocols.clone(),
        guards: current.guards.clone(),
        assets: current.assets.clone(),
        limits: Limits {
            calls_per_hour: 7,
            ..current.limits.clone()
        },
    };
    // Same storage key as the registry's `Key::Policy(vault)` variant.
    let key = (symbol_short!("Policy"), f.vault.clone());
    f.env.as_contract(&f.registry, || {
        f.env.storage().persistent().set(&key, &v1);
    });
    let read = f.policy();
    assert_eq!((read.limits.calls_per_hour, read.exposure_caps), (7, None));
    approve(&f).unwrap();
    f.update_policy(|policy| {
        policy.calls.remove(approve_call(&f));
    });
    assert_eq!(approve(&f), Err(Error::CallNotAllowed));
}
