import type { Address, Receipt } from "./receipt.js";
import { verifyBuyerCountersig, verifySellerSig } from "./sign.js";
import { verifyInclusion, type MerkleProofStep } from "./merkle.js";
import { receiptDigest } from "./receipt.js";

export interface VerifyReceiptOptions {
  /** Address expected to have produced seller.sig. Defaults to receipt.payment.payee. */
  sellerAddress?: Address;
  /** Address expected to have produced buyer.countersig. Defaults to receipt.payment.payer. */
  buyerAddress?: Address;
  /** If provided, checked against receipt.response.body_sha256. */
  expectedBodySha256?: string;
  /** If true, a missing buyer countersig fails verification. Default false. */
  requireCountersig?: boolean;
  /**
   * If true (default), a receipt where payment.payer === payment.payee fails verification.
   * A seller who controls both addresses can fully self-sign AND self-countersign a receipt
   * for a "delivery" that never happened to anyone else — see README "Trust model" for why
   * reputation scoring must never treat such a receipt as evidence of a real counterparty.
   */
  rejectSelfDeal?: boolean;
}

export interface VerifyReceiptResult {
  valid: boolean;
  errors: string[];
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Compares two addresses case-insensitively. Ethereum addresses are case-insensitive
 * (EIP-55 checksum casing is a display convention, not a distinct address); comparing
 * raw strings lets a checksummed form and a lowercase form of the SAME address bypass
 * an equality check like the self-dealing guard below.
 */
export function sameAddress(a: Address, b: Address): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

function isBasicallyWellFormed(receipt: Receipt): string[] {
  const errors: string[] = [];
  if (receipt.scheme !== "x402-receipts/v0") errors.push("unexpected scheme");
  if (!receipt.payment) errors.push("missing payment");
  if (!receipt.request) errors.push("missing request");
  if (!receipt.response) errors.push("missing response");
  if (!receipt.seller || !receipt.seller.sig) errors.push("missing seller signature");
  return errors;
}

/** Checks schema validity, seller signature, buyer countersig (if present/required), and body hash. */
export async function verifyReceipt(
  receipt: Receipt,
  options: VerifyReceiptOptions = {}
): Promise<VerifyReceiptResult> {
  const errors = isBasicallyWellFormed(receipt);
  if (errors.length > 0) {
    return { valid: false, errors };
  }

  const rejectSelfDeal = options.rejectSelfDeal ?? true;
  if (rejectSelfDeal && sameAddress(receipt.payment.payer, receipt.payment.payee)) {
    errors.push("self-dealing: payer==payee");
  }

  const sellerAddress = options.sellerAddress ?? receipt.payment.payee;
  let sellerOk = false;
  try {
    sellerOk = await verifySellerSig(receipt, sellerAddress);
  } catch (err) {
    errors.push(`seller signature check threw: ${errorMessage(err)}`);
  }
  if (!sellerOk) errors.push("seller signature invalid");

  if (receipt.buyer.countersig) {
    const buyerAddress = options.buyerAddress ?? receipt.payment.payer;
    let buyerOk = false;
    try {
      buyerOk = await verifyBuyerCountersig(receipt, buyerAddress);
    } catch (err) {
      errors.push(`buyer countersignature check threw: ${errorMessage(err)}`);
    }
    if (!buyerOk) errors.push("buyer countersignature invalid");
  } else if (options.requireCountersig) {
    errors.push("missing required buyer countersignature");
  }

  if (options.expectedBodySha256 && options.expectedBodySha256 !== receipt.response.body_sha256) {
    errors.push("response body_sha256 mismatch");
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Verifies that a receipt is included in an anchored merkle batch. The receipt digest is
 * treated as raw leaf data: verifyInclusion hashes it as a leaf with the RFC-6962 0x00
 * domain-separation prefix before folding the proof upward, so an internal batch node's
 * preimage can never be substituted for a real leaf (see merkle.ts hashLeaf/hashNode).
 */
export function verifyAnchored(receipt: Receipt, proof: MerkleProofStep[], expectedRoot: string): boolean {
  const leaf = receiptDigest(receipt);
  return verifyInclusion(leaf, proof, expectedRoot);
}
