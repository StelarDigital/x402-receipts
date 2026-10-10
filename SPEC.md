# x402-receipts SPEC — v0.5.1

Normative specification for the receipt envelope, canonicalization, extension-response
placement, verification predicates, and the draft EAS batch-anchor schema. Written in
response to reviewer feedback on
[x402-foundation/x402#2833](https://github.com/x402-foundation/x402/issues/2833).

The keywords **MUST**, **MUST NOT**, **SHOULD**, **SHOULD NOT**, and **MAY** are to be
interpreted as in RFC 2119.

## 0. Version delta

| | v0.3 (`baeffeb`) | v0.4 (`720b74d`–`c34ef8a`) | v0.5 (this document) |
|---|---|---|---|
| `payment_requirements_sha256` | added | unchanged | unchanged; canonicalization rules made explicit (§4) |
| `delivery.status` | added | unchanged | unchanged; predicates enumerated explicitly (§5) |
| `asset_address` | added | unchanged | unchanged |
| EIP-712 domain | versioned (`"0.3"`) | unchanged | unchanged (still `"0.3"` — the domain versions the *signature*, not the schema; see §1) |
| canonicalization | ad hoc sorted-key JSON (`canonicalize`) | unchanged | formalized as RFC 8785 JCS (§1); `canonicalizeJCS`/`envelopeDigest` named aliases added, byte-identical output |
| receipt delivery to a verifier | undocumented / header examples in README | unchanged | `extensions["delivery-receipt"]` is now the canonical placement; header carriage demoted to an explicitly documented projection (§2) |
| batch anchoring | EAS `ANCHOR_SCHEMA` implemented, undocumented as a portable spec | unchanged | drafted here as a Foundation-ownable batch-envelope schema (§6) |
| ERC-8183 | not addressed | not addressed | binding statement added (§7) |
| merkle inclusion proof | implemented (`merkle.ts`), untested against the spec thread | unchanged | documented as delivered (§8); no new code needed. **v0.5.1:** leaf envelope-state made normative (§8) and exercised end-to-end by vectors (§9) |
| conformance vectors | none | none | `vectors/` + `VECTORS.md` (§9). **v0.5.1:** tier-2 vectors added — countersigned+anchored PASS twin, non-payer countersig, leaf-absent-from-root |
| per-action vs. batch anchoring | not addressed | not addressed | **v0.5.1:** stated as independent, composable strategies (§6.0) |
| attester neutrality | not addressed | not addressed | **v0.5.1:** every signing role is a party to the transaction; an anchor is an existence bound, never an independent finding (§6.2) |

`scheme` stays `"x402-receipts/v0"` in every version to date, including v0.5 — the schema
version lives in the EIP-712 signing domain (`domainForV03`) and the npm package version,
never in the `scheme` string, so a receipt's shape never has to be sniffed from a
string a verifier must special-case.

## 1. Canonical envelope

The **canonical envelope** of a receipt is its full `Receipt` object (`receipt.ts`) —
every field, including `seller.sig`, `buyer.countersig`, and `anchor`. There is no
separate "core" envelope distinct from the signable subset (`receiptCore`, §3) and the
full envelope (`receiptDigest`): `receiptCore` is a *projection* of the envelope used for
building the EIP-712 typed-data message, not a different envelope.

**Canonicalization: RFC 8785 (JCS).** The canonical serialization of any envelope (or any
value derived from one, e.g. `PaymentRequirements`) is produced by `canonicalizeJCS`
(`receipt.ts`), a named alias of the pre-existing `canonicalize`. No third-party JCS
library is used or required. For this package's closed value domain — plain objects,
arrays, strings, booleans, `null`, and finite numbers excluding `-0` (everything else:
`undefined`, `NaN`, `±Infinity`, `Date`, `Map`, `Set`, functions, non-plain-prototype
objects — throws, see `sortKeys`) — a sorted-key `JSON.stringify` **is** an RFC
8785-conformant serialization, because:

1. **Member ordering.** RFC 8785 §3.2.3 requires object members sorted by the UTF-16 code
   unit sequence of their names. JavaScript's default `Array.prototype.sort()` on strings
   performs exactly this comparison; `sortKeys` sorts every object's keys this way at
   every nesting depth (verified: `test/jcs.test.ts` "key ordering" cases, including a
   surrogate-pair vs. BMP-character ordering case where code-point order and code-unit
   order would disagree).
2. **Number serialization.** RFC 8785 §3.2.2.3 mandates the ECMAScript
   `Number::toString` algorithm. `JSON.stringify` already emits exactly this
   representation for every finite number (integers never carry a trailing `.0` or
   exponent below `1e21`; `1e2` and `100` serialize identically; see `test/jcs.test.ts`
   "number forms").
3. **String encoding.** RFC 8785 assumes the standard JSON string encoding (mandatory
   escapes for `"`, `\`, and control characters `< 0x20`; no additional escaping
   required); this is what `JSON.stringify` produces. Distinct Unicode *literal* vs.
   `\uXXXX`-*escaped* source for the same character canonicalize identically, because
   both parse to the same string value before serialization (`test/jcs.test.ts`
   "unicode" cases).
4. **No Unicode normalization.** Neither RFC 8785 nor this package normalizes strings
   (NFC/NFD/etc.) — two Unicode-equivalent-but-differently-composed strings are treated
   as **distinct** values and canonicalize to distinct JSON text
   (`test/jcs.test.ts` "NFC/NFD").

`sortKeys`'s rejection of `-0`, `NaN`, `±Infinity`, `Date`, `Map`/`Set`, and `undefined`
is a *stricter* subset than generic RFC 8785 (which must define behavior for every
IEEE-754 double an arbitrary JSON producer might emit) — this package's envelope schema
never needs those values, so rejecting them outright removes a whole class of
non-injective-serialization bugs (e.g. `-0` and `0` colliding, `undefined` being silently
dropped by `JSON.stringify`) rather than requiring a canonicalization rule for them.

**receiptDigest / envelopeDigest.** `receiptDigest(receipt) === envelopeDigest(receipt) ===
sha256hex(canonicalizeJCS(receipt))`. Both names resolve to the same function; `receiptDigest`
is the pre-existing name used as the merkle leaf value (`merkle.ts`, `anchor.ts`);
`envelopeDigest` is added because the #2833 thread and this document call it "the
canonical envelope digest." They MUST NOT be allowed to diverge — `envelopeDigest` is
defined in terms of `receiptDigest`, not reimplemented.

**hashPaymentRequirements** (`request.payment_requirements_sha256`, v0.3, unchanged in
v0.5) uses the same canonicalization: `hashPaymentRequirements(req) ===
sha256hex(canonicalizeJCS(req))`. A `PaymentRequirements` object canonicalizes and
digests identically regardless of key insertion order (`test/v03.test.ts`).

## 2. Extension-response placement

**Canonical placement (v0.5, item 1 on #2833).** A seller MUST make the receipt
available at `extensions["delivery-receipt"]` on the x402 v2 payment-response object.
`attachReceiptExtension(response, receipt)` (`extension.ts`) produces this placement
non-destructively (existing `extensions` entries from other extensions are preserved).
`receiptFromExtensions(extensions)` reads it back, returning `null` (never throwing) if
absent or malformed.

The key is `"delivery-receipt"` — **lowercase**, hyphenated, matching the x402 v2
extension-registry naming convention. `DELIVERY_RECEIPT_EXTENSION_KEY` is the single
source of truth for this string; no other spelling (`deliveryReceipt`, `Delivery-Receipt`,
etc.) is valid.

**Header carriage is a projection, never primary (demoting the pre-v0.5 framing).**
Pre-v0.5 README examples showed a receipt riding in an `x402-receipt` or
`payment-response` response header as if that were how a receipt is delivered. As of
v0.5 this framing is retracted: a header MAY carry the same receipt JSON — via the
`@deprecated`-marked `projectReceiptHeader(receipt)` (`extension.ts`), which MUST
produce byte-identical JSON to the `extensions["delivery-receipt"]` value — but this
exists ONLY as a fallback for transports that strip or limit response bodies before a
client can read `extensions` (e.g. some CDN edge configurations, HEAD-adjacent proxies).
A verifier:

- MUST treat `extensions["delivery-receipt"]` as authoritative whenever the response
  body is available.
- MUST NOT treat a header-carried receipt as verified on its own if the body is also
  available and the two disagree — that disagreement itself MUST fail verification (the
  header is a claim about the extension value, not an independent source of truth).
- MAY use the header as the sole source only when the body is genuinely unavailable
  (documented exception, not the default path).

## 3. Signing (unchanged from v0.3)

`seller.sig` is an EIP-712 signature (`domainForV03`, `{ name: "x402-receipts", version:
"0.3", chainId }`) over a typed struct (`v03Message`) committing to `scheme` +
`sellerAgentId` + `payment` (including `assetAddress`) + `paymentRequirementsHash` +
`request` + `response`. This is unchanged in v0.5: the canonical-envelope work in this
document is about the *digest/serialization* of the full receipt (used for the merkle
leaf and content-addressing), not the EIP-712 signing domain, which already had its own
versioned, explicitly-typed-and-hashed struct as of v0.3. `verifySellerSig`/
`verifyBuyerCountersig` try v0.3 first, then fall back to the legacy v0 domain, unchanged.

### 3.1 Reference composition (settlement/refusal identity)

A payment's settlement/refusal identity is **derived once, at ingress, from the request as received (canonical form)**, and resolved identically by both the settle path and the refusal path, bound to `attempt_id`.

*Prohibition:* **no path re-reads `accepts` after ingress.** The positive rule ("derived once… settle and refusal resolve the same `attempt_id`") tells you what to build; the negative one is what a refactor test actually asserts — a guardrail that re-derives the fingerprint from live state can drift back in a refactor, and that drift is the failure this rule exists to prevent.

*Composition:* the digest is computed over **decoded, named fields** pulled out of the request object, never over the wire array — wire ordering is not ours to control, and a reorder that changes the digest silently splits or merges a count (the actual bug). This builds on the `canonicalizeJCS` rule in §4.

Consequences (the two-event split — reorder-within-terms vs a real terms change):
- Reorder-within-terms (same content) preserves one identity.
- A genuine terms change (new `payTo`/`amount`) yields a new identity and a legitimate `redeem_count` reset — an audit signal, not a bug.
- A mid-attempt terms change surfaces as an announcement event ("announcement changed mid-attempt"), never folded into the identity as a count divergence.

*Acceptance tests (all of which fail today if a second read exists):*
1. One settle + N refusals for the same attempt ⇒ the digest and `attempt_id` read byte-identical at both sites.
2. Permuting `accepts` without changing terms ⇒ digest unchanged (canonical, not wire).
3. Changing `amount` mid-attempt ⇒ new fingerprint, and the in-flight change surfaces as an announcement event, not a count divergence.

*Provenance:* developed in discussion on x402-receipts#6; invariant language per the gates-spec refusal-attestation guardrail model (RW-001). Authored by @ruiruii.


## 4. `payment_requirements_sha256` canonicalization rules

- Computed over exactly `{ payTo, amount, asset, scheme, resource, timeout }`
  (`PaymentRequirements`, `receipt.ts`) — no other fields are included or permitted in
  the hashed object.
- Canonicalization is `canonicalizeJCS` (§1): the hash is insensitive to key order but
  sensitive to every value, including whitespace-insensitive string content changes and
  numeric-vs-string type of `amount`/`timeout` (a `PaymentRequirements.amount` typed as
  `string` and a same-valued number are NOT the same hash input — the field is typed
  `string` precisely to remove that ambiguity).
- `verifyReceipt({ paymentRequirements })` recomputes `hashPaymentRequirements` from the
  caller-supplied requirements and compares byte-for-byte against
  `request.payment_requirements_sha256`; a mismatch is a `valid: false` error. Absent on
  either side (no stored hash, or no `paymentRequirements` option), the check is skipped
  — additive, backward compatible with pre-v0.3 receipts.

## 5. Predicates (settlement truth vs. delivery truth)

Two independent truths, checked by two independent functions, and this document
enumerates every fail-closed condition normatively:

**Delivery truth** — "did the seller consider what they sent back a successful
delivery?" (`verifyReceipt`, `deliveryStatusOk`, `verify.ts`):

- `delivery` absent → no claim made either way; `deliveryStatusOk` returns `true`
  (legacy/no-claim, not "verified delivered").
- `delivery.status === "delivered"` → `deliveryStatusOk` returns `true`.
- `delivery.status ∈ {"failed", "partial"}` → `deliveryStatusOk` returns `false`.
- `goods` attached AND `delivery.status !== "delivered"` → `verifyReceipt` MUST return
  `valid: false` (a goods claim paired with a non-delivered status is a self-contradiction
  the receipt itself flags).
- `goods.body_sha256 !== response.body_sha256` → `verifyReceipt` MUST return
  `valid: false` (goods binding broken).

**Settlement truth** — "did the claimed payment actually happen on-chain, to the claimed
parties, for the claimed amount and asset?" (`verifySettlement`, `settlement.ts`). ALL of
the following fail closed (`settled: false`):

- Unrecognized `chain_id` (no default RPC route and no injected client).
- The RPC's own `eth_chainId` disagrees with `payment.chain_id` (never trusts a
  caller-configured chain id).
- The transaction is not found, or its receipt is not found.
- The transaction's on-chain `status !== "success"` (reverted).
- Confirmations cannot be determined (`getBlockNumber` throws) — unknown confirmations
  are never treated as sufficient.
- Confirmations `< minConfirmations` (default 2).
- `payment.asset_address` is present but does not resolve to a recognized contract for
  the claimed chain (allowlist-only; an arbitrary `0x...` address is never accepted on
  the theory that "it's an address" is not evidence of a non-freely-mintable asset).
- `payment.asset` is a native-asset symbol (`ETH`/`NATIVE`) — native settlement is not
  supported (fails closed rather than silently skipping the check).
- `payment.asset` does not resolve to a recognized ERC-20 contract for the claimed chain.
- No `Transfer` log for the resolved contract exists in the transaction's receipt.
- No `Transfer` log's `(from, to, value)` exactly matches
  `(payment.payer, payment.payee, payment.amount)` (address comparison
  case-insensitive per `sameAddress`; amount comparison is exact string equality of the
  decimal value) — **this is the predicate that fails
  `neg-settled-to-expected-solver-mismatch`** (§9): funds moved, but not to the receipt's
  claimed payee.

`verifyReceiptFull` / `verifyReceiptFull.valid` is `true` **only** when both the receipt
check (`verifyReceipt`, includes signature + delivery predicates) AND the settlement
check (`verifySettlement`) pass. Neither predicate is a substitute for the other: a
receipt can be well-formed, correctly signed, and claim `delivery.status: "delivered"`
while its settlement never happened (`neg-delivered-not-settled`), and a payment can have
genuinely settled while the seller's own delivery claim says it failed
(`neg-funded-not-delivered`).

## 6. EAS batch-envelope schema (draft, Foundation-ownable)

### 6.0 Per-action and batch anchoring are independent, composable strategies

This section specifies **batch** anchoring: a merkle root over many receipts'
`receiptDigest`/`envelopeDigest` leaves, committed in one EAS attestation. A **per-action**
anchor — one commitment per action, e.g. the permissionless CREATE2 action registry
proposed as `A1_ANCHOR` on #2833 — commits a single action at a time, at a different layer.

The two are **independent and composable, not sequential alternatives, and neither
supersedes the other.** A seller **MAY** use per-action anchoring only, batch anchoring
only, both, or neither; nothing in this document **SHOULD** be read as requiring a seller
to graduate from one to the other, and an implementer **MUST NOT** read either as the only
available option. Where both are used, they commit to the same value — the receipt's
`envelopeDigest` (§1) is the per-action anchor's committed digest *and* the batch's merkle
leaf — so a receipt anchored both ways carries two independent existence bounds over one
canonical digest, and a verifier **MAY** accept either.

They differ in what they cost and what they buy, which is why the choice is a deployment
decision rather than a spec-level one:

| | per-action anchor (e.g. `A1_ANCHOR`) | batch anchor (§6, this document) |
|---|---|---|
| granularity | one action | one root over N receipts |
| on-chain cost | per action | amortized across the batch |
| latency to anchored state | immediate, at delivery time | deferred to the batch's close |
| inclusion evidence | the anchor itself names the action | merkle inclusion proof (§8) |
| verifier needs | the anchoring transaction | the anchoring attestation + a proof + the leaf |

### 6.1 The schema

This package anchors batches of receipts to Base via EAS (Ethereum Attestation Service)
rather than a bespoke contract or ERC-8004 self-anchoring (ERC-8004 explicitly forbids an
agent self-anchoring its own reputation data; EAS is a neutral, already-deployed OP-stack
predeploy). `ANCHOR_SCHEMA` (`anchor.ts`, already registered and live on Base mainnet —
see README "On-chain anchoring") is:

```
uint256 agentId,bytes32 merkleRoot,uint64 receiptCount,uint64 periodStart,uint64 periodEnd,string receiptsURI
```

| field | type | meaning |
|---|---|---|
| `agentId` | `uint256` | the anchoring seller's ERC-8004 agent id |
| `merkleRoot` | `bytes32` | RFC-6962 merkle root (`merkle.ts`) over `receiptDigest`/`envelopeDigest` leaves — the vendor payload schema (the full `Receipt` envelope, §1) lives entirely *under* the leaves; the anchor itself commits only to the root |
| `receiptCount` | `uint64` | number of leaves in this batch |
| `periodStart` / `periodEnd` | `uint64` | unix seconds, min/max `response.ts` across the batch |
| `receiptsURI` | `string` | where the full batch (not just the root) can be fetched to verify against |
| *(EAS request-level, not schema data)* `refUID` | `bytes32` | chains this anchor to the agent's previous anchor via EAS's native `refUID` field — walkable without an off-chain index |

**Proposed v0.5 draft addition (not yet registered — registering it would mint a new,
distinct `schemaUID`, changing the on-chain schema is itself a deployment decision out of
scope for this PR):** a `receiptsHash` (`bytes32`, sha256 of the byte-exact blob at
`receiptsURI`) field alongside `receiptsURI`, closing the gap where `receiptsURI` today
names a location but does not itself commit to the bytes found there — `merkleRoot`
already commits to every individual receipt's content, but nothing currently commits to
"the blob at this URI is the same blob whose leaves built this root" other than
recomputing the merkle tree from the fetched blob. This is a **draft proposal**, not
shipped in this release: `ANCHOR_SCHEMA` above remains the schema this package actually
anchors against.

**Why this is Foundation-ownable, not vendor-specific:** every leaf is a generic
`envelopeDigest` — a vendor's `goods`/`delivery`/domain-specific payload lives entirely
inside the leaf's `Receipt` object, never in the anchor schema itself. Any x402 seller
using any vendor payload schema can anchor batches under this same 6(+1)-field envelope;
the Foundation (or any neutral registry) can own and standardize this schema without
needing to standardize what any individual vendor puts inside a receipt.

### 6.2 A neutral venue is not a neutral attester

EAS is a neutral **venue**: it is a public predeploy that neither this package nor any
seller controls, so a commitment made there cannot later be withdrawn, back-dated, or
silently rewritten. That property is about the venue, and it is the only property the
venue provides.

The **attester** is not neutral. Under §6.1 the seller anchors batches of its own receipts
under its own `agentId`, with its own wallet, and chooses which leaves go in. This holds
for every signing role in the scheme, and the general statement is broader than any
single-address check:

> **Every signing role in a receipt is held by a party to the transaction.** `seller.sig`
> is the payee's. `buyer.countersig` is the payer's. The batch attestation is the
> anchoring seller's. No role in this specification is occupied by a disinterested third
> party, and no combination of these signatures constitutes an independent finding about
> the transaction.

Consequently, an evaluator:

- **MUST NOT** treat an anchor as an attestation *that the anchored receipts are true.*
  A merkle root commits to bytes; it says nothing about whether those bytes describe
  anything that happened. A seller can anchor a batch of entirely fabricated receipts and
  the anchor will be as valid as any other.
- **MUST NOT** count an anchor as an independent corroborating signal alongside the
  seller's signature. It is the same party asserting the same thing at a second layer.
- **MAY** rely on an anchor for exactly one thing: an **existence and ordering bound** —
  *this digest existed no later than this block's timestamp, and is committed in an order
  that cannot be rewritten after the fact.* That bound is sound precisely because block
  time is not the attester's to move: a seller cannot back-date a receipt into an earlier
  anchor, nor remove a leaf from a root already published.
- **MUST** obtain any independent finding from a source outside the receipt's signing
  roles — for settlement truth, the chain itself (§5, `verifySettlement`); for
  counterparty independence, an external funding-source/age signal this package does not
  provide.

ERC-8004's bar on an agent self-anchoring its own reputation data is satisfied at the
venue level (the registry is not ours) and **not** at the attester level (the data is
ours, about us). §6.1's citation of that rule justifies the choice of EAS over a bespoke
contract; it does not, and is not claimed to, make the seller a neutral attester.

## 7. ERC-8183 binding statement

Where an implementation binds an ERC-8183 attestation to an x402 settlement:
`attestationHash` (the ERC-8183 attestation's committed hash) MUST equal
`receiptDigest`/`envelopeDigest` computed over the receipt's canonicalized envelope (§1)
— i.e. the same sha256-over-JCS digest already used as the merkle leaf (§6) and produced
by signing (§3). Because the envelope's `payment` block includes `tx_hash` (settlement
proof) and the `request`/`response` blocks include `url_hash`/`params_hash`/`body_sha256`
(request/response hashes), and `seller.sig` is an EIP-712 signature over
`payment`+`payment_requirements_sha256`+`request`+`response` (§3, the "payee sig" ERC-8183
asks for), `attestationHash = envelopeDigest(receipt)` transitively commits to all four
things ERC-8183 binding requires in one value: settlement proof, request hash, response
hash, and payee signature — without ERC-8183 needing to model any of them itself. An
ERC-8183 consumer that has `attestationHash` and later obtains the full `Receipt` can
verify the binding with a single equality check (`attestationHash ===
envelopeDigest(receipt)`) before running `verifyReceipt`/`verifySettlement` against it.

## 8. Merkle inclusion verification

**Already implemented, no new code required for v0.5.** `verifyInclusion(leafData,
proof, expectedRoot)` (`merkle.ts`) lets a single receipt verify against a committed
batch anchor's root without refetching every other receipt in the batch: it recomputes
`hashLeaf(leafData)` (RFC-6962 `sha256(0x00 || data)`, domain-separated from internal
nodes so an internal node's preimage can never be replayed as a leaf) and folds the
sibling-path `proof` upward with `hashNode` (`sha256(0x01 || left || right)`), checking
the result equals `expectedRoot`. `getProof(tree, leafIndex)` produces that sibling path
for any leaf in a tree built by `buildMerkleTree`. `verifyAnchored(receipt, proof,
expectedRoot)` (`verify.ts`) is the receipt-level convenience wrapper:
`leaf = receiptDigest(receipt)` (the same digest as §1/§6), then `verifyInclusion`.
Already exercised for even/odd leaf counts, tampered proofs, wrong roots, and
forged-leaf/forged-proof substitution attempts (`test/merkle.test.ts`), and as of v0.5.1
end-to-end at the vector level against a populated `anchor` block, in both the included
and the absent-leaf case (§9).

**Which envelope state is the leaf (normative).** The merkle leaf for a receipt is
`envelopeDigest` computed over that receipt in its **pre-anchor state** — every field as
signed and (if applicable) countersigned, with `anchor: null`. This is forced, not
stylistic: `anchor.batch_merkle_root` is derived from the leaves, so a leaf computed over
an envelope that already contained the anchor block would be self-referential and
underivable. A verifier holding a receipt with a populated `anchor` therefore **MUST**
recompute the leaf over the envelope with `anchor` set to `null` before calling
`verifyInclusion`/`verifyAnchored`; passing the anchored envelope directly yields a
different digest and fails inclusion. `verifyAnchored` takes the receipt as given and does
not strip `anchor` itself — the caller owns that step
(`test/vectors.test.ts`'s `preAnchor` helper is the reference two-liner).

## 9. Conformance vectors

`vectors/` + `vectors/VECTORS.md`: two PASS vectors and five negative vectors, each pinned
to the single named predicate it must fail on, across two trust tiers.

**Tier 1 — seller signature + settlement + delivery (v0.5).** One PASS vector
(settlement truth AND delivery truth hold, built from a real settled Base mainnet USDC
transaction independently re-confirmed against a public RPC) and three negatives
(`neg-funded-not-delivered`, `neg-delivered-not-settled`,
`neg-settled-to-expected-solver-mismatch`), each pinned to a §5 predicate.

**Tier 2 — buyer countersignature + anchor inclusion (v0.5.1).** Every tier-1 vector
carries `buyer.countersig: null` and `anchor: null`, so a tier-1 PASS asserts the
seller-signature tier and nothing above it. Tier 2 makes that boundary deliberate rather
than an omission: `pass-countersigned-anchored` is the tier-1 PASS twin with
`buyer.countersig` and `anchor` actually populated (real `countersignReceipt` output; real
`buildMerkleTree`/`getProof` root and proof over real envelope digests — the anchor's
`base_tx` is synthetic and labeled as such, since posting an EAS attestation is a funded
on-chain write, and per §6.2 the anchor is an existence bound either way).
`neg-countersig-not-payer` carries a real, well-formed countersignature produced by a key
that is not `payment.payer` — it must fail closed against the expected buyer address and
against the default. `neg-leaf-not-in-anchored-root` is signed, countersigned and settled,
but its leaf is absent from the batch its `anchor` names, while the supplied proof is a
genuine proof for the leaf that does occupy that index — isolating the inclusion predicate
(§8) from proof malformation.

Every vector's `envelopeDigest` is
recorded in `VECTORS.md`'s digest table and re-asserted by `test/vectors.test.ts` on
every test run — a canonicalization regression fails that suite even if every predicate
still happens to evaluate correctly.
