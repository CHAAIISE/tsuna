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

Collateral supply and borrowing use separate transactions because their combined resource fee can exceed Stellar's 32-bit inner transaction fee limit. The transaction helper supports a fee bump when resource fees exceed that limit. The WASM upload is sponsored by the Alice testnet burner (`E2E_USER_SECRET`); upload rent on testnet can consume thousands of test XLM.

`spike.ts` builds with `stellar contract build`, uploads the WASM, deploys a fresh vault, configures its call and argument rules, and deposits 100 test USDC in exchange for shares. The configured session key approves Blend and supplies the funds through `submit_with_allowance`. The script checks the resulting supply position and NAV, then submits two rejected calls: a direct token transfer and a Blend withdrawal addressed to the attacker.

Rejected calls are submitted despite their failed preflight, using a successful invocation's resource budget and the required allowlist storage key. A rejection counts only when RPC `getTransaction` reports `FAILED` and its vault diagnostics contain the expected contract error code. The script also checks that attacker balances and the vault's Blend positions are unchanged. It then donates 10 test USDC explicitly to exercise performance fees, pauses the vault, checks that deposits are blocked, and redeems the depositor's shares in two withdrawals that unwind Blend. Only protocol fee shares and rounding dust remain invested; at least 5,000 USDC must remain with the admin at completion.

These scripts are testnet transactions, not a local simulation. They spend test XLM on fees and create real lending positions. The vault currently validates idle USDC plus its same-asset Blend position; multi-asset accounting is not supported by this contract yet.

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

`execute(target, fn, args)` is the only path for the session key. In order, it checks that the session is not revoked, the vault is not paused, `(target, fn)` is allowlisted with one rule per argument, and each argument satisfies its rule. `Amount` arguments and same-asset `BlendRequests` (summed, never netted) are charged against the limits set by the owner with `set_limits`:

| Limit | Default | Error |
| --- | --- | --- |
| Per-call amount, in bps of NAV before the call | 10,000 | `TxCapExceeded` (14) |
| Amount per UTC day, in bps of NAV at each call | 100,000 | `DailyCapExceeded` (15) |
| Calls per clock hour, including zero-amount calls | 60 | `RateLimited` (16) |
| Blend health factor after the call, in bps | 13,000 | `HealthFactorTooLow` (17) |
| Price-per-share drop from the rolling 24-hour peak | 2,000 | pause via `check_drawdown` |

After the call, NAV must not fall more than `max_loss_bps` (constructor) or the whole transaction reverts with `NavDropped` (5), including any protocol state, allowance and usage counters it wrote. Other refusals: `CallNotAllowed` (1), `DestinationNotVault` (2), `SpenderNotProtocol` (3), `ArgCountMismatch` (4), `Paused` (6), `SessionRevoked` (18). Successful calls emit `Executed(target, fn, nav_before, nav_after)`.

The owner can pause the vault (`set_paused`), `revoke_session`, or `rotate_session` to a new key. `check_drawdown()` is permissionless: anyone can pause a vault whose price per share has fallen below its 24-hour peak by more than the configured drawdown. Peaks are kept in a segment tree indexed by observation, so a check touches a logarithmic number of storage entries and skips expired history. None of these switches blocks withdrawals.
