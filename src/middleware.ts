import type { DeliveryInfo, GoodsInfo, GoodsKind, Hex, PaymentInfo, Receipt, RequestInfo, ResponseInfo } from "./receipt.js";
import { buildReceipt, sha256Hex } from "./receipt.js";
import { signReceipt } from "./sign.js";
import { appendReceipt } from "./ledger.js";

export interface SettlementResult<T> {
  payment: PaymentInfo;
  request: RequestInfo;
  response: ResponseInfo;
  value: T;
  /** Raw delivered body. Only needed if `goods` is configured on the middleware. */
  body?: string | Uint8Array;
}

export interface GoodsDescriberContext<T> {
  value: T;
  response: ResponseInfo;
  body: string | Uint8Array;
}

export interface GoodsDescription {
  description: string;
  kind: GoodsKind;
  summary: Record<string, string | number | boolean> | null;
}

export interface ReceiptMiddlewareOptions<T = unknown> {
  ledgerPath: string;
  sellerAgentId: string;
  /** If omitted, receipts are appended unsigned (seller.sig stays null). */
  sellerPrivateKey?: Hex;
  /** May be sync or async; if it returns a rejected promise, the rejection is swallowed. */
  onError?: (err: unknown) => void | Promise<void>;
  /**
   * Per-route goods describer. If configured AND the settlement result includes `body`,
   * the middleware computes body_sha256/bytes/preview itself from the actual delivered
   * body (never trusts caller-supplied values for those fields) and attaches a `goods`
   * block to the receipt. If omitted, or if `body` is not supplied, no `goods` block is
   * attached — old behavior.
   */
  goods?: (ctx: GoodsDescriberContext<T>) => GoodsDescription;
}

/**
 * Strips control characters (keeping \n and \t) and truncates to at most `max` Unicode
 * code points, splitting on a code-point boundary so a surrogate pair or multi-byte
 * UTF-8 character is never cut in half.
 */
export function sanitizePreview(body: string, max = 512): string {
  let stripped = "";
  for (const ch of body) {
    const code = ch.codePointAt(0)!;
    if (code === 9 || code === 10) {
      stripped += ch;
      continue;
    }
    if (code < 32 || code === 127) continue;
    stripped += ch;
  }
  const codepoints = Array.from(stripped);
  if (codepoints.length <= max) return stripped;
  return codepoints.slice(0, max).join("");
}

export interface ReceiptMiddleware<T> {
  /** Wraps an x402 settlement callback: runs it, then best-effort records a receipt. Never throws. */
  wrap(settle: () => Promise<SettlementResult<T>>): Promise<T>;
}

const defaultOnError = (err: unknown) => {
  console.error("[x402-receipts] receipt recording failed (fail-open, response unaffected):", err);
};

/**
 * Framework-agnostic hook around an x402 settlement callback. The wrapped callback's
 * result is always returned as-is; any error while building/signing/appending the
 * receipt is caught and reported via onError, never thrown into the response path.
 */
export function createReceiptMiddleware<T>(options: ReceiptMiddlewareOptions<T>): ReceiptMiddleware<T> {
  const onError = options.onError ?? defaultOnError;

  return {
    async wrap(settle: () => Promise<SettlementResult<T>>): Promise<T> {
      const result = await settle();

      try {
        let goods: GoodsInfo | undefined;
        if (options.goods && result.body !== undefined) {
          const body = result.body;
          const bodyStr = typeof body === "string" ? body : Buffer.from(body).toString("utf8");
          const bytes = typeof body === "string" ? Buffer.byteLength(body, "utf8") : body.length;
          const described = options.goods({ value: result.value, response: result.response, body });
          const preview = sanitizePreview(bodyStr, 512);
          goods = {
            description: described.description,
            kind: described.kind,
            summary: described.summary,
            body_sha256: sha256Hex(body),
            bytes,
            preview: preview.length > 0 ? preview : null,
          };
        }

        const delivery: DeliveryInfo = {
          status: result.response.status >= 200 && result.response.status < 300 ? "delivered" : "failed",
        };

        let receipt: Receipt = buildReceipt({
          payment: result.payment,
          request: result.request,
          response: result.response,
          seller_agent_id: options.sellerAgentId,
          delivery,
          ...(goods !== undefined ? { goods } : {}),
        });

        if (options.sellerPrivateKey) {
          receipt = await signReceipt(receipt, options.sellerPrivateKey);
        }

        await appendReceipt(options.ledgerPath, receipt);
      } catch (err) {
        // onError is caller-supplied and must never be trusted not to throw (sync) or
        // reject (async): if it does, the payment path must still see the settlement's
        // value, not a throw or an unhandled rejection.
        try {
          await onError(err);
        } catch (onErrorErr) {
          console.error(
            "[x402-receipts] onError handler itself threw (fail-open, ignored):",
            onErrorErr
          );
        }
      } finally {
        // Guarantees the settlement's own value is always returned, even if something
        // above this point throws unexpectedly.
        return result.value;
      }
    },
  };
}
