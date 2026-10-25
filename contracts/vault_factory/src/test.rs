extern crate std;

use super::*;
use soroban_sdk::{
    testutils::{Address as _, Ledger, MockAuth, MockAuthInvoke},
    IntoVal,
};

mod vault_v1 {
    soroban_sdk::contractimport!(file = "../target/wasm32v1-none/release/agent_vault.wasm");
}
mod vault_probe {
    soroban_sdk::contractimport!(file = "../target/wasm32v1-none/release/vault_probe.wasm");
}

const TIMELOCK: u64 = 600;

struct Setup {
    env: Env,
    factory: VaultFactoryClient<'static>,
    admin_a: Address,
    admin_b: Address,
    v1: BytesN<32>,
    v2: BytesN<32>,
    tag: String,
}

fn setup() -> Setup {
    let env = Env::default();
    env.ledger().set_timestamp(1_000);
    let admin_a = Address::generate(&env);
    let admin_b = Address::generate(&env);
    let id = env.register(VaultFactory, (&admin_a, &admin_b, TIMELOCK));
    let factory = VaultFactoryClient::new(&env, &id);
    let v1 = env.deployer().upload_contract_wasm(vault_v1::WASM);
    let v2 = env.deployer().upload_contract_wasm(vault_probe::WASM);
    let tag = String::from_str(&env, VAULT_TAG);
    Setup {
        env,
        factory,
        admin_a,
        admin_b,
        v1,
        v2,
        tag,
    }
}

fn params(env: &Env) -> VaultParams {
    VaultParams {
        asset: Address::generate(env),
        protocol_recipient: Address::generate(env),
        oracle: Address::generate(env),
        registry: Address::generate(env),
    }
}

fn publish_v1(s: &Setup) {
    s.env.mock_all_auths();
    s.factory.set_ref(&s.tag, &s.v1);
}

#[test]
fn three_vaults_upgrade_with_one_apply() {
    let s = setup();
    publish_v1(&s);
    let mut creators = std::vec::Vec::new();
    for _ in 0..3 {
        let creator = Address::generate(&s.env);
        let vault = s
            .factory
            .deploy_vault(&creator, &Address::generate(&s.env), &params(&s.env));
        creators.push((creator, vault));
    }
    assert_eq!(s.factory.vault_count(), 3);
    let listed = s.factory.vaults();
    for (i, (creator, vault)) in creators.iter().enumerate() {
        assert_eq!(listed.get(i as u32).unwrap(), *vault);
        assert_eq!(vault_v1::Client::new(&s.env, vault).owner(), *creator);
        assert!(vault_probe::Client::new(&s.env, vault)
            .try_version()
            .is_err());
    }

    let eta = s.factory.propose_ref(&s.tag, &s.v2);
    assert_eq!(eta, 1_000 + TIMELOCK);
    assert_eq!(
        s.factory.pending_ref(&s.tag),
        Some(PendingRef {
            wasm_hash: s.v2.clone(),
            eta
        })
    );
    s.env.ledger().set_timestamp(eta);
    s.factory.apply_ref(&s.tag);

    assert_eq!(s.factory.current_ref(&s.tag), Some(s.v2.clone()));
    assert_eq!(s.factory.pending_ref(&s.tag), None);
    for (_, vault) in creators.iter() {
        assert_eq!(vault_probe::Client::new(&s.env, vault).version(), 2);
    }
}

#[test]
fn apply_before_timelock_fails() {
    let s = setup();
    publish_v1(&s);
    s.factory.propose_ref(&s.tag, &s.v2);
    s.env.ledger().set_timestamp(1_000 + TIMELOCK - 1);
    assert_eq!(
        s.factory.try_apply_ref(&s.tag),
        Err(Ok(Error::TimelockActive))
    );
    assert_eq!(s.factory.current_ref(&s.tag), Some(s.v1.clone()));
}

#[test]
fn apply_without_pending_fails() {
    let s = setup();
    publish_v1(&s);
    assert_eq!(
        s.factory.try_apply_ref(&s.tag),
        Err(Ok(Error::NoPendingRef))
    );
}

#[test]
fn set_ref_cannot_overwrite_existing_tag() {
    let s = setup();
    publish_v1(&s);
    assert_eq!(
        s.factory.try_set_ref(&s.tag, &s.v2),
        Err(Ok(Error::RefAlreadySet))
    );
}

#[test]
fn set_ref_requires_both_admins() {
    let s = setup();
    s.env.mock_all_auths();
    s.factory.set_ref(&s.tag, &s.v1);
    let auths = s.env.auths();
    let signers: std::vec::Vec<Address> = auths.iter().map(|(a, _)| a.clone()).collect();
    assert!(signers.contains(&s.admin_a) && signers.contains(&s.admin_b));
}

#[test]
fn single_admin_cannot_propose_or_apply() {
    let s = setup();
    publish_v1(&s);
    s.env.set_auths(&[]);

    let args = (s.tag.clone(), s.v2.clone()).into_val(&s.env);
    let invoke = MockAuthInvoke {
        contract: &s.factory.address,
        fn_name: "propose_ref",
        args,
        sub_invokes: &[],
    };
    s.env.mock_auths(&[MockAuth {
        address: &s.admin_a,
        invoke: &invoke,
    }]);
    assert!(s.factory.try_propose_ref(&s.tag, &s.v2).is_err());
    assert_eq!(s.factory.pending_ref(&s.tag), None);

    s.env.mock_all_auths();
    s.factory.propose_ref(&s.tag, &s.v2);
    s.env.ledger().set_timestamp(1_000 + TIMELOCK);
    s.env.set_auths(&[]);
    let args = (s.tag.clone(),).into_val(&s.env);
    let invoke = MockAuthInvoke {
        contract: &s.factory.address,
        fn_name: "apply_ref",
        args,
        sub_invokes: &[],
    };
    s.env.mock_auths(&[MockAuth {
        address: &s.admin_a,
        invoke: &invoke,
    }]);
    assert!(s.factory.try_apply_ref(&s.tag).is_err());
    assert_eq!(s.factory.current_ref(&s.tag), Some(s.v1.clone()));
}

#[test]
fn deploy_requires_creator_auth() {
    let s = setup();
    publish_v1(&s);
    s.env.set_auths(&[]);
    let creator = Address::generate(&s.env);
    let agent = Address::generate(&s.env);
    let p = params(&s.env);
    assert!(s.factory.try_deploy_vault(&creator, &agent, &p).is_err());
    assert_eq!(s.factory.vault_count(), 0);

    s.env.mock_all_auths();
    s.factory.deploy_vault(&creator, &agent, &p);
    let auths = s.env.auths();
    assert_eq!(auths.len(), 1);
    assert_eq!(auths[0].0, creator);
}

#[test]
fn deploy_before_publish_fails() {
    let s = setup();
    s.env.mock_all_auths();
    let creator = Address::generate(&s.env);
    assert_eq!(
        s.factory
            .try_deploy_vault(&creator, &Address::generate(&s.env), &params(&s.env)),
        Err(Ok(Error::RefNotSet))
    );
}

#[test]
fn constructor_rejects_same_admin() {
    let env = Env::default();
    let a = Address::generate(&env);
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        env.register(VaultFactory, (&a, &a, TIMELOCK));
    }));
    assert!(r.is_err());
}
