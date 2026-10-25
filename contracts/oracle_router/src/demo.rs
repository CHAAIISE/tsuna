//! Admin-forced prices for the testnet crash demo. Compiled only with the `demo` feature:
//! a production build exposes `is_demo() == false` and no way to force a price.

#[cfg(not(feature = "demo"))]
use soroban_sdk::{Address, Env};

#[cfg(not(feature = "demo"))]
pub(crate) fn enabled(_env: &Env) -> bool {
    false
}

#[cfg(not(feature = "demo"))]
pub(crate) fn forced(_env: &Env, _asset: &Address) -> Option<i128> {
    None
}

#[cfg(feature = "demo")]
pub(crate) use forced_prices::{enabled, forced};

#[cfg(feature = "demo")]
pub(crate) mod forced_prices {
    use soroban_sdk::{contractevent, contractimpl, contracttype, Address, Env};

    use crate::{Error, OracleRouter, OracleRouterArgs, OracleRouterClient};

    #[contracttype]
    enum DemoKey {
        Enabled,
        Price(Address),
    }

    #[contractevent]
    pub struct DemoPriceSet {
        #[topic]
        pub asset: Address,
        pub price: i128,
    }

    pub(crate) fn enabled(env: &Env) -> bool {
        env.storage()
            .instance()
            .get(&DemoKey::Enabled)
            .unwrap_or(false)
    }

    pub(crate) fn forced(env: &Env, asset: &Address) -> Option<i128> {
        if !enabled(env) {
            return None;
        }
        env.storage()
            .persistent()
            .get(&DemoKey::Price(asset.clone()))
    }

    #[contractimpl]
    impl OracleRouter {
        pub fn set_demo(env: Env, enabled: bool) {
            OracleRouter::admin(env.clone()).require_auth();
            env.storage().instance().set(&DemoKey::Enabled, &enabled);
        }

        /// Forced prices bypass sources and the jump breaker and are never stored as
        /// last valid prices, so they cannot outlive demo mode in the exit regime.
        pub fn set_demo_price(env: Env, asset: Address, price: i128) -> Result<(), Error> {
            OracleRouter::admin(env.clone()).require_auth();
            if !enabled(&env) {
                return Err(Error::DemoDisabled);
            }
            if price <= 0 {
                return Err(Error::InvalidConfig);
            }
            env.storage()
                .persistent()
                .set(&DemoKey::Price(asset.clone()), &price);
            DemoPriceSet { asset, price }.publish(&env);
            Ok(())
        }

        pub fn clear_demo_price(env: Env, asset: Address) {
            OracleRouter::admin(env.clone()).require_auth();
            env.storage().persistent().remove(&DemoKey::Price(asset));
        }
    }
}
