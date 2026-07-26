# v0.5 conformance vectors

JCS-canonical (RFC 8785) fixtures for x402-foundation/x402#2833's requested conformance
suite: one PASS vector (settlement truth + delivery truth both hold) and three negative
vectors, each pinned to a single named predicate that must fail.

Every `.json` file here is `{ id, description, predicate, vectorSellerAddress,
vectorBuyerAddress, mockOnChain, receipt }`. `receipt` is the exact `Receipt` object (see
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
