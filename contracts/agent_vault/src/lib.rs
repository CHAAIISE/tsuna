#![no_std]
mod adapters;
mod drawdown;
mod errors;
mod fees;
mod leash;
mod oracle;
mod perimeter;
mod roles;
mod shares;
#[cfg(test)]
mod test;
#[cfg(test)]
mod test_adapters;
#[cfg(test)]
mod test_oracle;
#[cfg(test)]
mod test_policy;
#[cfg(test)]
mod test_roles;
#[cfg(test)]
mod testutils;

use soroban_sdk::{
    contract, contractevent, contractimpl, contracttype, token, Address, Env, Symbol, Val, Vec,
};

pub use adapters::{Adapter, AdapterKind, MAX_POSITIONS};
pub use errors::Error;
pub use leash::{LossBucket, Usage};
use oracle::Prices;
use policy_registry::RoleMode;

const BPS: i128 = 10_000;

#[contracttype]
enum Key {
    Owner,
    Agent,
    Asset,
    Paused,
    Adapters,
    /// XOXNO account (position NFT id) the vault owns at a controller.
    Account(Address),
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
    /// Budget counters of a named role; the default role keeps `Usage` and `Losses`.
    RoleUsage(Symbol),
    RoleLosses(Symbol),
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

/// An execution by a named role; the default role publishes [`Executed`].
#[contractevent]
pub struct RoleExecuted {
    #[topic]
    pub role: Symbol,
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

    /// Values and unwinds `protocol` with the `kind` adapter. The protocol must be allowlisted
    /// in the registry policy, and at most [`MAX_POSITIONS`] adapters may hold positions.
    pub fn set_adapter(env: Env, kind: AdapterKind, protocol: Address) -> Result<(), Error> {
        Self::owner(env.clone()).require_auth();
        adapters::register(&env, &leash::rules(&env)?, kind, protocol)
    }

    /// Refused while the protocol still holds value or debt for the vault.
    pub fn remove_adapter(env: Env, protocol: Address) -> Result<(), Error> {
        Self::owner(env.clone()).require_auth();
        adapters::remove(
            &env,
            &protocol,
            &mut Prices::strict(&env, &Self::asset(env.clone())),
        )
    }

    pub fn adapters(env: Env) -> Vec<Adapter> {
        adapters::list(&env)
    }

    pub fn set_paused(env: Env, paused: bool) {
        Self::owner(env.clone()).require_auth();
        env.storage().instance().set(&Key::Paused, &paused);
    }

    pub fn usage(env: Env) -> Usage {
        leash::usage(&env, None)
    }

    /// NAV lost to executions over the rolling 24 h window, in base-asset units.
    pub fn daily_loss(env: Env) -> Result<i128, Error> {
        leash::daily_loss(&env, None)
    }

    /// Budget counters of `role`; `default` reads the same counters as [`Self::usage`].
    pub fn role_usage(env: Env, role: Symbol) -> Usage {
        leash::usage(&env, roles::counters(&env, &role).as_ref())
    }

    pub fn role_daily_loss(env: Env, role: Symbol) -> Result<i128, Error> {
        leash::daily_loss(&env, roles::counters(&env, &role).as_ref())
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

    /// Lowest health factor across lending positions in bps, at strict oracle prices.
    pub fn health_factor(env: Env) -> Result<i128, Error> {
        let mut prices = Prices::strict(&env, &Self::asset(env.clone()));
        Ok(strict_book(&env, &mut prices)?.health)
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

    /// Never blocked by pause or by the oracle. The vault exits the holder's share of every
    /// protocol position itself. Non-base assets are valued at exit prices; if any of them has
    /// no usable price, the holder receives their pro-rata share of every asset in kind instead.
    /// A leveraged position is exited only as far as its debt can be repaid from idle balances,
    /// so fewer shares than requested may be redeemed: the event and balances show how many.
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
        let mut prices = Prices::exit(&env, &asset);
        let nav = exit_nav(&env, &asset, &assets, &mut prices)?;
        if let Some(nav) = nav {
            // Fees crystallize only on a priced NAV; an in-kind exit has no profit to measure.
            fees::crystallize(&env, nav)?;
        }
        let supply = shares::effective_supply(&env)?;
        let shares = adapters::exitable(&env, shares, supply, nav.is_some())?;
        if shares == 0 {
            return Err(Error::RepaymentUnavailable);
        }
        let before = balances(&env, &assets);
        adapters::unwind(&env, shares, supply)?;
        let after = balances(&env, &assets);
        // The holder's claim on each asset: their pro-rata idle balance plus every unwind
        // proceed. Protocol rounding dust belongs to the remaining shares.
        let own = shares::mul_div(&env, before.get_unchecked(0), shares, supply, false)?
            .checked_add(after.get_unchecked(0) - before.get_unchecked(0))
            .ok_or(Error::ArithmeticOverflow)?;
        let mut in_kind: Vec<(Address, i128)> = Vec::new(&env);
        let amount = match nav {
            Some(nav) => {
                let entitlement =
                    shares::mul_div(&env, shares, shares::effective_assets(nav)?, supply, false)?;
                let mut claim = own;
                for (index, held_asset) in assets.iter().enumerate().skip(1) {
                    let index = index as u32;
                    let (idle, now) = (before.get_unchecked(index), after.get_unchecked(index));
                    let idle_value = prices.value(&env, &held_asset, idle)?.unwrap_or(0);
                    let proceeds = prices.delta(&env, &held_asset, now - idle)?.unwrap_or(0);
                    claim = claim
                        .checked_add(shares::mul_div(&env, idle_value, shares, supply, false)?)
                        .and_then(|claim| claim.checked_add(proceeds))
                        .ok_or(Error::ArithmeticOverflow)?;
                }
                // The holder's share of non-base assets is bought back in base at the exit
                // price while base liquidity lasts; the rest leaves in kind at that price.
                let target = entitlement.min(claim);
                let amount = target.min(token.balance(&me));
                let mut residual = target - amount;
                for (index, held_asset) in assets.iter().enumerate().skip(1) {
                    if residual <= 0 {
                        break;
                    }
                    let balance = after.get_unchecked(index as u32);
                    let value = match prices.value(&env, &held_asset, balance)? {
                        Some(value) if value > 0 => value,
                        _ => continue,
                    };
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
                for (index, held_asset) in assets.iter().enumerate().skip(1) {
                    let index = index as u32;
                    let (idle, now) = (before.get_unchecked(index), after.get_unchecked(index));
                    let units = shares::mul_div(&env, idle, shares, supply, false)?
                        .checked_add(now - idle)
                        .ok_or(Error::ArithmeticOverflow)?;
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
        if nav.is_some() {
            if let Some(nav) = exit_nav(&env, &asset, &assets, &mut prices)? {
                snapshot(&env, nav)?;
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
        let agent = Self::session(env.clone()).ok_or(Error::SessionRevoked)?;
        agent.require_auth();
        let scope = roles::default_scope(&env)?;
        Self::run(env, scope, target, fn_name, args)
    }

    /// `execute` on behalf of `role`, signed by its `member`, with that role's allowlist and
    /// quotas. Role `default` is `execute` itself: the session key, the policy's own `calls`
    /// and `limits`. A RiskOff role may act while paused, provided the call reduces risk.
    pub fn execute_as(
        env: Env,
        member: Address,
        role: Symbol,
        target: Address,
        fn_name: Symbol,
        args: Vec<Val>,
    ) -> Result<Val, Error> {
        member.require_auth();
        let scope = if roles::counters(&env, &role).is_none() {
            if Self::session(env.clone()).ok_or(Error::SessionRevoked)? != member {
                return Err(Error::NotRoleMember);
            }
            roles::default_scope(&env)?
        } else {
            roles::named(&env, &member, role)?
        };
        Self::run(env, scope, target, fn_name, args)
    }

    fn run(
        env: Env,
        scope: roles::Scope,
        target: Address,
        fn_name: Symbol,
        args: Vec<Val>,
    ) -> Result<Val, Error> {
        let roles::Scope { name, mode, policy } = scope;
        let role = name.as_ref();
        let asset = Self::asset(env.clone());
        // One price per asset for the whole call: before and after are valued alike.
        let mut prices = Prices::strict(&env, &asset);
        let call = leash::inspect(&env, &policy, &target, &fn_name, &args, &mut prices)?;
        let before = valuation(&env, &policy.assets, &mut prices)?;
        let prepared = adapters::prepare(
            &env,
            &policy,
            &call.rule,
            &target,
            &fn_name,
            &args,
            &mut prices,
        )?;
        let committed = prepared.value.unwrap_or(call.value);
        leash::charge(&env, &policy.limits, committed, before.nav, role)?;
        let held = perimeter::holdings(&env, &policy, &target)?;
        let assets_before = (mode == RoleMode::RiskOff).then(|| oracle::held(&env, &policy.assets));
        if call.rule.approve {
            let me = env.current_contract_address();
            for (pulled, amount) in call.pulls.iter() {
                if amount > 0 {
                    token::Client::new(&env, &pulled).approve(
                        &me,
                        &target,
                        &amount,
                        &env.ledger().sequence(),
                    );
                }
            }
        }
        if !prepared.auth.is_empty() {
            env.authorize_as_current_contract(prepared.auth);
        }
        let out: Val = env.invoke_contract(&target, &fn_name, args.clone());
        adapters::settle(&env, &target, &fn_name, &args, &out)?;
        let after = valuation(&env, &policy.assets, &mut prices)?;
        let (nav_before, nav_after) = (before.nav, after.nav);
        let max_loss = call.rule.max_loss_bps;
        let guarded = (|| -> Result<(), Error> {
            if nav_after < shares::mul_div(&env, nav_before, BPS - max_loss as i128, BPS, true)? {
                return Err(Error::NavDropped);
            }
            leash::record_loss(
                &env,
                &policy.limits,
                nav_before - nav_after,
                nav_before,
                role,
            )?;
            perimeter::conserved(&env, &policy, &target, &held, nav_before, max_loss)?;
            perimeter::allowances_cleared(&env, &policy, &call.spenders)
        })();
        roles::outcome(mode, guarded)?;
        if let Some(assets_before) = assets_before {
            let assets_after = oracle::held(&env, &policy.assets);
            let tolerance = shares::mul_div(&env, nav_before, max_loss.into(), BPS, false)?;
            roles::risk_not_increased(&before, &after, &assets_before, &assets_after, tolerance)?;
        } else {
            perimeter::exposure_within_cap(
                &env,
                &policy,
                &before.exposures,
                &after.exposures,
                nav_after,
            )?;
            if after.health < i128::from(policy.limits.min_health_factor_bps) {
                return Err(Error::HealthFactorTooLow);
            }
        }
        match name {
            None => Executed {
                target,
                fn_name,
                nav_before,
                nav_after,
            }
            .publish(&env),
            Some(role) => RoleExecuted {
                role,
                target,
                fn_name,
                nav_before,
                nav_after,
            }
            .publish(&env),
        }
        fees::crystallize(&env, nav_after)?;
        snapshot(&env, nav_after)?;
        Ok(out)
    }

    /// Value held by the vault, in units of the base asset: idle balances plus every protocol
    /// position net of debt, non-base assets at strict oracle prices. Fails while the oracle
    /// cannot vouch for a held asset, which blocks deposits and the agent but never withdrawals.
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

/// Strict NAV with the per-protocol exposures and health factor it was computed from.
struct Valuation {
    nav: i128,
    /// Idle non-base assets, in base units.
    idle: i128,
    exposures: Vec<(Address, i128)>,
    health: i128,
}

/// The strict regime prices every position (unpriced assets count as 0, unpriced debts fail).
fn strict_book(env: &Env, prices: &mut Prices) -> Result<adapters::Book, Error> {
    adapters::book(env, prices)?.ok_or(Error::OracleUnavailable)
}

fn valuation(env: &Env, assets: &Vec<Address>, prices: &mut Prices) -> Result<Valuation, Error> {
    let idle = oracle::strict_value(env, prices, assets)?;
    let book = strict_book(env, prices)?;
    let extra = idle
        .checked_add(book.net)
        .ok_or(Error::ArithmeticOverflow)?;
    Ok(Valuation {
        nav: nav_with(env, prices.base(), extra)?,
        idle,
        exposures: book.exposures,
        health: book.health,
    })
}

/// Strict NAV counting the idle non-base `assets`.
fn nav_of(env: &Env, assets: &Vec<Address>) -> Result<i128, Error> {
    let asset: Address = env.storage().instance().get(&Key::Asset).unwrap();
    Ok(valuation(env, assets, &mut Prices::strict(env, &asset))?.nav)
}

/// Exit-regime NAV, or `None` when an idle asset or a position has no usable price.
fn exit_nav(
    env: &Env,
    asset: &Address,
    assets: &Vec<Address>,
    prices: &mut Prices,
) -> Result<Option<i128>, Error> {
    let held = oracle::held(env, assets);
    let Some(values) = oracle::exit_values(env, prices, &held) else {
        return Ok(None);
    };
    let Some(book) = adapters::book(env, prices)? else {
        return Ok(None);
    };
    let extra = values
        .iter()
        .try_fold(book.net, |total, value| total.checked_add(value))
        .ok_or(Error::ArithmeticOverflow)?;
    Ok(Some(nav_with(env, asset, extra)?))
}

/// Base idle balance + `extra` (other assets and positions already valued in base units).
fn nav_with(env: &Env, asset: &Address, extra: i128) -> Result<i128, Error> {
    let idle = token::Client::new(env, asset).balance(&env.current_contract_address());
    let nav = idle.checked_add(extra).ok_or(Error::ArithmeticOverflow)?;
    if nav < 0 {
        return Err(Error::Insolvent);
    }
    Ok(nav)
}

fn balances(env: &Env, assets: &Vec<Address>) -> Vec<i128> {
    let me = env.current_contract_address();
    let mut out = Vec::new(env);
    for asset in assets.iter() {
        out.push_back(token::Client::new(env, &asset).balance(&me));
    }
    out
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
