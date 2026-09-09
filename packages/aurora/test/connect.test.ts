import { describe, expect, test } from "bun:test";
import { bytesToHex, decodeFunctionData, erc20Abi, type Hex, recoverMessageAddress, toFunctionSelector } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { attentionPerpAbi, iKuruRouterAbi, outcomeMarketsAbi } from "../../contracts-ts/src/abis";
import {
  AuroraHttpError,
  AuroraInputError,
  base58Decode,
  checkCreatedExecution,
  checkIntentPayload,
  CURVE_AUSD_POOL,
  CURVE_AUSD_VENUE,
  curvePoolAbi,
  ConnectPlanError,
  ConnectStepError,
  type CreateExecutionBody,
  DEPOSIT_ADDRESS,
  deleteExecutionMessage,
  depositAusdSteps,
  encodeStep,
  type EvmStep,
  type Execution,
  fundUsdcSteps,
  IntentsConnectClient,
  KURU_AUSD_USDC,
  KURU_CLOB_VENUE,
  KURU_MAINNET,
  MIN_AMOUNT_OUT,
  MONAD_ASSETS,
  MONAD_MAINNET_CONNECT,
  minusBps,
  mintOutcomeSetSteps,
  openPerpSteps,
  planBridgeIn,
  signIntentPayload,
  sweepSteps,
  toIntentsSignature,
  transferStep,
  validateSteps,
} from "../src";
import { fixture, fromFixture, json, recordedSleep, scriptedFetch } from "./helpers";

const KEY = "test-app-key-0000";
const WALLET = "0x2222222222222222222222222222222222222222";
const ACCOUNT = "0x4444444444444444444444444444444444444444";
const USDC = MONAD_ASSETS.USDC.address!;
const cfg = MONAD_MAINNET_CONNECT;
const kuruCfg = { ...MONAD_MAINNET_CONNECT, venue: KURU_CLOB_VENUE };
const INTERMEDIARY = "0x5181Ad08975Ac86A2b6368497a96F06FC0Bb4e63";

function connect(script: Parameters<typeof scriptedFetch>[0], apiKey: string | null = KEY) {
  const f = scriptedFetch(script);
  const s = recordedSleep();
  return { api: new IntentsConnectClient({ apiKey: apiKey ?? undefined, fetch: f.fetch, sleep: s.sleep, random: () => 0 }), ...f, waits: s.waits };
}

/** Lowercases every string, so checksummed and lowercase addresses compare equal. */
const lower = (v: unknown): unknown =>
  typeof v === "string" ? v.toLowerCase() : Array.isArray(v) ? v.map(lower) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, lower(x)])) : v;

describe("Intents Connect client", () => {
  test("lists Monad as a destination and derives the intermediary", async () => {
    const { api, calls } = connect([fromFixture("connect/supported-tokens"), fromFixture("connect/intermediary")]);
    const tokens = await api.supportedTokens("inOperation");
    expect(new URL(calls[0]!.url).searchParams.get("flow")).toBe("inOperation");
    expect(tokens.out.filter((t) => t.blockchain === "monad").map((t) => t.symbol).sort()).toEqual(["MON", "USDC", "USDT0"]);
    expect(tokens.out.find((t) => t.symbol === "USDC" && t.blockchain === "monad")!.assetId).toBe(MONAD_ASSETS.USDC.assetId);
    const intermediary = await api.intermediary(WALLET);
    expect(calls[1]!.url).toBe(`https://intents-connect-api.aurora.dev/api/v1/executions/${WALLET}/intermediary`);
    expect(intermediary.evm).toBe("0x5181Ad08975Ac86A2b6368497a96F06FC0Bb4e63");
    expect(intermediary.originType).toBe("evm");
  });

  test("create calls carry x-api-key, and fail locally without one", async () => {
    const r1 = fixture("connect/dry-round1");
    const { api, calls } = connect([json(r1.status, r1.body)]);
    await api.createExecution(WALLET, r1.request);
    expect((calls[0]!.init.headers as Record<string, string>)["x-api-key"]).toBe(KEY);
    const keyless = connect([], null);
    expect(keyless.api.createExecution(WALLET, r1.request)).rejects.toBeInstanceOf(AuroraInputError);
    expect(keyless.calls).toHaveLength(0);
  });

  test("surfaces the API's own errors", async () => {
    const r1 = fixture("connect/dry-round1");
    const { api } = connect([fromFixture("connect/error-missing-key")]);
    const error = await api.createExecution(WALLET, r1.request).catch((e) => e);
    expect(error).toBeInstanceOf(AuroraHttpError);
    expect(error.status).toBe(401);
    expect(error.message).toContain("missing or invalid api token");
  });

  test("rejects a recipient on a bridge-in and a live create without steps", async () => {
    const r1 = fixture("connect/dry-round1");
    const { api, calls } = connect([]);
    expect(api.createExecution(WALLET, { ...r1.request, quote: { ...r1.request.quote, recipient: ACCOUNT } })).rejects.toBeInstanceOf(AuroraInputError);
    expect(api.createExecution(WALLET, { ...r1.request, dry: false })).rejects.toBeInstanceOf(AuroraInputError);
    expect(calls).toHaveLength(0);
  });

  test("never retries a live create, which holds the wallet's lock", async () => {
    const r2 = fixture("connect/dry-round2-curve");
    const { api, calls } = connect([json(502, { error: "bad gateway" }), json(201, r2.body)]);
    const error = await api.createExecution(WALLET, { ...r2.request, dry: false }).catch((e) => e);
    expect(error.status).toBe(502);
    expect(calls).toHaveLength(1);
  });

  test("reads executions and waits for a final status", async () => {
    const list = fixture("connect/executions");
    const expired = list.body.result.find((e: Execution) => e.status === "EXPIRED");
    const { api, calls } = connect([json(200, list.body), json(200, { result: [expired] })]);
    const all = await api.executions(WALLET, { status: ["EXPIRED", "OPERATION_PENDING"] });
    expect(new URL(calls[0]!.url).searchParams.get("status")).toBe("EXPIRED,OPERATION_PENDING");
    expect(all.map((e) => e.executionMode).sort()).toEqual(["quote_with_steps", "steps_only"]);
    expect(all.find((e) => e.executionMode === "steps_only")!.quote?.swapType).toBe("EXACT_INPUT");
    expect((await api.waitForExecution(WALLET, expired.id)).status).toBe("EXPIRED");
  });

  test("steps-only executions need no key", async () => {
    const sweep = fixture("connect/steps-dry-sweep");
    const { api, calls } = connect([json(sweep.status, sweep.body)], null);
    const res = await api.createStepsExecution(WALLET, sweep.request);
    expect(res.status).toBe("OPERATION_PENDING");
    expect(res.details?.networkFee).toBe(sweep.body.result.details.networkFee);
    expect((calls[0]!.init.headers as Record<string, string>)["x-api-key"]).toBeUndefined();
  });
});

describe("Trendr recipes against the live API", () => {
  for (const [venue, config, swapIndex, amountIndexes] of [
    ["kuru", kuruCfg, 1, [5, 6]],
    ["curve", cfg, 1, [2, 3]],
  ] as const) {
    test(`the deposit-AUSD recipe on ${venue} is exactly what the API accepted for a Monad dry run`, () => {
      const r2 = fixture(`connect/dry-round2-${venue}`);
      const swap = (r2.request.steps as EvmStep[])[swapIndex]!;
      const usdcIn = BigInt(swap.parameters[amountIndexes[0]] as string);
      const minAusdOut = BigInt(swap.parameters[amountIndexes[1]] as string);
      const steps = depositAusdSteps(config, { usdcIn, minAusdOut, account: WALLET });
      expect(lower(steps)).toEqual(lower(r2.request.steps));
      // The service echoed our steps and appended its fee transfer in USDC.
      const echoed = r2.body.result.steps as EvmStep[];
      expect(echoed).toHaveLength(steps.length + 1);
      expect(lower(echoed.slice(0, steps.length))).toEqual(lower(steps));
      const fee = echoed.at(-1)!;
      expect(fee.to.toLowerCase()).toBe(USDC.toLowerCase());
      expect(fee.functionSignature).toBe("transfer(address,uint256)");
      expect(fee.parameters[1]).toBe(r2.body.result.details.networkFee);
    });
  }

  test("the sweep recipe is exactly the steps-only body the API accepted", () => {
    const sweep = fixture("connect/steps-dry-sweep");
    expect(lower(sweepSteps(cfg, { account: WALLET, usdc: 1_000_000n, ausd: 500_000n }))).toEqual(lower(sweep.request.steps));
  });
});

describe("recipe encoding", () => {
  const seriesId = "0x1111111111111111111111111111111111111111111111111111111111111111" as Hex;
  const trendId = "0x2222222222222222222222222222222222222222222222222222222222222222" as Hex;
  const outcomeMarkets = "0x5555555555555555555555555555555555555555";
  const attentionPerp = "0x6666666666666666666666666666666666666666";

  test("deposit AUSD on the stable pool: approve, then exchange paying the account", () => {
    const steps = depositAusdSteps(cfg, { usdcIn: 20_000_000n, minAusdOut: 19_900_000n, account: ACCOUNT });
    validateSteps(steps, { flow: "bridge-in", destinationToken: USDC });
    const [approve, exchange] = steps.map((s) => encodeStep(s));
    expect(steps).toHaveLength(2);
    expect(approve!.to).toBe(USDC);
    expect(decodeFunctionData({ abi: erc20Abi, data: approve!.data }).args).toEqual([CURVE_AUSD_POOL.address, 20_000_000n]);
    expect(exchange!.to).toBe(CURVE_AUSD_POOL.address);
    const decoded = decodeFunctionData({ abi: curvePoolAbi, data: exchange!.data });
    expect(decoded.functionName).toBe("exchange");
    expect(decoded.args).toEqual([1n, 0n, 20_000_000n, 19_900_000n, ACCOUNT]);
  });

  test("deposit AUSD on Kuru: approve, Kuru swap, transfer to the account", () => {
    const [approve, swap, transfer] = depositAusdSteps(kuruCfg, { usdcIn: 20_000_000n, minAusdOut: 19_700_000n, account: ACCOUNT }).map((s) => encodeStep(s));
    expect(approve!.to).toBe(USDC);
    expect(decodeFunctionData({ abi: erc20Abi, data: approve!.data }).args).toEqual([KURU_MAINNET.router, 20_000_000n]);
    expect(swap!.to).toBe(KURU_MAINNET.router);
    const decoded = decodeFunctionData({ abi: iKuruRouterAbi, data: swap!.data });
    expect(decoded.functionName).toBe("anyToAnySwap");
    expect(lower(decoded.args)).toEqual(lower([[KURU_AUSD_USDC.address], [true], [false], USDC, cfg.ausd, 20_000_000n, 19_700_000n]));
    expect(decodeFunctionData({ abi: erc20Abi, data: transfer!.data }).args).toEqual([ACCOUNT, 19_700_000n]);
  });

  test("outcome complete set: swap into the intermediary, then mint(seriesId, amount, account)", () => {
    const steps = mintOutcomeSetSteps(cfg, { usdcIn: 20_000_000n, minAusdOut: 19_700_000n, account: ACCOUNT, intermediary: INTERMEDIARY, outcomeMarkets, seriesId });
    validateSteps(steps, { flow: "bridge-in", destinationToken: USDC });
    // mint pulls AUSD from its caller, so the pool pays the intermediary, not the account.
    expect(decodeFunctionData({ abi: curvePoolAbi, data: encodeStep(steps[1]!).data }).args[4]).toBe(INTERMEDIARY);
    const approve = encodeStep(steps[2]!);
    expect(approve.to).toBe(cfg.ausd);
    expect(decodeFunctionData({ abi: erc20Abi, data: approve.data }).args).toEqual([outcomeMarkets, 19_700_000n]);
    const mint = encodeStep(steps[3]!);
    const mintItem = outcomeMarketsAbi.find((x) => x.type === "function" && x.name === "mint")!;
    expect(mint.data.slice(0, 10)).toBe(toFunctionSelector(mintItem as never));
    const decoded = decodeFunctionData({ abi: outcomeMarketsAbi, data: mint.data });
    expect(decoded.functionName).toBe("mint");
    expect(decoded.args).toEqual([seriesId, 19_700_000n, ACCOUNT]);
  });

  test("perp: openFor(account, ...) on AttentionPerp with the swapped AUSD as margin", () => {
    const steps = openPerpSteps(kuruCfg, {
      usdcIn: 20_000_000n,
      minAusdOut: 19_700_000n,
      account: ACCOUNT,
      intermediary: INTERMEDIARY,
      attentionPerp,
      trendId,
      isLong: true,
      leverage: 2n * 10n ** 18n,
      acceptableIndex: 123_456n,
      deadline: 1_791_600_000n,
    });
    validateSteps(steps, { flow: "bridge-in", destinationToken: USDC });
    const decoded = decodeFunctionData({ abi: attentionPerpAbi, data: encodeStep(steps[3]!).data });
    expect(decoded.functionName).toBe("openFor");
    expect(decoded.args).toEqual([ACCOUNT, trendId, true, 19_700_000n, 2n * 10n ** 18n, 123_456n, 1_791_600_000n]);
  });

  test("fund USDC: one transfer of the service's guaranteed amount", () => {
    const steps = fundUsdcSteps(cfg, { account: ACCOUNT });
    validateSteps(steps, { flow: "bridge-in", destinationToken: USDC });
    expect(steps[0]!.parameters[1]).toBe(MIN_AMOUNT_OUT);
    const call = encodeStep(steps[0]!, { [MIN_AMOUNT_OUT]: "19888375" });
    expect(decodeFunctionData({ abi: erc20Abi, data: call.data }).args).toEqual([ACCOUNT, 19_888_375n]);
    expect(() => validateSteps(steps, { flow: "steps-only", destinationToken: USDC })).toThrow(ConnectStepError);
  });

  test("bad inputs fail before anything is built", () => {
    expect(() => depositAusdSteps(cfg, { usdcIn: 0n, minAusdOut: 1n, account: ACCOUNT })).toThrow(ConnectStepError);
    expect(() => depositAusdSteps(cfg, { usdcIn: 1n, minAusdOut: 1n, account: "alice.near" })).toThrow(ConnectStepError);
    expect(() => mintOutcomeSetSteps(cfg, { usdcIn: 1n, minAusdOut: 1n, account: ACCOUNT, intermediary: "", outcomeMarkets, seriesId })).toThrow(ConnectStepError);
  });
});

describe("step rules", () => {
  const ok = transferStep(USDC, ACCOUNT, 1n);
  const code = (fn: () => void) => {
    try {
      fn();
    } catch (e) {
      return (e as ConnectStepError).code;
    }
    return "none";
  };
  const check = (steps: EvmStep[], flow: "bridge-in" | "steps-only" | "out-operation" = "bridge-in") => () =>
    validateSteps(steps, { flow, destinationToken: USDC });

  test("enforces the documented limits", () => {
    expect(code(check([]))).toBe("NO_STEPS");
    expect(code(check(new Array(31).fill(ok)))).toBe("TOO_MANY_STEPS");
    expect(code(check([{ ...ok, gas: "1" } as EvmStep]))).toBe("ILLEGAL_STEP_SHAPE");
    expect(code(check([{ ...ok, functionSignature: "transfer(address, uint256)" }]))).toBe("BAD_SIGNATURE");
    expect(code(check([{ ...ok, parameters: [ACCOUNT] }]))).toBe("BAD_PARAMETERS");
    expect(code(check([transferStep(cfg.ausd, ACCOUNT, 1n)]))).toBe("DESTINATION_TOKEN_UNTOUCHED");
    expect(code(check([transferStep(USDC, ACCOUNT, MIN_AMOUNT_OUT)], "steps-only"))).toBe("PLACEHOLDER_NOT_ALLOWED");
    expect(code(check([{ ...ok, to: DEPOSIT_ADDRESS }]))).toBe("ILLEGAL_STEP_SHAPE");
    expect(code(check([ok, { ...ok, to: DEPOSIT_ADDRESS, functionSignature: "native", parameters: [] }], "out-operation"))).toBe("BAD_SIGNATURE");
    expect(code(check([ok]))).toBe("none");
  });
});

describe("planning a bridge-in", () => {
  const r1 = fixture("connect/dry-round1");
  const r2 = fixture("connect/dry-round2-curve");
  // The pool's recorded price for 1,000 USDC, applied linearly, less 0.5%: a stand-in for get_dy.
  const [, sample] = fixture("curve/ausd-pool").body.usdcToAusd;
  const build = ({ spendable }: { spendable: bigint }) =>
    depositAusdSteps(cfg, { usdcIn: spendable, minAusdOut: minusBps((spendable * BigInt(sample.dy)) / BigInt(sample.dx), 50), account: ACCOUNT });
  const plan = async (round2Body = r2.body) => {
    const { api, calls } = connect([json(200, r1.body), json(200, round2Body)]);
    const result = await planBridgeIn(api, { wallet: WALLET, quote: r1.request.quote, destinationToken: USDC, build, metadata: r1.request.metadata });
    return { result, calls };
  };

  test("sizes the steps from the dry runs so the exact amount is known before signing", async () => {
    const { result, calls } = await plan();
    expect(calls).toHaveLength(2);
    expect(calls[0]!.body.steps).toEqual([]);
    expect(calls[0]!.body.dry).toBe(true);
    expect(calls[1]!.body.dry).toBe(true);
    expect(calls[1]!.body.steps[0].parameters[1]).toBe(r1.body.result.quote.minAmountOut);
    for (const c of calls) expect((c.init.headers as Record<string, string>)["x-api-key"]).toBe(KEY);
    expect(result.intermediary).toBe("0x5181Ad08975Ac86A2b6368497a96F06FC0Bb4e63");
    expect(result.grossMinAmountOut).toBe(BigInt(r1.body.result.quote.minAmountOut));
    expect(result.networkFee).toBe(BigInt(r2.body.result.details.networkFee));
    expect(result.minAmountOut).toBe(BigInt(r2.body.result.quote.minAmountOut));
    expect(result.spendable).toBe((result.minAmountOut * 9_990n) / 10_000n);
    expect(result.request.dry).toBe(false);
    expect(result.request.steps[0]!.parameters[1]).toBe(result.spendable.toString());
    expect(result.estimatedSeconds).toBe(37);
    // The fee and the spend fit inside the bridge's guaranteed delivery.
    expect(result.spendable + result.networkFee).toBeLessThanOrEqual(result.grossMinAmountOut);
  });

  test("stops when gas estimation failed instead of baking in a gross amount", async () => {
    const noFee = structuredClone(r2.body);
    delete noFee.result.details.networkFee;
    const error = await plan(noFee).catch((e) => e);
    expect(error).toBeInstanceOf(ConnectPlanError);
    expect(error.code).toBe("NO_FEE_ESTIMATE");
  });

  test("checks the live create before the user signs", async () => {
    const { result } = await plan();
    const payload = fixture("connect/executions").body.result[0].details.payload;
    const created = (patch: Partial<Execution> = {}, steps?: EvmStep[]): Execution => ({
      ...r2.body.result,
      id: "33ca3807-0e1b-455f-a6dd-1a482ec9b385",
      quote: { ...r2.body.result.quote, minAmountOut: result.minAmountOut.toString(), depositAddress: "0x8b9F5A1329c0d5376038F1d29DeB7C662B5f7426" },
      steps: steps ?? [...result.steps, { ...transferStep(USDC, "0x546252c9a0E974f75892b4c54b7a67B69a0aFf45", result.networkFee), metadata: { name: "Fee Transfer" } }],
      details: { ...r2.body.result.details, payload, signingStandard: "erc191" },
      ...patch,
    });
    const now = Date.parse("2026-08-14T09:00:00Z");
    const ok = checkCreatedExecution(created(), result, { now });
    expect(ok.depositAddress).toBe("0x8b9F5A1329c0d5376038F1d29DeB7C662B5f7426");
    expect(ok.depositAmount).toBe("20000000");
    expect(ok.payloadJson).toBe(payload.payload_json);
    expect(ok.authorized?.calls).toHaveLength(2);
    // A payload past its deadline is refused before the user is asked to sign.
    expect(() => checkCreatedExecution(created(), result)).toThrow("expired");

    const codeOf = (e: Execution) => {
      try {
        checkCreatedExecution(e, result, { now });
      } catch (error) {
        return (error as ConnectPlanError).code;
      }
    };
    const base = created();
    expect(codeOf({ ...base, quote: { ...base.quote, minAmountOut: (result.spendable - 1n).toString() } })).toBe("QUOTE_MOVED");
    const tampered = [...result.steps];
    tampered[1] = transferStep(cfg.ausd, WALLET, 1n);
    expect(codeOf(created({}, [...tampered, base.steps!.at(-1) as EvmStep]))).toBe("STEPS_CHANGED");
    expect(codeOf(created({}, [...result.steps, transferStep(cfg.ausd, WALLET, result.networkFee)]))).toBe("STEPS_CHANGED");
    expect(codeOf({ ...base, details: { ...base.details, signingStandard: "raw_ed25519", payload: { ...payload, standard: "raw_ed25519" } } })).toBe("UNEXPECTED_SIGNING");
  });

  test("the live create body is a valid request", async () => {
    const { result } = await plan();
    const body: CreateExecutionBody = result.request;
    expect(body.quote.recipient).toBeUndefined();
    expect(body.steps).toEqual(result.steps);
  });
});

describe("signing", () => {
  const execution = fixture("connect/executions").body.result.find((e: Execution) => e.executionMode === "quote_with_steps");
  const payloadJson: string = execution.details.payload.payload_json;
  const before = Date.parse("2026-08-14T09:00:00Z");

  test("the payload authorizes chain-signature calls for the wallet's own intermediary", () => {
    const checked = checkIntentPayload(payloadJson, { wallet: WALLET, now: before });
    expect(checked.signer).toBe(WALLET);
    expect(checked.calls).toHaveLength(2);
    for (const call of checked.calls) {
      expect(call.contract).toBe("proxy-signer-dev.near");
      expect(call.path).toBe(WALLET);
      expect(call.digest).toMatch(/^0x[0-9a-f]{64}$/);
    }
  });

  test("refuses payloads for another wallet, expired ones and unknown signer contracts", () => {
    expect(() => checkIntentPayload(payloadJson, { wallet: ACCOUNT, now: before })).toThrow("not");
    expect(() => checkIntentPayload(payloadJson, { wallet: WALLET, now: Date.parse("2027-01-01") })).toThrow("expired");
    expect(() => checkIntentPayload(payloadJson, { wallet: WALLET, now: before, allowedContracts: ["proxy-signer.near"] })).toThrow("unexpected signer");
    expect(() => checkIntentPayload("{}", { wallet: WALLET })).toThrow("unexpected payload");
  });

  test("an EOA's personal_sign becomes secp256k1:base58(r||s||v) and recovers to the signer", async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const encoded = await signIntentPayload((message) => account.signMessage({ message }), payloadJson);
    expect(encoded.startsWith("secp256k1:")).toBe(true);
    const bytes = base58Decode(encoded.slice("secp256k1:".length));
    expect(bytes).toHaveLength(65);
    expect([0, 1]).toContain(bytes[64]!);
    const restored = Uint8Array.from(bytes);
    restored[64] = restored[64]! + 27;
    expect(await recoverMessageAddress({ message: payloadJson, signature: bytesToHex(restored) })).toBe(account.address);
    expect(() => toIntentsSignature("0x1234")).toThrow();
  });

  test("deleting an execution signs a fixed message", () => {
    expect(deleteExecutionMessage("e5abf7ce-1187-4562-b2a7-c52d6560f327")).toBe("delete_execution:e5abf7ce-1187-4562-b2a7-c52d6560f327");
  });
});
