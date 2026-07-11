# x402-receipts

Signed proof-of-delivery middleware for [x402](https://x402.org) machine-commerce sellers.

On each settled payment, `x402-receipts` emits a dual-signable delivery receipt that
binds the payment to fingerprints of the exact request and response, appends it to a
local append-only JSONL ledger, and batches receipt digests into merkle roots for cheap
on-chain anchoring.

**Live on-chain proof** — the first receipt anchor is a verifiable EAS attestation on
Base mainnet: [`0xf699…ced33`](https://base.easscan.org/attestation/view/0xf6995000d125c074074a5afdf35ddfb451227a2bc71c88cf6659926d192ced33)
(schema [`0xfb77…464d`](https://base.easscan.org/schema/view/0xfb77eeddebcffed10572b3070923232c07426ec52b033ddaa17c2cb8f040464d)).
This is a working reference deployment, not a mock.

## Why

x402 (and the underlying chain) proves that money moved. It proves nothing about
whether the seller actually delivered what was paid for, or what was delivered.

For machine-to-machine commerce — an agent buying a signal, a dataset row, an API
call — that gap matters: there is no human in the loop to notice a bad response, and no
dispute process to fall back on. A receipt closes the gap:

- **Payment** (on-chain, already proven): "this tx moved this amount from payer to payee."
- **Receipt** (this library): "for that tx, the seller delivered a specific, hashed
  response to a specific, hashed request, at this time — and signed it."

The receipt is the delivery slip: the seller signs a commitment to exact request/response
hashes, the buyer can optionally countersign to record acceptance, and batches of
receipts can be anchored on-chain via a merkle root so any individual receipt can later
be proven included in a specific, timestamped batch — without paying to post every
receipt on-chain individually.

### Trust model — what a receipt does and doesn't prove

A valid receipt proves: "the key matching `payment.payee` signed a commitment to this
exact request/response, and (if present) the key matching `payment.payer` countersigned
acceptance of that exact signed receipt." It does **not**, by itself, prove that the
seller and buyer are different parties.

**A seller who controls both the payer and payee address can fabricate a fully valid,
fully countersigned receipt for a delivery that never happened to any real
counterparty** — one key signs `seller.sig`, the same key signs `buyer.countersig`, and
`verifyReceipt` passes every check. This is why `verifyReceipt` defaults to
`rejectSelfDeal: true`, which fails verification whenever `payment.payer ===
payment.payee`. Callers who need to allow same-address test/internal flows can pass
`{ rejectSelfDeal: false }` explicitly, but should not do so for anything that feeds a
public trust or reputation signal.

Self-dealing detection only catches the same-address case. It does **not** catch a
seller who mints many distinct addresses and pays itself from each of them — that
requires an external signal (e.g., a funding-source or on-chain age/reputation check)
outside this library's scope. The practical consequence for anyone scoring receipts as a
reputation signal: **count distinct, independently-funded counterparties, never raw
receipt counts.** A seller with 10,000 receipts from 3 real buyers should score below one
with 50 receipts from 50 distinct, independently-funded buyers.

### Settlement-grounded reputation (M2a)

The gap above is bigger than self-dealing detection alone can close: **a receipt's
signature only proves who signed it — it proves nothing about whether
`payment.tx_hash` is real.** An attacker with two wallets they control can sign a fully
valid seller signature and buyer countersignature over a receipt that references a
fabricated tx hash, a reverted transaction, or a real transaction that moved a
different amount, asset, or pair of addresses than the receipt claims. Two colluding
(or single-attacker-controlled) wallets can manufacture an unlimited number of such
receipts — this is the sybil attack a signature-only scheme cannot defend against.

`verifySettlement()` (`src/settlement.ts`) closes that hole by treating the chain, not
the signature, as ground truth: it queries a Base RPC node for the transaction the
receipt references and confirms it actually happened — confirmed, succeeded, with
enough block confirmations (`minConfirmations`, default 2 — an unknown confirmation
count fails closed, never treated as sufficient), verified to actually be on the claimed
`chain_id` (by asking the RPC's own `getChainId()`, not by trusting caller config), and
moving exactly `payment.amount` of a *recognized* `payment.asset` from `payment.payer`
to `payment.payee` (decoded ERC-20 `Transfer` log; address comparisons
case-insensitive). Native-asset settlement (`ETH`/`NATIVE`) is not implemented and
always fails closed with an explicit error. `verifyReceiptFull()` runs this alongside
the existing `verifyReceipt()` signature/schema/self-deal checks — this is the function
a reputation scorer should call, never `verifyReceipt()` alone.

`scoreSeller()` (`src/reputation.ts`) then turns a set of receipts that passed
`verifyReceiptFull()` into a reputation number that weights **distinct, on-chain-verified
payers**, not raw receipt count — the same principle the paragraph above states, now
backed by proof the payments were real. The formula is documented in full in
`src/reputation.ts`; in one line: `score = distinctPayers * 10 * (0.5 + 0.5 *
countersignedRatio) * recencyFactor + min(log2(receiptCount + 1), 3)` — the receipt-count
term is not just logarithmic, it is hard-capped at 3, so no volume of receipts from a
single payer (however large the flood) can substitute for distinct payers.
`buyerCountersignedRatio` only counts a countersig that re-verifies as a real EIP-712
signature (`scoreSeller`'s `verifyCountersig` option, real verification by default) — a
receipt with a truthy-but-forged `buyer.countersig` field never inflates the score.

Honest limits: `verifySettlement` resolves ERC-20 asset contracts from a small explicit
symbol map, and ALSO accepts a literal `0x...` contract address in `payment.asset` only
if that address matches one already in the allowlist — an arbitrary, unrecognized
contract address is never accepted no matter how convincing its on-chain Transfer logs
look, because an attacker can deploy and freely mint their own worthless ERC-20 and
"pay" themselves from any number of wallets. Any chain_id this package has no default
RPC route for also fails closed rather than silently defaulting to Base mainnet. None of
this defends against a single attacker funding many distinct wallets from one source;
that remains an external funding-source/age signal outside this library's scope (see the
paragraph above). What it *does* rule out is the cheapest sybil attacks: signing
receipts for payments that never happened at all, or for payments to/from a
self-controlled token contract.

### On-chain anchoring (EAS on Base)

`src/anchor.ts` (M2b) posts a batch's merkle root on-chain via
[EAS](https://attest.org) (Ethereum Attestation Service) on Base — a public,
timestamped, queryable commitment to a batch of receipts, without paying to post every
receipt individually.

**Why EAS, not a bespoke contract or ERC-8004:** ERC-8004 explicitly forbids an agent
self-anchoring its own reputation data. EAS is a neutral, already-deployed attestation
registry — an OP-stack predeploy on both Base mainnet and Base Sepolia, so there is no
contract of our own to deploy or audit — and every attestation is readable for free via
[base.easscan.org](https://base.easscan.org)'s GraphQL API, no API key or indexer of our
own required.

**Contract addresses (identical on both networks):**

| Contract | Address | Base mainnet | Base Sepolia |
| --- | --- | --- | --- |
| EAS | `0x4200000000000000000000000000000000000021` | 8453 | 84532 |
| SchemaRegistry | `0x4200000000000000000000000000000000000020` | 8453 | 84532 |

**Schema (register once per network):**

```
uint256 agentId,bytes32 merkleRoot,uint64 receiptCount,uint64 periodStart,uint64 periodEnd,string receiptsURI
```

```ts
import { registerSchema, anchorBatch, buildAnchorFromLedger } from "x402-receipts";

const schemaUID = await registerSchema(walletClient); // idempotent-safe: safe to call again on any network

const batchInput = buildAnchorFromLedger(verifiedReceipts, {
  agentId: 42n,
  receiptsURI: "https://example.com/receipts/batch-1.jsonl", // where the full batch can be fetched
});

const attestationUID = await anchorBatch(walletClient, {
  schemaUID,
  ...batchInput,
  refUID: previousAttestationUID, // omit/zero for the first anchor
});
```

`registerSchema` and `anchorBatch` take an injectable `AnchorWalletClient`
(`simulateContract` + `writeContract`, mirroring viem's own simulate-then-submit
pattern) as their first argument so the test suite never touches the network; pass
`undefined` along with `{ rpcUrl, privateKey }` to have one built lazily via
`createAnchorWalletClient`. Every anchor's `refUID` references the previous
attestation's UID for the same agent, so the anchor history for an agent can be walked
back through EAS alone — no off-chain index required.

**Honest limit:** anchoring commits a merkle root publicly and gives it a block
timestamp. It does **not**, by itself, prove that any receipt in the batch actually
settled — a merkle root is just a commitment to some bytes; nothing stops anchoring a
root over fabricated receipts. Settlement proof is `verifySettlement` /
`verifyReceiptFull`'s job (see "Settlement-grounded reputation" above); the two are
independent checks and a caller scoring reputation should run both, never substitute
one for the other.

## Receipt schema (v0)

```json
{
  "scheme": "x402-receipts/v0",
  "payment":  { "chain_id": number, "tx_hash": hex, "asset": string, "amount": string, "payer": address, "payee": address },
  "request":  { "method": string, "url_hash": sha256hex, "params_hash": sha256hex, "ts": iso8601 },
  "response": { "status": number, "body_sha256": sha256hex, "content_type": string, "ts": iso8601, "latency_ms": number },
  "seller":   { "erc8004_agent_id": string, "sig": eip712sig },
  "buyer":    { "countersig": eip712sig | null },
  "anchor":   { "batch_merkle_root": hex, "base_tx": hex, "leaf_index": number } | null,
  "goods":    { "description": string, "kind": "api-response"|"file"|"dataset"|"text"|"other", "summary": object | null, "body_sha256": sha256hex, "bytes": number, "preview": string | null } | null | undefined
}
```

- `request.url_hash` / `request.params_hash` and `response.body_sha256` are sha256 hex
  digests — the raw request/response bodies are never stored in the receipt, only their
  fingerprints.
- `seller.sig` is an EIP-712 signature over `scheme + payment + request + response +
  seller.erc8004_agent_id`, produced with the seller's key.
- `buyer.countersig` is optional: an EIP-712 signature over the full seller-signed
  receipt, produced with the buyer's key, recording the buyer's acceptance of that exact
  signed receipt.
- `anchor` is populated once a batch containing this receipt has been posted on-chain
  (M2b — see "On-chain anchoring (EAS on Base)" and "Status" below; this library does
  not currently populate `anchor` on the `Receipt` object automatically, callers do so
  after `anchorBatch` returns a UID and an inclusion proof is available).

## Goods on the receipt

A receipt on its own only proves *that* a payment settled and *a* response body
existed with a given hash — it says nothing human-readable about what was actually
delivered. The optional `goods` block lets a seller declare what the payment bought,
bound to the exact delivered bytes:

```json
{
  "scheme": "x402-receipts/v0",
  "payment":  { "chain_id": 8453, "tx_hash": "0x...", "asset": "USDC", "amount": "1000000", "payer": "0x...", "payee": "0x..." },
  "request":  { "method": "GET", "url_hash": "...", "params_hash": "...", "ts": "2026-07-11T12:00:00.000Z" },
  "response": { "status": 200, "body_sha256": "e3b0c4...", "content_type": "application/json", "ts": "2026-07-11T12:00:00.400Z", "latency_ms": 400 },
  "seller":   { "erc8004_agent_id": "erc8004:8453:0x...", "sig": "0x..." },
  "buyer":    { "countersig": null },
  "anchor":   null,
  "goods": {
    "description": "market-brief: SOL regime+sentiment+price+risk",
    "kind": "api-response",
    "summary": { "symbol": "SOL-USD", "regime": "trending", "risk": "medium" },
    "body_sha256": "e3b0c4...",
    "bytes": 214,
    "preview": "{\"symbol\":\"SOL-USD\",\"regime\":\"trending\",...}"
  }
}
```

**What this proves:** `goods.body_sha256` and `goods.bytes` are checked against the
actual delivered body by `verifyGoodsAgainstBody` (recomputes sha256 + byte length, and
if `goods.preview` is non-null, checks it's a prefix of the sanitized body). This proves
the `goods` block genuinely describes *these exact bytes* — not some other response.
`verifyReceipt` additionally fails any receipt where `goods.body_sha256` doesn't equal
`response.body_sha256` (the receipt-level binding).

**What this doesn't prove:** `goods.description` and `goods.summary` are seller
*claims*, not independently verified facts. The hash binding proves "this description
is talking about these bytes," not "this description is an honest characterization of
those bytes." `goods` is deliberately excluded from the seller's EIP-712 signature
payload (`receiptCore`) — the signature already commits to `response.body_sha256`, and
`goods.body_sha256` is required to match it, so the delivered bytes stay authenticated
either way, while `goods` fields stay purely additive and backwards-compatible (a
receipt without `goods` canonicalizes identically to a pre-goods-feature receipt; the
key is omitted entirely, not set to `null`).

`goods` is optional everywhere: `buildReceipt` only attaches it when explicitly passed,
and `createReceiptMiddleware` only computes it when a `goods` describer is configured
AND the settlement result includes the raw `body` — otherwise receipts are built exactly
as before.

```ts
import { createReceiptMiddleware } from "x402-receipts";

const receipts = createReceiptMiddleware({
  ledgerPath: "./receipts.jsonl",
  sellerAgentId: "erc8004:8453:0xSellerAgent...",
  sellerPrivateKey: process.env.SELLER_PRIVATE_KEY as `0x${string}`,
  goods: ({ value }) => ({
    description: "market-brief: SOL regime+sentiment+price+risk",
    kind: "api-response",
    summary: { symbol: value.symbol, regime: value.regime },
  }),
});

const value = await receipts.wrap(async () => {
  const settlement = await settleX402Payment(req);
  const body = JSON.stringify(computeResponseBody(req));
  return {
    payment: settlement.paymentInfo,
    request: { /* ... */ },
    response: { status: 200, body_sha256: sha256Hex(body), content_type: "application/json", ts: new Date().toISOString(), latency_ms: settlement.latencyMs },
    value: JSON.parse(body),
    body, // required for the goods describer to run; body_sha256/bytes/preview are computed from this, never trusted from the caller
  };
});
```

## Usage

### Build and sign a receipt

```ts
import { buildReceipt, sha256Hex } from "x402-receipts";
import { signReceipt, countersignReceipt } from "x402-receipts";

const receipt = buildReceipt({
  payment: {
    chain_id: 8453,
    tx_hash: "0x...",
    asset: "USDC",
    amount: "1000000",
    payer: "0xBuyer...",
    payee: "0xSeller...",
  },
  request: {
    method: "GET",
    url_hash: sha256Hex(requestUrl),
    params_hash: sha256Hex(JSON.stringify(requestParams)),
    ts: new Date().toISOString(),
  },
  response: {
    status: 200,
    body_sha256: sha256Hex(responseBody),
    content_type: "application/json",
    ts: new Date().toISOString(),
    latency_ms: 42,
  },
  seller_agent_id: "erc8004:8453:0xSellerAgent...",
});

const signed = await signReceipt(receipt, sellerPrivateKey);
// Optional, buyer-side:
const countersigned = await countersignReceipt(signed, buyerPrivateKey);
```

### Verify a receipt

```ts
import { verifyReceipt } from "x402-receipts";

const result = await verifyReceipt(signed, {
  // Defaults: sellerAddress = receipt.payment.payee, buyerAddress = receipt.payment.payer,
  // rejectSelfDeal = true (fails if payment.payer === payment.payee — see "Trust model").
  expectedBodySha256: sha256Hex(actualResponseBody),
});
if (!result.valid) throw new Error(`bad receipt: ${result.errors.join(", ")}`);
```

### Append to the ledger

```ts
import { appendReceipt, readLedger } from "x402-receipts";

await appendReceipt("./receipts.jsonl", signed);
const all = await readLedger("./receipts.jsonl");
```

The ledger is append-only by construction: `appendReceipt` opens the file with
`O_APPEND` and issues a single `write()` of one JSONL line (atomic across concurrent
writers — including separate OS processes — for writes this small), then `fsync`s
before returning. There is no read-modify-rewrite step, so concurrent appenders can
never clobber each other's lines. Anything that anchors receipts into merkle batches
(see below) reads this append-only log directly; it never rewrites or reorders it.

### Wrap an x402 settlement handler (fail-open)

```ts
import { createReceiptMiddleware } from "x402-receipts";

const receipts = createReceiptMiddleware({
  ledgerPath: "./receipts.jsonl",
  sellerAgentId: "erc8004:8453:0xSellerAgent...",
  sellerPrivateKey: process.env.SELLER_PRIVATE_KEY as `0x${string}`,
});

app.get("/v1/signal", async (req, res) => {
  const value = await receipts.wrap(async () => {
    const settlement = await settleX402Payment(req); // your existing x402 flow
    const body = computeResponseBody(req);
    return {
      payment: settlement.paymentInfo,
      request: { method: req.method, url_hash: sha256Hex(req.url), params_hash: sha256Hex(JSON.stringify(req.query)), ts: new Date().toISOString() },
      response: { status: 200, body_sha256: sha256Hex(JSON.stringify(body)), content_type: "application/json", ts: new Date().toISOString(), latency_ms: settlement.latencyMs },
      value: body,
    };
  });
  res.json(value);
});
```

Receipt recording never throws into the response path: any error while building,
signing, or appending a receipt is caught and passed to `onError` (default:
`console.error`), and the wrapped settlement's own result is always returned unchanged.

### Merkle batching for on-chain anchoring

```ts
import { buildMerkleTree, getProof, verifyInclusion } from "x402-receipts";
import { receiptDigest } from "x402-receipts";

const leaves = batchOfReceipts.map(receiptDigest);
const tree = buildMerkleTree(leaves);
const proof = getProof(tree, 0);
verifyInclusion(leaves[0], proof, tree.root); // true

// Later, once anchored on-chain:
import { verifyAnchored } from "x402-receipts";
verifyAnchored(receipt, proof, anchoredRoot);
```

Merkle hashing follows RFC 6962 (Certificate Transparency) domain separation: leaf
hashes are `sha256(0x00 || data)` and internal node hashes are `sha256(0x01 || left ||
right)`, so an internal node's preimage can never be replayed as a valid leaf. The tree
is built with RFC 6962's recursive left-balanced split (not naive power-of-two padding
with a duplicated last node), so batches of different sizes never collide on the same
root even when the last leaf repeats (e.g. `[A,B,C]` and `[A,B,C,C]` produce different
roots).

### Verify settlement and score a seller

```ts
import { verifyReceiptFull, scoreSeller } from "x402-receipts";

const result = await verifyReceiptFull(signed, {
  rpcUrl: "https://mainnet.base.org", // optional; this is the default for chain_id 8453
});
if (!result.valid) throw new Error(`unsettled or invalid: ${result.errors.join(", ")}`);

// Once you've verified a batch of a seller's receipts with verifyReceiptFull:
const verifiedReceipts = allReceipts.filter(/* ...ran verifyReceiptFull, kept only .valid */);
const reputation = await scoreSeller(verifiedReceipts);
```

## Status

- **M0/M1 (this package):** receipt schema, canonical serialization, EIP-712
  sign/verify, JSONL ledger, merkle batching, fail-open middleware hook. No network
  calls anywhere in this package.
- **M2a (this package):** `verifySettlement` / `verifyReceiptFull` — on-chain settlement
  verification against a Base RPC node, and `scoreSeller` — distinct-payer-weighted
  reputation scoring. The only network call in this package; fully mockable via
  `VerifySettlementOptions.client` (see `src/settlement.ts`).
- **M2b (this package):** `registerSchema` / `anchorBatch` / `buildAnchorFromLedger`
  (`src/anchor.ts`) — anchors a batch's merkle root on-chain via EAS on Base. See
  "On-chain anchoring (EAS on Base)" above. All network access goes through an
  injectable `AnchorWalletClient`; no real network calls in the test suite.

## Development

```sh
npm install
npm run build       # tsc -> dist/
npm test            # vitest
npm run typecheck   # tsc --noEmit
```

## License

Apache-2.0. See [LICENSE](./LICENSE).
