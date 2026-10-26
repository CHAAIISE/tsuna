use soroban_sdk::contracterror;

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
    InvalidAmount = 8,
    InsufficientShares = 9,
    ZeroShares = 10,
    ArithmeticOverflow = 11,
    Insolvent = 12,
    TxCapExceeded = 14,
    DailyCapExceeded = 15,
    RateLimited = 16,
    HealthFactorTooLow = 17,
    SessionRevoked = 18,
    AssetNotAllowed = 19,
    DailyLossExceeded = 20,
    AllowanceNotCleared = 21,
    ValueLeftPerimeter = 22,
    ExposureCapExceeded = 23,
    StalePrice = 24,
    SourcesDisagree = 25,
    PriceJump = 26,
    OracleUnavailable = 27,
    /// The creator has not registered this vault's policy yet: the agent can do nothing.
    PolicyMissing = 28,
    /// An adapter can only be set for a protocol the policy allowlists.
    ProtocolNotAllowed = 29,
    /// A protocol already has another adapter, or still holds value and cannot be removed.
    AdapterInUse = 30,
    /// More protocol positions than the vault can value within one transaction.
    TooManyPositions = 31,
    /// A swap's minimum output is below the oracle quote less the call's loss tolerance.
    SlippageTooLoose = 32,
    /// The vault holds too little of a debt asset to repay any of the leaver's share.
    RepaymentUnavailable = 33,
    /// `execute_as` names a role the policy in force does not define.
    RoleNotFound = 34,
    /// The signer of `execute_as` is not the member of the role it names.
    NotRoleMember = 35,
    /// A RiskOff call left the vault riskier or poorer than it found it.
    RiskIncreased = 36,
    /// The target runs code other than the Wasm hash the vault pinned for it; the owner must
    /// review and acknowledge the new code first.
    ProtocolChanged = 37,
    /// `apply_oracle` before the proposal's timelock has passed.
    OracleTimelockActive = 38,
    /// `apply_oracle` with no oracle change pending.
    NoPendingOracle = 39,
}
