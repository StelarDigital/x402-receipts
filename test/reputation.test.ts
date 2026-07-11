import { describe, expect, it } from "vitest";
import { scoreSeller } from "../src/reputation.js";
import { buildReceipt } from "../src/receipt.js";
import { countersignReceipt, signReceipt } from "../src/sign.js";
import { addressOf, makeBuyerKey, makeSellerKey, sampleInput } from "./fixtures.js";

const NOW = new Date("2026-07-10T12:00:00.000Z");

async function receiptFor(
  sellerKey: `0x${string}`,
  buyerKey: `0x${string}`,
  opts: { countersigned?: boolean; forgeCountersig?: boolean; ts?: string } = {}
) {
  const payer = addressOf(buyerKey);
  const payee = addressOf(sellerKey);
  const receipt = buildReceipt(
    sampleInput({
      payment: { payer, payee } as any,
      response: { ts: opts.ts ?? "2026-07-10T12:00:00.000Z" } as any,
    })
  );
  const signed = await signReceipt(receipt, sellerKey);
  if (opts.forgeCountersig) {
    // Truthy but cryptographically invalid — must never count as a valid countersig.
    return { ...signed, buyer: { countersig: "0x00" as any } };
  }
  if (opts.countersigned) {
    return countersignReceipt(signed, buyerKey);
  }
  return signed;
}

describe("scoreSeller: sybil resistance", () => {
  it("scores 100 receipts from 1 payer far below 100 receipts from 100 distinct payers", async () => {
    const sellerKey = makeSellerKey();
    const singlePayerKey = makeBuyerKey();

    const fromOnePayer = await Promise.all(
      Array.from({ length: 100 }, () => receiptFor(sellerKey, singlePayerKey, { countersigned: true }))
    );
    const fromManyPayers = await Promise.all(
      Array.from({ length: 100 }, () => receiptFor(sellerKey, makeBuyerKey(), { countersigned: true }))
    );

    const oneScore = (await scoreSeller(fromOnePayer, { now: NOW })).score;
    const manyScore = (await scoreSeller(fromManyPayers, { now: NOW })).score;

    expect(oneScore).toBeGreaterThan(0);
    expect(manyScore).toBeGreaterThan(oneScore * 10);
  });

  it("reports distinctPayers and settledReceiptCount correctly", async () => {
    const sellerKey = makeSellerKey();
    const buyerKey = makeBuyerKey();
    const receipts = await Promise.all([
      receiptFor(sellerKey, buyerKey),
      receiptFor(sellerKey, buyerKey),
      receiptFor(sellerKey, buyerKey),
    ]);

    const summary = await scoreSeller(receipts, { now: NOW });
    expect(summary.distinctPayers).toBe(1);
    expect(summary.settledReceiptCount).toBe(3);
  });

  it("countersigned ratio increases the score", async () => {
    const sellerKey = makeSellerKey();
    const buyerKeys = Array.from({ length: 20 }, () => makeBuyerKey());

    const uncountersigned = await Promise.all(
      buyerKeys.map((k) => receiptFor(sellerKey, k, { countersigned: false }))
    );
    const countersigned = await Promise.all(
      buyerKeys.map((k) => receiptFor(sellerKey, k, { countersigned: true }))
    );

    const lowScore = (await scoreSeller(uncountersigned, { now: NOW })).score;
    const highScore = (await scoreSeller(countersigned, { now: NOW })).score;

    expect(highScore).toBeGreaterThan(lowScore);
  });

  it("FIX 4 regression: a huge receipt flood from 1 payer (log term capped) still scores below 5 distinct payers", async () => {
    const sellerKey = makeSellerKey();
    const singlePayerKey = makeBuyerKey();
    // Left uncountersigned so this test doesn't spend real EC-recovery time per receipt;
    // the flood only needs to demonstrate the log2 cap, which is independent of countersig.
    const floodedReceipt = await receiptFor(sellerKey, singlePayerKey, { countersigned: false });

    // Stand-in for an unbounded 1-payer flood (1e9 receipts): what matters for the log2
    // cap is settledReceiptCount, and log2(count+1) is already >3 well before 100,000,
    // so this array size exercises the same cap 1e9 would without allocating 1e9 objects.
    const massFlood = Array.from({ length: 100_000 }, () => floodedReceipt);

    const fiveDistinctPayers = await Promise.all(
      Array.from({ length: 5 }, () => receiptFor(sellerKey, makeBuyerKey(), { countersigned: true }))
    );

    const floodScore = (await scoreSeller(massFlood, { now: NOW })).score;
    const fiveScore = (await scoreSeller(fiveDistinctPayers, { now: NOW })).score;

    expect(floodScore).toBeLessThan(fiveScore);
  });

  it("FIX 5 regression: a truthy but cryptographically invalid countersig does not inflate the score", async () => {
    const sellerKey = makeSellerKey();
    const buyerKeys = Array.from({ length: 10 }, () => makeBuyerKey());

    const noCountersig = await Promise.all(
      buyerKeys.map((k) => receiptFor(sellerKey, k, { countersigned: false }))
    );
    const forgedCountersig = await Promise.all(
      buyerKeys.map((k) => receiptFor(sellerKey, k, { forgeCountersig: true }))
    );

    const noCountersigScore = (await scoreSeller(noCountersig, { now: NOW })).score;
    const forgedScore = (await scoreSeller(forgedCountersig, { now: NOW })).score;
    const forgedSummary = await scoreSeller(forgedCountersig, { now: NOW });

    expect(forgedSummary.buyerCountersignedRatio).toBe(0);
    expect(forgedScore).toBe(noCountersigScore);
  });

  it("returns zero score for an empty set without throwing", async () => {
    await expect(scoreSeller([])).resolves.not.toThrow();
    const summary = await scoreSeller([]);
    expect(summary).toEqual({
      distinctPayers: 0,
      settledReceiptCount: 0,
      buyerCountersignedRatio: 0,
      oldestTs: null,
      newestTs: null,
      score: 0,
    });
  });

  it("treats case-different addresses from the same payer as one distinct payer", async () => {
    const sellerKey = makeSellerKey();
    const buyerKey = makeBuyerKey();

    const a = await receiptFor(sellerKey, buyerKey);
    const lowered = { ...a, payment: { ...a.payment, payer: a.payment.payer.toLowerCase() as any } };

    const summary = await scoreSeller([a, lowered], { now: NOW });
    expect(summary.distinctPayers).toBe(1);
  });
});
