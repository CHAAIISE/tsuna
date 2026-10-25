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
}
