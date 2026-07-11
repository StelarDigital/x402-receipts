import { createHash } from "node:crypto";

export type Hex = `0x${string}`;
export type Address = `0x${string}`;

export interface PaymentInfo {
  chain_id: number;
  tx_hash: Hex;
  asset: string;
  amount: string;
  payer: Address;
  payee: Address;
}

export interface RequestInfo {
  method: string;
  url_hash: string;
  params_hash: string;
  ts: string;
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

export interface Receipt {
  scheme: "x402-receipts/v0";
  payment: PaymentInfo;
  request: RequestInfo;
  response: ResponseInfo;
  seller: SellerInfo;
  buyer: BuyerInfo;
  anchor: AnchorInfo | null;
}

export interface BuildReceiptInput {
  payment: PaymentInfo;
  request: RequestInfo;
  response: ResponseInfo;
  seller_agent_id: string;
}

/** Builds an unsigned receipt (seller.sig, buyer.countersig, anchor all null). */
export function buildReceipt(input: BuildReceiptInput): Receipt {
  return {
    scheme: "x402-receipts/v0",
    payment: { ...input.payment },
    request: { ...input.request },
    response: { ...input.response },
    seller: { erc8004_agent_id: input.seller_agent_id, sig: null },
    buyer: { countersig: null },
    anchor: null,
  };
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
