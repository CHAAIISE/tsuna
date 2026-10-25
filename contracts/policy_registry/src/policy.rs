use soroban_sdk::{contracttype, Address, Map, Symbol, Vec};

pub const BPS: u32 = 10_000;
pub const MAX_ASSETS: u32 = 8;
pub const MAX_PROTOCOLS: u32 = 8;
pub const MAX_GUARDS: u32 = 4;
/// Every execution loads the whole policy, so its size is bounded.
pub const MAX_CALLS: u32 = 16;

/// Constraint on one positional argument of an allowlisted call.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ArgRule {
    Any,
    /// Must be the vault: blocks `from`/`to`/`spender` pointing at a third party.
    Vault,
    /// Must be an allowlisted protocol (e.g. the spender of an `approve`).
    Protocol,
    /// Non-negative base-asset amount, included in transaction and daily budgets.
    Amount,
    /// Sum of same-base-asset Blend request amounts; never net deposits against withdrawals.
    BlendRequests,
    /// `Vec<Address>` whose every element is one of the vault's allowed assets (e.g. a swap path).
    Assets,
}

/// Allowlist entry for one `(target, fn)` pair.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CallRule {
    pub args: Vec<ArgRule>,
    /// NAV and perimeter loss tolerated for one call (e.g. 10 stable-to-stable, 50 volatile).
    pub max_loss_bps: u32,
    /// The vault grants the target an allowance for the pulled amount, expiring this ledger.
    pub approve: bool,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Limits {
    pub tx_cap_bps: u32,
    pub daily_cap_bps: u32,
    pub calls_per_hour: u32,
    pub min_health_factor_bps: u32,
    pub max_drawdown_bps: u32,
    /// Cumulative NAV loss allowed over a rolling 24 h window.
    pub daily_loss_bps: u32,
    /// Largest share of NAV a single protocol may hold after an execution.
    pub max_exposure_bps: u32,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            tx_cap_bps: 10_000,
            daily_cap_bps: 100_000,
            calls_per_hour: 60,
            min_health_factor_bps: 13_000,
            max_drawdown_bps: 2_000,
            daily_loss_bps: 50,
            max_exposure_bps: 5_000,
        }
    }
}

/// First published policy schema. Entries written in this shape stay readable as [`PolicyV2`].
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PolicyV1 {
    pub calls: Map<(Address, Symbol), CallRule>,
    pub protocols: Vec<Address>,
    /// Contracts that legitimately custody funds when the key protocol is called
    /// (pool, strategy, pair), counted in the balance-conservation check.
    pub guards: Map<Address, Vec<Address>>,
    /// Assets the agent may route through or request; the base asset stays first.
    pub assets: Vec<Address>,
    pub limits: Limits,
}

/// Current policy schema. Fields added after v1 are `Option`s: a struct field missing
/// from a stored map unpacks as `None`, so v1 entries are read without any migration.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PolicyV2 {
    pub calls: Map<(Address, Symbol), CallRule>,
    pub protocols: Vec<Address>,
    pub guards: Map<Address, Vec<Address>>,
    pub assets: Vec<Address>,
    pub limits: Limits,
    /// Per-protocol overrides of `limits.max_exposure_bps`.
    pub exposure_caps: Option<Map<Address, u32>>,
}

impl PolicyV2 {
    pub fn rule(&self, target: &Address, fn_name: &Symbol) -> Option<CallRule> {
        self.calls.get((target.clone(), fn_name.clone()))
    }

    pub fn is_protocol(&self, address: &Address) -> bool {
        self.protocols.contains(address)
    }

    pub fn guards_of(&self, protocol: &Address) -> Option<Vec<Address>> {
        self.guards.get(protocol.clone())
    }

    /// Largest share of NAV, in basis points, that `protocol` may hold.
    pub fn exposure_cap(&self, protocol: &Address) -> u32 {
        self.exposure_caps
            .as_ref()
            .and_then(|caps| caps.get(protocol.clone()))
            .unwrap_or(self.limits.max_exposure_bps)
    }
}
