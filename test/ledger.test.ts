import { describe, expect, it, afterEach } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { appendReceipt, iterateLedger, readLedger } from "../src/ledger.js";
import { sampleReceipt } from "./fixtures.js";

const execFileAsync = promisify(execFile);
const workerScript = fileURLToPath(new URL("./fixtures/append-worker.mjs", import.meta.url));

const dirs: string[] = [];

async function freshLedgerPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "x402-receipts-test-"));
  dirs.push(dir);
  return join(dir, "ledger.jsonl");
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe("ledger", () => {
  it("appends and reads back a single receipt", async () => {
    const path = await freshLedgerPath();
    const receipt = sampleReceipt();
    await appendReceipt(path, receipt);
    const all = await readLedger(path);
    expect(all).toHaveLength(1);
    expect(all[0].payment.tx_hash).toBe(receipt.payment.tx_hash);
  });

  it("appends multiple receipts as separate JSONL lines, in order", async () => {
    const path = await freshLedgerPath();
    const r1 = sampleReceipt({ request: { method: "GET" } as any });
    const r2 = sampleReceipt({ request: { method: "POST" } as any });
    await appendReceipt(path, r1);
    await appendReceipt(path, r2);
    const all = await readLedger(path);
    expect(all).toHaveLength(2);
    expect(all[0].request.method).toBe("GET");
    expect(all[1].request.method).toBe("POST");
  });

  it("survives many concurrent appends without corrupting lines", async () => {
    const path = await freshLedgerPath();
    const receipts = Array.from({ length: 25 }, () => sampleReceipt());
    await Promise.all(receipts.map((r) => appendReceipt(path, r)));
    const all = await readLedger(path);
    expect(all).toHaveLength(25);
    for (const r of all) {
      expect(r.scheme).toBe("x402-receipts/v0");
    }
  });

  it("iterateLedger yields the same receipts as readLedger", async () => {
    const path = await freshLedgerPath();
    await appendReceipt(path, sampleReceipt());
    await appendReceipt(path, sampleReceipt());
    const collected = [];
    for await (const r of iterateLedger(path)) {
      collected.push(r);
    }
    expect(collected).toHaveLength(2);
  });

  it("survives concurrent appends from real, separate OS processes (O_APPEND is process-safe)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "x402-receipts-test-"));
    dirs.push(dir);
    const path = join(dir, "ledger.jsonl");
    const workerCount = 5;
    const linesPerWorker = 10;

    await Promise.all(
      Array.from({ length: workerCount }, (_, i) =>
        execFileAsync(process.execPath, [workerScript, path, String(linesPerWorker), String(i)])
      )
    );

    const content = await readFile(path, "utf8");
    const lines = content.split("\n").filter((l) => l.trim().length > 0);
    expect(lines).toHaveLength(workerCount * linesPerWorker);

    const perWorkerCounts = new Map<string, number>();
    for (const line of lines) {
      const parsed = JSON.parse(line);
      perWorkerCounts.set(parsed.worker, (perWorkerCounts.get(parsed.worker) ?? 0) + 1);
    }
    expect(perWorkerCounts.size).toBe(workerCount);
    for (const count of perWorkerCounts.values()) {
      expect(count).toBe(linesPerWorker);
    }
  }, 20000);

  it("returns an empty array for a ledger that doesn't exist yet", async () => {
    const dir = await mkdtemp(join(tmpdir(), "x402-receipts-test-"));
    dirs.push(dir);
    const all = await readLedger(join(dir, "does-not-exist.jsonl"));
    expect(all).toEqual([]);
  });
});
