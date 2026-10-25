#![no_std]
mod adapters;
mod fees;
mod shares;
#[cfg(test)]
mod test;

use soroban_sdk::{
    contract, contracterror, contractevent, contractimpl, contracttype, token, Address, Env,
    Symbol, TryFromVal, Val, Vec,
};

const BPS: i128 = 10_000;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    CallNotAllowed = 1,
    DestinationNotVault = 2,
    SpenderNotProtocol = 3,
    ArgCountMismatch = 4,
    NavDropped = 5,
    Paused = 6,
    BadAdapterData = 7,
    InvalidAmount = 8,
    InsufficientShares = 9,
    ZeroShares = 10,
    ArithmeticOverflow = 11,
    Insolvent = 12,
    InvalidConfig = 13,
}

/// Constraint on one positional argument of an allowlisted call.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ArgRule {
    Any,
    /// Must be this vault: blocks `from`/`to`/`spender` pointing at a third party.
    Vault,
    /// Must be an allowlisted protocol (e.g. the spender of an `approve`).
    Protocol,
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
    MaxLossBps,
    Paused,
    Blend,
    Rule(Address, Symbol),
    Protocol(Address),
    ProtocolRecipient,
    TotalShares,
    Shares(Address),
    HighWaterMark,
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
        max_loss_bps: u32,
    ) -> Result<(), Error> {
        if max_loss_bps > BPS as u32 {
            return Err(Error::InvalidConfig);
        }
        let s = env.storage().instance();
        s.set(&Key::Owner, &owner);
        s.set(&Key::Agent, &agent);
        s.set(&Key::Asset, &asset);
        s.set(&Key::MaxLossBps, &max_loss_bps);
        s.set(&Key::Paused, &false);
        s.set(&Key::ProtocolRecipient, &protocol_recipient);
        s.set(&Key::TotalShares, &0_i128);
        s.set(
            &Key::HighWaterMark,
            &fees::HighWaterMark {
                assets: 1,
                supply: shares::VIRTUAL_SHARES,
            },
        );
        Ok(())
    }

    pub fn allow_protocol(env: Env, protocol: Address) {
        Self::owner(&env).require_auth();
        env.storage()
            .persistent()
            .set(&Key::Protocol(protocol), &true);
    }

    pub fn allow_call(env: Env, target: Address, fn_name: Symbol, rules: Vec<ArgRule>) {
        Self::owner(&env).require_auth();
        env.storage()
            .persistent()
            .set(&Key::Rule(target, fn_name), &rules);
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
        s.get::<_, Address>(&Key::Agent).unwrap().require_auth();
        if s.get(&Key::Paused).unwrap_or(false) {
            return Err(Error::Paused);
        }

        let rules: Vec<ArgRule> = env
            .storage()
            .persistent()
            .get(&Key::Rule(target.clone(), fn_name.clone()))
            .ok_or(Error::CallNotAllowed)?;
        if rules.len() != args.len() {
            return Err(Error::ArgCountMismatch);
        }
        let me = env.current_contract_address();
        for (rule, arg) in rules.iter().zip(args.iter()) {
            match rule {
                ArgRule::Any => {}
                ArgRule::Vault => {
                    let a = Address::try_from_val(&env, &arg)
                        .map_err(|_| Error::DestinationNotVault)?;
                    if a != me {
                        return Err(Error::DestinationNotVault);
                    }
                }
                ArgRule::Protocol => {
                    let a =
                        Address::try_from_val(&env, &arg).map_err(|_| Error::SpenderNotProtocol)?;
                    if !Self::is_protocol(&env, &a) {
                        return Err(Error::SpenderNotProtocol);
                    }
                }
            }
        }

        let nav_before = Self::nav(env.clone())?;
        let out: Val = env.invoke_contract(&target, &fn_name, args);
        let nav_after = Self::nav(env.clone())?;

        let max_loss: u32 = s.get(&Key::MaxLossBps).unwrap();
        if nav_after < shares::mul_div(&env, nav_before, BPS - max_loss as i128, BPS, true)? {
            return Err(Error::NavDropped);
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
    NavSnapshot {
        nav,
        pps: shares::price(env, nav)?,
        ts: env.ledger().timestamp(),
    }
    .publish(env);
    Ok(())
}
