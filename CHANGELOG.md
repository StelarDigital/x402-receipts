# Changelog

## 0.5.1

Response to two follow-up reviews on
[x402-foundation/x402#2833](https://github.com/x402-foundation/x402/issues/2833).
**Docs and conformance vectors only — no behavior change to any shipped function**, and
the four v0.5 vectors' digests are byte-identical (the generator is deterministic; those
files are unmodified).

**[@giskard09](https://github.com/giskard09)** — pointed out that §6's batch anchoring
(merkle root over many receipts, via EAS) and per-action anchoring (`A1_ANCHOR`'s
permissionless CREATE2 registry, one action at a time) are different layers, and that
reading them as sequential alternatives would lead a future implementer to pick one
assuming it was the only option. Changed:

- **SPEC.md §6.0 (new)** states normatively that the two are **independent, composable
  strategies, not sequential alternatives**: a seller MAY use either, both, or neither;
  neither supersedes the other; an implementer MUST NOT read either as the only option.
  Both commit to the same `envelopeDigest`, so using both yields two independent existence
  bounds over one canonical digest. Includes a trade-off table (granularity, on-chain
  cost, latency-to-anchored, inclusion evidence, what a verifier needs).
- **README "On-chain anchoring"** carries the same statement, so the point is not
  spec-only.

**Tersign ([@wowlegend](https://github.com/wowlegend))** — two findings.

*(1) All four vectors carried `buyer.countersig: null` and `anchor: null`, so "PASS" meant
seller-signature-only while `countersignReceipt`/`verifyInclusion` shipped unexercised at
the vector level.* Changed — three new vectors, all produced by running the library's own
signing/merkle code (`scripts/gen-vectors.mjs`, deterministic), wired into
`test/vectors.test.ts`:

- **`pass-countersigned-anchored`** — the PASS twin with `buyer.countersig` AND `anchor`
  actually populated. Passes `verifyReceipt({ requireCountersig: true })`,
  `verifySettlement`, and `verifyInclusion`/`verifyAnchored` against a real
  `buildMerkleTree`/`getProof` root and proof over real envelope digests.
  (`anchor.base_tx` is labeled SYNTHETIC — no on-chain attestation was posted to build a
  fixture; the root, leaf and proof are not.)
- **`neg-countersig-not-payer`** — a real, well-formed countersignature from a key that is
  not `payment.payer`; fails closed against both the expected buyer address and the
  default, while `seller.sig` stays valid.
- **`neg-leaf-not-in-anchored-root`** — signed, countersigned and settled, but its leaf is
  absent from the batch its `anchor` names; the supplied proof is a genuine proof for the
  leaf that does occupy that index, isolating the inclusion predicate from proof
  malformation.
- **SPEC.md §8** additionally makes the leaf's envelope state normative: the leaf is the
  digest of the **pre-anchor** envelope (`anchor: null`), because a leaf computed over an
  envelope already containing the derived root would be self-referential. Verifiers must
  strip `anchor` before calling `verifyInclusion`/`verifyAnchored`.

*(2) The README stated a limit SPEC.md did not, and the structural version of that limit
is broader than the README's "same-address case".* Changed — the full-width statement now
appears in both, identically:

- **SPEC.md §6.2 (new)** and **README "Trust model"**: self-dealing detection is
  **address-level only**; **every signing role — payee signature, buyer countersignature,
  batch attester — is held by a party to the transaction**, so no combination of them is
  an independent finding. EAS is a neutral **venue** but the seller is not a neutral
  **attester**; ERC-8004's self-anchoring bar is met at the venue level and not at the
  attester level. An evaluator MAY rely on an anchor for an **existence/ordering bound
  only** (sound because block time is not the attester's to move) and MUST NOT read it as
  an attestation of the anchored receipts' truth, nor as corroboration of `seller.sig`.

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
