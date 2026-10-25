#![no_std]
mod policy;
pub use policy::*;

#[cfg(feature = "contract")]
mod contract;
#[cfg(feature = "contract")]
mod rules;
#[cfg(feature = "contract")]
pub use contract::*;

#[cfg(all(test, feature = "contract"))]
mod test;
