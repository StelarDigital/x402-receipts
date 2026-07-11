import { describe, expect, it } from "vitest";
import { buildReceipt } from "../src/receipt.js";
import { countersignReceipt, signReceipt, verifyBuyerCountersig, verifySellerSig } from "../src/sign.js";
import { addressOf, makeBuyerKey, makeSellerKey, sampleInput } from "./fixtures.js";

describe("sign / verify round trip", () => {
  it("seller signature verifies against the seller address", async () => {
    const sellerKey = makeSellerKey();
    const buyerKey = makeBuyerKey();
    const receipt = buildReceipt(
      sampleInput({
        payment: {
          chain_id: 8453,
          tx_hash: `0x${"b".repeat(64)}`,
          asset: "USDC",
          amount: "500000",
          payer: addressOf(buyerKey),
          payee: addressOf(sellerKey),
        },
      })
    );

    const signed = await signReceipt(receipt, sellerKey);
    expect(signed.seller.sig).toBeTruthy();
    await expect(verifySellerSig(signed, addressOf(sellerKey))).resolves.toBe(true);
  });

  it("rejects a seller signature checked against the wrong address", async () => {
    const sellerKey = makeSellerKey();
    const wrongKey = makeSellerKey();
    const receipt = buildReceipt(sampleInput({ payment: { payee: addressOf(sellerKey) } as any }));
    const signed = await signReceipt(receipt, sellerKey);
    await expect(verifySellerSig(signed, addressOf(wrongKey))).resolves.toBe(false);
  });

  it("buyer countersignature verifies and binds to the seller's exact signature", async () => {
    const sellerKey = makeSellerKey();
    const buyerKey = makeBuyerKey();
    const receipt = buildReceipt(
      sampleInput({ payment: { payer: addressOf(buyerKey), payee: addressOf(sellerKey) } as any })
    );
    const signed = await signReceipt(receipt, sellerKey);
    const countersigned = await countersignReceipt(signed, buyerKey);

    await expect(verifyBuyerCountersig(countersigned, addressOf(buyerKey))).resolves.toBe(true);
  });

  it("refuses to countersign a receipt with no seller signature", async () => {
    const buyerKey = makeBuyerKey();
    const receipt = buildReceipt(sampleInput());
    await expect(countersignReceipt(receipt, buyerKey)).rejects.toThrow();
  });

  describe("tamper detection", () => {
    const fields: Array<[string, (r: any) => any]> = [
      ["payment.amount", (r) => ({ ...r, payment: { ...r.payment, amount: "999999999" } })],
      ["payment.tx_hash", (r) => ({ ...r, payment: { ...r.payment, tx_hash: `0x${"c".repeat(64)}` } })],
      ["request.url_hash", (r) => ({ ...r, request: { ...r.request, url_hash: "f".repeat(64) } })],
      ["response.status", (r) => ({ ...r, response: { ...r.response, status: 500 } })],
      ["response.body_sha256", (r) => ({ ...r, response: { ...r.response, body_sha256: "0".repeat(64) } })],
      ["seller.erc8004_agent_id", (r) => ({ ...r, seller: { ...r.seller, erc8004_agent_id: "erc8004:1:0xdead" } })],
    ];

    it.each(fields)("mutating %s invalidates the seller signature", async (_name, mutate) => {
      const sellerKey = makeSellerKey();
      const receipt = buildReceipt(sampleInput({ payment: { payee: addressOf(sellerKey) } as any }));
      const signed = await signReceipt(receipt, sellerKey);
      const tampered = mutate(signed);
      await expect(verifySellerSig(tampered, addressOf(sellerKey))).resolves.toBe(false);
    });

    it("mutating the seller sig after countersigning invalidates the buyer countersig", async () => {
      const sellerKey = makeSellerKey();
      const buyerKey = makeBuyerKey();
      const receipt = buildReceipt(
        sampleInput({ payment: { payer: addressOf(buyerKey), payee: addressOf(sellerKey) } as any })
      );
      const signed = await signReceipt(receipt, sellerKey);
      const countersigned = await countersignReceipt(signed, buyerKey);
      const tampered = { ...countersigned, seller: { ...countersigned.seller, sig: `0x${"1".repeat(130)}` } };
      await expect(verifyBuyerCountersig(tampered as any, addressOf(buyerKey))).resolves.toBe(false);
    });
  });
});
