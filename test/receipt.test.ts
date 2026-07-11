import { describe, expect, it } from "vitest";
import { buildReceipt, canonicalize, canonicalDigest } from "../src/receipt.js";
import { sampleInput } from "./fixtures.js";

describe("canonicalize", () => {
  it("produces identical output regardless of key insertion order", () => {
    const a = { b: 1, a: 2, c: { z: 1, y: 2 } };
    const b = { c: { y: 2, z: 1 }, a: 2, b: 1 };
    expect(canonicalize(a)).toBe(canonicalize(b));
  });

  it("produces output with no whitespace", () => {
    const out = canonicalize({ a: 1, b: [1, 2, { c: 3 }] });
    expect(out).not.toMatch(/\s/);
  });

  it("is stable across repeated calls on the same receipt", () => {
    const input = sampleInput();
    const receipt = buildReceipt(input);
    const d1 = canonicalDigest(receipt);
    const d2 = canonicalDigest(JSON.parse(JSON.stringify(receipt)));
    expect(d1).toBe(d2);
  });

  it("changes digest when any field changes", () => {
    const receipt = buildReceipt(sampleInput());
    const mutated = { ...receipt, response: { ...receipt.response, status: 500 } };
    expect(canonicalDigest(receipt)).not.toBe(canonicalDigest(mutated));
  });

  describe("rejects non-injective values", () => {
    it("throws on undefined", () => {
      expect(() => canonicalize({ a: undefined })).toThrow(/undefined/);
      expect(() => canonicalize(undefined)).toThrow(/undefined/);
    });

    it("throws on NaN", () => {
      expect(() => canonicalize({ a: Number.NaN })).toThrow(/NaN/);
    });

    it("throws on Infinity and -Infinity", () => {
      expect(() => canonicalize({ a: Number.POSITIVE_INFINITY })).toThrow(/Infinity/);
      expect(() => canonicalize({ a: Number.NEGATIVE_INFINITY })).toThrow(/Infinity/);
    });

    it("normalizes -0 to 0 instead of letting it collide silently with +0 via JSON", () => {
      const negZero = canonicalize({ a: -0 });
      const posZero = canonicalize({ a: 0 });
      expect(negZero).toBe(posZero);
      expect(negZero).toBe('{"a":0}');
    });

    it("throws inside nested arrays/objects, not just at the top level", () => {
      expect(() => canonicalize({ a: [1, 2, Number.NaN] })).toThrow(/NaN/);
      expect(() => canonicalize({ a: { b: undefined } })).toThrow(/undefined/);
    });

    it("throws on a Date object (JSON.stringify would silently serialize it as an ISO string, but a nested Date can collide with other shapes)", () => {
      expect(() => canonicalize({ a: new Date("2026-07-10T12:00:00.000Z") })).toThrow(/Date/);
    });

    it("throws on a Date nested inside an array", () => {
      expect(() => canonicalize({ a: [new Date()] })).toThrow(/Date/);
    });

    it("throws on a Map or Set (non-plain object, JSON.stringify silently mangles to '{}')", () => {
      expect(() => canonicalize({ a: new Map([["x", 1]]) })).toThrow(/Map/);
      expect(() => canonicalize({ a: new Set([1, 2]) })).toThrow(/Set/);
    });

    it("throws on a function", () => {
      expect(() => canonicalize({ a: () => 1 })).toThrow(/function/);
    });
  });
});

describe("buildReceipt", () => {
  it("builds an unsigned receipt with the v0 scheme", () => {
    const receipt = buildReceipt(sampleInput());
    expect(receipt.scheme).toBe("x402-receipts/v0");
    expect(receipt.seller.sig).toBeNull();
    expect(receipt.buyer.countersig).toBeNull();
    expect(receipt.anchor).toBeNull();
  });
});
