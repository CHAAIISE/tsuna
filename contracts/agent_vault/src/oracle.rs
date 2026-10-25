//! Valuation of non-base assets, idle or inside protocol positions, through the oracle router.
//!
//! Agent paths use the strict regime and fail closed. Withdrawals use the exit regime and
//! never fail because of the oracle: without a usable price the holder is paid in kind.

use soroban_sdk::{token, vec, Address, Env, IntoVal, InvokeError, Map, Symbol, Vec};

use crate::{shares::mul_div, Error, Key};

// Router error codes.
const NO_PRICE_FEED: u32 = 1;
const STALE_PRICE: u32 = 2;
const SOURCES_DISAGREE: u32 = 3;
const PRICE_JUMP: u32 = 4;

fn router(env: &Env) -> Address {
    env.storage().instance().get(&Key::Oracle).unwrap()
}

/// Non-base `assets` with a positive idle balance; the base asset comes first and is skipped.
pub(crate) fn held(env: &Env, assets: &Vec<Address>) -> Vec<(Address, i128)> {
    let me = env.current_contract_address();
    let mut out = Vec::new(env);
    for asset in assets.iter().skip(1) {
        let balance = token::Client::new(env, &asset).balance(&me);
        if balance > 0 {
            out.push_back((asset, balance));
        }
    }
    out
}

/// Strict price in quote units (7 decimals); `None` when the asset has no configured feed.
fn strict(env: &Env, asset: &Address) -> Result<Option<i128>, Error> {
    match env.try_invoke_contract::<i128, InvokeError>(
        &router(env),
        &Symbol::new(env, "price_strict"),
        vec![env, asset.into_val(env)],
    ) {
        Ok(Ok(price)) if price > 0 => Ok(Some(price)),
        Err(Ok(InvokeError::Contract(NO_PRICE_FEED))) => Ok(None),
        Err(Ok(InvokeError::Contract(STALE_PRICE))) => Err(Error::StalePrice),
        Err(Ok(InvokeError::Contract(SOURCES_DISAGREE))) => Err(Error::SourcesDisagree),
        Err(Ok(InvokeError::Contract(PRICE_JUMP))) => Err(Error::PriceJump),
        _ => Err(Error::OracleUnavailable),
    }
}

fn exit(env: &Env, asset: &Address) -> Option<i128> {
    match env.try_invoke_contract::<Option<i128>, InvokeError>(
        &router(env),
        &Symbol::new(env, "price_for_exit"),
        vec![env, asset.into_val(env)],
    ) {
        Ok(Ok(Some(price))) if price > 0 => Some(price),
        _ => None,
    }
}

fn unit(env: &Env, asset: &Address) -> Result<i128, Error> {
    match token::Client::new(env, asset).try_decimals() {
        Ok(Ok(decimals)) => 10_i128.checked_pow(decimals).ok_or(Error::BadAdapterData),
        _ => Err(Error::BadAdapterData),
    }
}

/// Quotes for one invocation, fetched lazily and cached per asset as `(price, token unit)`.
/// A zero price means the regime has no usable price for that asset.
pub(crate) struct Prices {
    exit: bool,
    base: Address,
    quotes: Map<Address, (i128, i128)>,
}

impl Prices {
    pub(crate) fn strict(env: &Env, base: &Address) -> Self {
        Self::new(env, base, false)
    }

    pub(crate) fn exit(env: &Env, base: &Address) -> Self {
        Self::new(env, base, true)
    }

    fn new(env: &Env, base: &Address, exit: bool) -> Self {
        Self {
            exit,
            base: base.clone(),
            quotes: Map::new(env),
        }
    }

    pub(crate) fn base(&self) -> &Address {
        &self.base
    }

    /// The base price must be strict in both regimes: a stale base price cut by the haircut
    /// would inflate the other assets in favour of the leaver.
    fn quote(&mut self, env: &Env, asset: &Address) -> Result<(i128, i128), Error> {
        if let Some(quote) = self.quotes.get(asset.clone()) {
            return Ok(quote);
        }
        let price = if *asset == self.base {
            if self.exit {
                strict(env, asset).ok().flatten()
            } else {
                strict(env, asset)?
            }
        } else if self.exit {
            exit(env, asset)
        } else {
            strict(env, asset)?
        };
        let quote = match price.map(|price| (price, unit(env, asset))) {
            None => (0, 1),
            Some((price, Ok(unit))) => (price, unit),
            Some((_, Err(_))) if self.exit => (0, 1),
            Some((_, Err(error))) => return Err(error),
        };
        self.quotes.set(asset.clone(), quote);
        Ok(quote)
    }

    /// `Some(numerator, denominator)` converting units of `asset` into base units.
    fn ratio(&mut self, env: &Env, asset: &Address) -> Result<Option<(i128, i128)>, Error> {
        let (base_price, base_unit) = self.quote(env, &self.base.clone())?;
        if base_price == 0 {
            return Ok(None);
        }
        let (price, asset_unit) = self.quote(env, asset)?;
        if price == 0 {
            return Ok(None);
        }
        let numerator = price
            .checked_mul(base_unit)
            .ok_or(Error::ArithmeticOverflow)?;
        let denominator = base_price
            .checked_mul(asset_unit)
            .ok_or(Error::ArithmeticOverflow)?;
        Ok(Some((numerator, denominator)))
    }

    /// Base-asset value of a holding of `asset`, rounded down. Strict: an asset without a
    /// feed is worth 0, so converting into an unpriced asset reads as a loss; any other oracle
    /// failure blocks. Exit: `None` when the asset has no usable price.
    pub(crate) fn value(
        &mut self,
        env: &Env,
        asset: &Address,
        amount: i128,
    ) -> Result<Option<i128>, Error> {
        if *asset == self.base || amount == 0 {
            return Ok(Some(amount));
        }
        match self.ratio(env, asset)? {
            Some((numerator, denominator)) => {
                Ok(Some(mul_div(env, amount, numerator, denominator, false)?))
            }
            None if self.exit => Ok(None),
            None => Ok(Some(0)),
        }
    }

    /// Base-asset value of a liability in `asset`, rounded up. A debt is never valued at 0:
    /// strict fails closed, exit returns `None`.
    pub(crate) fn debt(
        &mut self,
        env: &Env,
        asset: &Address,
        amount: i128,
    ) -> Result<Option<i128>, Error> {
        if *asset == self.base || amount == 0 {
            return Ok(Some(amount));
        }
        match self.ratio(env, asset)? {
            Some((numerator, denominator)) => {
                Ok(Some(mul_div(env, amount, numerator, denominator, true)?))
            }
            None if self.exit => Ok(None),
            None => Err(Error::OracleUnavailable),
        }
    }

    /// Signed value of a balance change: gains round down, losses round up.
    pub(crate) fn delta(
        &mut self,
        env: &Env,
        asset: &Address,
        amount: i128,
    ) -> Result<Option<i128>, Error> {
        if amount >= 0 {
            self.value(env, asset, amount)
        } else {
            Ok(self.debt(env, asset, -amount)?.map(|value| -value))
        }
    }

    /// Units of `to` worth `amount` of `from` at strict prices. Both must be priced.
    pub(crate) fn convert(
        &mut self,
        env: &Env,
        from: &Address,
        amount: i128,
        to: &Address,
    ) -> Result<i128, Error> {
        let (from_price, from_unit) = self.quote(env, from)?;
        let (to_price, to_unit) = self.quote(env, to)?;
        if from_price == 0 || to_price == 0 {
            return Err(Error::OracleUnavailable);
        }
        let numerator = from_price
            .checked_mul(to_unit)
            .ok_or(Error::ArithmeticOverflow)?;
        let denominator = to_price
            .checked_mul(from_unit)
            .ok_or(Error::ArithmeticOverflow)?;
        mul_div(env, amount, numerator, denominator, false)
    }
}

/// Value of idle non-base assets at strict prices.
pub(crate) fn strict_value(
    env: &Env,
    prices: &mut Prices,
    assets: &Vec<Address>,
) -> Result<i128, Error> {
    let mut total: i128 = 0;
    for (asset, balance) in held(env, assets) {
        total = total
            .checked_add(prices.value(env, &asset, balance)?.unwrap_or(0))
            .ok_or(Error::ArithmeticOverflow)?;
    }
    Ok(total)
}

/// Exit values of `held`, in base units and in the same order, or `None` when any of them
/// has no usable price.
pub(crate) fn exit_values(
    env: &Env,
    prices: &mut Prices,
    held: &Vec<(Address, i128)>,
) -> Option<Vec<i128>> {
    let mut out = Vec::new(env);
    for (asset, balance) in held.iter() {
        out.push_back(prices.value(env, &asset, balance).ok().flatten()?);
    }
    Some(out)
}
