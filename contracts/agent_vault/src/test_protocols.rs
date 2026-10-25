extern crate std;

use crate::{
    test::{Fixture, UNIT},
    testutils::blend::{BlendMock, BlendMockClient, RATE},
    Error, ProtocolAcknowledged, ProtocolPinned, ProtocolUpgraded,
};
use soroban_sdk::{
    testutils::{Address as _, Events, MockAuth, MockAuthInvoke},
    vec, Address, BytesN, ContractExecutable, Event, Executable, IntoVal,
};

fn code(protocol: &Address) -> BytesN<32> {
    match protocol.executable() {
        Some(Executable::Wasm(hash)) => hash,
        other => panic!("not a Wasm contract: {other:?}"),
    }
}

/// Swaps `pool`'s code for a fresh copy of the Blend mock under a new Wasm hash, as an
/// upgradeable protocol's admin would; the pool keeps its storage.
fn upgrade(f: &Fixture, pool: &Address) -> BytesN<32> {
    let hash = f.env.upload(BlendMock);
    f.env.as_contract(pool, || {
        f.env
            .deployer()
            .update_current_contract(ContractExecutable::Wasm(hash.clone()))
    });
    assert_eq!(code(pool), hash);
    hash
}

/// 1,000 USDC deposited and supplied to an allowlisted Blend pool.
fn invested() -> (Fixture, Address) {
    let f = Fixture::new();
    f.env.cost_estimate().budget().reset_unlimited();
    f.deposit(&f.alice, 1_000 * UNIT);
    let pool = f.invest(1_000 * UNIT, 0);
    (f, pool)
}

#[test]
fn execute_pins_protocol_hash() {
    let f = Fixture::new();
    let pool = f.blend_pool();
    f.deposit(&f.alice, 100 * UNIT);
    assert_eq!(f.client().protocol_hash(&pool), None);
    f.submit(&pool, 10 * UNIT, 0).unwrap();
    assert!(f.env.events().all().events().contains(
        &ProtocolPinned {
            protocol: pool.clone(),
            hash: code(&pool),
        }
        .to_xdr(&f.env, &f.vault)
    ));
    assert_eq!(f.client().protocol_hash(&pool), Some(code(&pool)));
    // A Stellar asset contract has no Wasm to pin.
    f.approve_noop();
    assert_eq!(f.client().protocol_hash(&f.asset), None);
    f.submit(&pool, 10 * UNIT, 0).unwrap();
}

#[test]
fn upgraded_protocol_blocks_execute() {
    let (f, pool) = invested();
    let pinned = code(&pool);
    upgrade(&f, &pool);
    assert_eq!(f.submit(&pool, 10 * UNIT, 1), Err(Error::ProtocolChanged));
    assert_eq!(f.client().protocol_hash(&pool), Some(pinned));
    assert!(!f.client().paused());
}

#[test]
fn check_protocols_pauses_on_upgrade() {
    let f = Fixture::new();
    let pool = f.blend_pool();
    let other = f.blend_pool();
    assert_eq!(f.client().check_protocols(), vec![&f.env]);
    assert_eq!(f.client().protocol_hash(&pool), Some(code(&pool)));
    assert_eq!(f.client().protocol_hash(&other), Some(code(&other)));
    assert!(!f.client().paused());
    let old = code(&pool);
    let new = upgrade(&f, &pool);
    // Anyone can run the check: no authorization is mocked.
    assert_eq!(f.client().check_protocols(), vec![&f.env, pool.clone()]);
    assert!(f.env.events().all().events().contains(
        &ProtocolUpgraded {
            protocol: pool.clone(),
            old: old.clone(),
            new,
        }
        .to_xdr(&f.env, &f.vault)
    ));
    assert!(f.client().paused());
    assert_eq!(f.client().halted_protocols(), vec![&f.env, pool.clone()]);
    assert_eq!(f.client().protocol_hash(&pool), Some(old));
    assert_eq!(f.client().check_protocols(), vec![&f.env, pool.clone()]);
    assert_eq!(f.client().halted_protocols(), vec![&f.env, pool]);
    assert_eq!(
        f.client()
            .mock_all_auths()
            .try_deposit(&f.alice, &UNIT)
            .err(),
        Some(Ok(Error::Paused))
    );
}

#[test]
fn acknowledge_resumes_after_upgrade() {
    let (f, pool) = invested();
    let new = upgrade(&f, &pool);
    f.client().check_protocols();
    assert!(f.client().paused());
    let stranger = Address::generate(&f.env);
    assert!(f
        .client()
        .mock_auths(&[MockAuth {
            address: &stranger,
            invoke: &MockAuthInvoke {
                contract: &f.vault,
                fn_name: "acknowledge_protocol",
                args: (pool.clone(), new.clone()).into_val(&f.env),
                sub_invokes: &[],
            },
        }])
        .try_acknowledge_protocol(&pool, &new)
        .is_err());
    f.client()
        .mock_all_auths()
        .acknowledge_protocol(&pool, &new);
    assert!(f.env.events().all().events().contains(
        &ProtocolAcknowledged {
            protocol: pool.clone(),
            hash: new.clone(),
        }
        .to_xdr(&f.env, &f.vault)
    ));
    assert!(!f.client().paused());
    assert_eq!(f.client().halted_protocols(), vec![&f.env]);
    assert_eq!(f.client().protocol_hash(&pool), Some(new));
    assert_eq!(f.client().check_protocols(), vec![&f.env]);
    f.submit(&pool, 100 * UNIT, 1).unwrap();
    assert_eq!(f.token_balance(&f.vault), 100 * UNIT);
}

#[test]
fn acknowledge_rejects_stale_hash() {
    let (f, pool) = invested();
    let old = code(&pool);
    let first = upgrade(&f, &pool);
    f.client().check_protocols();
    // The code moved again after the owner reviewed `first`.
    upgrade(&f, &pool);
    for stale in [old.clone(), first] {
        assert_eq!(
            f.client()
                .mock_all_auths()
                .try_acknowledge_protocol(&pool, &stale)
                .err(),
            Some(Ok(Error::ProtocolChanged))
        );
    }
    assert!(f.client().paused());
    assert_eq!(f.client().halted_protocols(), vec![&f.env, pool.clone()]);
    assert_eq!(f.client().protocol_hash(&pool), Some(old));
}

#[test]
fn acknowledge_keeps_drawdown_pause() {
    // Drawdown first: the watch finds the vault already paused.
    let (f, pool) = invested();
    BlendMockClient::new(&f.env, &pool).set_rate(&(RATE / 2));
    assert!(f.client().check_drawdown());
    let new = upgrade(&f, &pool);
    assert_eq!(f.client().check_protocols(), vec![&f.env, pool.clone()]);
    f.client()
        .mock_all_auths()
        .acknowledge_protocol(&pool, &new);
    assert_eq!(f.client().halted_protocols(), vec![&f.env]);
    assert!(f.client().paused());

    // Watch first: a drawdown breached while halted takes the pause over.
    let (f, pool) = invested();
    let new = upgrade(&f, &pool);
    f.client().check_protocols();
    assert!(f.client().paused());
    BlendMockClient::new(&f.env, &pool).set_rate(&(RATE / 2));
    assert!(f.client().check_drawdown());
    f.client()
        .mock_all_auths()
        .acknowledge_protocol(&pool, &new);
    assert!(f.client().paused());

    // An owner pause during the halt is the owner's to lift, too.
    let (f, pool) = invested();
    let new = upgrade(&f, &pool);
    f.client().check_protocols();
    f.client().mock_all_auths().set_paused(&true);
    f.client()
        .mock_all_auths()
        .acknowledge_protocol(&pool, &new);
    assert!(f.client().paused());
}

#[test]
fn withdraw_open_while_protocol_halted() {
    let (f, pool) = invested();
    upgrade(&f, &pool);
    f.client().check_protocols();
    assert!(f.client().paused());
    let shares = f.client().balance(&f.alice);
    let paid = f.withdraw(&f.alice, shares);
    // Rounding dust stays with the remaining virtual shares.
    assert!(paid >= 1_000 * UNIT - 1);
    assert_eq!(f.token_balance(&f.alice), 9_000 * UNIT + paid);
    assert_eq!(f.client().balance(&f.alice), 0);
    assert!(f.token_balance(&pool) <= 1);
}
