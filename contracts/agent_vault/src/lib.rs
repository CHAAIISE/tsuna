#![no_std]
mod adapters;
mod drawdown;
mod errors;
mod fees;
mod leash;
mod oracle;
mod perimeter;
mod shares;
#[cfg(test)]
mod test;
#[cfg(test)]
mod test_oracle;
#[cfg(test)]
mod test_policy;
#[cfg(test)]
mod testutils;

use soroban_sdk::{
    contract, contractevent, contractimpl, contracttype, token, Address, Env, Symbol, Val, Vec,
};

pub use errors::Error;
pub use leash::{LossBucket, Usage};

const BPS: i128 = 10_000;

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
    Paused,
    Blend,
    ProtocolRecipient,
    TotalShares,
    Shares(Address),
    HighWaterMark,
    Usage,
    Revoked,
    Observations,
    Peak(u32, u32),
    Losses,
    Oracle,
    Registry,
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

/// Part of a withdrawal paid in a non-base asset, without conversion.
#[contractevent]
pub struct WithdrawnInKind {
    #[topic]
    pub user: Address,
    #[topic]
    pub asset: Address,
    pub amount: i128,
}

#[contract]
pub struct AgentVault;

#[contractimpl]
impl AgentVault {
    /// `registry` holds this vault's rules; the owner registers them there before any deposit.
    pub fn __constructor(
        env: Env,
        owner: Address,
        agent: Address,
        asset: Address,
        protocol_recipient: Address,
        oracle: Address,
        registry: Address,
    ) {
        let s = env.storage().instance();
        s.set(&Key::Owner, &owner);
        s.set(&Key::Agent, &agent);
        s.set(&Key::Asset, &asset);
        s.set(&Key::Paused, &false);
        s.set(&Key::ProtocolRecipient, &protocol_recipient);
        s.set(&Key::Oracle, &oracle);
        s.set(&Key::Registry, &registry);
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

    pub fn set_blend(env: Env, pool: Address, reserve_index: u32) {
        Self::owner(env.clone()).require_auth();
        env.storage().instance().set(
            &Key::Blend,
            &BlendPosition {
                pool,
                reserve_index,
            },
        );
    }

    pub fn set_paused(env: Env, paused: bool) {
        Self::owner(env.clone()).require_auth();
        env.storage().instance().set(&Key::Paused, &paused);
    }

    pub fn usage(env: Env) -> Usage {
        leash::usage(&env)
    }

    /// NAV lost to executions over the rolling 24 h window, in base-asset units.
    pub fn daily_loss(env: Env) -> Result<i128, Error> {
        leash::daily_loss(&env)
    }

    pub fn revoke_session(env: Env) {
        Self::owner(env.clone()).require_auth();
        env.storage().instance().set(&Key::Revoked, &true);
    }

    pub fn rotate_session(env: Env, agent: Address) {
        Self::owner(env.clone()).require_auth();
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
        let policy = leash::rules(&env)?;
        let nav = nav_of(&env, &policy.assets)?;
        let price = shares::price(&env, nav)?;
        if drawdown::breached(&env, price, policy.limits.max_drawdown_bps)? {
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

    /// Never blocked by pause or by the oracle. Idle non-base assets are valued at exit prices;
    /// if any of them has no usable price, the holder receives their pro-rata share of every
    /// asset in kind instead.
    pub fn withdraw(env: Env, user: Address, shares: i128) -> Result<i128, Error> {
        user.require_auth();
        if shares <= 0 {
            return Err(Error::InvalidAmount);
        }
        if shares > Self::balance(env.clone(), user.clone()) {
            return Err(Error::InsufficientShares);
        }
        let asset: Address = env.storage().instance().get(&Key::Asset).unwrap();
        let token = token::Client::new(&env, &asset);
        let me = env.current_contract_address();
        let assets = leash::assets(&env);
        let held = oracle::held(&env, &assets);
        let priced = match oracle::exit_values(&env, &asset, &held) {
            Some(values) => {
                let extra = sum(&values)?;
                let nav = nav_with(&env, &asset, extra)?;
                // Fees crystallize only on a priced NAV; an in-kind exit has no profit to measure.
                fees::crystallize(&env, nav)?;
                Some((values, extra, nav))
            }
            None => None,
        };
        let supply = shares::effective_supply(&env)?;
        let idle_before = token.balance(&me);
        let idle_claim = shares::mul_div(&env, idle_before, shares, supply, false)?;
        adapters::unwind(&env, &asset, shares, supply)?;
        // Pay only this holder's idle balance and actual adapter proceeds.
        // Protocol rounding dust belongs to the remaining shares.
        let own = idle_claim
            .checked_add(token.balance(&me) - idle_before)
            .ok_or(Error::ArithmeticOverflow)?;
        let mut in_kind: Vec<(Address, i128)> = Vec::new(&env);
        let amount = match &priced {
            Some((values, extra, nav)) => {
                let entitlement =
                    shares::mul_div(&env, shares, shares::effective_assets(*nav)?, supply, false)?;
                let extra_claim = shares::mul_div(&env, *extra, shares, supply, false)?;
                // The holder's share of non-base assets is bought back in base at the exit
                // price while base liquidity lasts; the rest leaves in kind at that price.
                let target = entitlement.min(
                    own.checked_add(extra_claim)
                        .ok_or(Error::ArithmeticOverflow)?,
                );
                let amount = target.min(token.balance(&me));
                let mut residual = target - amount;
                for (index, (held_asset, balance)) in held.iter().enumerate() {
                    let value = values.get_unchecked(index as u32);
                    if residual <= 0 {
                        break;
                    }
                    if value <= 0 {
                        continue;
                    }
                    let units =
                        balance.min(shares::mul_div(&env, residual, balance, value, false)?);
                    if units > 0 {
                        residual -= shares::mul_div(&env, units, value, balance, true)?;
                        in_kind.push_back((held_asset, units));
                    }
                }
                amount
            }
            None => {
                for (held_asset, balance) in held.iter() {
                    let units = shares::mul_div(&env, balance, shares, supply, false)?;
                    if units > 0 {
                        in_kind.push_back((held_asset, units));
                    }
                }
                own
            }
        };
        if amount <= 0 && in_kind.is_empty() {
            return Err(Error::InvalidAmount);
        }
        shares::burn(&env, &user, shares)?;
        if amount > 0 {
            token.transfer(&me, &user, &amount);
        }
        for (held_asset, units) in in_kind.iter() {
            token::Client::new(&env, &held_asset).transfer(&me, &user, &units);
            WithdrawnInKind {
                user: user.clone(),
                asset: held_asset,
                amount: units,
            }
            .publish(&env);
        }
        Withdrawn {
            user,
            amount: amount.max(0),
            shares,
        }
        .publish(&env);
        if priced.is_some() {
            let held = oracle::held(&env, &assets);
            if let Some(values) = oracle::exit_values(&env, &asset, &held) {
                snapshot(&env, nav_with(&env, &asset, sum(&values)?)?)?;
            }
        }
        Ok(amount.max(0))
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
        let policy = leash::rules(&env)?;
        let call = leash::inspect(&env, &policy, &target, &fn_name, &args)?;
        let nav_before = nav_of(&env, &policy.assets)?;
        leash::charge(&env, &policy.limits, call.value, nav_before)?;
        let held = perimeter::holdings(&env, &policy, &target)?;
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
        let nav_after = nav_of(&env, &policy.assets)?;
        let max_loss = call.rule.max_loss_bps;
        if nav_after < shares::mul_div(&env, nav_before, BPS - max_loss as i128, BPS, true)? {
            return Err(Error::NavDropped);
        }
        leash::record_loss(&env, &policy.limits, nav_before - nav_after, nav_before)?;
        perimeter::conserved(&env, &policy, &target, &held, nav_before, max_loss)?;
        perimeter::allowances_cleared(&env, &policy, &call.spenders)?;
        perimeter::exposure_within_cap(&env, &policy, &asset, &exposed, nav_after)?;
        if Self::health_factor(env.clone())? < i128::from(policy.limits.min_health_factor_bps) {
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

    /// Value held by the vault, in units of the base asset: idle balance + Blend supply/collateral
    /// − debt + other idle assets at strict oracle prices. Fails while the oracle cannot vouch
    /// for a held asset, which blocks deposits and the agent but never withdrawals.
    pub fn nav(env: Env) -> Result<i128, Error> {
        nav_of(&env, &leash::assets(&env))
    }

    pub fn oracle(env: Env) -> Address {
        env.storage().instance().get(&Key::Oracle).unwrap()
    }

    pub fn registry(env: Env) -> Address {
        env.storage().instance().get(&Key::Registry).unwrap()
    }

    pub fn owner(env: Env) -> Address {
        env.storage().instance().get(&Key::Owner).unwrap()
    }

    /// Base asset: deposits, withdrawals and NAV are denominated in it.
    pub fn asset(env: Env) -> Address {
        env.storage().instance().get(&Key::Asset).unwrap()
    }
}

/// NAV counting the idle non-base `assets` at strict oracle prices.
fn nav_of(env: &Env, assets: &Vec<Address>) -> Result<i128, Error> {
    let asset: Address = env.storage().instance().get(&Key::Asset).unwrap();
    nav_with(env, &asset, oracle::strict_value(env, &asset, assets)?)
}

/// Base idle balance + adapter positions + `extra` (other assets already valued in base units).
fn nav_with(env: &Env, asset: &Address, extra: i128) -> Result<i128, Error> {
    let idle = token::Client::new(env, asset).balance(&env.current_contract_address());
    let nav = idle
        .checked_add(adapters::nav(env, asset)?)
        .and_then(|nav| nav.checked_add(extra))
        .ok_or(Error::ArithmeticOverflow)?;
    if nav < 0 {
        return Err(Error::Insolvent);
    }
    Ok(nav)
}

fn sum(values: &Vec<i128>) -> Result<i128, Error> {
    values.iter().try_fold(0_i128, |total, value| {
        total.checked_add(value).ok_or(Error::ArithmeticOverflow)
    })
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
