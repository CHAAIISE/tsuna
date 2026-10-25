#![no_std]
use soroban_sdk::{
    contract, contracterror, contractevent, contractimpl, contracttype, symbol_short, token,
    Address, Env, IntoVal, Map, Symbol, TryFromVal, Val, Vec,
};

const BPS: i128 = 10_000;
const BLEND_SCALAR: i128 = 1_000_000_000_000;

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

#[contract]
pub struct AgentVault;

#[contractimpl]
impl AgentVault {
    pub fn __constructor(env: Env, owner: Address, agent: Address, asset: Address, max_loss_bps: u32) {
        let s = env.storage().instance();
        s.set(&Key::Owner, &owner);
        s.set(&Key::Agent, &agent);
        s.set(&Key::Asset, &asset);
        s.set(&Key::MaxLossBps, &max_loss_bps);
        s.set(&Key::Paused, &false);
    }

    pub fn allow_protocol(env: Env, protocol: Address) {
        Self::owner(&env).require_auth();
        env.storage().persistent().set(&Key::Protocol(protocol), &true);
    }

    pub fn allow_call(env: Env, target: Address, fn_name: Symbol, rules: Vec<ArgRule>) {
        Self::owner(&env).require_auth();
        env.storage().persistent().set(&Key::Rule(target, fn_name), &rules);
    }

    pub fn set_blend(env: Env, pool: Address, reserve_index: u32) {
        Self::owner(&env).require_auth();
        env.storage()
            .instance()
            .set(&Key::Blend, &BlendPosition { pool, reserve_index });
    }

    pub fn set_paused(env: Env, paused: bool) {
        Self::owner(&env).require_auth();
        env.storage().instance().set(&Key::Paused, &paused);
    }

    /// The only entry point the agent's session key can use. The agent proposes any call;
    /// the vault checks it against the allowlist, runs it, then reverts everything if value left the vault.
    pub fn execute(env: Env, target: Address, fn_name: Symbol, args: Vec<Val>) -> Result<Val, Error> {
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
                    let a = Address::try_from_val(&env, &arg).map_err(|_| Error::DestinationNotVault)?;
                    if a != me {
                        return Err(Error::DestinationNotVault);
                    }
                }
                ArgRule::Protocol => {
                    let a = Address::try_from_val(&env, &arg).map_err(|_| Error::SpenderNotProtocol)?;
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
        if nav_after * BPS < nav_before * (BPS - max_loss as i128) {
            return Err(Error::NavDropped);
        }
        Executed { target, fn_name, nav_before, nav_after }.publish(&env);
        Ok(out)
    }

    /// Value held by the vault, in units of the base asset: idle balance + Blend supply/collateral − debt.
    pub fn nav(env: Env) -> Result<i128, Error> {
        let s = env.storage().instance();
        let asset: Address = s.get(&Key::Asset).unwrap();
        let me = env.current_contract_address();
        let mut nav = token::Client::new(&env, &asset).balance(&me);

        if let Some(b) = s.get::<_, BlendPosition>(&Key::Blend) {
            let positions: Map<Symbol, Val> =
                env.invoke_contract(&b.pool, &Symbol::new(&env, "get_positions"), (me,).into_val(&env));
            let reserve: Map<Symbol, Val> =
                env.invoke_contract(&b.pool, &Symbol::new(&env, "get_reserve"), (asset,).into_val(&env));
            let data = field_map(&env, &reserve, symbol_short!("data"))?;
            let b_rate = field_i128(&env, &data, Symbol::new(&env, "b_rate"))?;
            let d_rate = field_i128(&env, &data, Symbol::new(&env, "d_rate"))?;

            let b_tokens = entry(&env, &positions, symbol_short!("supply"), b.reserve_index)?
                + entry(&env, &positions, Symbol::new(&env, "collateral"), b.reserve_index)?;
            let d_tokens = entry(&env, &positions, Symbol::new(&env, "liabilities"), b.reserve_index)?;
            // Same rounding as Blend: supply rounds down, debt rounds up.
            nav += b_tokens * b_rate / BLEND_SCALAR;
            nav -= (d_tokens * d_rate + BLEND_SCALAR - 1) / BLEND_SCALAR;
        }
        Ok(nav)
    }

    pub fn is_protocol(env: &Env, addr: &Address) -> bool {
        env.storage().persistent().get(&Key::Protocol(addr.clone())).unwrap_or(false)
    }

    fn owner(env: &Env) -> Address {
        env.storage().instance().get(&Key::Owner).unwrap()
    }
}

fn field_map(env: &Env, m: &Map<Symbol, Val>, k: Symbol) -> Result<Map<Symbol, Val>, Error> {
    let v = m.get(k).ok_or(Error::BadAdapterData)?;
    Map::try_from_val(env, &v).map_err(|_| Error::BadAdapterData)
}

fn field_i128(env: &Env, m: &Map<Symbol, Val>, k: Symbol) -> Result<i128, Error> {
    let v = m.get(k).ok_or(Error::BadAdapterData)?;
    i128::try_from_val(env, &v).map_err(|_| Error::BadAdapterData)
}

fn entry(env: &Env, positions: &Map<Symbol, Val>, k: Symbol, index: u32) -> Result<i128, Error> {
    let v = positions.get(k).ok_or(Error::BadAdapterData)?;
    let m: Map<u32, i128> = Map::try_from_val(env, &v).map_err(|_| Error::BadAdapterData)?;
    Ok(m.get(index).unwrap_or(0))
}
