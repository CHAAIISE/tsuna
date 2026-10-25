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

`spike.ts` builds with `stellar contract build`, uploads the WASM, deploys a fresh vault, configures its call and argument rules, and transfers 100 test USDC to it. The configured session key approves Blend and supplies the funds through `submit_with_allowance`. The script checks the resulting supply position and NAV, then submits two rejected calls: a direct token transfer and a Blend withdrawal addressed to the attacker.

Rejected calls are submitted despite their failed preflight, using a successful invocation's resource budget and the required allowlist storage key. A rejection counts only when RPC `getTransaction` reports `FAILED` and its vault diagnostics contain the expected contract error code. The script also checks that attacker balances and the vault's Blend positions are unchanged. Each run creates a new vault and leaves its 100 USDC invested; at least 5,000 USDC must remain with the admin at completion.

These scripts are testnet transactions, not a local simulation. They spend test XLM on fees and create real lending positions. The vault currently validates idle USDC plus its same-asset Blend position; multi-asset accounting is not supported by this contract yet.
