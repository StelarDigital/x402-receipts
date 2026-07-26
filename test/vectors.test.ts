import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { envelopeDigest, type Receipt } from "../src/receipt.js";
import { deliveryStatusOk, verifyReceipt } from "../src/verify.js";
import { verifySettlement, type SettlementClient, type SettlementTransaction, type SettlementTransactionReceipt } from "../src/settlement.js";

const VECTORS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "vectors");

interface VectorFixture {
  id: string;
  description: string;
  predicate: string;
  vectorSellerAddress: `0x${string}`;
  vectorBuyerAddress: `0x${string}`;
  mockOnChain: {
    status: "success" | "reverted";
    blockNumber: number;
    currentBlock: number;
    transferLog: { contract: string; from: string; to: string; value: string } | null;
  };
  receipt: Receipt;
}

const DIGESTS: Record<string, string> = {
  "pass-settled-delivered": "b287e7addc8f0a06754a39f13a88fdd7e14b8b856a799288ba5ba0c7b526d991",
  "neg-funded-not-delivered": "4fb1ec3149cc40cb503752418a71258f4f55d7a29478075a9f06f9bd36650e33",
  "neg-delivered-not-settled": "cef6d26c5eef38bb403942ec5cc95bed6a22976bda19e2a0fec746a23f2d1db7",
  "neg-settled-to-expected-solver-mismatch": "20646a53e788ca9a51fca1ec52e84fb4525bef210b2c177da71b55ff9beaa7e9",
};

function loadVector(id: string): VectorFixture {
  return JSON.parse(readFileSync(join(VECTORS_DIR, `${id}.json`), "utf8"));
}

function mockClientFor(vector: VectorFixture): SettlementClient {
  const tx: SettlementTransaction = {
    hash: vector.receipt.payment.tx_hash,
    from: vector.receipt.payment.payer,
    to: vector.mockOnChain.transferLog?.contract as `0x${string}` | undefined ?? null,
    value: 0n,
  };
  const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
  const logs = vector.mockOnChain.transferLog
    ? [
        {
          address: vector.mockOnChain.transferLog.contract as `0x${string}`,
          topics: [
            TRANSFER_TOPIC,
            (`0x${"0".repeat(24)}${vector.mockOnChain.transferLog.from.slice(2).toLowerCase()}`) as `0x${string}`,
            (`0x${"0".repeat(24)}${vector.mockOnChain.transferLog.to.slice(2).toLowerCase()}`) as `0x${string}`,
          ],
          data: (`0x${BigInt(vector.mockOnChain.transferLog.value).toString(16).padStart(64, "0")}`) as `0x${string}`,
        },
      ]
    : [];
  const receipt: SettlementTransactionReceipt = {
    status: vector.mockOnChain.status,
    logs,
    blockNumber: BigInt(vector.mockOnChain.blockNumber),
  };
  return {
    getChainId: async () => vector.receipt.payment.chain_id,
    getTransaction: async () => tx,
    getTransactionReceipt: async () => receipt,
    getBlockNumber: async () => BigInt(vector.mockOnChain.currentBlock),
  };
}

describe("v0.5 conformance vectors: digest stability", () => {
  const ids = readdirSync(VECTORS_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.replace(/\.json$/, ""));

  it("every vector file in vectors/ has a pinned expected digest in this test", () => {
    expect(ids.sort()).toEqual(Object.keys(DIGESTS).sort());
  });

  for (const id of Object.keys(DIGESTS)) {
    it(`${id}: envelopeDigest(receipt) matches VECTORS.md's recorded digest`, () => {
      const vector = loadVector(id);
      expect(envelopeDigest(vector.receipt)).toBe(DIGESTS[id]);
    });
  }
});

describe("v0.5 conformance vectors: predicates", () => {
  it("PASS pass-settled-delivered: seller signature verifies (via vectorSellerAddress) AND settlement matches", async () => {
    const vector = loadVector("pass-settled-delivered");
    const receiptResult = await verifyReceipt(vector.receipt, { sellerAddress: vector.vectorSellerAddress });
    expect(receiptResult.valid).toBe(true);
    expect(receiptResult.errors).toEqual([]);

    const client = mockClientFor(vector);
    const settlement = await verifySettlement(vector.receipt, { client });
    expect(settlement.settled).toBe(true);
    expect(settlement.errors).toEqual([]);

    expect(deliveryStatusOk(vector.receipt)).toBe(true);
  });

  it("NEG neg-funded-not-delivered: fails the delivery predicate even though settlement is real", async () => {
    const vector = loadVector("neg-funded-not-delivered");

    expect(deliveryStatusOk(vector.receipt)).toBe(false);

    const receiptResult = await verifyReceipt(vector.receipt, { sellerAddress: vector.vectorSellerAddress });
    expect(receiptResult.valid).toBe(false);
    expect(receiptResult.errors.some((e) => e.includes('delivery.status is "failed"'))).toBe(true);

    // Settlement truth is independently real/unaffected — this vector isolates the
    // delivery predicate, not the settlement predicate.
    const client = mockClientFor(vector);
    const settlement = await verifySettlement(vector.receipt, { client });
    expect(settlement.settled).toBe(true);
  });

  it("NEG neg-delivered-not-settled: fails the settlement predicate even though delivery claims success", async () => {
    const vector = loadVector("neg-delivered-not-settled");

    expect(deliveryStatusOk(vector.receipt)).toBe(true); // the (false) claim itself is well-formed

    const client = mockClientFor(vector);
    const settlement = await verifySettlement(vector.receipt, { client });
    expect(settlement.settled).toBe(false);
    expect(settlement.errors.some((e) => e.includes("did not succeed on-chain"))).toBe(true);
  });

  it("NEG neg-settled-to-expected-solver-mismatch: fails the settlement predicate on transfer-recipient mismatch", async () => {
    const vector = loadVector("neg-settled-to-expected-solver-mismatch");

    const client = mockClientFor(vector);
    const settlement = await verifySettlement(vector.receipt, { client });
    expect(settlement.settled).toBe(false);
    expect(settlement.errors.some((e) => e.includes("none match the receipt"))).toBe(true);
  });
});
