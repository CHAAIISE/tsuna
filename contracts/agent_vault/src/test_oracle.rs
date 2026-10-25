extern crate std;

use crate::{
    shares::VIRTUAL_SHARES,
    test::{outcome, Fixture, UNIT},
    Error, WithdrawnInKind,
};
use oracle_router::{testutils::MockReflectorClient, Feed, OracleRouterClient, ReflectorAsset};
use policy_registry::ArgRule;
use soroban_sdk::{
    contract, contractimpl, contracttype,
    testutils::{Events, Ledger},
    token, vec, Address, Env, Event, IntoVal, Symbol,
};

const START: u64 = 1_800_000_000;
/// One USD with Reflector's 14 decimals.
const R_USD: i128 = 100_000_000_000_000;

#[contracttype]
enum SwapperKey {
    Pair,
}

/// Trades a fixed amount of the base asset for a fixed amount of another asset.
#[contract]
struct Swapper;

#[contractimpl]
impl Swapper {
    pub fn __constructor(env: Env, base: Address, other: Address) {
        env.storage()
            .instance()
            .set(&SwapperKey::Pair, &(base, other));
    }

    pub fn swap(env: Env, from: Address, amount_in: i128, amount_out: i128) {
        let (base, other): (Address, Address) =
            env.storage().instance().get(&SwapperKey::Pair).unwrap();
        let me = env.current_contract_address();
        if amount_in > 0 {
            token::Client::new(&env, &base).transfer_from(&me, &from, &me, &amount_in);
        }
        if amount_out > 0 {
            token::Client::new(&env, &other).transfer(&me, &from, &amount_out);
        }
    }
}

/// Vault holding USDC (base) and allowed to hold XLM, with alice and bob 100 USDC each.
struct Market {
    f: Fixture,
    xlm: Address,
    swapper: Address,
}

impl Market {
    /// `xlm_quoted_at`: timestamp of the only XLM price published, or `None` when the
    /// fixture has no oracle to configure.
    fn new(f: Fixture, xlm_quoted_at: Option<u64>) -> Self {
        f.env.ledger().set_timestamp(START);
        let xlm = f
            .env
            .register_stellar_asset_contract_v2(f.owner.clone())
            .address();
        f.set_assets(vec![&f.env, f.asset.clone(), xlm.clone()]);
        let swapper = f.env.register(Swapper, (f.asset.clone(), xlm.clone()));
        token::StellarAssetClient::new(&f.env, &xlm)
            .mock_all_auths()
            .mint(&swapper, &(10_000 * UNIT));
        f.allow_protocol(&swapper);
        f.allow(
            &swapper,
            "swap",
            vec![&f.env, ArgRule::Vault, ArgRule::Amount, ArgRule::Any],
            true,
        );
        let m = Self { f, xlm, swapper };
        if let Some(quoted_at) = xlm_quoted_at {
            let router = OracleRouterClient::new(&m.f.env, &m.f.oracle);
            router
                .mock_all_auths()
                .set_feed(&m.f.asset, &m.feed("USDC"));
            router.mock_all_auths().set_feed(&m.xlm, &m.feed("XLM"));
            m.push("USDC", R_USD, START);
            m.push("XLM", 17 * R_USD / 100, quoted_at);
        }
        m.f.deposit(&m.f.alice, 100 * UNIT);
        m.f.deposit(&m.f.bob, 100 * UNIT);
        m
    }

    fn feed(&self, ticker: &str) -> Feed {
        Feed {
            reflector: ReflectorAsset::Other(Symbol::new(&self.f.env, ticker)),
            chainlink: None,
        }
    }

    fn push(&self, ticker: &str, price: i128, timestamp: u64) {
        MockReflectorClient::new(&self.f.env, &self.f.reflector).push(
            &ReflectorAsset::Other(Symbol::new(&self.f.env, ticker)),
            &price,
            &timestamp,
        );
    }

    /// The agent's only way to act; a zero swap is a neutral probe.
    fn swap(&self, amount_in: i128, amount_out: i128) -> Result<(), Error> {
        outcome(self.f.client().mock_all_auths().try_execute(
            &self.swapper,
            &Symbol::new(&self.f.env, "swap"),
            &(self.f.vault.clone(), amount_in, amount_out).into_val(&self.f.env),
        ))
    }

    fn xlm_balance(&self, owner: &Address) -> i128 {
        token::Client::new(&self.f.env, &self.xlm).balance(owner)
    }

    /// Airdrop that bypasses the agent, so no price is ever accepted for it.
    fn airdrop_xlm(&self, amount: i128) {
        token::StellarAssetClient::new(&self.f.env, &self.xlm)
            .mock_all_auths()
            .mint(&self.f.vault, &amount);
    }

    fn supply(&self) -> i128 {
        self.f.client().total_shares() + VIRTUAL_SHARES
    }

    fn nav(&self) -> Result<i128, Error> {
        self.f
            .client()
            .try_nav()
            .map(|nav| nav.unwrap())
            .map_err(|error| error.unwrap())
    }
}

#[test]
fn idle_assets_are_valued_at_strict_prices() {
    let m = Market::new(Fixture::new(), Some(START));
    // 34 USDC for 200 XLM at 0.17: value-neutral, so the NAV post-condition holds.
    m.swap(34 * UNIT, 200 * UNIT).unwrap();
    assert_eq!(m.nav(), Ok(200 * UNIT));
    assert_eq!(m.xlm_balance(&m.f.vault), 200 * UNIT);
    // A move the breaker cannot confirm yet blocks the agent and the strict NAV.
    m.f.env.ledger().set_timestamp(START + 300);
    m.push("USDC", R_USD, START + 300);
    m.push("XLM", 20 * R_USD / 100, START + 300);
    assert_eq!(m.swap(0, 0), Err(Error::PriceJump));
    assert_eq!(m.nav(), Err(Error::PriceJump));
    // Confirmed on the next Reflector update.
    m.f.env.ledger().set_timestamp(START + 600);
    m.push("USDC", R_USD, START + 600);
    m.push("XLM", 20 * R_USD / 100, START + 600);
    assert_eq!(m.nav(), Ok(206 * UNIT));
    m.swap(0, 0).unwrap();
    // An asset without a feed has no price: it counts as zero.
    OracleRouterClient::new(&m.f.env, &m.f.oracle)
        .mock_all_auths()
        .remove_feed(&m.xlm);
    assert_eq!(m.nav(), Ok(166 * UNIT));
}

#[test]
fn exit_with_stale_oracle_haircut() {
    let m = Market::new(Fixture::new(), Some(START));
    m.swap(34 * UNIT, 200 * UNIT).unwrap();
    m.f.env.ledger().set_timestamp(START + 3_600);
    assert_eq!(m.swap(0, 0), Err(Error::StalePrice));
    let shares = m.f.client().balance(&m.f.alice);
    let supply = m.supply();
    // 200 XLM at the last valid 0.17, cut by 5%: 32.3 USDC.
    let xlm_value = 323 * UNIT / 10;
    let nav = 166 * UNIT + xlm_value;
    let expected = (shares * (nav + 1) / supply)
        .min(166 * UNIT * shares / supply + xlm_value * shares / supply);
    let before = m.f.token_balance(&m.f.alice);
    assert_eq!(m.f.withdraw(&m.f.alice, shares), expected);
    assert_eq!(m.f.token_balance(&m.f.alice) - before, expected);
    // The leaver bears the haircut: 99.15 USDC (less rounding dust) instead of 100, and no XLM.
    assert!((9_915 * UNIT / 100 - expected) <= 2);
    assert_eq!(m.xlm_balance(&m.f.alice), 0);
    assert_eq!(m.xlm_balance(&m.f.vault), 200 * UNIT);
    assert_eq!(m.f.token_balance(&m.f.vault), 166 * UNIT - expected);
    // The agent stays blocked until the oracle recovers.
    assert_eq!(m.swap(0, 0), Err(Error::StalePrice));
    m.push("USDC", R_USD, START + 3_600);
    m.push("XLM", 17 * R_USD / 100, START + 3_600);
    m.swap(0, 0).unwrap();
}

#[test]
fn priced_exit_pays_in_kind_beyond_base_liquidity() {
    let m = Market::new(Fixture::new(), Some(START));
    // All idle USDC converted: the vault cannot buy the leaver's XLM back in base.
    m.swap(200 * UNIT, 11_764_705_882).unwrap();
    let shares = m.f.client().balance(&m.f.alice);
    let supply = m.supply();
    let held = m.xlm_balance(&m.f.vault);
    let paid = m.f.withdraw(&m.f.alice, shares);
    let events = m.f.env.events().all();
    assert_eq!(paid, 0);
    let received = m.xlm_balance(&m.f.alice);
    assert!(received > 0 && received <= held * shares / supply + 1);
    assert!(held * shares / supply - received <= 2);
    assert!(events.events().contains(
        &WithdrawnInKind {
            user: m.f.alice.clone(),
            asset: m.xlm.clone(),
            amount: received,
        }
        .to_xdr(&m.f.env, &m.f.vault)
    ));
}

#[test]
fn exit_in_kind_without_price() {
    // XLM was only ever quoted an hour before: no valid price has been accepted.
    let m = Market::new(Fixture::new(), Some(START - 3_600));
    m.airdrop_xlm(200 * UNIT);
    assert_eq!(m.swap(0, 0), Err(Error::StalePrice));
    assert_eq!(
        OracleRouterClient::new(&m.f.env, &m.f.oracle).price_for_exit(&m.xlm),
        None
    );
    let shares = m.f.client().balance(&m.f.alice);
    let supply = m.supply();
    let usdc = 200 * UNIT * shares / supply;
    let xlm = 200 * UNIT * shares / supply;
    assert_eq!(m.f.withdraw(&m.f.alice, shares), usdc);
    assert!(m.f.env.events().all().events().contains(
        &WithdrawnInKind {
            user: m.f.alice.clone(),
            asset: m.xlm.clone(),
            amount: xlm,
        }
        .to_xdr(&m.f.env, &m.f.vault)
    ));
    assert_eq!(m.f.token_balance(&m.f.alice), 9_900 * UNIT + usdc);
    assert_eq!(m.xlm_balance(&m.f.alice), xlm);
    // Each holder gets their pro-rata share: about half of each asset.
    assert!((usdc - 100 * UNIT).abs() <= 1 && (xlm - 100 * UNIT).abs() <= 1);
    let bob = m.f.client().balance(&m.f.bob);
    m.f.withdraw(&m.f.bob, bob);
    assert!(m.xlm_balance(&m.f.bob) >= 100 * UNIT - 1);
}

#[test]
fn missing_oracle_blocks_agent_but_not_withdraw() {
    let m = Market::new(Fixture::without_oracle(), None);
    // Buying an asset the vault cannot price is refused outright.
    assert_eq!(m.swap(34 * UNIT, 200 * UNIT), Err(Error::OracleUnavailable));
    assert_eq!(m.f.token_balance(&m.f.vault), 200 * UNIT);
    m.airdrop_xlm(200 * UNIT);
    assert_eq!(m.swap(0, 0), Err(Error::OracleUnavailable));
    assert_eq!(m.nav(), Err(Error::OracleUnavailable));
    assert_eq!(
        m.f.client()
            .mock_all_auths()
            .try_deposit(&m.f.alice, &UNIT)
            .err(),
        Some(Ok(Error::OracleUnavailable))
    );
    m.f.client().mock_all_auths().set_paused(&true);
    let shares = m.f.client().balance(&m.f.alice);
    let supply = m.supply();
    assert_eq!(
        m.f.withdraw(&m.f.alice, shares),
        200 * UNIT * shares / supply
    );
    assert_eq!(m.xlm_balance(&m.f.alice), 200 * UNIT * shares / supply);
}
