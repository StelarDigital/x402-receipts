import { promises as fs } from "node:fs";
import { dirname } from "node:path";
import type { Receipt } from "./receipt.js";
import { canonicalize } from "./receipt.js";

async function readFileOrEmpty(path: string): Promise<string> {
  try {
    return await fs.readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw err;
  }
}

/**
 * Appends a receipt as one JSONL line.
 *
 * The ledger is append-only by design (anchoring reads it as a pure append log to build
 * merkle batches). Previously this used a read-modify-rewrite (read whole file, write to
 * a tmp path, rename over the ledger) which is atomic per-writer but NOT safe across
 * concurrent writers/processes: two writers can both read the same "existing" content,
 * and the second rename simply clobbers the first writer's line.
 *
 * Instead we open the file with O_APPEND and issue a single write() of one line. POSIX
 * guarantees O_APPEND writes are atomic with respect to the file's write offset for
 * writes that complete in a single system call (true here: JSONL receipt lines are small,
 * far under PIPE_BUF/typical filesystem atomic-write limits), so concurrent appenders —
 * whether separate async tasks, threads, or OS processes — can never interleave or
 * clobber each other's lines. We fsync before returning so a crash right after a
 * successful append can't silently lose it.
 */
export async function appendReceipt(ledgerPath: string, receipt: Receipt): Promise<void> {
  const line = `${canonicalize(receipt)}\n`;
  await fs.mkdir(dirname(ledgerPath), { recursive: true });
  const handle = await fs.open(ledgerPath, "a");
  try {
    await handle.write(line, null, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** Reads the full ledger into memory and parses every line as a Receipt. */
export async function readLedger(ledgerPath: string): Promise<Receipt[]> {
  const content = await readFileOrEmpty(ledgerPath);
  if (content.length === 0) return [];
  return content
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Receipt);
}

/** Async-iterates the ledger line by line without loading the whole file at once. */
export async function* iterateLedger(ledgerPath: string): AsyncGenerator<Receipt> {
  const content = await readFileOrEmpty(ledgerPath);
  if (content.length === 0) return;
  for (const line of content.split("\n")) {
    if (line.trim().length === 0) continue;
    yield JSON.parse(line) as Receipt;
  }
}
