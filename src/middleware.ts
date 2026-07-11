import type { Hex, PaymentInfo, Receipt, RequestInfo, ResponseInfo } from "./receipt.js";
import { buildReceipt } from "./receipt.js";
import { signReceipt } from "./sign.js";
import { appendReceipt } from "./ledger.js";

export interface SettlementResult<T> {
  payment: PaymentInfo;
  request: RequestInfo;
  response: ResponseInfo;
  value: T;
}

export interface ReceiptMiddlewareOptions {
  ledgerPath: string;
  sellerAgentId: string;
  /** If omitted, receipts are appended unsigned (seller.sig stays null). */
  sellerPrivateKey?: Hex;
  /** May be sync or async; if it returns a rejected promise, the rejection is swallowed. */
  onError?: (err: unknown) => void | Promise<void>;
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
export function createReceiptMiddleware<T>(options: ReceiptMiddlewareOptions): ReceiptMiddleware<T> {
  const onError = options.onError ?? defaultOnError;

  return {
    async wrap(settle: () => Promise<SettlementResult<T>>): Promise<T> {
      const result = await settle();

      try {
        let receipt: Receipt = buildReceipt({
          payment: result.payment,
          request: result.request,
          response: result.response,
          seller_agent_id: options.sellerAgentId,
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
