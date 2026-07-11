// Standalone worker process for the ledger cross-process append test.
// Deliberately re-implements the same O_APPEND + fsync technique as
// src/ledger.ts#appendReceipt (rather than importing the TS source, so this can run as a
// plain OS process with no transpile step) to prove the technique itself is safe when
// multiple real, independent OS processes append to the same file concurrently.
import { promises as fs } from "node:fs";

const [, , ledgerPath, countStr, workerId] = process.argv;
const count = Number(countStr);

async function appendLine(path, line) {
  const handle = await fs.open(path, "a");
  try {
    await handle.write(`${line}\n`, null, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function main() {
  for (let i = 0; i < count; i++) {
    await appendLine(ledgerPath, JSON.stringify({ worker: workerId, seq: i }));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
