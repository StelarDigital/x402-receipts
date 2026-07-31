import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { envelopeDigest, type Receipt } from "../src/receipt.js";
import { deliveryStatusOk, verifyAnchored, verifyReceipt } from "../src/verify.js";
import { verifyInclusion, type MerkleProofStep } from "../src/merkle.js";
import { verifySellerSig } from "../src/sign.js";
import { verifySettlement, type SettlementClient, type SettlementTransaction, type SettlementTransactionReceipt } from "../src/settlement.js";

const VECTORS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "vectors");

interface VectorFixture {
  id: string;
  description: string;
  predicate: string;
  vectorSellerAddress: `0x${string}`;
  vectorBuyerAddress: `0x${string}`;
  /** Present only on `neg-countersig-not-payer`: the key that actually countersigned. */
  vectorImpostorAddress?: `0x${string}`;
  /** Present only on anchored vectors: envelopeDigest of the receipt in its PRE-ANCHOR state. */
  anchoredLeaf?: string;
  /** Present only on `neg-leaf-not-in-anchored-root`: the leaf actually at `anchor.leaf_index`. */
  decoyLeaf?: string;
  merkleProof?: MerkleProofStep[];
  batchLeaves?: string[];
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
  "pass-countersigned-anchored": "d9a835dfba19cb6da87f390a85ade40202f1281d9a2a2179ab2f0fc3841770bb",
  "neg-countersig-not-payer": "05264696dd2c53536b2b1d70ec03fcd9bf539984ba49127d5a4c67964bd73155",
  "neg-leaf-not-in-anchored-root": "e420aac6cbffef025e463af9c7bd10538dd01c5044aa2b80b7897ea48566e806",
};

/** The receipt as it existed when it was batched: the anchor block cannot commit to a root computed over a digest that already contains that root (SPEC.md §8). */
function preAnchor(receipt: Receipt): Receipt {
  return { ...receipt, anchor: null };
}

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

describe("v0.5.1 conformance vectors: countersignature + anchor-inclusion tier", () => {
  it("PASS pass-countersigned-anchored: countersig verifies, settlement matches, AND the leaf is provably in the anchored root", async () => {
    const vector = loadVector("pass-countersigned-anchored");
    const receipt = vector.receipt;

    // Tier 2 is actually populated — this is what the four original vectors never exercised.
    expect(receipt.buyer.countersig).not.toBeNull();
    expect(receipt.anchor).not.toBeNull();

    const receiptResult = await verifyReceipt(receipt, {
      sellerAddress: vector.vectorSellerAddress,
      buyerAddress: vector.vectorBuyerAddress,
      requireCountersig: true,
    });
    expect(receiptResult.errors).toEqual([]);
    expect(receiptResult.valid).toBe(true);

    // Vector-key convention (same as seller.sig, see VECTORS.md): the countersigning key
    // is a labeled vector-only key, not the real payer's key, so the DEFAULT
    // buyerAddress (payment.payer) must NOT verify. Stated as an assertion rather than
    // left implicit.
    const defaultBuyer = await verifyReceipt(receipt, { sellerAddress: vector.vectorSellerAddress });
    expect(defaultBuyer.valid).toBe(false);
    expect(defaultBuyer.errors).toContain("buyer countersignature invalid");

    const settlement = await verifySettlement(receipt, { client: mockClientFor(vector) });
    expect(settlement.settled).toBe(true);
    expect(settlement.errors).toEqual([]);

    // The leaf is the PRE-ANCHOR envelope digest, recomputed here rather than trusted.
    const leaf = envelopeDigest(preAnchor(receipt));
    expect(leaf).toBe(vector.anchoredLeaf);
    expect(vector.batchLeaves![receipt.anchor!.leaf_index]).toBe(leaf);

    const root = receipt.anchor!.batch_merkle_root.slice(2);
    expect(verifyInclusion(leaf, vector.merkleProof!, root)).toBe(true);
    expect(verifyAnchored(preAnchor(receipt), vector.merkleProof!, root)).toBe(true);
  });

  it("NEG neg-countersig-not-payer: a real EIP-712 countersignature from a non-payer key fails closed against both the expected buyer and the default payer", async () => {
    const vector = loadVector("neg-countersig-not-payer");
    const receipt = vector.receipt;
    expect(receipt.buyer.countersig).not.toBeNull();

    // Isolation: the seller signature itself is untouched and still valid, so the only
    // thing this vector fails on is the countersignature's signer.
    expect(await verifySellerSig(receipt, vector.vectorSellerAddress)).toBe(true);

    const asExpectedBuyer = await verifyReceipt(receipt, {
      sellerAddress: vector.vectorSellerAddress,
      buyerAddress: vector.vectorBuyerAddress,
    });
    expect(asExpectedBuyer.valid).toBe(false);
    expect(asExpectedBuyer.errors).toContain("buyer countersignature invalid");

    const asPayer = await verifyReceipt(receipt, { sellerAddress: vector.vectorSellerAddress });
    expect(asPayer.valid).toBe(false);
    expect(asPayer.errors).toContain("buyer countersignature invalid");

    // And it is not a forged blob: it verifies for the key that actually produced it —
    // which is precisely why "a countersig is present" can never stand in for
    // "the payer accepted".
    const asImpostor = await verifyReceipt(receipt, {
      sellerAddress: vector.vectorSellerAddress,
      buyerAddress: vector.vectorImpostorAddress!,
    });
    expect(asImpostor.valid).toBe(true);
  });

  it("NEG neg-leaf-not-in-anchored-root: an otherwise-valid receipt whose leaf is absent from the anchored batch fails the inclusion predicate", async () => {
    const vector = loadVector("neg-leaf-not-in-anchored-root");
    const receipt = vector.receipt;
    const root = receipt.anchor!.batch_merkle_root.slice(2);

    // Isolation: signature + countersignature + settlement all pass. Only inclusion fails.
    const receiptResult = await verifyReceipt(receipt, {
      sellerAddress: vector.vectorSellerAddress,
      buyerAddress: vector.vectorBuyerAddress,
      requireCountersig: true,
    });
    expect(receiptResult.valid).toBe(true);
    const settlement = await verifySettlement(receipt, { client: mockClientFor(vector) });
    expect(settlement.settled).toBe(true);

    const leaf = envelopeDigest(preAnchor(receipt));
    expect(leaf).toBe(vector.anchoredLeaf);
    expect(vector.batchLeaves).not.toContain(leaf);

    expect(verifyInclusion(leaf, vector.merkleProof!, root)).toBe(false);
    expect(verifyAnchored(preAnchor(receipt), vector.merkleProof!, root)).toBe(false);

    // The proof is genuine — it verifies for the leaf actually at that index — so the
    // failure is the receipt's absence from the batch, not a malformed proof.
    expect(verifyInclusion(vector.decoyLeaf!, vector.merkleProof!, root)).toBe(true);
    expect(vector.batchLeaves![receipt.anchor!.leaf_index]).toBe(vector.decoyLeaf);
  });
});
