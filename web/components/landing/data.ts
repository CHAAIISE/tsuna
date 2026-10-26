export const explorerTx = (hash: string) => `https://stellar.expert/explorer/testnet/tx/${hash}`;

export const shortHash = (hash: string) => `${hash.slice(0, 8)}…${hash.slice(-6)}`;

export const metamaskReport = "https://metamask.io/news/crypto-security-report-may-2026";

export type Incident = {
  figure: string;
  date: string;
  title: string;
  body: string;
  sources: { label: string; href: string }[];
};

export const incidents: Incident[] = [
  {
    figure: "$150–200k",
    date: "4 May 2026",
    title: "Grok and its Bankr wallet",
    body: "A reply written in Morse code under a post was enough. Grok decoded it and its wallet sent the funds to a stranger.",
    sources: [
      { label: "BeInCrypto", href: "https://beincrypto.com/grok-wallet-bankr-drb-prompt-injection/" },
      { label: "Giskard", href: "https://www.giskard.ai/knowledge/how-grok-got-prompt-injected-an-x-user-drained-150-000-from-an-ai-wallet" },
    ],
  },
  {
    figure: "$204,000",
    date: "May 2026",
    title: "One prompt-injected agent",
    body: "MetaMask's security report describes a single AI wallet drained through prompt injection: “the first documented exploit of its kind”.",
    sources: [{ label: "MetaMask security report", href: metamaskReport }],
  },
  {
    figure: "Live",
    date: "July 2026",
    title: "Hidden instructions on web pages",
    body: "Ordinary-looking pages carried instructions only a model would read. Agents browsing them paid the attackers, in active campaigns.",
    sources: [
      {
        label: "Tech Times",
        href: "https://www.techtimes.com/articles/320039/20260709/hidden-webpage-instructions-are-making-ai-agents-pay-hackers-live-campaigns.htm",
      },
    ],
  },
  {
    figure: "55 ETH",
    date: "March 2025",
    title: "The aixbt trading bot",
    body: "An attacker got into the bot's dashboard and queued prompts that made it send 55 ETH out of its own wallet.",
    sources: [
      {
        label: "Cointelegraph via TradingView",
        href: "https://www.tradingview.com/news/cointelegraph:61f9396f2094b:0-hacker-breaks-into-ai-crypto-bot-aixbt-s-dashboard-to-snatch-55-eth/",
      },
    ],
  },
];

export type Check = { rule: string; error: string };

export const checkGroups: { title: string; when: string; checks: Check[] }[] = [
  {
    title: "Before the call",
    when: "Read from the rules the agent can't edit.",
    checks: [
      { rule: "The function is on the allowlist for that exact contract.", error: "CallNotAllowed" },
      { rule: "Every address argument points back to the vault.", error: "DestinationNotVault" },
      { rule: "Every token in a swap path or lending request is an allowed asset.", error: "AssetNotAllowed" },
      { rule: "The amount fits the per-call and daily caps.", error: "TxCapExceeded · DailyCapExceeded" },
      { rule: "The agent hasn't used up its calls for the hour.", error: "RateLimited" },
    ],
  },
  {
    title: "After the call",
    when: "Same transaction. If one fails, nothing happened.",
    checks: [
      { rule: "The vault's value is conserved at oracle price, within that call's tolerance.", error: "NavDropped" },
      { rule: "Token balances stay inside the vault and its protocols.", error: "ValueLeftPerimeter" },
      { rule: "No approval is left behind.", error: "AllowanceNotCleared" },
      { rule: "The lending health factor stays at 1.3 or above.", error: "HealthFactorTooLow" },
      { rule: "No protocol holds more than its share of the vault.", error: "ExposureCapExceeded" },
      { rule: "Losses over the last 24 hours stay under the daily budget.", error: "DailyLossExceeded" },
    ],
  },
  {
    title: "Outside the call",
    when: "Guards that don't depend on the agent acting.",
    checks: [
      { rule: "A drawdown past the limit pauses the agent. Anyone can trigger the check.", error: "check_drawdown" },
      { rule: "Withdrawals stay open, even while paused or without a fresh price.", error: "withdraw" },
      { rule: "Loosening a rule waits out a public timelock. Tightening applies at once.", error: "TimelockActive" },
    ],
  },
];

export type ProofItem = {
  outcome: "refused" | "allowed";
  name: string;
  meaning: string;
  txs: { label?: string; hash: string; href?: string }[];
};

export const proofs: ProofItem[] = [
  {
    outcome: "refused",
    name: "CallNotAllowed",
    meaning: "Asked the vault to transfer its USDC to an outside address. Transfers aren't on the allowlist.",
    txs: [{ hash: "1c437c4694e9952dfc4aeb0211eb92d0d29e705044fdafac74e168add1bb333a" }],
  },
  {
    outcome: "refused",
    name: "DestinationNotVault",
    meaning: "A real Blend call, but with the attacker as the recipient. The address check caught it.",
    txs: [{ hash: "67023e5686171893f11938507eca60fed5b169ef471251fa057fa3f0bc5a2314" }],
  },
  {
    outcome: "refused",
    name: "SpendingLimitExceeded",
    meaning: "A third paid data request in one period. The agent's 5 USDC budget would be exceeded, so its account refused to pay.",
    txs: [{ hash: "acb0718ab4b12f0cdfd9d7846df7a3bf5e308d6eaec3dac084e690a362c4c76e" }],
  },
  {
    outcome: "allowed",
    name: "Blend supply",
    meaning: "40 USDC supplied to Blend through the vault. Approval back to zero afterwards.",
    txs: [{ hash: "1c6df3673431c154948c09b000f7161836433ea1692f25194ae60385db7331ca" }],
  },
  {
    outcome: "allowed",
    name: "Paid signals",
    meaning: "The agent bought lending rates over x402 and a risk score over MPP from its capped budget.",
    txs: [
      { label: "x402", hash: "cbe0c84c58a7664179b116579d2067e23d539bf85b505782d4bf2880439ae88b" },
      { label: "MPP", hash: "113f45b3c8debabd5034d28fce47c331f6a5f4c9527e1ed7691d37ff203f08c8" },
    ],
  },
  {
    outcome: "allowed",
    name: "Deposit from Ethereum",
    meaning: "USDC burned on Sepolia, minted on Stellar with CCTP, swapped and deposited into a vault.",
    txs: [
      {
        label: "Sepolia burn",
        hash: "0xabc2b1408517ca159068c3e653be9daf3826dfb72b0d176456cf15a3651005c5",
        href: "https://sepolia.etherscan.io/tx/0xabc2b1408517ca159068c3e653be9daf3826dfb72b0d176456cf15a3651005c5",
      },
      { label: "Mint", hash: "f97e8cd4398d31027296e28a55cf45d48858b01bf6e0316a9feb96815d77e890" },
      { label: "Deposit", hash: "7a84cab316ac85959df3c633bc91422704bf0dab36d2112b3677322fcbd38fe6" },
    ],
  },
  {
    outcome: "allowed",
    name: "Trustline through the SAC",
    meaning: "A USDC trustline opened by calling trust() on the asset's contract, not with a classic operation.",
    txs: [{ hash: "de7cc86499051a3c379a4451c7d8fcad3b7a0c096a0b9c2bcd1adafaba6e3b26" }],
  },
];

export type Brick = { name: string; role: string; status: "testnet" | "tested" | "in progress" };

export const bricks: Brick[] = [
  { name: "Blend", role: "Lending pool the vault supplies to. The vault reads positions and the health factor straight from it.", status: "testnet" },
  { name: "DeFindex", role: "Second USDC venue for the Prudent strategy. Only deposit and withdraw are allowlisted, never share transfers.", status: "testnet" },
  { name: "Soroswap", role: "Swaps for the Leverage strategy and for USDC arriving over CCTP. Every hop must be an allowed asset.", status: "testnet" },
  { name: "Aquarius", role: "XLM/USDC liquidity for the Liquidity strategy, with LP shares valued back to their underlying tokens.", status: "testnet" },
  { name: "Reflector", role: "Prices every asset the vault holds, so value is measured at oracle price, never at a pool price.", status: "testnet" },
  { name: "Chainlink Data Feeds", role: "Second source for BTC. If it and Reflector disagree by more than 2 %, the agent is blocked.", status: "testnet" },
  { name: "OpenZeppelin smart accounts + spending_limit", role: "Passkey accounts for depositors, and a capped account the agent pays for its data from.", status: "testnet" },
  { name: "x402 / MPP", role: "How the agent pays per request for rate and risk signals.", status: "testnet" },
  { name: "CCTP", role: "Brings USDC from Ethereum Sepolia into a vault.", status: "testnet" },
  { name: "CAP-85 executable references", role: "Every vault runs one shared executable, so a fix reaches the whole fleet in one transaction, after a timelock.", status: "testnet" },
  { name: "CAP-86", role: "Rule sets gain new optional fields and old entries still read, with no storage migration.", status: "testnet" },
  { name: "SAC trust()", role: "Opens a new account's USDC trustline from a contract call.", status: "testnet" },
];
