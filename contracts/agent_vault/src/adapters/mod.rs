pub(crate) mod blend;

use soroban_sdk::{Address, Env, Vec};

use crate::{BlendPosition, Error, Key};

pub(crate) fn nav(env: &Env, asset: &Address) -> Result<i128, Error> {
    match env
        .storage()
        .instance()
        .get::<_, BlendPosition>(&Key::Blend)
    {
        Some(position) => blend::nav(env, asset, &position),
        None => Ok(0),
    }
}

pub(crate) fn health_factor(env: &Env, asset: &Address) -> Result<i128, Error> {
    match env
        .storage()
        .instance()
        .get::<_, BlendPosition>(&Key::Blend)
    {
        Some(position) => blend::health_factor(env, asset, &position),
        None => Ok(i128::MAX),
    }
}

/// Gross value held in each protocol, before netting any debt against it.
pub(crate) fn exposures(env: &Env, asset: &Address) -> Result<Vec<(Address, i128)>, Error> {
    let mut out = Vec::new(env);
    if let Some(position) = env
        .storage()
        .instance()
        .get::<_, BlendPosition>(&Key::Blend)
    {
        out.push_back((position.pool.clone(), blend::gross(env, asset, &position)?));
    }
    Ok(out)
}

pub(crate) fn unwind(env: &Env, asset: &Address, shares: i128, supply: i128) -> Result<(), Error> {
    if let Some(position) = env
        .storage()
        .instance()
        .get::<_, BlendPosition>(&Key::Blend)
    {
        blend::unwind(env, asset, &position, shares, supply)?;
    }
    Ok(())
}
