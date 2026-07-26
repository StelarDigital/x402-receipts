# Changelog

## 0.5.0

Response to reviewer follow-up on
[x402-foundation/x402#2833](https://github.com/x402-foundation/x402/issues/2833),
addressing the two outstanding v0.3 promises plus three new asks. See `SPEC.md` for the
full normative spec.

- **Canonical envelope, formalized as RFC 8785 JCS.** `canonicalizeJCS` /
  `envelopeDigest` — named aliases of the existing `canonicalize` / `receiptDigest` —
  document why this package's sorted-key JSON serialization already satisfies RFC 8785
  for its closed value domain. No digest changes, no new dependency; `SPEC.md` §1.
- **`extensions["delivery-receipt"]` extension-response placement** (item 1).
  `attachReceiptExtension` / `receiptFromExtensions` (new `src/extension.ts`). Any header
  carrying the same receipt is demoted to a documented, `@deprecated`-marked projection
  (`projectReceiptHeader`) — never primary. `SPEC.md` §2.
- **EAS batch-envelope schema drafted as Foundation-ownable** (item 4). `SPEC.md` §6
  documents the already-live `ANCHOR_SCHEMA` (`agentId`, `merkleRoot`, `receiptCount`,
  `periodStart`/`periodEnd`, `receiptsURI`, `refUID`) as a field table, plus a draft
  (unregistered) `receiptsHash` addition for a future schema version.
- **ERC-8183 binding statement** (item 5). `SPEC.md` §7:
  `attestationHash = envelopeDigest(receipt)`, which transitively commits to settlement
  proof (`tx_hash`), request/response hashes, and the payee (seller) EIP-712 signature.
- **JCS-pinned conformance vectors** (07-23 second): `vectors/` + `VECTORS.md` — one PASS
  vector built from a real settled Base mainnet USDC transaction (independently
  re-confirmed against a public RPC), and three negative vectors
  (`neg-funded-not-delivered`, `neg-delivered-not-settled`,
  `neg-settled-to-expected-solver-mismatch`), each pinned to one named fail-closed
  predicate. `scripts/gen-vectors.mjs` regenerates them deterministically.
- **Merkle inclusion verification** — already implemented (`verifyInclusion`,
  `merkle.ts`/`verify.ts`) since the batch-anchoring work; no new code, documented as
  delivered in `SPEC.md` §8.
- 207 tests passing (was 178 at v0.4.2); 29 new tests across JCS edge cases, extension
  placement, and the four conformance vectors.

## 0.4.2 and earlier

See git log (`6b604ad` and prior). Notable: v0.4.0/v0.4.1 (notify/"x402'd" human-readable
receipt layer), v0.3.0 (`payment_requirements_sha256`, `delivery.status`, `asset_address`,
versioned EIP-712 domain — the first response to #2833), v0.2.0 (goods attestation).
