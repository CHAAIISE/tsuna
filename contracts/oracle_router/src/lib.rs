#![no_std]
mod demo;
mod sources;
#[cfg(test)]
mod test;
#[cfg(any(test, feature = "testutils"))]
pub mod testutils;

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, Address, BytesN, Env, Symbol,
};

pub use sources::{PriceData, Round};

/// Prices are returned as quote-asset (USDC) units per whole asset unit, with 7 decimals.
pub const DECIMALS: u32 = 7;
pub const ONE: i128 = 10_000_000;
const BPS: i128 = 10_000;
/// A move larger than `max_jump_bps` against a price accepted this recently is suspect.
const JUMP_WINDOW: u64 = 15 * 60;
/// Last valid prices outlive an oracle outage of about a week (5 s ledgers).
const LAST_TTL: u32 = 120_960;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    NoPriceFeed = 1,
    StalePrice = 2,
    SourcesDisagree = 3,
    PriceJump = 4,
    InvalidConfig = 5,
    BadSourceData = 6,
    DemoDisabled = 7,
    /// The pending change's timelock has not passed yet.
    TimelockActive = 8,
    /// Nothing is pending, or `lock` was already called.
    NoChange = 9,
}

/// Asset identifier understood by Reflector (SEP-40).
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ReflectorAsset {
    Stellar(Address),
    Other(Symbol),
}

/// Sources for one asset's USD price. With a Chainlink feed, both sources must be fresh and agree.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Feed {
    pub reflector: ReflectorAsset,
    pub chainlink: Option<BytesN<32>>,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Config {
    pub reflector: Address,
    pub reflector_decimals: u32,
    /// Seconds; Reflector publishes every 300 s.
    pub reflector_max_age: u64,
    pub chainlink: Address,
    /// Seconds; Chainlink rounds only update on deviation or heartbeat.
    pub chainlink_max_age: u64,
    pub max_deviation_bps: u32,
    pub max_jump_bps: u32,
    pub exit_haircut_bps: u32,
}

/// Last price accepted by the strict regime and the ledger time it was accepted.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LastPrice {
    pub price: i128,
    pub ts: u64,
}

/// A change to the price sources, public until it applies.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Change {
    Config(Config),
    Feed(Address, Feed),
    RemoveFeed(Address),
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PendingChange {
    pub change: Change,
    /// Ledger time from which `apply_change` installs it.
    pub eta: u64,
}

#[contracttype]
enum Key {
    Admin,
    Quote,
    Config,
    Feed(Address),
    Last(Address),
    /// Seconds a change waits once the router is locked; absent while it is being set up.
    Timelock,
    Pending,
}

#[contract]
pub struct OracleRouter;

#[contractimpl]
impl OracleRouter {
    /// `quote` is the unit every price is expressed in (USDC); it needs its own USD feed.
    pub fn __constructor(
        env: Env,
        admin: Address,
        quote: Address,
        reflector: Address,
        chainlink: Address,
    ) {
        let s = env.storage().instance();
        s.set(&Key::Admin, &admin);
        s.set(&Key::Quote, &quote);
        s.set(
            &Key::Config,
            &Config {
                reflector,
                reflector_decimals: 14,
                reflector_max_age: 900,
                chainlink,
                chainlink_max_age: 90_000,
                max_deviation_bps: 200,
                max_jump_bps: 1_500,
                exit_haircut_bps: 500,
            },
        );
    }

    /// Ends the setup phase: from now on every change to the config or the feeds waits
    /// `timelock` seconds in public (`pending_change`) before anyone can apply it.
    pub fn lock(env: Env, timelock: u64) -> Result<(), Error> {
        Self::admin(env.clone()).require_auth();
        if Self::timelock(env.clone()).is_some() {
            return Err(Error::NoChange);
        }
        if timelock == 0 {
            return Err(Error::InvalidConfig);
        }
        env.storage().instance().set(&Key::Timelock, &timelock);
        Ok(())
    }

    pub fn timelock(env: Env) -> Option<u64> {
        env.storage().instance().get(&Key::Timelock)
    }

    pub fn pending_change(env: Env) -> Option<PendingChange> {
        env.storage().instance().get(&Key::Pending)
    }

    /// Installs the pending change once its timelock has passed. Anyone may call it.
    pub fn apply_change(env: Env) -> Result<(), Error> {
        let pending = Self::pending_change(env.clone()).ok_or(Error::NoChange)?;
        if env.ledger().timestamp() < pending.eta {
            return Err(Error::TimelockActive);
        }
        env.storage().instance().remove(&Key::Pending);
        install(&env, pending.change);
        Ok(())
    }

    pub fn cancel_change(env: Env) {
        Self::admin(env.clone()).require_auth();
        env.storage().instance().remove(&Key::Pending);
    }

    pub fn set_config(env: Env, config: Config) -> Result<(), Error> {
        Self::admin(env.clone()).require_auth();
        if config.reflector_decimals > 30
            || config.reflector_max_age == 0
            || config.chainlink_max_age == 0
            || config.max_deviation_bps == 0
            || config.max_deviation_bps > BPS as u32
            || config.max_jump_bps == 0
            || config.exit_haircut_bps >= BPS as u32
        {
            return Err(Error::InvalidConfig);
        }
        propose(&env, Change::Config(config));
        Ok(())
    }

    pub fn set_feed(env: Env, asset: Address, feed: Feed) {
        Self::admin(env.clone()).require_auth();
        propose(&env, Change::Feed(asset, feed));
    }

    pub fn remove_feed(env: Env, asset: Address) {
        Self::admin(env.clone()).require_auth();
        propose(&env, Change::RemoveFeed(asset));
    }

    pub fn admin(env: Env) -> Address {
        env.storage().instance().get(&Key::Admin).unwrap()
    }

    pub fn quote(env: Env) -> Address {
        env.storage().instance().get(&Key::Quote).unwrap()
    }

    pub fn config(env: Env) -> Config {
        env.storage().instance().get(&Key::Config).unwrap()
    }

    pub fn feed(env: Env, asset: Address) -> Option<Feed> {
        env.storage().persistent().get(&Key::Feed(asset))
    }

    pub fn last_price(env: Env, asset: Address) -> Option<LastPrice> {
        env.storage().temporary().get(&Key::Last(asset))
    }

    /// `true` only in a build compiled with the `demo` feature while the admin has demo mode on.
    pub fn is_demo(env: Env) -> bool {
        demo::enabled(&env)
    }

    /// Price for agent paths: every configured source must be fresh, sources must agree
    /// and the price may not jump against the last accepted one. Fails closed.
    pub fn price_strict(env: Env, asset: Address) -> Result<i128, Error> {
        if let Some(price) = demo::forced(&env, &asset) {
            return Ok(price);
        }
        let quoted = quoted(&env, &asset)?;
        if quoted.feed.is_some() {
            guard_jump(&env, &asset, &quoted)?;
            accept(&env, &asset, quoted.price);
        }
        Ok(quoted.price)
    }

    /// Price for withdrawals, which must never be blocked by the oracle: the strict price when
    /// available, otherwise the last valid price cut by `exit_haircut_bps` so the leaver bears
    /// the uncertainty. `None` means no valid price exists and the asset must be paid in kind.
    pub fn price_for_exit(env: Env, asset: Address) -> Option<i128> {
        if let Some(price) = demo::forced(&env, &asset) {
            return Some(price);
        }
        let config = Self::config(env.clone());
        let fallback = || {
            Self::last_price(env.clone(), asset.clone()).and_then(|last| {
                last.price
                    .checked_mul(BPS - config.exit_haircut_bps as i128)
                    .map(|scaled| scaled / BPS)
            })
        };
        match quoted(&env, &asset) {
            Ok(quoted) if quoted.feed.is_none() => Some(quoted.price),
            Ok(quoted) => match guard_jump(&env, &asset, &quoted) {
                Ok(()) => {
                    accept(&env, &asset, quoted.price);
                    Some(quoted.price)
                }
                // A sudden crash must not let the leaver exit at the pre-crash price.
                Err(_) => fallback().map(|price| price.min(quoted.price)),
            },
            Err(Error::NoPriceFeed) => None,
            Err(_) => fallback(),
        }
    }
}

struct Quoted {
    price: i128,
    /// `None` for the quote asset itself.
    feed: Option<(Feed, Feed)>,
}

/// Asset price in quote units (7 decimals), before the jump breaker.
fn quoted(env: &Env, asset: &Address) -> Result<Quoted, Error> {
    let quote: Address = env.storage().instance().get(&Key::Quote).unwrap();
    let feed = |asset: &Address| -> Result<Feed, Error> {
        env.storage()
            .persistent()
            .get(&Key::Feed(asset.clone()))
            .ok_or(Error::NoPriceFeed)
    };
    if *asset == quote {
        return Ok(Quoted {
            price: ONE,
            feed: None,
        });
    }
    let asset_feed = feed(asset)?;
    let quote_feed = feed(&quote)?;
    let config: Config = env.storage().instance().get(&Key::Config).unwrap();
    let asset_usd = usd(env, &config, &asset_feed)?;
    let quote_usd = usd(env, &config, &quote_feed)?;
    let price = asset_usd.checked_mul(ONE).ok_or(Error::BadSourceData)? / quote_usd;
    if price <= 0 {
        return Err(Error::BadSourceData);
    }
    Ok(Quoted {
        price,
        feed: Some((asset_feed, quote_feed)),
    })
}

/// 18-decimal USD price, averaged over both sources when the asset has a Chainlink feed.
fn usd(env: &Env, config: &Config, feed: &Feed) -> Result<i128, Error> {
    let reflector = sources::reflector(env, config, &feed.reflector)?;
    let Some(data_id) = &feed.chainlink else {
        return Ok(reflector);
    };
    let chainlink = sources::chainlink(env, config, data_id)?;
    let (low, high) = (reflector.min(chainlink), reflector.max(chainlink));
    if sources::moved(high, low, config.max_deviation_bps) {
        return Err(Error::SourcesDisagree);
    }
    Ok(low + (high - low) / 2)
}

/// A large move within the jump window passes only if two independent sources already agree
/// on it, or if both Reflector series involved held the new level over their last two updates.
fn guard_jump(env: &Env, asset: &Address, quoted: &Quoted) -> Result<(), Error> {
    let Some((asset_feed, quote_feed)) = &quoted.feed else {
        return Ok(());
    };
    let Some(last) = env
        .storage()
        .temporary()
        .get::<_, LastPrice>(&Key::Last(asset.clone()))
    else {
        return Ok(());
    };
    let config: Config = env.storage().instance().get(&Key::Config).unwrap();
    if env.ledger().timestamp().saturating_sub(last.ts) >= JUMP_WINDOW
        || !sources::moved(quoted.price, last.price, config.max_jump_bps)
    {
        return Ok(());
    }
    let confirmed = asset_feed.chainlink.is_some()
        || (sources::reflector_stable(
            env,
            &config,
            &asset_feed.reflector,
            config.max_deviation_bps,
        ) && sources::reflector_stable(
            env,
            &config,
            &quote_feed.reflector,
            config.max_deviation_bps,
        ));
    if confirmed {
        Ok(())
    } else {
        Err(Error::PriceJump)
    }
}

fn accept(env: &Env, asset: &Address, price: i128) {
    let key = Key::Last(asset.clone());
    let temporary = env.storage().temporary();
    temporary.set(
        &key,
        &LastPrice {
            price,
            ts: env.ledger().timestamp(),
        },
    );
    temporary.extend_ttl(&key, LAST_TTL, LAST_TTL);
}

/// Applies at once during setup; once locked, queues the change behind the timelock
/// (a new proposal replaces the pending one and restarts its clock).
fn propose(env: &Env, change: Change) {
    match OracleRouter::timelock(env.clone()) {
        None => install(env, change),
        Some(timelock) => env.storage().instance().set(
            &Key::Pending,
            &PendingChange {
                change,
                eta: env.ledger().timestamp() + timelock,
            },
        ),
    }
}

fn install(env: &Env, change: Change) {
    match change {
        Change::Config(config) => env.storage().instance().set(&Key::Config, &config),
        Change::Feed(asset, feed) => env.storage().persistent().set(&Key::Feed(asset), &feed),
        Change::RemoveFeed(asset) => env.storage().persistent().remove(&Key::Feed(asset)),
    }
}
