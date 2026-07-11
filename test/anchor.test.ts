import { decodeAbiParameters } from "viem";
import { describe, expect, it } from "vitest";
import {
  ANCHOR_SCHEMA,
  ANCHOR_SCHEMA_PARAMS,
  EAS_ADDRESS,
  SCHEMA_REGISTRY_ADDRESS,
  anchorBatch,
  buildAnchorFromLedger,
  registerSchema,
  type AnchorWalletClient,
} from "../src/anchor.js";
import { buildMerkleTree } from "../src/merkle.js";
import { receiptDigest } from "../src/receipt.js";
import { sampleReceipt } from "./fixtures.js";

interface RecordedCall {
  address: string;
  functionName: string;
  args: readonly unknown[];
}

function mockClient(opts: {
  result: unknown;
  txHash?: `0x${string}`;
  calls: RecordedCall[];
  simulateThrows?: boolean;
  throwMessage?: string;
}): AnchorWalletClient {
  return {
    async simulateContract(args) {
      if (opts.simulateThrows) throw new Error(opts.throwMessage ?? "execution reverted: AlreadyExists()");
      opts.calls.push({ address: args.address, functionName: args.functionName, args: args.args });
      return { result: opts.result, request: { __mockRequest: true, functionName: args.functionName } };
    },
    async writeContract() {
      return opts.txHash ?? (`0x${"b".repeat(64)}` as `0x${string}`);
    },
  };
}

describe("registerSchema", () => {
  it("builds the correct register() call and returns the mocked schemaUID", async () => {
    const schemaUID = `0x${"1".repeat(64)}` as `0x${string}`;
    const calls: RecordedCall[] = [];
    const client = mockClient({ result: schemaUID, calls });

    const result = await registerSchema(client, {});

    expect(result).toBe(schemaUID);
    expect(calls).toHaveLength(1);
    expect(calls[0].address).toBe(SCHEMA_REGISTRY_ADDRESS);
    expect(calls[0].functionName).toBe("register");
    expect(calls[0].args).toEqual([ANCHOR_SCHEMA, "0x0000000000000000000000000000000000000000", true]);
  });

  it("respects custom resolver/revocable/registry address", async () => {
    const schemaUID = `0x${"2".repeat(64)}` as `0x${string}`;
    const calls: RecordedCall[] = [];
    const client = mockClient({ result: schemaUID, calls });
    const resolver = `0x${"9".repeat(40)}` as `0x${string}`;

    await registerSchema(client, { resolver, revocable: false });

    expect(calls[0].args).toEqual([ANCHOR_SCHEMA, resolver, false]);
  });

  it("recovers the deterministic UID locally when the contract call reverts (already registered)", async () => {
    const calls: RecordedCall[] = [];
    const client = mockClient({ result: null, calls, simulateThrows: true });

    const first = await registerSchema(client, {});
    const second = await registerSchema(client, {});

    expect(first).toBe(second);
    expect(first).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("propagates a non-AlreadyExists failure instead of reporting false success", async () => {
    const calls: RecordedCall[] = [];
    const client = mockClient({
      result: null,
      calls,
      simulateThrows: true,
      throwMessage: "HTTP request failed: 503 Service Unavailable",
    });

    await expect(registerSchema(client, {})).rejects.toThrow(/503/);
  });
});

describe("anchorBatch", () => {
  it("encodes the 6 schema fields correctly (round-trip) and passes the right AttestationRequestData", async () => {
    const attestationUID = `0x${"3".repeat(64)}` as `0x${string}`;
    const calls: RecordedCall[] = [];
    const client = mockClient({ result: attestationUID, calls });

    const schemaUID = `0x${"4".repeat(64)}` as `0x${string}`;
    const merkleRoot = `0x${"5".repeat(64)}` as `0x${string}`;

    const result = await anchorBatch(client, {
      schemaUID,
      agentId: 42n,
      merkleRoot,
      receiptCount: 7n,
      periodStart: 1000n,
      periodEnd: 2000n,
      receiptsURI: "https://example.com/receipts/batch-1.jsonl",
    });

    expect(result).toBe(attestationUID);
    expect(calls).toHaveLength(1);
    expect(calls[0].address).toBe(EAS_ADDRESS);
    expect(calls[0].functionName).toBe("attest");

    const [request] = calls[0].args as [{ schema: string; data: Record<string, unknown> }];
    expect(request.schema).toBe(schemaUID);
    expect(request.data.recipient).toBe("0x0000000000000000000000000000000000000000");
    expect(request.data.expirationTime).toBe(0n);
    expect(request.data.revocable).toBe(true);
    expect(request.data.refUID).toBe(`0x${"0".repeat(64)}`);

    const decoded = decodeAbiParameters(ANCHOR_SCHEMA_PARAMS, request.data.data as `0x${string}`);
    expect(decoded[0]).toBe(42n);
    expect(decoded[1]).toBe(merkleRoot);
    expect(decoded[2]).toBe(7n);
    expect(decoded[3]).toBe(1000n);
    expect(decoded[4]).toBe(2000n);
    expect(decoded[5]).toBe("https://example.com/receipts/batch-1.jsonl");
  });

  it("threads a caller-supplied refUID into AttestationRequestData", async () => {
    const calls: RecordedCall[] = [];
    const client = mockClient({ result: `0x${"6".repeat(64)}`, calls });
    const refUID = `0x${"7".repeat(64)}` as `0x${string}`;

    await anchorBatch(client, {
      schemaUID: `0x${"8".repeat(64)}` as `0x${string}`,
      agentId: 1n,
      merkleRoot: `0x${"a".repeat(64)}` as `0x${string}`,
      receiptCount: 1n,
      periodStart: 0n,
      periodEnd: 0n,
      receiptsURI: "https://example.com/r.jsonl",
      refUID,
    });

    const [request] = calls[0].args as [{ data: Record<string, unknown> }];
    expect(request.data.refUID).toBe(refUID);
  });

  it("chains two sequential anchors: the second references the first's UID", async () => {
    const firstUID = `0x${"1".repeat(64)}` as `0x${string}`;
    const secondUID = `0x${"2".repeat(64)}` as `0x${string}`;
    const schemaUID = `0x${"9".repeat(64)}` as `0x${string}`;

    const firstCalls: RecordedCall[] = [];
    const firstClient = mockClient({ result: firstUID, calls: firstCalls });
    const returnedFirstUID = await anchorBatch(firstClient, {
      schemaUID,
      agentId: 1n,
      merkleRoot: `0x${"a".repeat(64)}` as `0x${string}`,
      receiptCount: 1n,
      periodStart: 0n,
      periodEnd: 100n,
      receiptsURI: "https://example.com/batch-1.jsonl",
    });

    const secondCalls: RecordedCall[] = [];
    const secondClient = mockClient({ result: secondUID, calls: secondCalls });
    await anchorBatch(secondClient, {
      schemaUID,
      agentId: 1n,
      merkleRoot: `0x${"b".repeat(64)}` as `0x${string}`,
      receiptCount: 1n,
      periodStart: 100n,
      periodEnd: 200n,
      receiptsURI: "https://example.com/batch-2.jsonl",
      refUID: returnedFirstUID,
    });

    const [secondRequest] = secondCalls[0].args as [{ data: Record<string, unknown> }];
    expect(returnedFirstUID).toBe(firstUID);
    expect(secondRequest.data.refUID).toBe(firstUID);
  });
});

describe("buildAnchorFromLedger", () => {
  it("matches src/merkle.ts's root over the same receipts, and correct count/period bounds", () => {
    const receipts = [
      sampleReceipt({ response: { status: 200, body_sha256: "a".repeat(64), content_type: "application/json", ts: "2026-07-10T12:00:00.000Z", latency_ms: 10 } }),
      sampleReceipt({ response: { status: 200, body_sha256: "b".repeat(64), content_type: "application/json", ts: "2026-07-10T13:00:00.000Z", latency_ms: 10 } }),
      sampleReceipt({ response: { status: 200, body_sha256: "c".repeat(64), content_type: "application/json", ts: "2026-07-10T11:00:00.000Z", latency_ms: 10 } }),
    ];

    const expectedTree = buildMerkleTree(receipts.map(receiptDigest));

    const result = buildAnchorFromLedger(receipts, { agentId: 99n, receiptsURI: "https://example.com/batch.jsonl" });

    expect(result.merkleRoot).toBe(`0x${expectedTree.root}`);
    expect(result.receiptCount).toBe(3n);
    expect(result.periodStart).toBe(BigInt(Math.floor(Date.parse("2026-07-10T11:00:00.000Z") / 1000)));
    expect(result.periodEnd).toBe(BigInt(Math.floor(Date.parse("2026-07-10T13:00:00.000Z") / 1000)));
    expect(result.agentId).toBe(99n);
    expect(result.receiptsURI).toBe("https://example.com/batch.jsonl");
  });

  it("throws on an empty receipt batch", () => {
    expect(() => buildAnchorFromLedger([], { agentId: 1n, receiptsURI: "https://example.com/x.jsonl" })).toThrow(
      /zero receipts/
    );
  });
});
