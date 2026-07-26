import type { Receipt } from "./receipt.js";

/**
 * v0.5: the extension key this package uses under the x402 v2 payment-response
 * `extensions` object (x402-foundation/x402#2833 item 1). Lowercase, hyphenated, matching
 * the x402 v2 extension-registry naming convention (cf. other registered extension keys).
 */
export const DELIVERY_RECEIPT_EXTENSION_KEY = "delivery-receipt" as const;

export interface ExtensionsCarrier {
  extensions?: Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * Canonical placement (v0.5): attaches `receipt` at `extensions["delivery-receipt"]` on
 * an x402 v2 payment response object. This is the ONLY placement a verifier is required
 * to read from — see `projectReceiptHeader` below for why a header carrying the same
 * receipt is a projection, never a substitute for this.
 *
 * Non-destructive: any existing `extensions` entries (from other extensions) on
 * `response` are preserved; only the `delivery-receipt` key is set/overwritten.
 */
export function attachReceiptExtension<T extends ExtensionsCarrier>(response: T, receipt: Receipt): T {
  return {
    ...response,
    extensions: {
      ...response.extensions,
      [DELIVERY_RECEIPT_EXTENSION_KEY]: receipt,
    },
  };
}

/**
 * Reads the receipt back out of `extensions["delivery-receipt"]`. Returns `null` if
 * absent or if the value there isn't a plain object — never throws on a malformed or
 * missing extension, so a caller doesn't need a try/catch to probe for the receipt's
 * presence.
 */
export function receiptFromExtensions(extensions: Record<string, unknown> | undefined | null): Receipt | null {
  const value = extensions?.[DELIVERY_RECEIPT_EXTENSION_KEY];
  if (value === undefined || value === null || typeof value !== "object") return null;
  return value as Receipt;
}

/**
 * @deprecated Header carriage of a receipt is a PROJECTION of the canonical
 * `extensions["delivery-receipt"]` placement (`attachReceiptExtension`) — never the
 * primary path, and never authoritative on its own. This demotes the "header-primary"
 * framing from pre-v0.5 README examples (`x402-receipt` / `payment-response` headers):
 * those examples showed a header as if it were how a receipt is delivered; as of v0.5 a
 * header MUST carry byte-identical JSON to the extension value and exists ONLY for
 * transports that strip/limit response bodies before a client can read `extensions`
 * (e.g. some CDN edge configs, HEAD-adjacent proxies). A verifier reading a receipt from
 * a header without cross-checking it against `extensions["delivery-receipt"]` (when the
 * body is available) is not doing v0.5-conformant verification.
 */
export function projectReceiptHeader(receipt: Receipt): string {
  return JSON.stringify(receipt);
}
