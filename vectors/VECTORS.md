# v0.5 / v0.5.1 conformance vectors

JCS-canonical (RFC 8785) fixtures for x402-foundation/x402#2833's requested conformance
suite, across two trust tiers:

- **Tier 1 (v0.5)** — seller signature + settlement + delivery. One PASS vector
  (settlement truth + delivery truth both hold) and three negative vectors, each pinned
  to a single named predicate that must fail.
- **Tier 2 (v0.5.1)** — buyer countersignature + anchor inclusion. Every tier-1 vector
  carries `buyer.countersig: null` and `anchor: null`, so a tier-1 PASS asserts the
  seller-signature tier and nothing above it. Tier 2 sets that boundary deliberately:
  one countersigned-and-anchored PASS twin and two negatives
  (`neg-countersig-not-payer`, `neg-leaf-not-in-anchored-root`).

Every `.json` file here is `{ id, description, predicate, vectorSellerAddress,
vectorBuyerAddress, mockOnChain, receipt }`, plus — on tier-2 vectors — `anchoredLeaf`,
`merkleProof`, `batchLeaves`, and (where the predicate needs them) `decoyLeaf` /
`vectorImpostorAddress`. `receipt` is the exact `Receipt` object (see
`SPEC.md` "Canonical envelope"); `envelopeDigest(receipt)` (== `receiptDigest`, sha256 of
`canonicalizeJCS(receipt)`) is the digest below. `mockOnChain` is the settlement-client
mock each vector's test in `test/vectors.test.ts` injects via `SettlementClient` — no
network call is ever made to reproduce or verify these vectors.

Regenerated deterministically by `scripts/gen-vectors.mjs` (run `npm run build && node
scripts/gen-vectors.mjs` from the repo root) — EIP-712 signing over secp256k1 uses RFC
6979 deterministic nonces, so re-running the generator against the same fixed
`VECTOR_SELLER_KEY` reproduces byte-identical output, including `seller.sig`.

## Digest table

| id | envelopeDigest (sha256 hex) |
|---|---|
| `pass-settled-delivered` | `b287e7addc8f0a06754a39f13a88fdd7e14b8b856a799288ba5ba0c7b526d991` |
| `neg-funded-not-delivered` | `4fb1ec3149cc40cb503752418a71258f4f55d7a29478075a9f06f9bd36650e33` |
| `neg-delivered-not-settled` | `cef6d26c5eef38bb403942ec5cc95bed6a22976bda19e2a0fec746a23f2d1db7` |
| `neg-settled-to-expected-solver-mismatch` | `20646a53e788ca9a51fca1ec52e84fb4525bef210b2c177da71b55ff9beaa7e9` |
| `pass-countersigned-anchored` | `d9a835dfba19cb6da87f390a85ade40202f1281d9a2a2179ab2f0fc3841770bb` |
| `neg-countersig-not-payer` | `05264696dd2c53536b2b1d70ec03fcd9bf539984ba49127d5a4c67964bd73155` |
| `neg-leaf-not-in-anchored-root` | `e420aac6cbffef025e463af9c7bd10538dd01c5044aa2b80b7897ea48566e806` |

`test/vectors.test.ts` "digest stability" tests recompute `envelopeDigest(vector.receipt)`
for every file above and assert it equals the table value — a canonicalization
regression (key-order bug, number-format bug, whitespace leak, etc.) fails these tests
even if every other predicate test still happens to pass.

## Vector-only signing keys

`seller.sig` on every vector below is produced by a fixed, publicly-labeled **vector-only**
test private key (`0x` + `"11".repeat(31)` + `"aa"`) — **not** the production seller key
for the real on-chain payee (`0x32d711C66dD1AD0c42D0cFe48e58ee5f2dE7c243`), which this repo
never exposes. Because the vector's signing key's address (`vectorSellerAddress` =
`0xC49Adc1ef48fC1D237d55379Fef7F3142cE22468`) differs from `payment.payee`, verifying these
vectors requires passing `{ sellerAddress: vectorSellerAddress }` explicitly to
`verifyReceipt`/`verifySellerSig` rather than relying on the default (`payment.payee`)
lookup — see each test in `test/vectors.test.ts`. This keeps the underlying economic facts
(tx hash, payer, payee, amount, asset) 100% real while never requiring or risking a real
private key in a public repository.

## PASS vector: the real settlement, independently confirmed

`pass-settled-delivered` claims `tx_hash =
0xdeb5872c039a88ae37b66ae490c0c8da9b6a4c652d84494ddcc9a05211d6cc80` on Base mainnet
(chain_id 8453), a `5000`-unit (0.005 nominal) USDC transfer from
`0xe61Bd34fcEdF14E0b41B582166eed69E3a6deF89` to
`0x32d711C66dD1AD0c42D0cFe48e58ee5f2dE7c243`. This was independently re-confirmed against
a public Base RPC (`https://mainnet.base.org`, `eth_getTransactionReceipt`, read-only, no
write/POST to any third party) at build time:

- `status: "0x1"` (succeeded)
- ERC-20 `Transfer(address,address,uint256)` log on `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`
  (Base mainnet USDC), topics decode to `from=0xe61bd34fcedf14e0b41b582166eed69e3a6def89`,
  `to=0x32d711c66dd1ad0c42d0cfe48e58ee5f2de7c243`, `data=0x1388` = `5000` (hex `0x1388`)

This is the real, original entry from this deployment's own receipt ledger
(`/root/x402api/receipts/receipts.jsonl`, `ts: 2026-07-11T21:03:55Z`) — the `payment`,
`request`, and `response` fields (minus the added v0.5 `asset_address` /
`payment_requirements_sha256` / `delivery` fields, which are additive per v0.3/v0.5 and
were not recorded on the original raw entry) are unmodified. `latency_ms` is rounded from
the original `296.4012622833252` to the integer `296` because the EIP-712 `Response`
struct types `latencyMs` as `uint256` (see `sign.ts`) — a design constraint documented in
`SPEC.md`, not a vector-specific choice.

## Negative vectors

- **`neg-funded-not-delivered`** — reuses the same real settled tx (payment truth holds)
  but `delivery.status: "failed"` with a `goods` block attached. Fails the delivery
  predicate (`deliveryStatusOk` / `verifyReceipt`'s goods+delivery check), independent of
  settlement truth.
- **`neg-delivered-not-settled`** — `delivery.status: "delivered"`, but `tx_hash` is a
  SYNTHETIC value (`0xdede...de`, clearly not the real tx above) whose mocked chain
  receipt has `status: "reverted"`. Fails the settlement predicate
  (`verifySettlement`), independent of the delivery claim.
- **`neg-settled-to-expected-solver-mismatch`** — real tx/payer/amount/asset, but the
  mocked on-chain `Transfer` log actually moved funds to `0x...0BADBAD`, not the receipt's
  claimed `payee`. Models a solver-substitution/front-run: money moved, but not to the
  named counterparty. Fails the settlement predicate's transfer-match check.

## Tier 2 (v0.5.1): countersignature and anchor inclusion

The four vectors above all carry `buyer.countersig: null` and `anchor: null`. That made a
suite-wide PASS mean **seller-signature tier only** — `countersignReceipt`,
`verifyInclusion` and `verifyAnchored` shipped and were unit-tested, but no vector
exercised them. These three set that tier deliberately.

- **`pass-countersigned-anchored`** — the `pass-settled-delivered` twin, one tier up:
  same real settled Base mainnet USDC transfer and same `delivery.status: "delivered"`,
  but `buyer.countersig` is real `countersignReceipt` output over the exact seller-signed
  receipt, and `anchor` is populated. Passes
  `verifyReceipt({ sellerAddress, buyerAddress, requireCountersig: true })`,
  `verifySettlement`, and `verifyInclusion(anchoredLeaf, merkleProof, root)`.
- **`neg-countersig-not-payer`** — identical except the countersignature was produced by a
  third vector-only key (`vectorImpostorAddress`) belonging to **no** party named in the
  receipt: a relayer or bystander attaching an acceptance the buyer never gave. The
  signature is real and well-formed — it verifies for the key that made it, which is
  exactly why "a countersig is present" can never stand in for "the payer accepted". Fails
  closed against both the expected buyer address and the default (`payment.payer`), while
  `seller.sig` stays valid, isolating the predicate.
- **`neg-leaf-not-in-anchored-root`** — signed, countersigned and settled, but its
  envelope digest is not one of the leaves of the batch its `anchor` names. The supplied
  proof is a **genuine** proof for the receipt that actually occupies that `leaf_index`
  (`decoyLeaf`, assertable as `verifyInclusion(decoyLeaf, proof, root) === true`), so the
  failure isolates the inclusion predicate itself rather than proof malformation.

### The merkle leaf is the pre-anchor envelope

`anchoredLeaf` is `envelopeDigest(receipt)` computed with `anchor: null`. This is forced,
not stylistic: `anchor.batch_merkle_root` is derived from the leaves, so a leaf computed
over an envelope already containing the anchor block would be self-referential. Verifiers
holding an anchored receipt must strip `anchor` before calling
`verifyInclusion`/`verifyAnchored` — see `SPEC.md` §8 and the `preAnchor` helper in
`test/vectors.test.ts`.

### What is real and what is synthetic in the anchor block

| field | status |
|---|---|
| `anchor.batch_merkle_root` | **real** — `buildMerkleTree` output over real `envelopeDigest` leaves (the other vectors' own receipts are the sibling leaves) |
| `merkleProof` | **real** — `getProof` output, verified by `verifyInclusion` in the generator before the file is written |
| `anchoredLeaf` / `decoyLeaf` / `batchLeaves` | **real** — envelope digests of real receipts in this directory |
| `anchor.base_tx` | **SYNTHETIC** (`0xa5a5…a5`) — no EAS attestation was posted on-chain to build these fixtures; posting one is a funded, irreversible on-chain write and out of scope for a test vector |

Labeling `base_tx` synthetic costs the vectors nothing, because per `SPEC.md` §6.2 an
anchor is an existence/ordering bound and never an independent finding about the receipt —
the predicate under test here is merkle inclusion, which is fully determined by the root,
the leaf and the proof, all of which are real.

### Vector-only countersigning key

`buyer.countersig` follows the same convention as `seller.sig`: it is produced by a fixed,
publicly-labeled vector-only key (`0x` + `"22".repeat(31)` + `"bb"`, address
`vectorBuyerAddress`), **not** the real payer's key, which this repo never exposes. So
tier-2 verification must pass `{ buyerAddress: vectorBuyerAddress }` explicitly;
`test/vectors.test.ts` asserts that the default (`payment.payer`) does **not** verify,
rather than leaving that convention implicit. `neg-countersig-not-payer` uses a third key
(`0x` + `"33".repeat(31)` + `"cc"`).
