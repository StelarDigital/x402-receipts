import { describe, expect, it } from "vitest";
import { buildReceipt } from "../src/receipt.js";
import {
  DELIVERY_RECEIPT_EXTENSION_KEY,
  attachReceiptExtension,
  projectReceiptHeader,
  receiptFromExtensions,
} from "../src/extension.js";
import { sampleInput } from "./fixtures.js";

describe("v0.5 extension-response placement", () => {
  it("DELIVERY_RECEIPT_EXTENSION_KEY is the lowercase hyphenated key the spec mandates", () => {
    expect(DELIVERY_RECEIPT_EXTENSION_KEY).toBe("delivery-receipt");
  });

  it("attachReceiptExtension places the receipt at extensions['delivery-receipt']", () => {
    const receipt = buildReceipt(sampleInput());
    const response = attachReceiptExtension({ status: 200 }, receipt);
    expect(response.extensions).toEqual({ "delivery-receipt": receipt });
    expect(response.status).toBe(200);
  });

  it("attachReceiptExtension preserves existing extensions from other extension keys", () => {
    const receipt = buildReceipt(sampleInput());
    const response = attachReceiptExtension(
      { extensions: { "some-other-extension": { foo: "bar" } } },
      receipt
    );
    expect(response.extensions).toEqual({
      "some-other-extension": { foo: "bar" },
      "delivery-receipt": receipt,
    });
  });

  it("attachReceiptExtension overwrites a stale delivery-receipt entry, not merges it", () => {
    const receiptA = buildReceipt(sampleInput());
    const receiptB = buildReceipt(sampleInput({ payment: { amount: "999" } as any }));
    const first = attachReceiptExtension({}, receiptA);
    const second = attachReceiptExtension(first, receiptB);
    expect(second.extensions).toEqual({ "delivery-receipt": receiptB });
  });

  it("receiptFromExtensions round-trips a receipt placed by attachReceiptExtension", () => {
    const receipt = buildReceipt(sampleInput());
    const response = attachReceiptExtension({}, receipt);
    expect(receiptFromExtensions(response.extensions)).toEqual(receipt);
  });

  it("receiptFromExtensions returns null (never throws) when extensions is absent, null, or empty", () => {
    expect(receiptFromExtensions(undefined)).toBeNull();
    expect(receiptFromExtensions(null)).toBeNull();
    expect(receiptFromExtensions({})).toBeNull();
  });

  it("receiptFromExtensions returns null when the key holds a non-object value", () => {
    expect(receiptFromExtensions({ "delivery-receipt": "not-a-receipt" })).toBeNull();
    expect(receiptFromExtensions({ "delivery-receipt": 42 })).toBeNull();
  });

  it("projectReceiptHeader (deprecated) is byte-identical JSON to the extension value, never a separate encoding", () => {
    const receipt = buildReceipt(sampleInput());
    const response = attachReceiptExtension({}, receipt);
    const header = projectReceiptHeader(receipt);
    expect(JSON.parse(header)).toEqual(response.extensions["delivery-receipt"]);
  });
});
