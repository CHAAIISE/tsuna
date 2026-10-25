use policy_registry::{CallRule, PolicyV2};
use soroban_sdk::{auth::InvokerContractAuthEntry, Address, Env, IntoVal, Symbol, Val, Vec};

use super::{arg, require_allowed, transfer, vault_arg};
use crate::{oracle::Prices, shares::mul_div, Error, BPS};

/// `swap_exact_tokens_for_tokens(amount_in, amount_out_min, path, to, deadline)`: the router
/// pulls `amount_in` from `to` into the first pair with `transfer`. The vault authorizes that
/// exact transfer only when the pair is a declared custody contract of the router, and only
/// when `amount_out_min` is no looser than the oracle quote minus the rule's loss tolerance.
#[allow(clippy::too_many_arguments)]
pub(crate) fn prepare(
    env: &Env,
    policy: &PolicyV2,
    rule: &CallRule,
    router: &Address,
    fn_name: &Symbol,
    args: &Vec<Val>,
    prices: &mut Prices,
    auth: &mut Vec<InvokerContractAuthEntry>,
) -> Result<Option<i128>, Error> {
    if *fn_name != Symbol::new(env, "swap_exact_tokens_for_tokens") {
        return Ok(None);
    }
    vault_arg(env, args, 3)?;
    let amount_in: i128 = arg(env, args, 0, Error::InvalidAmount)?;
    let min_out: i128 = arg(env, args, 1, Error::InvalidAmount)?;
    let path: Vec<Address> = arg(env, args, 2, Error::AssetNotAllowed)?;
    if amount_in <= 0 || min_out < 0 || path.len() < 2 {
        return Err(Error::InvalidAmount);
    }
    for asset in path.iter() {
        require_allowed(policy, &asset)?;
    }
    let (from, to) = (path.get_unchecked(0), path.get_unchecked(path.len() - 1));
    let quoted = prices.convert(env, &from, amount_in, &to)?;
    let floor = mul_div(
        env,
        quoted,
        BPS - i128::from(rule.max_loss_bps.min(10_000)),
        BPS,
        true,
    )?;
    if min_out < floor {
        return Err(Error::SlippageTooLoose);
    }
    let pair: Address = env.invoke_contract(
        router,
        &Symbol::new(env, "router_pair_for"),
        (from.clone(), path.get_unchecked(1)).into_val(env),
    );
    if !policy
        .guards_of(router)
        .is_some_and(|guards| guards.contains(&pair))
    {
        return Err(Error::SpenderNotProtocol);
    }
    auth.push_back(transfer(env, &from, &pair, amount_in));
    Ok(Some(prices.value(env, &from, amount_in)?.unwrap_or(0)))
}
