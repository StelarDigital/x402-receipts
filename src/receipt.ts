import { createHash } from "node:crypto";

export type Hex = `0x${string}`;
export type Address = `0x${string}`;

export interface PaymentInfo {
  chain_id: number;
  tx_hash: Hex;
  /**
   * Either a legacy symbol (e.g. "USDC") or a CAIP-19 asset id / raw contract address.
   * Prefer `asset_address` for unambiguous on-chain contract binding (v0.3).
   */
  asset: string;
  amount: string;
  payer: Address;
  payee: Address;
  /**
   * Optional (v0.3): the token's contract address (or CAIP-19 id), bound alongside
   * `asset` so a verifier doesn't have to resolve a symbol to a contract itself. See
   * settlement.ts resolveAssetContract / BASE_USDC.
   */
  asset_address?: string;
}

export interface RequestInfo {
  method: string;
  url_hash: string;
  params_hash: string;
  ts: string;
  /**
   * Optional (v0.3): sha256 of the canonicalized payment requirements the buyer agreed
   * to (see `hashPaymentRequirements`). Lets a verifier confirm the receipt is bound to
   * the exact requirements the buyer was quoted, not a substituted one.
   */
  payment_requirements_sha256?: string;
}

/**
 * The payment requirements a buyer agrees to before paying (v0.3). Canonicalized and
 * hashed via `hashPaymentRequirements` into `request.payment_requirements_sha256`.
 */
export interface PaymentRequirements {
  payTo: string;
  amount: string;
  asset: string;
  scheme: string;
  resource: string;
  timeout: number;
}

/** sha256 of the canonicalized payment requirements object (v0.3). */
export function hashPaymentRequirements(req: PaymentRequirements): string {
  return canonicalDigest(req);
}

export interface ResponseInfo {
  status: number;
  body_sha256: string;
  content_type: string;
  ts: string;
  latency_ms: number;
}

export interface SellerInfo {
  erc8004_agent_id: string;
  sig: Hex | null;
}

export interface BuyerInfo {
  countersig: Hex | null;
}

export interface AnchorInfo {
  batch_merkle_root: Hex;
  base_tx: Hex;
  leaf_index: number;
}

export type GoodsKind = "api-response" | "file" | "dataset" | "text" | "other";

/**
 * Seller-declared description of what was actually delivered, bound to the delivered
 * bytes via body_sha256/bytes (see verifyGoodsAgainstBody in verify.ts). The binding
 * proves "these are the exact bytes the seller is describing" — it does NOT prove the
 * description/summary are truthful; they remain seller claims, same trust level as any
 * other unsigned metadata. `goods` is intentionally excluded from receiptCore/signing:
 * the seller signature already commits to response.body_sha256, and goods.body_sha256
 * must equal it, so the delivered bytes are authenticated either way. Description/
 * summary/preview riding alongside are NOT separately signed and can be swapped by
 * anyone relaying the receipt as long as body_sha256 still matches — see README
 * "Goods on the receipt" for what this does and doesn't prove.
 */
export interface GoodsInfo {
  description: string;
  kind: GoodsKind;
  summary: Record<string, string | number | boolean> | null;
  body_sha256: string;
  bytes: number;
  preview: string | null;
}

export type DeliveryStatus = "delivered" | "failed" | "partial";

/**
 * Optional (v0.3) seller-declared delivery outcome. Excluded from the seller signature
 * payload, same trust level as `goods` — see verify.ts deliveryStatusOk and
 * verifyReceipt's goods+delivery=failed check for what this does and doesn't prove.
 */
export interface DeliveryInfo {
  status: DeliveryStatus;
}

export interface Receipt {
  scheme: "x402-receipts/v0";
  payment: PaymentInfo;
  request: RequestInfo;
  response: ResponseInfo;
  seller: SellerInfo;
  buyer: BuyerInfo;
  anchor: AnchorInfo | null;
  /** Optional goods attestation. Omitted entirely (not even `null`) unless explicitly provided. */
  goods?: GoodsInfo | null;
  /** Optional (v0.3) delivery outcome. Omitted entirely (not even `null`) unless explicitly provided. */
  delivery?: DeliveryInfo | null;
}

export interface BuildReceiptInput {
  payment: PaymentInfo;
  request: RequestInfo;
  response: ResponseInfo;
  seller_agent_id: string;
  goods?: GoodsInfo | null;
  delivery?: DeliveryInfo | null;
}

/**
 * Builds an unsigned receipt (seller.sig, buyer.countersig, anchor all null). The
 * `goods` key is only ever set on the returned object when `input.goods` is not
 * `undefined` — this keeps the canonicalized/digested shape of a goods-less receipt
 * byte-identical to receipts built before goods attestation existed.
 */
export function buildReceipt(input: BuildReceiptInput): Receipt {
  const receipt: Receipt = {
    scheme: "x402-receipts/v0",
    payment: { ...input.payment },
    request: { ...input.request },
    response: { ...input.response },
    seller: { erc8004_agent_id: input.seller_agent_id, sig: null },
    buyer: { countersig: null },
    anchor: null,
  };
  if (input.goods !== undefined) {
    receipt.goods =
      input.goods === null
        ? null
        : { ...input.goods, summary: input.goods.summary ? { ...input.goods.summary } : null };
  }
  if (input.delivery !== undefined) {
    receipt.delivery = input.delivery === null ? null : { ...input.delivery };
  }
  return receipt;
}

/**
 * Recursively sorts object keys so JSON.stringify output is deterministic, and rejects
 * values that JSON.stringify would otherwise silently mangle into something else
 * (undefined dropped/nulled, NaN/Infinity turned into `null`, -0 printed as `0` but
 * distinct in `Object.is`) — any of which would let two logically different inputs
 * canonicalize to colliding digests.
 */
function sortKeys(value: unknown): unknown {
  if (value === undefined) {
    throw new Error("canonicalize: undefined is not allowed (ambiguous serialization)");
  }
  if (typeof value === "number") {
    if (Number.isNaN(value)) throw new Error("canonicalize: NaN is not allowed");
    if (!Number.isFinite(value)) throw new Error("canonicalize: Infinity is not allowed");
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value === "function") {
    throw new Error("canonicalize: functions are not allowed (non-serializable)");
  }
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  if (value instanceof Date) {
    throw new Error(
      "canonicalize: Date objects are not allowed (JSON.stringify serializes them " +
        "non-injectively; pass an ISO string field instead)"
    );
  }
  if (value instanceof Map || value instanceof Set) {
    throw new Error(`canonicalize: ${value.constructor.name} is not allowed (non-plain object)`);
  }
  if (value !== null && typeof value === "object") {
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
      throw new Error("canonicalize: only plain objects and arrays are allowed");
    }
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

/** Canonical JSON: sorted keys, no whitespace. Stable across field insertion order. */
export function canonicalize(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

export function sha256Hex(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

/** sha256 of the canonical JSON of any value, hex-encoded. */
export function canonicalDigest(value: unknown): string {
  return sha256Hex(canonicalize(value));
}

/** The stable core of a receipt used for signing/hashing (excludes sig/countersig/anchor fields). */
export function receiptCore(receipt: Receipt) {
  return {
    scheme: receipt.scheme,
    payment: receipt.payment,
    request: receipt.request,
    response: receipt.response,
    seller_agent_id: receipt.seller.erc8004_agent_id,
  };
}

/** Canonical digest of the full receipt (including signatures/anchor), used as a merkle leaf. */
export function receiptDigest(receipt: Receipt): string {
  return canonicalDigest(receipt);
}
