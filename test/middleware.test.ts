import { describe, expect, it, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createReceiptMiddleware } from "../src/middleware.js";
import { readLedger } from "../src/ledger.js";
import { verifySellerSig } from "../src/sign.js";
import { addressOf, makeSellerKey, sampleInput } from "./fixtures.js";

const dirs: string[] = [];

async function freshLedgerPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "x402-receipts-mw-test-"));
  dirs.push(dir);
  return join(dir, "ledger.jsonl");
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe("createReceiptMiddleware", () => {
  it("records a signed receipt and still returns the settlement's value", async () => {
    const ledgerPath = await freshLedgerPath();
    const sellerKey = makeSellerKey();
    const input = sampleInput({ payment: { payee: addressOf(sellerKey) } as any });

    const mw = createReceiptMiddleware<{ ok: true }>({
      ledgerPath,
      sellerAgentId: input.seller_agent_id,
      sellerPrivateKey: sellerKey,
    });

    const value = await mw.wrap(async () => ({
      payment: input.payment,
      request: input.request,
      response: input.response,
      value: { ok: true },
    }));

    expect(value).toEqual({ ok: true });
    const ledger = await readLedger(ledgerPath);
    expect(ledger).toHaveLength(1);
    expect(ledger[0].seller.sig).toBeTruthy();
    await expect(verifySellerSig(ledger[0], addressOf(sellerKey))).resolves.toBe(true);
  });

  it("is fail-open: an appendReceipt failure never throws into the caller", async () => {
    const sellerKey = makeSellerKey();
    const input = sampleInput({ payment: { payee: addressOf(sellerKey) } as any });
    let onErrorCalls = 0;

    const mw = createReceiptMiddleware<{ ok: true }>({
      // A directory, not a file: writes here must fail, exercising the catch path.
      ledgerPath: await mkdtempDirAsLedgerPath(),
      sellerAgentId: input.seller_agent_id,
      sellerPrivateKey: sellerKey,
      onError: () => {
        onErrorCalls++;
      },
    });

    const value = await mw.wrap(async () => ({
      payment: input.payment,
      request: input.request,
      response: input.response,
      value: { ok: true },
    }));

    expect(value).toEqual({ ok: true });
    expect(onErrorCalls).toBe(1);
  });

  it("is fail-open even when receipt building itself throws (bad tx_hash)", async () => {
    const ledgerPath = await freshLedgerPath();
    const sellerKey = makeSellerKey();
    const input = sampleInput({ payment: { payee: addressOf(sellerKey) } as any });
    let caught: unknown;

    const mw = createReceiptMiddleware<{ ok: true }>({
      ledgerPath,
      sellerAgentId: input.seller_agent_id,
      sellerPrivateKey: sellerKey,
      onError: (err) => {
        caught = err;
      },
    });

    const value = await mw.wrap(async () => ({
      payment: { ...input.payment, tx_hash: "not-a-valid-hash" as any },
      request: input.request,
      response: input.response,
      value: { ok: true },
    }));

    expect(value).toEqual({ ok: true });
    expect(caught).toBeDefined();
  });

  it("is fail-open even when onError itself throws", async () => {
    const sellerKey = makeSellerKey();
    const input = sampleInput({ payment: { payee: addressOf(sellerKey) } as any });

    const mw = createReceiptMiddleware<{ ok: true }>({
      // A directory, not a file: writes fail, exercising the catch path, whose onError
      // handler below also throws.
      ledgerPath: await mkdtempDirAsLedgerPath(),
      sellerAgentId: input.seller_agent_id,
      sellerPrivateKey: sellerKey,
      onError: () => {
        throw new Error("onError itself is broken");
      },
    });

    const value = await mw.wrap(async () => ({
      payment: input.payment,
      request: input.request,
      response: input.response,
      value: { ok: true },
    }));

    expect(value).toEqual({ ok: true });
  });

  it("is fail-open when onError is async and its returned promise rejects", async () => {
    const sellerKey = makeSellerKey();
    const input = sampleInput({ payment: { payee: addressOf(sellerKey) } as any });

    const unhandledRejections: unknown[] = [];
    const onUnhandledRejection = (reason: unknown) => unhandledRejections.push(reason);
    process.on("unhandledRejection", onUnhandledRejection);

    try {
      const mw = createReceiptMiddleware<{ ok: true }>({
        // A directory, not a file: writes fail, exercising the catch path, whose async
        // onError handler below rejects instead of throwing synchronously.
        ledgerPath: await mkdtempDirAsLedgerPath(),
        sellerAgentId: input.seller_agent_id,
        sellerPrivateKey: sellerKey,
        onError: async () => {
          throw new Error("async onError rejected");
        },
      });

      const value = await mw.wrap(async () => ({
        payment: input.payment,
        request: input.request,
        response: input.response,
        value: { ok: true },
      }));

      expect(value).toEqual({ ok: true });

      // Give any unhandled-rejection microtask a turn to fire before asserting.
      await new Promise((resolve) => setImmediate(resolve));
      expect(unhandledRejections).toHaveLength(0);
    } finally {
      process.off("unhandledRejection", onUnhandledRejection);
    }
  });
});

async function mkdtempDirAsLedgerPath(): Promise<string> {
  // Returns a directory path used AS a ledger file path, so writes against it fail
  // (EISDIR), exercising the middleware's fail-open catch path.
  const dir = await mkdtemp(join(tmpdir(), "x402-receipts-mw-fail-"));
  dirs.push(dir);
  return dir;
}
