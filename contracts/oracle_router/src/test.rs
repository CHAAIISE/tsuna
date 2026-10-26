extern crate std;

use crate::{
    testutils::{MockChainlink, MockChainlinkClient, MockReflector, MockReflectorClient},
    Error, Feed, LastPrice, OracleRouter, OracleRouterClient, ReflectorAsset, ONE,
};
use soroban_sdk::{
    testutils::{Address as _, Ledger},
    Address, BytesN, Env, Symbol,
};

const START: u64 = 1_800_000_000;
/// One USD with Reflector's 14 decimals.
const R_USD: i128 = 100_000_000_000_000;
/// One USD with Chainlink's 18 decimals.
const C_USD: i128 = 1_000_000_000_000_000_000;

struct Fixture {
    env: Env,
    router: Address,
    reflector: Address,
    chainlink: Address,
    usdc: Address,
    xlm: Address,
    btc: Address,
    btc_feed: BytesN<32>,
}

impl Fixture {
    fn new() -> Self {
        let env = Env::default();
        env.ledger().set_timestamp(START);
        let admin = Address::generate(&env);
        let usdc = Address::generate(&env);
        let xlm = Address::generate(&env);
        let btc = Address::generate(&env);
        let reflector = env.register(MockReflector, ());
        let chainlink = env.register(MockChainlink, ());
        let router = env.register(
            OracleRouter,
            (admin, usdc.clone(), reflector.clone(), chainlink.clone()),
        );
        let btc_feed = BytesN::from_array(&env, &[7; 32]);
        let f = Self {
            env,
            router,
            reflector,
            chainlink,
            usdc,
            xlm,
            btc,
            btc_feed,
        };
        let client = f.client().mock_all_auths();
        client.set_feed(&f.usdc, &f.reflector_feed("USDC", None));
        client.set_feed(&f.xlm, &f.reflector_feed("XLM", None));
        client.set_feed(&f.btc, &f.reflector_feed("BTC", Some(f.btc_feed.clone())));
        f.push("USDC", R_USD, START);
        f.push("XLM", 17 * R_USD / 100, START);
        f.push("BTC", 80_000 * R_USD, START);
        f.round(80_000 * C_USD, START);
        f
    }

    fn client(&self) -> OracleRouterClient<'_> {
        OracleRouterClient::new(&self.env, &self.router)
    }

    fn reflector_feed(&self, ticker: &str, chainlink: Option<BytesN<32>>) -> Feed {
        Feed {
            reflector: ReflectorAsset::Other(Symbol::new(&self.env, ticker)),
            chainlink,
        }
    }

    fn push(&self, ticker: &str, price: i128, timestamp: u64) {
        MockReflectorClient::new(&self.env, &self.reflector).push(
            &ReflectorAsset::Other(Symbol::new(&self.env, ticker)),
            &price,
            &timestamp,
        );
    }

    fn round(&self, answer: i128, timestamp: u64) {
        MockChainlinkClient::new(&self.env, &self.chainlink).set_round(
            &self.btc_feed,
            &answer,
            &timestamp,
        );
    }

    fn at(&self, timestamp: u64) {
        self.env.ledger().set_timestamp(timestamp);
    }

    fn strict(&self, asset: &Address) -> Result<i128, Error> {
        self.client()
            .try_price_strict(asset)
            .map(|price| price.unwrap())
            .map_err(|error| error.unwrap())
    }
}

#[test]
fn prices_are_quoted_in_usdc_with_seven_decimals() {
    let f = Fixture::new();
    assert_eq!(f.strict(&f.xlm), Ok(1_700_000));
    assert_eq!(f.strict(&f.btc), Ok(80_000 * ONE));
    assert_eq!(f.strict(&f.usdc), Ok(ONE));
    // A depegged quote moves every price: 0.17 USD / 0.98 USD.
    f.push("USDC", 98 * R_USD / 100, START + 300);
    f.at(START + 300);
    assert_eq!(f.strict(&f.xlm), Ok(1_734_693));
    assert_eq!(
        f.client().last_price(&f.xlm),
        Some(LastPrice {
            price: 1_734_693,
            ts: START + 300
        })
    );
}

#[test]
fn unconfigured_asset_has_no_price() {
    let f = Fixture::new();
    let unknown = Address::generate(&f.env);
    assert_eq!(f.strict(&unknown), Err(Error::NoPriceFeed));
    assert_eq!(f.client().price_for_exit(&unknown), None);
    f.client().mock_all_auths().remove_feed(&f.usdc);
    assert_eq!(f.strict(&f.xlm), Err(Error::NoPriceFeed));
}

#[test]
fn stale_price() {
    let f = Fixture::new();
    f.at(START + 900);
    assert_eq!(f.strict(&f.xlm), Ok(1_700_000));
    f.at(START + 901);
    assert_eq!(f.strict(&f.xlm), Err(Error::StalePrice));
    // A stale quote fails every asset, even with a fresh asset price.
    f.push("XLM", 17 * R_USD / 100, START + 901);
    assert_eq!(f.strict(&f.xlm), Err(Error::StalePrice));
    // Chainlink only updates on deviation or heartbeat, so its window is longer,
    // but a configured second source that stopped updating still fails closed.
    let f = Fixture::new();
    f.at(START + 90_001);
    f.push("USDC", R_USD, START + 90_001);
    f.push("BTC", 80_000 * R_USD, START + 90_001);
    assert_eq!(f.strict(&f.btc), Err(Error::StalePrice));
    f.round(80_000 * C_USD, START + 90_001);
    assert_eq!(f.strict(&f.btc), Ok(80_000 * ONE));
}

#[test]
fn sources_disagree() {
    let f = Fixture::new();
    // Default tolerance between Reflector and Chainlink is 2%.
    f.round(81_601 * C_USD, START);
    assert_eq!(f.strict(&f.btc), Err(Error::SourcesDisagree));
    assert_eq!(f.client().last_price(&f.btc), None);
    f.round(81_600 * C_USD, START);
    assert_eq!(f.strict(&f.btc), Ok(80_800 * ONE));
    f.round(78_000 * C_USD, START);
    assert_eq!(f.strict(&f.btc), Err(Error::SourcesDisagree));
}

#[test]
fn price_jump() {
    let f = Fixture::new();
    assert_eq!(f.strict(&f.xlm), Ok(1_700_000));
    // +17.6% against a price accepted 5 minutes ago.
    f.at(START + 300);
    f.push("USDC", R_USD, START + 300);
    f.push("XLM", 20 * R_USD / 100, START + 300);
    assert_eq!(f.strict(&f.xlm), Err(Error::PriceJump));
    // Withdrawals still get a price, haircut and never above the suspect one.
    assert_eq!(f.client().price_for_exit(&f.xlm), Some(1_615_000));
    // The new level held over two Reflector updates: accepted.
    f.at(START + 600);
    f.push("USDC", R_USD, START + 600);
    f.push("XLM", 20 * R_USD / 100, START + 600);
    assert_eq!(f.strict(&f.xlm), Ok(2_000_000));
    // A crash is also refused until it is confirmed.
    f.at(START + 900);
    f.push("USDC", R_USD, START + 900);
    f.push("XLM", 10 * R_USD / 100, START + 900);
    assert_eq!(f.strict(&f.xlm), Err(Error::PriceJump));
    assert_eq!(f.client().price_for_exit(&f.xlm), Some(1_000_000));
    // Moves under the threshold, or older than 15 minutes, are not jumps.
    f.at(START + 1_500);
    f.push("USDC", R_USD, START + 1_500);
    assert_eq!(f.strict(&f.xlm), Ok(1_000_000));
    f.push("XLM", 11 * R_USD / 100, START + 1_500);
    assert_eq!(f.strict(&f.xlm), Ok(1_100_000));
    // Two agreeing sources confirm a move immediately.
    f.push("BTC", 80_000 * R_USD, START + 1_500);
    assert_eq!(f.strict(&f.btc), Ok(80_000 * ONE));
    f.at(START + 1_800);
    f.push("USDC", R_USD, START + 1_800);
    f.push("BTC", 100_000 * R_USD, START + 1_800);
    f.round(100_000 * C_USD, START + 1_800);
    assert_eq!(f.strict(&f.btc), Ok(100_000 * ONE));
}

#[test]
fn exit_price_falls_back_to_last_valid_price_with_haircut() {
    let f = Fixture::new();
    assert_eq!(f.client().price_for_exit(&f.xlm), Some(1_700_000));
    f.at(START + 3_600);
    assert_eq!(f.strict(&f.xlm), Err(Error::StalePrice));
    assert_eq!(f.client().price_for_exit(&f.xlm), Some(1_615_000));
    // No valid price was ever accepted: the asset must leave in kind.
    let f = Fixture::new();
    f.at(START + 3_600);
    assert_eq!(f.client().price_for_exit(&f.xlm), None);
    // A broken source behaves like a missing price, never like a trap.
    let f = Fixture::new();
    let mut config = f.client().config();
    config.reflector = Address::generate(&f.env);
    f.client().mock_all_auths().set_config(&config);
    assert_eq!(f.strict(&f.xlm), Err(Error::StalePrice));
    assert_eq!(f.client().price_for_exit(&f.xlm), None);
}

#[test]
fn configuration_is_admin_only_and_validated() {
    let f = Fixture::new();
    let config = f.client().config();
    assert!(f.client().try_set_config(&config).is_err());
    assert!(f
        .client()
        .try_set_feed(&f.xlm, &f.reflector_feed("XLM", None))
        .is_err());
    assert!(f.client().try_remove_feed(&f.xlm).is_err());
    for invalid in [
        crate::Config {
            exit_haircut_bps: 10_000,
            ..config.clone()
        },
        crate::Config {
            max_jump_bps: 0,
            ..config.clone()
        },
        crate::Config {
            max_deviation_bps: 0,
            ..config.clone()
        },
        crate::Config {
            reflector_max_age: 0,
            ..config.clone()
        },
        crate::Config {
            reflector_decimals: 31,
            ..config.clone()
        },
    ] {
        assert_eq!(
            f.client().mock_all_auths().try_set_config(&invalid),
            Err(Ok(Error::InvalidConfig))
        );
    }
    assert!(!f.client().is_demo());
}

#[cfg(feature = "demo")]
#[test]
fn demo_prices_are_admin_only_flagged_and_never_stored() {
    use crate::demo::forced_prices::DemoPriceSet;
    use soroban_sdk::{testutils::Events, Event};

    let f = Fixture::new();
    assert_eq!(
        f.client().mock_all_auths().try_set_demo_price(&f.xlm, &ONE),
        Err(Ok(Error::DemoDisabled))
    );
    assert!(f.client().try_set_demo(&true).is_err());
    f.client().mock_all_auths().set_demo(&true);
    assert!(f.client().is_demo());
    f.client().mock_all_auths().set_demo_price(&f.xlm, &850_000);
    let events = f.env.events().all();
    assert_eq!(
        events.events().last().unwrap(),
        &DemoPriceSet {
            asset: f.xlm.clone(),
            price: 850_000
        }
        .to_xdr(&f.env, &f.router)
    );
    assert_eq!(f.strict(&f.xlm), Ok(850_000));
    assert_eq!(f.client().price_for_exit(&f.xlm), Some(850_000));
    assert_eq!(f.client().last_price(&f.xlm), None);
    f.client().mock_all_auths().set_demo(&false);
    assert_eq!(f.strict(&f.xlm), Ok(1_700_000));
}

#[test]
fn locked_router_waits_out_the_timelock_before_changing_sources() {
    let f = Fixture::new();
    let client = f.client().mock_all_auths();
    client.lock(&600);
    assert_eq!(client.try_lock(&600), Err(Ok(Error::NoChange)));
    assert_eq!(f.strict(&f.xlm), Ok(1_700_000));
    // Dropping a feed is proposed, not applied: the price still comes from Reflector.
    client.remove_feed(&f.xlm);
    assert_eq!(f.strict(&f.xlm), Ok(1_700_000));
    let pending = client.pending_change().unwrap();
    assert_eq!(pending.eta, START + 600);
    assert_eq!(client.try_apply_change(), Err(Ok(Error::TimelockActive)));
    // Widening the allowed divergence waits as well, and replaces the earlier proposal.
    let mut loose = client.config();
    loose.max_deviation_bps = 10_000;
    client.set_config(&loose);
    assert_eq!(client.config().max_deviation_bps, 200);
    f.at(START + 600);
    f.push("XLM", 17 * R_USD / 100, START + 600);
    client.apply_change();
    assert_eq!(client.config().max_deviation_bps, 10_000);
    assert_eq!(client.feed(&f.xlm).is_some(), true);
    assert_eq!(client.pending_change(), None);
    assert_eq!(client.try_apply_change(), Err(Ok(Error::NoChange)));
}
