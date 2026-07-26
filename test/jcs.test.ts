import { describe, expect, it } from "vitest";
import { canonicalize, canonicalizeJCS, canonicalDigest, envelopeDigest, receiptDigest, buildReceipt } from "../src/receipt.js";
import { sampleInput } from "./fixtures.js";

// RFC 8785 (JSON Canonicalization Scheme) edge cases for our constrained envelope shape.
// See receipt.ts `canonicalizeJCS` doc comment for why sorted-key JSON.stringify already
// satisfies JCS here (no separate JCS library needed).
describe("JCS canonicalization edge cases (RFC 8785)", () => {
  it("canonicalizeJCS is the same function as canonicalize (named alias, never diverges)", () => {
    expect(canonicalizeJCS).toBe(canonicalize);
  });

  it("key ordering: UTF-16 code-unit sort, not insertion order or locale order", () => {
    // "Z" (0x5A) < "a" (0x61) < "z" (0x7A) < "é" (0xe9) in code-unit order — locale
    // collation would sort these differently (e.g. case-insensitively, or "é" near "e").
    const value = { z: 1, é: 2, Z: 3, a: 4 } as Record<string, number>;
    expect(canonicalizeJCS(value)).toBe('{"Z":3,"a":4,"z":1,"é":2}');
  });

  it("key ordering is stable across surrogate-pair keys (sorted by UTF-16 code unit, not code point)", () => {
    // "￿" (single code unit) sorts before a surrogate pair like "𝄞" (U+1D11E, two
    // code units starting with \uD834) under UTF-16 code-unit comparison, even though
    // \u{1D11E} as a code point is numerically larger than ￿.
    const value: Record<string, number> = { "𝄞": 1, "￿": 2 };
    expect(canonicalizeJCS(value)).toBe('{"𝄞":1,"￿":2}');
  });

  it("number forms: integer-valued numbers never serialize with a decimal point or exponent", () => {
    expect(canonicalizeJCS({ a: 100 })).toBe('{"a":100}');
    expect(canonicalizeJCS({ a: 1e2 })).toBe('{"a":100}');
    expect(canonicalizeJCS({ a: 1e21 })).toBe('{"a":1e+21}'); // ECMAScript Number::toString switches to exponential past 1e21
  });

  it("number forms: fractional numbers serialize via ECMAScript Number::toString, not a fixed decimal format", () => {
    expect(canonicalizeJCS({ a: 0.1 })).toBe('{"a":0.1}');
    expect(canonicalizeJCS({ a: 1.5 })).toBe('{"a":1.5}');
    expect(canonicalizeJCS({ a: 100.0 })).toBe('{"a":100}'); // 100.0 === 100, no trailing .0 survives
  });

  it("unicode: a literal multi-byte character and its \\uXXXX escape are distinct source but canonicalize to the same JSON text", () => {
    const literal = { name: "café" };
    const escaped = { name: "café" };
    expect(canonicalizeJCS(literal)).toBe(canonicalizeJCS(escaped));
  });

  it("unicode: distinct NFC/NFD forms of the same visual string are NOT normalized (JCS does not require Unicode normalization)", () => {
    const nfc = "é"; // é, precomposed
    const nfd = "é"; // e + combining acute accent, decomposed
    expect(nfc).not.toBe(nfd);
    expect(canonicalizeJCS({ a: nfc })).not.toBe(canonicalizeJCS({ a: nfd }));
  });

  it("empty object and empty array canonicalize distinctly", () => {
    expect(canonicalizeJCS({})).toBe("{}");
    expect(canonicalizeJCS([])).toBe("[]");
    expect(canonicalizeJCS({ a: {} })).not.toBe(canonicalizeJCS({ a: [] }));
  });

  it("nested key sort applies at every depth independently, not just the top level", () => {
    const value = { b: { z: 1, a: 2 }, a: { z: 3, a: 4 } };
    expect(canonicalizeJCS(value)).toBe('{"a":{"a":4,"z":3},"b":{"a":2,"z":1}}');
  });

  it("array element order is preserved (arrays are ordered, only object keys are sorted)", () => {
    expect(canonicalizeJCS([3, 1, 2])).toBe("[3,1,2]");
  });
});

describe("envelopeDigest / receiptDigest naming", () => {
  it("envelopeDigest is identical to receiptDigest for the same receipt (v0.5 spec naming alias)", () => {
    const receipt = buildReceipt(sampleInput());
    expect(envelopeDigest(receipt)).toBe(receiptDigest(receipt));
  });

  it("envelopeDigest equals canonicalDigest of the same receipt", () => {
    const receipt = buildReceipt(sampleInput());
    expect(envelopeDigest(receipt)).toBe(canonicalDigest(receipt));
  });
});
