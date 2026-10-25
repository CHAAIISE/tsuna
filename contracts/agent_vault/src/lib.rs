#![no_std]
mod adapters;
mod drawdown;
mod errors;
mod fees;
mod leash;
mod perimeter;
mod shares;
#[cfg(test)]
mod test;
#[cfg(test)]
mod testutils;

use soroban_sdk::{
    contract, contractevent, contractimpl, contracttype, token, Address, Env, Symbol, Val, Vec,
};

pub use errors::Error;
pub use leash::{Limits, LossBucket, Usage};

const BPS: i128 = 10_000;
const MAX_ASSETS: u32 = 8;
const MAX_GUARDS: u32 = 4;

/// Constraint on one positional argument of an allowlisted call.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ArgRule {
    Any,
    /// Must be this vault: blocks `from`/`to`/`spender` pointing at a third party.
    Vault,
    /// Must be an allowlisted protocol (e.g. the spender of an `approve`).
    Protocol,
    /// Non-negative base-asset amount, included in transaction and daily budgets.
    Amount,
    /// Sum of same-base-asset Blend request amounts; never net deposits against withdrawals.
    BlendRequests,
    /// `Vec<Address>` whose every element is one of the vault's allowed assets (e.g. a swap path).
    Assets,
}

/// Allowlist entry for one `(target, fn)` pair.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CallRule {
    pub args: Vec<ArgRule>,
    /// NAV and perimeter loss tolerated for one call (e.g. 10 stable-to-stable, 50 volatile).
    pub max_loss_bps: u32,
    /// The vault grants the target an allowance for the pulled amount, expiring this ledger.
    pub approve: bool,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BlendPosition {
    pub pool: Address,
    pub reserve_index: u32,
}

#[contracttype]
enum Key {
    Owner,
    Agent,
    Asset,
    Assets,
    Paused,
    Blend,
    Rule(Address, Symbol),
    Protocol(Address),
    Guards(Address),
    ProtocolRecipient,
    TotalShares,
    Shares(Address),
    HighWaterMark,
    Limits,
    Usage,
    Revoked,
    Observations,
    Peak(u32, u32),
    Losses,
}

#[contractevent]
pub struct Executed {
    #[topic]
    pub target: Address,
    #[topic]
    pub fn_name: Symbol,
    pub nav_before: i128,
    pub nav_after: i128,
}

#[contractevent]
pub struct NavSnapshot {
    pub nav: i128,
    pub pps: i128,
    pub ts: u64,
}

#[contractevent]
pub struct Deposited {
    #[topic]
    pub user: Address,
    pub amount: i128,
    pub shares: i128,
}

#[contractevent]
pub struct Withdrawn {
    #[topic]
    pub user: Address,
    pub amount: i128,
    pub shares: i128,
}

#[contract]
pub struct AgentVault;

#[contractimpl]
impl AgentVault {
    pub fn __constructor(
        env: Env,
        owner: Address,
        agent: Address,
        asset: Address,
        protocol_recipient: Address,
    ) {
        let s = env.storage().instance();
        s.set(&Key::Owner, &owner);
        s.set(&Key::Agent, &agent);
        s.set(&Key::Asset, &asset);
        s.set(&Key::Assets, &Vec::from_array(&env, [asset.clone()]));
        s.set(&Key::Paused, &false);
        s.set(&Key::ProtocolRecipient, &protocol_recipient);
        s.set(&Key::Limits, &Limits::default());
        s.set(&Key::Revoked, &false);
        s.set(&Key::TotalShares, &0_i128);
        s.set(
            &Key::HighWaterMark,
            &fees::HighWaterMark {
                assets: 1,
                supply: shares::VIRTUAL_SHARES,
            },
        );
    }

    pub fn allow_protocol(env: Env, protocol: Address) {
        Self::owner(&env).require_auth();
        env.storage()
            .persistent()
            .set(&Key::Protocol(protocol), &true);
    }

    pub fn allow_call(
        env: Env,
        target: Address,
        fn_name: Symbol,
        rule: CallRule,
    ) -> Result<(), Error> {
        Self::owner(&env).require_auth();
        if rule.max_loss_bps > BPS as u32 {
            return Err(Error::InvalidConfig);
        }
        env.storage()
            .persistent()
            .set(&Key::Rule(target, fn_name), &rule);
        Ok(())
    }

    /// Assets the agent may route through or request; the base asset stays first.
    pub fn set_assets(env: Env, assets: Vec<Address>) -> Result<(), Error> {
        Self::owner(&env).require_auth();
        let base: Address = env.storage().instance().get(&Key::Asset).unwrap();
        if assets.is_empty() || assets.get_unchecked(0) != base || assets.len() > MAX_ASSETS {
            return Err(Error::InvalidConfig);
        }
        env.storage().instance().set(&Key::Assets, &assets);
        Ok(())
    }

    pub fn assets(env: Env) -> Vec<Address> {
        leash::assets(&env)
    }

    /// Contracts that legitimately custody funds when `protocol` is called
    /// (pool, strategy, pair), counted in the balance-conservation check.
    pub fn set_guards(env: Env, protocol: Address, guards: Vec<Address>) -> Result<(), Error> {
        Self::owner(&env).require_auth();
        if guards.len() > MAX_GUARDS {
            return Err(Error::InvalidConfig);
        }
        env.storage()
            .persistent()
            .set(&Key::Guards(protocol), &guards);
        Ok(())
    }

    pub fn guards(env: Env, protocol: Address) -> Vec<Address> {
        env.storage()
            .persistent()
            .get(&Key::Guards(protocol))
            .unwrap_or(Vec::new(&env))
    }

    pub fn set_blend(env: Env, pool: Address, reserve_index: u32) {
        Self::owner(&env).require_auth();
        env.storage().instance().set(
            &Key::Blend,
            &BlendPosition {
                pool,
                reserve_index,
            },
        );
    }

    pub fn set_paused(env: Env, paused: bool) {
        Self::owner(&env).require_auth();
        env.storage().instance().set(&Key::Paused, &paused);
    }

    pub fn set_limits(env: Env, limits: Limits) -> Result<(), Error> {
        Self::owner(&env).require_auth();
        leash::validate(&limits)?;
        env.storage().instance().set(&Key::Limits, &limits);
        Ok(())
    }

    pub fn limits(env: Env) -> Limits {
        leash::limits(&env)
    }

    pub fn usage(env: Env) -> Usage {
        leash::usage(&env)
    }

    /// NAV lost to executions over the rolling 24 h window, in base-asset units.
    pub fn daily_loss(env: Env) -> Result<i128, Error> {
        leash::daily_loss(&env)
    }

    pub fn revoke_session(env: Env) {
        Self::owner(&env).require_auth();
        env.storage().instance().set(&Key::Revoked, &true);
    }

    pub fn rotate_session(env: Env, agent: Address) {
        Self::owner(&env).require_auth();
        env.storage().instance().set(&Key::Agent, &agent);
        env.storage().instance().set(&Key::Revoked, &false);
    }

    pub fn session(env: Env) -> Option<Address> {
        if env.storage().instance().get(&Key::Revoked).unwrap_or(false) {
            None
        } else {
            env.storage().instance().get(&Key::Agent)
        }
    }

    pub fn paused(env: Env) -> bool {
        env.storage().instance().get(&Key::Paused).unwrap_or(false)
    }

    pub fn health_factor(env: Env) -> Result<i128, Error> {
        let asset: Address = env.storage().instance().get(&Key::Asset).unwrap();
        adapters::health_factor(&env, &asset)
    }

    pub fn check_drawdown(env: Env) -> Result<bool, Error> {
        let nav = Self::nav(env.clone())?;
        let price = shares::price(&env, nav)?;
        if drawdown::breached(&env, price)? {
            env.storage().instance().set(&Key::Paused, &true);
        }
        snapshot(&env, nav)?;
        Ok(Self::paused(env))
    }

    pub fn deposit(env: Env, user: Address, amount: i128) -> Result<i128, Error> {
        user.require_auth();
        if amount <= 0 {
            return Err(Error::InvalidAmount);
        }
        if env.storage().instance().get(&Key::Paused).unwrap_or(false) {
            return Err(Error::Paused);
        }
        let nav = Self::nav(env.clone())?;
        fees::crystallize(&env, nav)?;
        let minted = shares::mul_div(
            &env,
            amount,
            shares::effective_supply(&env)?,
            shares::effective_assets(nav)?,
            false,
        )?;
        if minted == 0 {
            return Err(Error::ZeroShares);
        }
        let asset: Address = env.storage().instance().get(&Key::Asset).unwrap();
        token::Client::new(&env, &asset).transfer(&user, env.current_contract_address(), &amount);
        shares::mint(&env, &user, minted)?;
        Deposited {
            user,
            amount,
            shares: minted,
        }
        .publish(&env);
        snapshot(
            &env,
            nav.checked_add(amount).ok_or(Error::ArithmeticOverflow)?,
        )?;
        Ok(minted)
    }

    pub fn withdraw(env: Env, user: Address, shares: i128) -> Result<i128, Error> {
        user.require_auth();
        if shares <= 0 {
            return Err(Error::InvalidAmount);
        }
        if shares > Self::balance(env.clone(), user.clone()) {
            return Err(Error::InsufficientShares);
        }
        let nav = Self::nav(env.clone())?;
        fees::crystallize(&env, nav)?;
        let supply = shares::effective_supply(&env)?;
        let entitlement =
            shares::mul_div(&env, shares, shares::effective_assets(nav)?, supply, false)?;
        let asset: Address = env.storage().instance().get(&Key::Asset).unwrap();
        let token = token::Client::new(&env, &asset);
        let me = env.current_contract_address();
        let idle_before = token.balance(&me);
        let idle_claim = shares::mul_div(&env, idle_before, shares, supply, false)?;
        adapters::unwind(&env, &asset, shares, supply)?;
        // Pay only this holder's idle balance and actual adapter proceeds.
        // Protocol rounding dust belongs to the remaining shares.
        let available = idle_claim
            .checked_add(token.balance(&me) - idle_before)
            .ok_or(Error::ArithmeticOverflow)?;
        let amount = entitlement.min(available);
        if amount <= 0 {
            return Err(Error::InvalidAmount);
        }
        shares::burn(&env, &user, shares)?;
        token.transfer(&me, &user, &amount);
        Withdrawn {
            user,
            amount,
            shares,
        }
        .publish(&env);
        snapshot(&env, Self::nav(env.clone())?)?;
        Ok(amount)
    }

    pub fn balance(env: Env, user: Address) -> i128 {
        shares::balance(&env, &user)
    }

    pub fn total_shares(env: Env) -> i128 {
        shares::total(&env)
    }

    /// Base-asset units per raw share, scaled by 10^18.
    pub fn price_per_share(env: Env) -> Result<i128, Error> {
        shares::price(&env, Self::nav(env.clone())?)
    }

    pub fn high_water_mark(env: Env) -> Result<i128, Error> {
        fees::high_water_mark(&env)
    }

    /// The only entry point the agent's session key can use. The agent proposes any call;
    /// the vault checks it against the allowlist, runs it, then reverts everything if value left the vault.
    pub fn execute(
        env: Env,
        target: Address,
        fn_name: Symbol,
        args: Vec<Val>,
    ) -> Result<Val, Error> {
        let s = env.storage().instance();
        let agent = Self::session(env.clone()).ok_or(Error::SessionRevoked)?;
        agent.require_auth();
        if Self::paused(env.clone()) {
            return Err(Error::Paused);
        }
        let call = leash::inspect(&env, &target, &fn_name, &args)?;
        let nav_before = Self::nav(env.clone())?;
        leash::charge(&env, call.value, nav_before)?;
        let held = perimeter::holdings(&env, &target)?;
        let asset: Address = s.get(&Key::Asset).unwrap();
        let exposed = adapters::exposures(&env, &asset)?;
        if call.rule.approve && call.pull > 0 {
            token::Client::new(&env, &asset).approve(
                &env.current_contract_address(),
                &target,
                &call.pull,
                &env.ledger().sequence(),
            );
        }
        let out: Val = env.invoke_contract(&target, &fn_name, args);
        let nav_after = Self::nav(env.clone())?;
        let max_loss = call.rule.max_loss_bps;
        if nav_after < shares::mul_div(&env, nav_before, BPS - max_loss as i128, BPS, true)? {
            return Err(Error::NavDropped);
        }
        leash::record_loss(&env, nav_before - nav_after, nav_before)?;
        perimeter::conserved(&env, &target, &held, nav_before, max_loss)?;
        perimeter::allowances_cleared(&env, &call.spenders)?;
        perimeter::exposure_within_cap(&env, &asset, &exposed, nav_after)?;
        if Self::health_factor(env.clone())? < i128::from(leash::limits(&env).min_health_factor_bps)
        {
            return Err(Error::HealthFactorTooLow);
        }
        Executed {
            target,
            fn_name,
            nav_before,
            nav_after,
        }
        .publish(&env);
        fees::crystallize(&env, nav_after)?;
        snapshot(&env, nav_after)?;
        Ok(out)
    }

    /// Value held by the vault, in units of the base asset: idle balance + Blend supply/collateral − debt.
    pub fn nav(env: Env) -> Result<i128, Error> {
        let asset: Address = env.storage().instance().get(&Key::Asset).unwrap();
        let idle = token::Client::new(&env, &asset).balance(&env.current_contract_address());
        let nav = idle
            .checked_add(adapters::nav(&env, &asset)?)
            .ok_or(Error::ArithmeticOverflow)?;
        if nav < 0 {
            return Err(Error::Insolvent);
        }
        Ok(nav)
    }

    pub fn is_protocol(env: &Env, addr: &Address) -> bool {
        env.storage()
            .persistent()
            .get(&Key::Protocol(addr.clone()))
            .unwrap_or(false)
    }

    fn owner(env: &Env) -> Address {
        env.storage().instance().get(&Key::Owner).unwrap()
    }
}

fn snapshot(env: &Env, nav: i128) -> Result<(), Error> {
    let pps = shares::price(env, nav)?;
    drawdown::record(env, pps)?;
    NavSnapshot {
        nav,
        pps,
        ts: env.ledger().timestamp(),
    }
    .publish(env);
    Ok(())
}
