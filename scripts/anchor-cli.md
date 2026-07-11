# Anchor CLI (intended flow — not a runnable script)

This file describes the intended runtime flow for posting an on-chain anchor with
`src/anchor.ts`. It deliberately contains no executable code: this repo makes no
network calls in its test suite, and a script that hits a real RPC/wallet doesn't
belong committed here.

## Flow

1. **Read the ledger** — `readLedger(ledgerPath)` (`src/ledger.ts`) to load the batch of
   receipts to anchor (e.g. everything appended since the last anchor).
2. **Verify each receipt** — `verifyReceiptFull(receipt, { rpcUrl })` (`src/settlement.ts`)
   for every receipt in the batch. Only receipts that pass go into the anchor; a batch
   containing an unsettled or forged receipt should not be committed on-chain.
3. **Build the anchor input** — `buildAnchorFromLedger(verifiedReceipts, { agentId,
   receiptsURI })` (`src/anchor.ts`). `receiptsURI` should point wherever the full batch
   is published (so a verifier can fetch the receipts a merkle root commits to, not
   just the root itself).
4. **Register the schema once per network** — `registerSchema(walletClient)`. Safe to
   call on every run; idempotent-safe (returns the same schemaUID whether or not it was
   already registered).
5. **Anchor** — `anchorBatch(walletClient, { schemaUID, ...batchInput, refUID:
   previousAttestationUID })`. Store the returned attestationUID (e.g. alongside the
   ledger) so the next run's `refUID` chains to it.

## What it needs at runtime

- The agent's wallet **private key**, used only to sign the `register`/`attest`
  transactions. Never commit a key to this repo. In this deployment the key lives at
  `~/.config/stelar/x402-anchor-wallet.key`, outside the repo.
- A **Base RPC URL** (mainnet `https://mainnet.base.org` or Base Sepolia
  `https://sepolia.base.org`, or a private RPC provider).
- **Gas** — the wallet needs a small ETH balance on Base to pay for `register`/`attest`
  transactions.

## Agent wallet

Address: `0xe61Bd34fcEdF14E0b41B582166eed69E3a6deF89`

The corresponding private key is not referenced anywhere in this repo's code or docs —
only the address, which is public by nature (it will appear as the attester on every
anchor anyway).
