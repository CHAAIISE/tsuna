use soroban_sdk::{token, Address, Env, Vec};

use crate::{adapters, leash, shares::mul_div, Error, Key, BPS};

/// Contracts whose token balances count as "still ours" during a call to `target`:
/// the vault, the target and the custody contracts the owner declared for it.
fn members(env: &Env, target: &Address) -> Vec<Address> {
    let mut members = Vec::from_array(env, [env.current_contract_address(), target.clone()]);
    let guards: Vec<Address> = env
        .storage()
        .persistent()
        .get(&Key::Guards(target.clone()))
        .unwrap_or(Vec::new(env));
    for guard in guards {
        if !members.contains(&guard) {
            members.push_back(guard);
        }
    }
    members
}

/// Per allowed asset: (vault balance, perimeter balance).
pub(crate) fn holdings(env: &Env, target: &Address) -> Result<Vec<(i128, i128)>, Error> {
    let members = members(env, target);
    let me = env.current_contract_address();
    let mut out = Vec::new(env);
    for asset in leash::assets(env) {
        let token = token::Client::new(env, &asset);
        let own = token.balance(&me);
        let mut total: i128 = 0;
        for member in members.iter() {
            total = total
                .checked_add(token.balance(&member))
                .ok_or(Error::ArithmeticOverflow)?;
        }
        out.push_back((own, total));
    }
    Ok(out)
}

/// Token balances are checked independently of the protocol's own accounting,
/// so a protocol that misreports positions cannot move funds out unnoticed.
pub(crate) fn conserved(
    env: &Env,
    target: &Address,
    before: &Vec<(i128, i128)>,
    nav_before: i128,
    max_loss_bps: u32,
) -> Result<(), Error> {
    let after = holdings(env, target)?;
    let base = leash::assets(env).get_unchecked(0);
    for (index, asset) in leash::assets(env).iter().enumerate() {
        let (own_before, total_before) = before.get_unchecked(index as u32);
        let (_, total_after) = after.get_unchecked(index as u32);
        let reference = if asset == base {
            nav_before
        } else {
            own_before
        };
        let tolerance = mul_div(env, reference, max_loss_bps.into(), BPS, false)?;
        if total_before - total_after > tolerance {
            return Err(Error::ValueLeftPerimeter);
        }
    }
    Ok(())
}

pub(crate) fn allowances_cleared(env: &Env, spenders: &Vec<Address>) -> Result<(), Error> {
    let me = env.current_contract_address();
    for asset in leash::assets(env) {
        let token = token::Client::new(env, &asset);
        for spender in spenders.iter() {
            if token.allowance(&me, &spender) != 0 {
                return Err(Error::AllowanceNotCleared);
            }
        }
    }
    Ok(())
}

/// A call may not grow a protocol's position past the cap. Calls that leave a position
/// unchanged or shrink it stay allowed, so interest drift never locks the agent out of de-risking.
pub(crate) fn exposure_within_cap(
    env: &Env,
    asset: &Address,
    before: &Vec<(Address, i128)>,
    nav: i128,
) -> Result<(), Error> {
    let cap = mul_div(
        env,
        nav,
        leash::limits(env).max_exposure_bps.into(),
        BPS,
        false,
    )?;
    for (protocol, value) in adapters::exposures(env, asset)? {
        let previous = before
            .iter()
            .find(|(address, _)| *address == protocol)
            .map_or(0, |(_, value)| value);
        if value > cap && value > previous {
            return Err(Error::ExposureCapExceeded);
        }
    }
    Ok(())
}
