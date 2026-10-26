//! Protocol adapters: valuation of the vault's positions, the token authorizations the vault
//! itself builds for protocol calls, and the pro-rata exit run by `withdraw`.

pub(crate) mod aquarius;
pub(crate) mod blend;
pub(crate) mod defindex;
pub(crate) mod soroswap;
pub(crate) mod xoxno;

use policy_registry::{CallRule, PolicyV2};
use soroban_sdk::{
    auth::{ContractContext, InvokerContractAuthEntry, SubContractInvocation},
    contracttype, symbol_short, token, Address, Env, IntoVal, Map, Symbol, TryFromVal, Val, Vec,
};

use crate::{oracle::Prices, shares::mul_div, Error, Key, BPS};

/// Positions valued in every NAV. An execution values them twice, so their number is bounded
/// to keep `execute` within Soroban's per-transaction read and instruction limits.
pub const MAX_POSITIONS: u32 = 4;

#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum AdapterKind {
    /// Lending pool: supply, collateral and debt in any reserve.
    Blend,
    /// DeFindex vault: shares redeemable for its assets.
    DeFindex,
    /// Aquarius two-token constant-product pool: LP shares.
    Aquarius,
    /// Soroswap router: swaps only, never holds a position.
    Soroswap,
    /// XOXNO lending controller: one account (position NFT) owned by the vault.
    Xoxno,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Adapter {
    pub kind: AdapterKind,
    pub protocol: Address,
}

/// One protocol position, in base-asset units.
#[derive(Default)]
pub(crate) struct Holding {
    /// Value held in the protocol before netting debt.
    pub gross: i128,
    pub debt: i128,
    /// Collateral weighted by the protocol's collateral factor.
    pub weighted_collateral: i128,
    /// Debt weighted by the protocol's liability factor.
    pub weighted_debt: i128,
}

impl Holding {
    pub(crate) fn add(&mut self, other: &Holding) -> Result<(), Error> {
        self.gross = add(self.gross, other.gross)?;
        self.debt = add(self.debt, other.debt)?;
        self.weighted_collateral = add(self.weighted_collateral, other.weighted_collateral)?;
        self.weighted_debt = add(self.weighted_debt, other.weighted_debt)?;
        Ok(())
    }
}

/// Every position at once.
pub(crate) struct Book {
    /// Sum of positions net of debt.
    pub net: i128,
    /// Gross value per protocol, for the exposure caps.
    pub exposures: Vec<(Address, i128)>,
    /// Lowest health factor across lending protocols, in bps; `i128::MAX` without debt.
    pub health: i128,
}

pub(crate) fn list(env: &Env) -> Vec<Adapter> {
    env.storage()
        .instance()
        .get(&Key::Adapters)
        .unwrap_or(Vec::new(env))
}

fn kind_of(env: &Env, protocol: &Address) -> Option<AdapterKind> {
    list(env)
        .iter()
        .find(|adapter| adapter.protocol == *protocol)
        .map(|adapter| adapter.kind)
}

/// Only allowlisted protocols get an adapter: adding one to the policy goes through the
/// registry's timelock, so an adapter cannot be used to price an arbitrary contract into the NAV.
pub(crate) fn register(
    env: &Env,
    policy: &PolicyV2,
    kind: AdapterKind,
    protocol: Address,
) -> Result<(), Error> {
    if !policy.is_protocol(&protocol) {
        return Err(Error::ProtocolNotAllowed);
    }
    let mut adapters = list(env);
    if let Some(existing) = adapters.iter().find(|a| a.protocol == protocol) {
        return if existing.kind == kind {
            Ok(())
        } else {
            Err(Error::AdapterInUse)
        };
    }
    let positions = adapters
        .iter()
        .filter(|a| a.kind != AdapterKind::Soroswap)
        .count() as u32;
    if kind != AdapterKind::Soroswap && positions >= MAX_POSITIONS {
        return Err(Error::TooManyPositions);
    }
    if kind == AdapterKind::Aquarius {
        aquarius::validate(env, &protocol)?;
    }
    adapters.push_back(Adapter { kind, protocol });
    env.storage().instance().set(&Key::Adapters, &adapters);
    Ok(())
}

/// An adapter still holding value cannot be removed: its position would vanish from the NAV.
pub(crate) fn remove(env: &Env, protocol: &Address, prices: &mut Prices) -> Result<(), Error> {
    let mut adapters = list(env);
    let index = adapters
        .iter()
        .position(|a| a.protocol == *protocol)
        .ok_or(Error::ProtocolNotAllowed)? as u32;
    let holding = holding(env, &adapters.get_unchecked(index), prices)?;
    if holding.gross != 0 || holding.debt != 0 {
        return Err(Error::AdapterInUse);
    }
    adapters.remove(index);
    env.storage().instance().set(&Key::Adapters, &adapters);
    Ok(())
}

/// A position in an asset the strict regime cannot price counts as 0, and a debt fails
/// closed; in the exit regime both yield `None`.
fn valued(env: &Env, adapter: &Adapter, prices: &mut Prices) -> Result<Option<Holding>, Error> {
    match adapter.kind {
        AdapterKind::Blend => blend::value(env, &adapter.protocol, prices),
        AdapterKind::DeFindex => defindex::value(env, &adapter.protocol, prices),
        AdapterKind::Aquarius => aquarius::value(env, &adapter.protocol, prices),
        AdapterKind::Xoxno => xoxno::value(env, &adapter.protocol, prices),
        AdapterKind::Soroswap => Ok(Some(Holding::default())),
    }
}

fn holding(env: &Env, adapter: &Adapter, prices: &mut Prices) -> Result<Holding, Error> {
    valued(env, adapter, prices)?.ok_or(Error::OracleUnavailable)
}

/// `None` when the exit regime cannot price some position.
pub(crate) fn book(env: &Env, prices: &mut Prices) -> Result<Option<Book>, Error> {
    let mut book = Book {
        net: 0,
        exposures: Vec::new(env),
        health: i128::MAX,
    };
    for adapter in list(env) {
        if adapter.kind == AdapterKind::Soroswap {
            continue;
        }
        let Some(holding) = valued(env, &adapter, prices)? else {
            return Ok(None);
        };
        book.net = add(book.net, holding.gross - holding.debt)?;
        book.exposures.push_back((adapter.protocol, holding.gross));
        if holding.weighted_debt > 0 {
            let health = mul_div(
                env,
                holding.weighted_collateral,
                BPS,
                holding.weighted_debt,
                false,
            )?;
            book.health = book.health.min(health);
        }
    }
    Ok(Some(book))
}

/// What an adapter needs for one call: the base-asset value the call commits (`None` when no
/// adapter handles it) and the token authorizations the protocol will consume. The entries are
/// derived from the call's own arguments and the vault's addresses: the session key never
/// supplies an authorization. The host keeps them for the vault's next contract call only, so
/// they must be granted right before invoking the target.
pub(crate) struct Prepared {
    pub value: Option<i128>,
    pub auth: Vec<InvokerContractAuthEntry>,
}

pub(crate) fn prepare(
    env: &Env,
    policy: &PolicyV2,
    rule: &CallRule,
    target: &Address,
    fn_name: &Symbol,
    args: &Vec<Val>,
    prices: &mut Prices,
) -> Result<Prepared, Error> {
    let mut auth = Vec::new(env);
    let value = match kind_of(env, target) {
        Some(AdapterKind::DeFindex) => {
            defindex::prepare(env, policy, target, fn_name, args, prices, &mut auth)?
        }
        Some(AdapterKind::Aquarius) => {
            aquarius::prepare(env, policy, target, fn_name, args, prices, &mut auth)?
        }
        Some(AdapterKind::Soroswap) => {
            soroswap::prepare(env, policy, rule, target, fn_name, args, prices, &mut auth)?
        }
        Some(AdapterKind::Xoxno) => {
            xoxno::prepare(env, policy, target, fn_name, args, prices, &mut auth)?
        }
        Some(AdapterKind::Blend) | None => None,
    };
    Ok(Prepared { value, auth })
}

/// Records protocol state the vault must remember from a successful call.
pub(crate) fn settle(
    env: &Env,
    target: &Address,
    fn_name: &Symbol,
    args: &Vec<Val>,
    out: &Val,
) -> Result<(), Error> {
    if kind_of(env, target) == Some(AdapterKind::Xoxno) {
        xoxno::settle(env, target, fn_name, args, out)?;
    }
    Ok(())
}

/// Debt a withdrawal must repay in one asset from the vault's idle balance, for the whole
/// position: `(owed, rounding margin)`. Repayment scales with the redeemed shares; the margin
/// covers per-request rounding and does not.
pub(crate) type Needs = Map<Address, (i128, i128)>;

pub(crate) fn need(
    needs: &mut Needs,
    asset: &Address,
    owed: i128,
    margin: i128,
) -> Result<(), Error> {
    let (total, slack) = needs.get(asset.clone()).unwrap_or((0, 0));
    needs.set(asset.clone(), (add(total, owed)?, add(slack, margin)?));
    Ok(())
}

/// Largest part of `shares` whose pro-rata debt repayments the vault can fund now.
/// `vault_wide`: the whole idle balance may fund the leaver's repayment (the priced exit nets
/// it against their claim); otherwise only the leaver's own idle share may.
pub(crate) fn exitable(
    env: &Env,
    shares: i128,
    supply: i128,
    vault_wide: bool,
) -> Result<i128, Error> {
    let mut needs: Needs = Map::new(env);
    for adapter in list(env) {
        match adapter.kind {
            AdapterKind::Blend => blend::needs(env, &adapter.protocol, &mut needs)?,
            AdapterKind::Xoxno => xoxno::needs(env, &adapter.protocol, &mut needs)?,
            _ => {}
        }
    }
    let me = env.current_contract_address();
    let mut exitable = shares;
    for (asset, (owed, margin)) in needs.iter() {
        if owed <= 0 {
            continue;
        }
        let idle = token::Client::new(env, &asset).balance(&me) - margin;
        let cap = if idle <= 0 {
            0
        } else if vault_wide {
            mul_div(env, idle, supply, owed, false)?
        } else if idle >= owed {
            shares
        } else {
            0
        };
        exitable = exitable.min(cap);
    }
    Ok(exitable)
}

/// Slippage an exit accepts when it sells collateral to repay its share of debt.
const EXIT_SWAP_SLIPPAGE_BPS: i128 = 300;

/// Makes a priced exit independent of the agent: when idle base cannot repay the leaver's share
/// of a base-asset debt, the vault withdraws that much non-base collateral and sells it for base
/// on its own Soroswap router, through a pair the policy declares. Returns the value lost to the
/// swap at exit prices, which the leaver bears. Does nothing when there is no shortfall, no
/// router, no declared pair or no price: the exit then stays capped by idle balances.
pub(crate) fn fund_exit(
    env: &Env,
    base: &Address,
    shares: i128,
    supply: i128,
    prices: &mut Prices,
) -> Result<i128, Error> {
    let adapters = list(env);
    let Some(router) = adapters
        .iter()
        .find(|adapter| adapter.kind == AdapterKind::Soroswap)
        .map(|adapter| adapter.protocol)
    else {
        return Ok(0);
    };
    let Some(policy) = crate::leash::policy(env) else {
        return Ok(0);
    };
    let me = env.current_contract_address();
    let token = token::Client::new(env, base);
    for adapter in adapters.iter() {
        if adapter.kind != AdapterKind::Blend {
            continue;
        }
        let mut needs: Needs = Map::new(env);
        blend::needs(env, &adapter.protocol, &mut needs)?;
        let Some((owed, margin)) = needs.get(base.clone()) else {
            continue;
        };
        let required = add(mul_div(env, owed, shares, supply, true)?, margin)?;
        let shortfall = required - token.balance(&me);
        if shortfall <= 0 {
            continue;
        }
        // Sell enough that the proceeds cover the shortfall even at the worst accepted price.
        let value = mul_div(env, shortfall, BPS, BPS - EXIT_SWAP_SLIPPAGE_BPS, true)?;
        let Some((asset, amount)) =
            blend::release_collateral(env, &adapter.protocol, base, prices, value)?
        else {
            continue;
        };
        let pair: Address = env.invoke_contract(
            &router,
            &Symbol::new(env, "router_pair_for"),
            (asset.clone(), base.clone()).into_val(env),
        );
        if !policy
            .guards_of(&router)
            .is_some_and(|guards| guards.contains(&pair))
        {
            return Err(Error::SpenderNotProtocol);
        }
        let quoted = prices.convert(env, &asset, amount, base)?;
        let min_out = mul_div(env, quoted, BPS - EXIT_SWAP_SLIPPAGE_BPS, BPS, true)?;
        let before = token.balance(&me);
        env.authorize_as_current_contract(Vec::from_array(
            env,
            [transfer(env, &asset, &pair, amount)],
        ));
        let _: Val = env.invoke_contract(
            &router,
            &Symbol::new(env, "swap_exact_tokens_for_tokens"),
            (
                amount,
                min_out,
                Vec::from_array(env, [asset.clone(), base.clone()]),
                me.clone(),
                env.ledger().timestamp() + 300,
            )
                .into_val(env),
        );
        let received = token.balance(&me) - before;
        return Ok((quoted - received).max(0));
    }
    Ok(0)
}

/// Exits `shares / supply` of every position into the vault's idle balances.
pub(crate) fn unwind(env: &Env, shares: i128, supply: i128) -> Result<(), Error> {
    for adapter in list(env) {
        let protocol = &adapter.protocol;
        match adapter.kind {
            AdapterKind::Blend => blend::unwind(env, protocol, shares, supply)?,
            AdapterKind::DeFindex => defindex::unwind(env, protocol, shares, supply)?,
            AdapterKind::Aquarius => aquarius::unwind(env, protocol, shares, supply)?,
            AdapterKind::Xoxno => xoxno::unwind(env, protocol, shares, supply)?,
            AdapterKind::Soroswap => {}
        }
    }
    Ok(())
}

/// Authorization for `contract.fn_name(args)` called by a protocol on the vault's behalf.
pub(crate) fn entry(
    env: &Env,
    contract: &Address,
    fn_name: Symbol,
    args: Vec<Val>,
) -> InvokerContractAuthEntry {
    InvokerContractAuthEntry::Contract(SubContractInvocation {
        context: ContractContext {
            contract: contract.clone(),
            fn_name,
            args,
        },
        sub_invocations: Vec::new(env),
    })
}

/// Authorization for exactly `asset.transfer(vault, to, amount)`.
pub(crate) fn transfer(
    env: &Env,
    asset: &Address,
    to: &Address,
    amount: i128,
) -> InvokerContractAuthEntry {
    entry(
        env,
        asset,
        symbol_short!("transfer"),
        (env.current_contract_address(), to.clone(), amount).into_val(env),
    )
}

pub(crate) fn arg<T: TryFromVal<Env, Val>>(
    env: &Env,
    args: &Vec<Val>,
    index: u32,
    error: Error,
) -> Result<T, Error> {
    T::try_from_val(env, &args.get(index).ok_or(Error::ArgCountMismatch)?).map_err(|_| error)
}

/// The argument must be the vault itself.
pub(crate) fn vault_arg(env: &Env, args: &Vec<Val>, index: u32) -> Result<(), Error> {
    let address: Address = arg(env, args, index, Error::DestinationNotVault)?;
    if address != env.current_contract_address() {
        return Err(Error::DestinationNotVault);
    }
    Ok(())
}

pub(crate) fn add(a: i128, b: i128) -> Result<i128, Error> {
    a.checked_add(b).ok_or(Error::ArithmeticOverflow)
}

pub(crate) fn require_allowed(policy: &PolicyV2, asset: &Address) -> Result<(), Error> {
    if policy.assets.contains(asset) {
        Ok(())
    } else {
        Err(Error::AssetNotAllowed)
    }
}
