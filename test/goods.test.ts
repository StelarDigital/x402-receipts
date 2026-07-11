import { describe, expect, it, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildReceipt,
  canonicalDigest,
  sha256Hex,
  type GoodsInfo,
} from "../src/receipt.js";
import { verifyReceipt, verifyGoodsAgainstBody } from "../src/verify.js";
import { signReceipt } from "../src/sign.js";
import { createReceiptMiddleware, sanitizePreview } from "../src/middleware.js";
import { readLedger } from "../src/ledger.js";
import { addressOf, makeSellerKey, sampleInput } from "./fixtures.js";

const dirs: string[] = [];

async function freshLedgerPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "x402-receipts-goods-test-"));
  dirs.push(dir);
  return join(dir, "ledger.jsonl");
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

function makeGoods(overrides: Partial<GoodsInfo> = {}, bodySha256: string): GoodsInfo {
  return {
    description: "market-brief: SOL regime+sentiment+price+risk",
    kind: "api-response",
    summary: { symbol: "SOL-USD", risk: "medium" },
    body_sha256: bodySha256,
    bytes: 42,
    preview: "preview text",
    ...overrides,
  };
}

describe("goods attestation: backwards compatibility", () => {
  it("leaves an old-shape (no goods) receipt's digest unchanged", () => {
    const input = sampleInput();
    const receiptWithoutGoods = buildReceipt(input);
    expect(receiptWithoutGoods).not.toHaveProperty("goods");

    // Simulate what the digest of a pre-goods-feature receipt looked like: the exact
    // same object shape, hand-built without ever touching the new code path.
    const legacyShapedReceipt = {
      scheme: receiptWithoutGoods.scheme,
      payment: receiptWithoutGoods.payment,
      request: receiptWithoutGoods.request,
      response: receiptWithoutGoods.response,
      seller: receiptWithoutGoods.seller,
      buyer: receiptWithoutGoods.buyer,
      anchor: receiptWithoutGoods.anchor,
    };

    expect(canonicalDigest(receiptWithoutGoods)).toBe(canonicalDigest(legacyShapedReceipt));
  });

  it("buildReceipt with goods: undefined omits the key entirely (not null)", () => {
    const receipt = buildReceipt(sampleInput());
    expect(Object.keys(receipt)).not.toContain("goods");
  });

  it("buildReceipt with goods explicitly set to null attaches a null goods key", () => {
    const receipt = buildReceipt({ ...sampleInput(), goods: null });
    expect(receipt.goods).toBeNull();
    expect(Object.keys(receipt)).toContain("goods");
  });
});

describe("goods attestation: build + canonicalize determinism", () => {
  it("produces an identical digest across repeated builds of the same input", () => {
    const input = sampleInput();
    const goods = makeGoods({}, input.response.body_sha256);
    const r1 = buildReceipt({ ...input, goods });
    const r2 = buildReceipt({ ...input, goods: { ...goods, summary: { ...goods.summary } } });
    expect(canonicalDigest(r1)).toBe(canonicalDigest(r2));
  });

  it("changes the digest when goods content changes", () => {
    const input = sampleInput();
    const goods = makeGoods({}, input.response.body_sha256);
    const r1 = buildReceipt({ ...input, goods });
    const r2 = buildReceipt({ ...input, goods: { ...goods, description: "different" } });
    expect(canonicalDigest(r1)).not.toBe(canonicalDigest(r2));
  });

  it("goods does not affect the seller signature (excluded from receiptCore)", async () => {
    const sellerKey = makeSellerKey();
    const input = sampleInput({ payment: { payee: addressOf(sellerKey) } as any });
    const goods = makeGoods({}, input.response.body_sha256);

    const receiptWithoutGoods = buildReceipt(input);
    const receiptWithGoods = buildReceipt({ ...input, goods });

    const signedWithout = await signReceipt(receiptWithoutGoods, sellerKey);
    const signedWith = await signReceipt(receiptWithGoods, sellerKey);

    expect(signedWith.seller.sig).toBe(signedWithout.seller.sig);
  });
});

describe("verifyReceipt: goods binding", () => {
  it("passes when goods.body_sha256 matches response.body_sha256", async () => {
    const sellerKey = makeSellerKey();
    const input = sampleInput({ payment: { payee: addressOf(sellerKey) } as any });
    const goods = makeGoods({}, input.response.body_sha256);
    const receipt = buildReceipt({ ...input, goods });
    const signed = await signReceipt(receipt, sellerKey);

    const result = await verifyReceipt(signed);
    expect(result.valid).toBe(true);
  });

  it("fails when goods.body_sha256 does not match response.body_sha256", async () => {
    const sellerKey = makeSellerKey();
    const input = sampleInput({ payment: { payee: addressOf(sellerKey) } as any });
    const goods = makeGoods({}, sha256Hex("different body"));
    const receipt = buildReceipt({ ...input, goods });
    const signed = await signReceipt(receipt, sellerKey);

    const result = await verifyReceipt(signed);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("goods.body_sha256 does not match response.body_sha256 (goods binding broken)");
  });

  it("is unaffected by a missing goods block (old behavior)", async () => {
    const sellerKey = makeSellerKey();
    const input = sampleInput({ payment: { payee: addressOf(sellerKey) } as any });
    const receipt = buildReceipt(input);
    const signed = await signReceipt(receipt, sellerKey);

    const result = await verifyReceipt(signed);
    expect(result.valid).toBe(true);
  });
});

describe("verifyGoodsAgainstBody", () => {
  it("passes on a genuine roundtrip", () => {
    const body = "hello world, this is the delivered payload";
    const goods: GoodsInfo = {
      description: "text payload",
      kind: "text",
      summary: null,
      body_sha256: sha256Hex(body),
      bytes: Buffer.byteLength(body, "utf8"),
      preview: sanitizePreview(body, 512),
    };
    const result = verifyGoodsAgainstBody(body, goods);
    expect(result.ok).toBe(true);
  });

  it("fails when the body is tampered with (hash mismatch)", () => {
    const body = "hello world";
    const goods: GoodsInfo = {
      description: "text payload",
      kind: "text",
      summary: null,
      body_sha256: sha256Hex(body),
      bytes: Buffer.byteLength(body, "utf8"),
      preview: "hello world",
    };
    const result = verifyGoodsAgainstBody("goodbye world", goods);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("body_sha256 mismatch");
  });

  it("fails when bytes is wrong even if the hash somehow matched a stale value", () => {
    const body = "hello world";
    const goods: GoodsInfo = {
      description: "text payload",
      kind: "text",
      summary: null,
      body_sha256: sha256Hex(body),
      bytes: 999,
      preview: null,
    };
    const result = verifyGoodsAgainstBody(body, goods);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("bytes mismatch");
  });

  it("fails when preview is not a prefix of the sanitized body", () => {
    const body = "hello world";
    const goods: GoodsInfo = {
      description: "text payload",
      kind: "text",
      summary: null,
      body_sha256: sha256Hex(body),
      bytes: Buffer.byteLength(body, "utf8"),
      preview: "totally different preview",
    };
    const result = verifyGoodsAgainstBody(body, goods);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("preview is not a prefix of the sanitized body");
  });

  it("passes with a null preview (display-only field, optional)", () => {
    const body = "hello world";
    const goods: GoodsInfo = {
      description: "text payload",
      kind: "text",
      summary: null,
      body_sha256: sha256Hex(body),
      bytes: Buffer.byteLength(body, "utf8"),
      preview: null,
    };
    expect(verifyGoodsAgainstBody(body, goods).ok).toBe(true);
  });

  it("roundtrips correctly with a Uint8Array body", () => {
    const bodyStr = "binary-ish payload";
    const body = new TextEncoder().encode(bodyStr);
    const goods: GoodsInfo = {
      description: "file payload",
      kind: "file",
      summary: null,
      body_sha256: sha256Hex(body),
      bytes: body.length,
      preview: sanitizePreview(bodyStr, 512),
    };
    expect(verifyGoodsAgainstBody(body, goods).ok).toBe(true);
  });
});

describe("sanitizePreview", () => {
  it("strips control characters but keeps \\n and \\t", () => {
    const raw = "line1\nline2\ttabbed\x00\x01\x07end";
    const out = sanitizePreview(raw, 512);
    expect(out).toBe("line1\nline2\ttabbedend");
  });

  it("truncates a long string to the max length safely", () => {
    const raw = "a".repeat(1000);
    const out = sanitizePreview(raw, 512);
    expect(out.length).toBe(512);
  });

  it("truncates on a code-point boundary, never splitting a multi-byte character", () => {
    // Each emoji is a surrogate pair (2 UTF-16 code units) but 1 code point.
    const raw = "😀".repeat(600);
    const out = sanitizePreview(raw, 512);
    expect(Array.from(out).length).toBe(512);
    // Re-encoding must not throw / produce replacement characters from a split surrogate.
    expect(out).not.toContain("�");
    expect([...out].every((ch) => ch === "😀")).toBe(true);
  });

  it("returns the string unchanged when under the max", () => {
    expect(sanitizePreview("short", 512)).toBe("short");
  });
});

describe("middleware: goods auto-fill", () => {
  it("attaches a goods block computed from the actual delivered body", async () => {
    const ledgerPath = await freshLedgerPath();
    const sellerKey = makeSellerKey();
    const input = sampleInput({ payment: { payee: addressOf(sellerKey) } as any });
    const body = JSON.stringify({ symbol: "SOL-USD", regime: "trending", price: 172.5 });
    const bodyShaOfActual = sha256Hex(body);
    const responseWithMatchingHash = { ...input.response, body_sha256: bodyShaOfActual };

    const mw = createReceiptMiddleware<{ ok: true }>({
      ledgerPath,
      sellerAgentId: input.seller_agent_id,
      sellerPrivateKey: sellerKey,
      goods: ({ body }) => ({
        description: "market-brief: SOL regime+sentiment+price+risk",
        kind: "api-response",
        summary: { symbol: "SOL-USD" },
      }),
    });

    await mw.wrap(async () => ({
      payment: input.payment,
      request: input.request,
      response: responseWithMatchingHash,
      value: { ok: true },
      body,
    }));

    const ledger = await readLedger(ledgerPath);
    expect(ledger).toHaveLength(1);
    const receipt = ledger[0];
    expect(receipt.goods).toBeTruthy();
    expect(receipt.goods!.description).toBe("market-brief: SOL regime+sentiment+price+risk");
    expect(receipt.goods!.kind).toBe("api-response");
    expect(receipt.goods!.summary).toEqual({ symbol: "SOL-USD" });
    expect(receipt.goods!.body_sha256).toBe(bodyShaOfActual);
    expect(receipt.goods!.bytes).toBe(Buffer.byteLength(body, "utf8"));
    expect(receipt.goods!.preview).toBe(body);

    const verifyResult = await verifyReceipt(receipt);
    expect(verifyResult.valid).toBe(true);
  });

  it("does not attach goods when no describer is configured (old behavior)", async () => {
    const ledgerPath = await freshLedgerPath();
    const sellerKey = makeSellerKey();
    const input = sampleInput({ payment: { payee: addressOf(sellerKey) } as any });

    const mw = createReceiptMiddleware<{ ok: true }>({
      ledgerPath,
      sellerAgentId: input.seller_agent_id,
      sellerPrivateKey: sellerKey,
    });

    await mw.wrap(async () => ({
      payment: input.payment,
      request: input.request,
      response: input.response,
      value: { ok: true },
      body: "some body",
    }));

    const ledger = await readLedger(ledgerPath);
    expect(ledger[0].goods).toBeUndefined();
  });

  it("does not attach goods when describer is configured but body is omitted", async () => {
    const ledgerPath = await freshLedgerPath();
    const sellerKey = makeSellerKey();
    const input = sampleInput({ payment: { payee: addressOf(sellerKey) } as any });

    const mw = createReceiptMiddleware<{ ok: true }>({
      ledgerPath,
      sellerAgentId: input.seller_agent_id,
      sellerPrivateKey: sellerKey,
      goods: () => ({ description: "x", kind: "text", summary: null }),
    });

    await mw.wrap(async () => ({
      payment: input.payment,
      request: input.request,
      response: input.response,
      value: { ok: true },
    }));

    const ledger = await readLedger(ledgerPath);
    expect(ledger[0].goods).toBeUndefined();
  });

  it("truncates the auto-filled preview to 512 code points for a long body", async () => {
    const ledgerPath = await freshLedgerPath();
    const sellerKey = makeSellerKey();
    const input = sampleInput({ payment: { payee: addressOf(sellerKey) } as any });
    const body = "x".repeat(2000);
    const bodySha = sha256Hex(body);
    const response = { ...input.response, body_sha256: bodySha };

    const mw = createReceiptMiddleware<{ ok: true }>({
      ledgerPath,
      sellerAgentId: input.seller_agent_id,
      sellerPrivateKey: sellerKey,
      goods: () => ({ description: "big payload", kind: "text", summary: null }),
    });

    await mw.wrap(async () => ({
      payment: input.payment,
      request: input.request,
      response,
      value: { ok: true },
      body,
    }));

    const ledger = await readLedger(ledgerPath);
    expect(ledger[0].goods!.preview!.length).toBe(512);
    expect(ledger[0].goods!.bytes).toBe(2000);
  });
});
