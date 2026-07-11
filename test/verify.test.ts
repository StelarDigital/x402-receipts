import { describe, expect, it } from "vitest";
import { buildReceipt } from "../src/receipt.js";
import { signReceipt, countersignReceipt } from "../src/sign.js";
import { verifyReceipt } from "../src/verify.js";
import { addressOf, makeBuyerKey, makeSellerKey, sampleInput } from "./fixtures.js";

describe("verifyReceipt: self-dealing", () => {
  it("rejects a receipt where payment.payer === payment.payee by default", async () => {
    const sellerKey = makeSellerKey();
    const address = addressOf(sellerKey);
    const receipt = buildReceipt(
      sampleInput({ payment: { payer: address, payee: address } as any })
    );
    const signed = await signReceipt(receipt, sellerKey);

    const result = await verifyReceipt(signed);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("self-dealing: payer==payee");
  });

  it("allows self-dealt receipts when rejectSelfDeal is explicitly disabled", async () => {
    const sellerKey = makeSellerKey();
    const address = addressOf(sellerKey);
    const receipt = buildReceipt(
      sampleInput({ payment: { payer: address, payee: address } as any })
    );
    const signed = await signReceipt(receipt, sellerKey);

    const result = await verifyReceipt(signed, { rejectSelfDeal: false });
    expect(result.valid).toBe(true);
    expect(result.errors).not.toContain("self-dealing: payer==payee");
  });

  it("rejects self-dealing even when payer/payee are the same address in different case forms", async () => {
    const sellerKey = makeSellerKey();
    const checksummed = addressOf(sellerKey);
    const lowercased = checksummed.toLowerCase() as typeof checksummed;
    expect(lowercased).not.toBe(checksummed); // sanity: fixture key does have mixed-case chars

    const receipt = buildReceipt(
      sampleInput({ payment: { payer: checksummed, payee: lowercased } as any })
    );
    const signed = await signReceipt(receipt, sellerKey);
    const countersigned = await countersignReceipt(signed, sellerKey);

    const result = await verifyReceipt(countersigned);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("self-dealing: payer==payee");
  });

  it("does not flag ordinary receipts with distinct payer/payee", async () => {
    const sellerKey = makeSellerKey();
    const buyerKey = makeBuyerKey();
    const receipt = buildReceipt(
      sampleInput({ payment: { payer: addressOf(buyerKey), payee: addressOf(sellerKey) } as any })
    );
    const signed = await signReceipt(receipt, sellerKey);

    const result = await verifyReceipt(signed);
    expect(result.valid).toBe(true);
  });
});

describe("verifyReceipt: malformed fields never throw", () => {
  it("returns {valid:false} instead of throwing on a malformed url_hash", async () => {
    const sellerKey = makeSellerKey();
    const buyerKey = makeBuyerKey();
    const receipt = buildReceipt(
      sampleInput({ payment: { payer: addressOf(buyerKey), payee: addressOf(sellerKey) } as any })
    );
    const signed = await signReceipt(receipt, sellerKey);
    const tampered = { ...signed, request: { ...signed.request, url_hash: "not-64-hex-chars" } };

    await expect(verifyReceipt(tampered)).resolves.toMatchObject({ valid: false });
    const result = await verifyReceipt(tampered);
    expect(result.errors.some((e) => e.includes("seller signature check threw"))).toBe(true);
  });

  it("returns {valid:false} instead of throwing on a malformed body_sha256", async () => {
    const sellerKey = makeSellerKey();
    const buyerKey = makeBuyerKey();
    const receipt = buildReceipt(
      sampleInput({ payment: { payer: addressOf(buyerKey), payee: addressOf(sellerKey) } as any })
    );
    const signed = await signReceipt(receipt, sellerKey);
    const tampered = { ...signed, response: { ...signed.response, body_sha256: "0xbad" } };

    const result = await verifyReceipt(tampered);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("seller signature check threw"))).toBe(true);
  });

  it("converts a malformed buyer countersig field into an errors entry, not a throw", async () => {
    const sellerKey = makeSellerKey();
    const buyerKey = makeBuyerKey();
    const receipt = buildReceipt(
      sampleInput({ payment: { payer: addressOf(buyerKey), payee: addressOf(sellerKey) } as any })
    );
    const signed = await signReceipt(receipt, sellerKey);
    const withBadCountersig = { ...signed, buyer: { countersig: "0xnotasignature" as any } };

    const result = await verifyReceipt(withBadCountersig);
    expect(result.valid).toBe(false);
    expect(
      result.errors.some((e) => e.includes("buyer countersignature invalid") || e.includes("threw"))
    ).toBe(true);
  });
});
