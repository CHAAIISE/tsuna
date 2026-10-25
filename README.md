# Leash

DeFi vaults on Stellar with on-chain limits for AI agents.

## Run locally

Requirements: Node.js ≥ 22.12, pnpm 12.15, Rust with `wasm32v1-none`, and Stellar CLI 28.1.

```sh
pnpm install
cp .env.example .env.local
ln -s ../.env.local web/.env.local
pnpm dev
```

Keep the existing environment file and symlink if they are already configured. Use only dedicated Stellar testnet burners for the variables in `.env.example`; never fund them with real assets.

```sh
pnpm typecheck
pnpm lint
pnpm test
pnpm build
pnpm contracts:build
pnpm contracts:test
```

## Testnet contract validation

```sh
pnpm tsx scripts/fund-usdc.ts
pnpm tsx scripts/spike.ts
```

`fund-usdc.ts` establishes the admin's USDC trustline and targets a 6,000 USDC-Blend balance by supplying XLM collateral and borrowing from the deployed Blend testnet pool. Collateral is calculated from the pool's oracle prices, reserve weights and existing debt, targeting a health factor of 1.75. If needed, it collects XLM from the configured agent, keeper and Alice burners, leaving 1,000 XLM per donor before transaction fees. An absent admin account is created with Friendbot. Insufficient funding fails explicitly.

Collateral supply and borrowing use separate transactions because their combined resource fee can exceed Stellar's 32-bit inner transaction fee limit. The transaction helper supports a fee bump when resource fees exceed that limit. WASM uploads are sponsored by the Alice testnet burner (`E2E_USER_SECRET`); upload rent on testnet can consume thousands of test XLM.

`spike.ts` builds with `stellar contract build`, uploads the WASMs, deploys a fresh policy registry (10-minute demo timelock) and a fresh vault, registers the vault's policy (call and argument rules, allowed protocol, default limits), and deposits 100 test USDC in exchange for shares. The session key supplies 40 USDC to Blend through `submit_with_allowance`; the vault grants the pool an allowance for exactly that amount, valid for the current ledger only, and checks it is consumed. The script prints the simulated resource cost of that `execute`, checks the resulting supply position, NAV and zero residual allowance, then submits two rejected calls: a direct token transfer and a Blend withdrawal addressed to the attacker.

Rejected calls are submitted despite their failed preflight, using a successful invocation's resource budget, which already covers the vault instance and the registry policy entry the rejected call reads. A rejection counts only when RPC `getTransaction` reports `FAILED` and its vault diagnostics contain the expected contract error code. The script also checks that attacker balances and the vault's Blend positions are unchanged. It then lowers the per-call cap (in force immediately), proposes raising it back (pending, publicly readable) and checks that applying it before the timelock fails with `TimelockActive`. It donates 10 test USDC explicitly to exercise performance fees, pauses the vault, checks that deposits are blocked, and redeems the depositor's shares in two withdrawals that unwind Blend. Only protocol fee shares and rounding dust remain invested; at least 5,000 USDC must remain with the admin at completion.

These scripts are testnet transactions, not a local simulation. They spend test XLM on fees and create real lending positions. The spike vault holds only USDC and its same-asset Blend position; Blend positions are valued in the base asset only, while other allowed assets held idle are valued through the oracle router (see [Oracle](#oracle)). The vault is deployed against the router recorded in `deployments/testnet.json`.

## Vault accounting

`deposit(user, amount)` and `withdraw(user, shares)` require the holder's authorization. Deposits and session-key execution stop when paused; withdrawals do not. Shares are internal, non-transferable claims, exposed by `balance(user)` and `total_shares()`.

Conversions use one virtual base-asset unit and 1,000,000,000 virtual shares: `shares = floor(amount × (total_shares + 1e9) / (NAV + 1))`. The 9-decimal offset makes donation-driven inflation expensive without rounding normal deposits to zero; a deposit that would mint zero shares is rejected. `price_per_share()` reports base-asset units per raw share, scaled by `1e18` (initial value `1e9`). The demo USDC has 7 decimals. Intermediate products use 256-bit arithmetic when needed.

Withdrawals unwind each configured Blend supply, collateral and debt position in proportion to the redeemed shares, including the virtual-share denominator. Repayment and releases are netted in one pool call; temporary repayment allowances are cleared. Payment is capped at the holder's NAV claim and includes only their proportion of idle assets plus actual unwind proceeds. Protocol rounding and virtual-share dust stay in the vault, rather than being taken from remaining holders. Availability still depends on Blend liquidity and its own risk checks.

Performance fees crystallize on deposit, withdrawal and successful execution: 10% of gains above the per-share high-water mark. New shares give 99% of that commission to the creator and 1% to the protocol recipient configured at deployment. No assets leave the vault for crystallization; fee holders redeem shares normally. The mark stores an exact post-fee asset/share ratio, stays unchanged through losses, and does not charge again on recovery to the same price. Deposits are priced after old profits have been charged. Direct donations count as gains; the script's donation is not a claim of earned yield.

Fee-recipient balances are touched on every crystallization, including when the fee is zero. This keeps their Soroban read-write footprint stable when lending interest crosses a fee threshold between simulation and inclusion.

`NavSnapshot` records post-action NAV, price per share and ledger timestamp for deposits, withdrawals and successful executions. `Deposited`, `Withdrawn` and `FeesCrystallized` record amounts and share movements. Unit scenarios cover first and subsequent deposits, donation attacks, authorization, rejected and partial withdrawals, pause exits from Blend, debt repayment, fees, loss recovery, rollback, snapshots and large balances:

```sh
cd contracts
cargo test -p agent-vault
stellar contract build
```

## Session limits

`execute(target, fn, args)` is the only path for the session key. In order, it checks that the session is not revoked, the vault is not paused, the vault's policy is registered (`PolicyMissing` (28) otherwise), `(target, fn)` is allowlisted with one rule per argument, and each argument satisfies its rule. The rules live in the [policy registry](#policy-registry): `calls` maps each pair to a `CallRule { args, max_loss_bps, approve }`. Argument rules are `Any`, `Vault`, `Protocol` (an address in the policy's `protocols`), `Amount`, `BlendRequests` and `Assets` (a `Vec<Address>` such as a swap path, where every element must be in the policy's `assets`, else `AssetNotAllowed` (19)). `Amount` arguments and same-asset `BlendRequests` (summed, never netted) are charged against the policy's `limits`:

| Limit | Default | Error |
| --- | --- | --- |
| Per-call amount, in bps of NAV before the call | 10,000 | `TxCapExceeded` (14) |
| Amount per UTC day, in bps of NAV at each call | 100,000 | `DailyCapExceeded` (15) |
| Calls per clock hour, including zero-amount calls | 60 | `RateLimited` (16) |
| Blend health factor after the call, in bps | 13,000 | `HealthFactorTooLow` (17) |
| NAV lost by executions over a rolling 24 h window (hourly buckets), in bps of NAV | 50 | `DailyLossExceeded` (20) |
| Gross value in one protocol after a call that grows it, in bps of NAV (per-protocol override: `exposure_caps`) | 5,000 | `ExposureCapExceeded` (23) |
| Price-per-share drop from the rolling 24-hour peak | 2,000 | pause via `check_drawdown` |

When a rule has `approve`, the vault itself grants the target an allowance for the amount the call may pull (the `Amount` arguments, or the net Blend inflow), expiring at the current ledger; the session key never chooses an approval. After the call, every post-condition must hold or the whole transaction reverts, including any protocol state, allowance and usage counters it wrote:

- NAV must not fall more than the rule's `max_loss_bps` (e.g. 10 for stable-to-stable, 50 for volatile pairs): `NavDropped` (5).
- Losses are added to the rolling 24 h budget, so repeated calls just under the per-call tolerance cannot drain the vault: `DailyLossExceeded` (20). `daily_loss()` reports the amount used.
- Allowances from the vault to the target and to every `Protocol` argument must be back to zero for every allowed asset: `AllowanceNotCleared` (21).
- Token balances are summed over the perimeter (the vault, the target and the custody contracts listed for it in the policy's `guards`, such as a pool or strategy) and must be conserved per asset within the rule's tolerance: `ValueLeftPerimeter` (22). This check reads balances directly, so a protocol that keeps reporting a position while sending the tokens elsewhere is still caught.
- No protocol's gross position may grow beyond the exposure cap. Calls that shrink a position stay allowed, so interest drift never blocks de-risking: `ExposureCapExceeded` (23).

Other refusals: `CallNotAllowed` (1), `DestinationNotVault` (2), `SpenderNotProtocol` (3), `ArgCountMismatch` (4), `Paused` (6), `SessionRevoked` (18). Successful calls emit `Executed(target, fn, nav_before, nav_after)`.

The leash stops the agent from moving value out of the vault; it does not make an allowlisted protocol safe. A compromised protocol can still lose what it holds, which is why exposure per protocol is capped and drawdowns pause the vault.

The owner can pause the vault (`set_paused`), `revoke_session`, or `rotate_session` to a new key. `check_drawdown()` is permissionless: anyone can pause a vault whose price per share has fallen below its 24-hour peak by more than the configured drawdown. Peaks are kept in a segment tree indexed by observation, so a check touches a logarithmic number of storage entries and skips expired history. None of these switches blocks withdrawals.

## Policy registry

`policy_registry` stores each vault's policy: `calls`, `protocols`, `guards` (custody contracts per protocol), `assets` (base asset first, then assets the agent may route through, all counted in NAV and paid out on withdrawal), `limits`, and since v2 `exposure_caps` (per-protocol overrides of `max_exposure_bps`). The vault is deployed with the registry's address as its sixth constructor argument and reads its policy from it on every `execute`, `check_drawdown`, `nav` and withdrawal; it keeps no rules of its own.

The vault's owner installs the first policy with `register(vault, policy)`, once and before any deposit (`VaultHasDeposits` (4) otherwise): the registry reads the vault's `owner()`, `asset()` and `total_shares()`, requires the owner's signature, and binds that owner as the vault's creator. Every later change goes through `propose_policy(vault, policy)`, signed by the creator, and is classified field by field against the policy in force:

- **Tightening** (remove a call, protocol, guard or asset; lower a cap, tolerance or rate; raise the minimum health factor; constrain an `Any` argument; drop `approve`) applies immediately (`PolicyTightened`) and cancels any pending proposal, which could otherwise undo it.
- **Loosening** (anything the current policy does not grant) is stored as `pending_policy(vault)` with an `eta` of now plus `policy_timelock()` (`PolicyProposed`), so depositors can see it and leave first. A change that tightens some fields and loosens others is a loosening. `apply_policy(vault)` installs it once the timelock has passed (`PolicyApplied`), else fails with `TimelockActive` (6).

The timelock is fixed at deployment: 24 h in production, 10 minutes for the testnet demo. Invalid policies (caps above 100%, a zero rate, a health factor below 1, a different base asset, more than 16 calls, 8 assets or 8 protocols, 4 guards per protocol) fail with `InvalidPolicy` (3).

Policies are versioned through Soroban's tolerant struct decoding (CAP-86, soroban-sdk 28): `PolicyV2` adds `exposure_caps` as an `Option` to `PolicyV1`, and a field missing from a stored map reads as `None`, so entries written by v1 code are read by v2 code without migration.

Removing an asset the vault still holds also removes it from NAV and withdrawals until it is allowed again; creators should unwind a position before dropping its asset.

```sh
cd contracts
cargo test -p policy-registry
```

## Oracle

`oracle_router` turns Reflector and Chainlink Data Feeds into prices in USDC with 7 decimals: the asset's USD price divided by USDC's USD price. The admin configures a feed per asset (`set_feed(asset, Feed { reflector, chainlink })`, with `reflector` a Reflector `Stellar(address)` or `Other(symbol)` asset and `chainlink` an optional feed ID). An asset without a feed has no price (`NoPriceFeed`), which the vault counts as zero.

| Source | Call | Format | Default maximum age |
| --- | --- | --- | --- |
| Reflector testnet `CCYOZJCOPG34LLQQ7N24YXBM7LL62R7ONMZ3G6WZAAYPB5OYKOMJRN63` | `lastprice(asset)` (SEP-40), `prices(asset, 2)` | `i128`, 14 decimals, USD base, 300 s resolution | 900 s |
| Chainlink Data Feeds proxy testnet `CBUF6IADAWPWIDWRTHJNINKXHG2UTIQ6TU2F2HRAXWAI7OT3KJPKK6O4` | `latest_round(data_id, 18)` | `I256`, 18 decimals | 90,000 s (rounds update on deviation or heartbeat; observed 3 to 10 hours apart on testnet) |

Testnet Chainlink publishes BTC/USD only (`data_id` `01a0b4d920000332000000000000000000000000000000000000000000000000`, [Chainlink docs](https://docs.chain.link/data-feeds/stellar/using-data-feeds-on-chain)). The deployed router (`oracleRouter` in `deployments/testnet.json`) prices USDC-Blend, XLM (Reflector) and wBTC (Reflector + Chainlink, averaged).

Two regimes:

- `price_strict(asset)` serves deposits, `nav()`, `execute` and `check_drawdown`, and fails closed: every configured source must be fresh (`StalePrice`, 2), two sources must agree within `max_deviation_bps` (default 200, else `SourcesDisagree`, 3), and a move above `max_jump_bps` (default 1,500) against the last accepted price within 15 minutes is refused (`PriceJump`, 4) unless both sources agree on it or the two latest Reflector updates of the asset and of USDC hold the new level. Each accepted price is stored with its ledger time (`last_price(asset)`) in temporary storage kept for about a week.
- `price_for_exit(asset)` serves withdrawals and never fails: the strict price when available; otherwise the last valid price cut by `exit_haircut_bps` (default 500), and never above a price refused as a jump; otherwise `None`.

In the vault, the router's errors become `StalePrice` (24), `SourcesDisagree` (25), `PriceJump` (26), or `OracleUnavailable` (27) when the router cannot be called. While a held asset has no strict price, the agent, deposits and `check_drawdown` are blocked. A withdrawal values held assets at exit prices: the holder's share of them is paid in the base asset while the vault has base liquidity, then in kind at the same price. If any held asset has no exit price, or the base asset has no strict price, the holder receives their pro-rata share of each asset (idle balances and unwound positions) without conversion, and fees wait for the next priced action. `WithdrawnInKind(user, asset, amount)` records each non-base payment.

Demo oracle on testnet only: the `demo` Cargo feature adds admin-only `set_demo(enabled)`, `set_demo_price(asset, price)` (event `DemoPriceSet(asset, price)`) and `clear_demo_price(asset)`. Forced prices bypass sources and the jump breaker and are never stored as last valid prices. `is_demo()` is public in every build and always `false` without the feature, whose functions are absent from the WASM:

```sh
cd contracts
cargo test -p oracle-router --features demo
stellar contract build --package oracle-router                   # production interface
stellar contract build --package oracle-router --features demo   # testnet crash demo
stellar contract info interface --wasm target/wasm32v1-none/release/oracle_router.wasm
```
## Cross-chain deposit (CCTP)

```sh
pnpm tsx scripts/cctp-demo.ts            # add --resume <sepolia burn hash> to continue after a burn
```

USDC moves from Ethereum Sepolia to a vault on Stellar testnet in five steps: `depositForBurnWithHook` on Sepolia (domain 0 → 27), Circle's Iris attestation, `CctpForwarder.mint_and_forward` on Stellar, a Soroswap swap from Circle USDC to the Blend USDC the vault holds, and the vault `deposit`. Both `mintRecipient` and `destinationCaller` are the `CctpForwarder` contract; the Stellar recipient is only in the hook data (24 zero bytes, version and length as big-endian u32, then the strkey), validated before any burn. Each burn uses Fast finality with `maxFee` read from Iris. Amounts are six-decimal in the CCTP message and scaled ×10 on Stellar; the script checks the recipient receives exactly `(amount − feeExecuted) × 10`.

The script prepares everything it needs and is safe to rerun: the bridge recipient (`LEASH_BRIDGE_USER_SECRET`, created and funded with Friendbot when absent), its Circle and Blend USDC trustlines opened with the SAC `trust` function, a test vault deployed from the uploaded `agent_vault` WASM (or `LEASH_BRIDGE_VAULT`), and the Circle-USDC / Blend-USDC Soroswap pair kept at 1:1 with 1,000 of each token. The ops account (`LEASH_CCTP_OPS_SECRET`) pays for `mint_and_forward`, seeds the pair with Circle USDC bought on the Stellar DEX and Blend USDC borrowed against XLM, and keeps Blend USDC to swap the pair back to 1:1 after bridged swaps move it. The swap must return at least 99.5 % of its input; nothing is burned when the pool cannot meet that floor. Addresses are recorded in `deployments/cctp.testnet.json`.

`/bridge` runs the same pipeline from the server-side Sepolia test wallet (`POST /api/bridge`, one run at a time; `GET /api/bridge` returns the steps and transaction hashes). Jobs are kept in a JSON file in the OS temporary directory, 20 at most; on serverless hosts they last as long as the instance.
## Agent payments

Agents pay for market signals from a signal budget: an OpenZeppelin smart account (`contracts/signal_budget`, `stellar-accounts` 0.8). The admin rule belongs to the operations account; the session rule lets the agent key sign transfers of Blend testnet USDC only, metered by the OZ `spending_limit` policy at 5 USDC per 17,280 ledgers (about a day).

```sh
pnpm tsx scripts/deploy-signal-budget.ts
pnpm tsx scripts/pay-signal.ts
```

`deploy-signal-budget.ts` uploads the verifier, policy and account WASMs when the network does not already store them, reuses the contracts recorded in `deployments/pay.testnet.json`, and keeps the budget at 20 USDC by borrowing on Blend against XLM collateral from `LEASH_PAY_OPS_SECRET` (Friendbot accounts are merged in when XLM runs low).

The web app sells two signals, 2 USDC per call by default (`SIGNAL_PRICE_USDC`):

- `GET /api/signals/rates` (x402, `@x402/next`): USDC and XLM reserves of the Blend pool with `b_rate`, `d_rate`, utilization and supply/borrow APR from Blend v2's rate model. Settlement happens only after a successful response.
- `GET /api/signals/risk` (MPP charge, `@stellar/mpp` method on `mppx`, secret `MPP_SECRET`): XLM price, 1-hour and retained-window change, annualized 5-minute and hourly volatility, and USDC peg deviation from the Reflector testnet oracle.

Each payload states its method. Both protocols use a signed Soroban authorization entry for the SEP-41 transfer; the server rebuilds the transaction, simulates it in enforce mode (which runs the account's `__check_auth` and the policy), checks that the only balance change is the payment, and submits it with `LEASH_FACILITATOR_SECRET` as source and fee payer.

The x402 facilitator runs in-process. The public testnet facilitator named in the Stellar docs (x402.org) refuses these payments: its verifier caps settlement fees at 50,000 stroops (a smart-account transfer simulates at about 465,000) and expects SAC transfer events only, while the policy emits its own. The stock `@stellar/mpp` server only accepts `G…` payers, so the MPP charge keeps its method schema with a verifier that accepts contract accounts.

`buySignal(kind, options)` in `@leash/agent` runs the 402 flow, signs with the session key, and returns `{ data, paymentTxHash }` or a typed refusal such as `SpendingLimitExceeded` (3221). With a `refusalSubmitter`, the refused payment is submitted anyway so the refusal is a `FAILED` transaction on-chain; its resources come from the same transfer reduced to one stroop. `pay-signal.ts` starts the web app on port 3217, buys one x402 and one MPP signal, verifies both hashes are `SUCCESS`, confirms that a third payment fails on-chain with the policy error, and stops the server. A budget that already spent in the current window is replaced by a fresh one.
