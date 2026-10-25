use soroban_sdk::{contractevent, contracttype, Address, Env};

use crate::{shares, AgentVault, Error, Key};

#[contracttype]
#[derive(Clone)]
pub(crate) struct HighWaterMark {
    pub assets: i128,
    pub supply: i128,
}

pub(crate) fn high_water_mark(env: &Env) -> Result<i128, Error> {
    let mark: HighWaterMark = env.storage().instance().get(&Key::HighWaterMark).unwrap();
    shares::mul_div(env, mark.assets, shares::PRICE_SCALE, mark.supply, false)
}

#[contractevent]
pub struct FeesCrystallized {
    pub profit: i128,
    pub fee_assets: i128,
    pub creator_shares: i128,
    pub protocol_shares: i128,
    pub high_water_mark: i128,
}

pub(crate) fn crystallize(env: &Env, nav: i128) -> Result<(), Error> {
    let storage = env.storage().instance();
    let creator = AgentVault::owner(env.clone());
    let recipient: Address = storage.get(&Key::ProtocolRecipient).unwrap();
    // Interest may cross the fee threshold after simulation. Both balances
    // must be in the read-write footprint even when no fee is due yet.
    shares::touch(env, &creator);
    if recipient != creator {
        shares::touch(env, &recipient);
    }
    let supply = shares::effective_supply(env)?;
    let assets = shares::effective_assets(nav)?;
    if shares::total(env) == 0 {
        storage.set(&Key::HighWaterMark, &HighWaterMark { assets, supply });
        return Ok(());
    }
    // Store the mark as an exact ratio; a rounded displayed price would
    // repeatedly charge small gains or discard them for large share supplies.
    let mark: HighWaterMark = storage.get(&Key::HighWaterMark).unwrap();
    let hurdle = shares::mul_div(env, mark.assets, supply, mark.supply, true)?;
    if assets <= hurdle {
        return Ok(());
    }
    let profit = assets - hurdle;
    let fee_assets = profit / 10;
    if fee_assets == 0 {
        return Ok(());
    }
    // Dilution gives the fee recipients the fee's asset value, rather than
    // overcharging existing holders by minting at the pre-fee price.
    let fee_shares = shares::mul_div(env, fee_assets, supply, assets - fee_assets, false)?;
    if fee_shares == 0 {
        return Ok(());
    }
    let protocol_shares = fee_shares / 100;
    let creator_shares = fee_shares - protocol_shares;
    shares::mint(env, &creator, creator_shares)?;
    if protocol_shares > 0 {
        shares::mint(env, &recipient, protocol_shares)?;
    }
    storage.set(
        &Key::HighWaterMark,
        &HighWaterMark {
            assets,
            supply: shares::effective_supply(env)?,
        },
    );
    let high_water_mark = high_water_mark(env)?;
    FeesCrystallized {
        profit,
        fee_assets,
        creator_shares,
        protocol_shares,
        high_water_mark,
    }
    .publish(env);
    Ok(())
}
