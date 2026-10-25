import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import {
  Address, Operation, SorobanDataBuilder, rpc, scValToNative, xdr,
} from "@stellar/stellar-sdk";
import { fundUsdc } from "./fund-usdc.js";
import {
  UNIT, address, balance, build, call, fail, horizon, i128, read, request, send,
  server, signer, simulate, submit, symbol, testnet, u32, vec, type Positions,
} from "./lib/stellar.js";

async function main(): Promise<void> {
  const admin = signer("LEASH_ADMIN_SECRET");
  const agent = signer("LEASH_AGENT_SECRET");
  const attacker = process.env.LEASH_ATTACKER_PUBLIC;
  if (!attacker) throw new Error("Missing LEASH_ATTACKER_PUBLIC");
  await fundUsdc();
  execFileSync("stellar", ["contract", "build", "--manifest-path", "contracts/Cargo.toml"], { stdio: "inherit" });
  const wasm = await readFile("contracts/target/wasm32v1-none/release/agent_vault.wasm");
  const uploaded = await send(admin, Operation.uploadContractWasm({ wasm }), true, signer("E2E_USER_SECRET"));
  console.log(`WASM_UPLOADED ${uploaded.txHash}`);
  assert(uploaded.returnValue, "Upload must return a WASM hash");
  const wasmHash = Buffer.from(scValToNative(uploaded.returnValue) as Uint8Array);
  const deployed = await send(admin, Operation.createCustomContract({
    address: new Address(admin.publicKey()), wasmHash,
    constructorArgs: [
      address(admin.publicKey()), address(agent.publicKey()), address(testnet.usdc),
      address(signer("LEASH_KEEPER_SECRET").publicKey()), u32(5),
    ],
  }));
  assert(deployed.returnValue, "Deployment must return a contract address");
  const vault = scValToNative(deployed.returnValue) as string;
  console.log(`VAULT ${vault} ${deployed.txHash}`);
  await send(admin, call(vault, "allow_protocol", [address(testnet.pool)]));
  await send(admin, call(vault, "allow_call", [address(testnet.usdc), symbol("approve"), vec(["Vault", "Protocol", "Any", "Any"].map(rule => vec([symbol(rule)])))]));
  await send(admin, call(vault, "allow_call", [address(testnet.pool), symbol("submit_with_allowance"), vec(["Vault", "Vault", "Vault", "Any"].map(rule => vec([symbol(rule)])))]));
  await send(admin, call(vault, "set_blend", [address(testnet.pool), u32(3)]));
  const amount = 100n * UNIT;
  const deposited = await send(admin, call(vault, "deposit", [address(admin.publicKey()), i128(amount)]));
  assert(deposited.returnValue, "Deposit must return shares");
  const shares = scValToNative(deposited.returnValue) as bigint;
  assert.equal(shares, amount * 1_000_000_000n, "First deposit must mint offset shares");
  console.log(`DEPOSITED ${deposited.txHash} assets=${amount} shares=${shares}`);
  const navBefore = await read<bigint>(admin, vault, "nav");
  const expiry = (await server.getLatestLedger()).sequence + 1_000;
  const approveArgs = [address(testnet.usdc), symbol("approve"), vec([address(vault), address(testnet.pool), i128(amount), u32(expiry)])];
  const approved = await send(agent, call(vault, "execute", approveArgs));
  console.log(`APPROVED ${approved.txHash}`);
  const supplyArgs = [address(testnet.pool), symbol("submit_with_allowance"), vec([address(vault), address(vault), address(vault), vec([request(testnet.usdc, amount, 0)])])];
  const supplied = await send(agent, call(vault, "execute", supplyArgs));
  const positions = await read<Positions>(admin, testnet.pool, "get_positions", [address(vault)]);
  const navAfter = await read<bigint>(admin, vault, "nav");
  assert((positions.supply[3] ?? 0n) > 0n, "Vault must own Blend supply tokens");
  assert.equal(await balance(admin, vault), 0n, "All idle USDC must be invested");
  assert(navAfter * 10_000n >= navBefore * 9_995n, "Supply must conserve NAV within five basis points");
  console.log(`AUTHORIZED ${supplied.txHash} NAV ${navBefore} -> ${navAfter}`);

  const attackerBefore = (await horizon.loadAccount(attacker)).balances;
  for (const attack of [
    { code: 1, name: "CallNotAllowed", target: testnet.usdc, fn: "transfer", args: [address(vault), address(attacker), i128(amount)] },
    { code: 2, name: "DestinationNotVault", target: testnet.pool, fn: "submit_with_allowance", args: [address(vault), address(vault), address(attacker), vec([request(testnet.usdc, amount, 1)])] },
  ]) {
    const operation = call(vault, "execute", [address(attack.target), symbol(attack.fn), vec(attack.args)]);
    const rejected = await server.simulateTransaction(await build(agent, operation));
    assert(rpc.Api.isSimulationError(rejected), "Attack must fail preflight");
    assert(rejected.error.includes(`Error(Contract, #${attack.code})`), `Unexpected preflight error: ${rejected.error}`);
    // A failing preflight has no resource estimate. Reuse a valid call's budget,
    // then include the exact allowlist key read by the rejected invocation.
    const { simulation } = await simulate(agent, call(vault, "execute", approveArgs));
    const data = new SorobanDataBuilder(simulation.transactionData.build());
    const ruleKey = xdr.LedgerKey.contractData(new xdr.LedgerKeyContractData({
      contract: new Address(vault).toScAddress(),
      key: vec([symbol("Rule"), address(attack.target), symbol(attack.fn)]),
      durability: xdr.ContractDataDurability.persistent,
    }));
    const keys = [...data.getReadOnly(), ruleKey];
    data.setReadOnly([...new Map(keys.map(key => [key.toXdr("base64"), key])).values()]);
    assert(operation.body.type === "invokeHostFunction");
    const func = operation.body.invokeHostFunctionOp.hostFunction;
    assert(func.type === "hostFunctionTypeInvokeContract");
    const root = new xdr.SorobanAuthorizedInvocation({
      function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(func.invokeContract),
      subInvocations: [],
    });
    const auth = new xdr.SorobanAuthorizationEntry({
      credentials: xdr.SorobanCredentials.sorobanCredentialsSourceAccount(), rootInvocation: root,
    });
    const authorized = Operation.invokeHostFunction({
      func, auth: [auth],
    });
    const raw = await build(agent, authorized);
    const finalTx = rpc.assembleTransaction(raw, simulation)
      .setSorobanData(data.setResourceFee(simulation.transactionData.build().resourceFee + 1_000_000n).build())
      .build();
    const result = await submit(agent, finalTx);
    assert.equal(result.status, rpc.Api.GetTransactionStatus.FAILED, `Attack unexpectedly succeeded: ${result.txHash}`);
    assert(result.status === rpc.Api.GetTransactionStatus.FAILED);
    const errors = (result.diagnosticEventsXdr ?? []).flatMap(event => {
      const contractEvent = event.event;
      const id = contractEvent.contractId;
      if (!id || Address.fromScAddress(xdr.ScAddress.scAddressTypeContract(id)).toString() !== vault) return [];
      return contractEvent.body.v0.topics.filter(topic => topic.type === "scvError").map(topic => topic.error);
    });
    assert(errors.some(error => error.type === "sceContract" && error.contractCode === attack.code), `Missing on-chain ${attack.name} diagnostic for ${result.txHash}`);
    console.log(`BLOCKED ${attack.name} ${result.txHash} RPC=FAILED code=${attack.code}`);
  }
  assert.deepEqual((await horizon.loadAccount(attacker)).balances, attackerBefore, "Attacker balances must remain unchanged");
  assert.deepEqual(await read<Positions>(admin, testnet.pool, "get_positions", [address(vault)]), positions, "Rejected attacks must not modify Blend positions");
  // A testnet donation exercises fee accounting; it is not protocol yield.
  await send(admin, call(testnet.usdc, "transfer", [address(admin.publicKey()), address(vault), i128(10n * UNIT)]));
  const crystallized = await send(agent, call(vault, "execute", [
    address(testnet.usdc), symbol("approve"),
    vec([address(vault), address(testnet.pool), i128(0n), u32(expiry)]),
  ]));
  const protocolShares = await read<bigint>(admin, vault, "balance", [address(signer("LEASH_KEEPER_SECRET").publicKey())]);
  const totalShares = await read<bigint>(admin, vault, "total_shares");
  const feeNav = await read<bigint>(admin, vault, "nav");
  const protocolValue = protocolShares * (feeNav + 1n) / (totalShares + 1_000_000_000n);
  assert(protocolValue >= UNIT / 100n - 1n && protocolValue <= UNIT / 100n + UNIT / 1_000n,
    "Protocol must receive 1% of the 10% performance commission");
  assert((await read<bigint>(admin, vault, "balance", [address(admin.publicKey())])) > shares,
    "Creator must receive fee shares");
  console.log(`FEES_CRYSTALLIZED ${crystallized.txHash} protocol_value=${protocolValue}`);
  await send(admin, call(vault, "set_paused", [xdr.ScVal.scvBool(true)]));
  const pausedDeposit = await server.simulateTransaction(await build(admin,
    call(vault, "deposit", [address(admin.publicKey()), i128(UNIT)])));
  assert(rpc.Api.isSimulationError(pausedDeposit) && pausedDeposit.error.includes("Error(Contract, #6)"),
    "Paused vault must reject deposits");
  const beforeWithdrawal = await balance(admin, admin.publicKey());
  const partial = await send(admin, call(vault, "withdraw", [address(admin.publicKey()), i128(shares / 2n)]));
  assert(partial.returnValue, "Withdrawal must return assets");
  const partialAmount = scValToNative(partial.returnValue) as bigint;
  assert.equal((await balance(admin, admin.publicKey())) - beforeWithdrawal, partialAmount);
  assert(partialAmount >= 109n * UNIT / 2n - UNIT / 100n && partialAmount <= 109n * UNIT / 2n + UNIT / 100n,
    "Partial paused withdrawal must return principal plus net gains");
  const partialPositions = await read<Positions>(admin, testnet.pool, "get_positions", [address(vault)]);
  assert((partialPositions.supply[3] ?? 0n) < (positions.supply[3] ?? 0n),
    "Withdrawal must unwind the Blend position");
  console.log(`WITHDRAWN_PAUSED ${partial.txHash} assets=${partialAmount}`);
  const remaining = await read<bigint>(admin, vault, "balance", [address(admin.publicKey())]);
  const redeemed = await send(admin, call(vault, "withdraw", [address(admin.publicKey()), i128(remaining)]));
  assert.equal(await read<bigint>(admin, vault, "balance", [address(admin.publicKey())]), 0n);
  const residual = await read<bigint>(admin, vault, "nav");
  assert(residual >= 0n && residual <= UNIT / 50n, "Only protocol commission and rounding dust may remain");
  console.log(`REDEEMED_PAUSED ${redeemed.txHash} residual_nav=${residual}`);
  assert((await balance(admin, admin.publicKey())) >= 5_000n * UNIT, "Admin must retain at least 5,000 USDC");
  console.log("PASS deposit, Blend supply, both on-chain refusals, performance fees and paused redemptions");
}

main().catch(fail);
