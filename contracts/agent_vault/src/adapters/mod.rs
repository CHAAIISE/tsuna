pub(crate) mod blend;

use soroban_sdk::{Address, Env};

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
