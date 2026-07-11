import { privateKeyToAccount } from "viem/accounts";
import { verifyTypedData } from "viem";
import type { Address, Hex, Receipt } from "./receipt.js";

const SELLER_TYPES = {
  Receipt: [
    { name: "scheme", type: "string" },
    { name: "sellerAgentId", type: "string" },
    { name: "payment", type: "Payment" },
    { name: "request", type: "Request" },
    { name: "response", type: "Response" },
  ],
  Payment: [
    { name: "chainId", type: "uint256" },
    { name: "txHash", type: "bytes32" },
    { name: "asset", type: "string" },
    { name: "amount", type: "string" },
    { name: "payer", type: "address" },
    { name: "payee", type: "address" },
  ],
  Request: [
    { name: "method", type: "string" },
    { name: "urlHash", type: "bytes32" },
    { name: "paramsHash", type: "bytes32" },
    { name: "ts", type: "string" },
  ],
  Response: [
    { name: "status", type: "uint256" },
    { name: "bodySha256", type: "bytes32" },
    { name: "contentType", type: "string" },
    { name: "ts", type: "string" },
    { name: "latencyMs", type: "uint256" },
  ],
} as const;

const COUNTERSIGN_TYPES = {
  ...SELLER_TYPES,
  CounterSign: [
    { name: "receipt", type: "Receipt" },
    { name: "sellerSig", type: "bytes" },
  ],
};

function domainFor(chainId: number) {
  return {
    name: "x402-receipts",
    version: "0",
    chainId,
  } as const;
}

function toBytes32(hexDigest: string): Hex {
  const clean = hexDigest.startsWith("0x") ? hexDigest.slice(2) : hexDigest;
  if (clean.length !== 64) {
    throw new Error(`expected 32-byte hex digest, got ${clean.length / 2} bytes`);
  }
  return `0x${clean}` as Hex;
}

function sellerMessage(receipt: Receipt) {
  return {
    scheme: receipt.scheme,
    sellerAgentId: receipt.seller.erc8004_agent_id,
    payment: {
      chainId: BigInt(receipt.payment.chain_id),
      txHash: receipt.payment.tx_hash,
      asset: receipt.payment.asset,
      amount: receipt.payment.amount,
      payer: receipt.payment.payer,
      payee: receipt.payment.payee,
    },
    request: {
      method: receipt.request.method,
      urlHash: toBytes32(receipt.request.url_hash),
      paramsHash: toBytes32(receipt.request.params_hash),
      ts: receipt.request.ts,
    },
    response: {
      status: BigInt(receipt.response.status),
      bodySha256: toBytes32(receipt.response.body_sha256),
      contentType: receipt.response.content_type,
      ts: receipt.response.ts,
      latencyMs: BigInt(receipt.response.latency_ms),
    },
  };
}

/** Seller signs the receipt core (payment + request + response binding), producing seller.sig. */
export async function signReceipt(receipt: Receipt, privateKey: Hex): Promise<Receipt> {
  const account = privateKeyToAccount(privateKey);
  const sig = await account.signTypedData({
    domain: domainFor(receipt.payment.chain_id),
    types: SELLER_TYPES,
    primaryType: "Receipt",
    message: sellerMessage(receipt),
  });
  return {
    ...receipt,
    seller: { ...receipt.seller, sig },
  };
}

/** Buyer countersigns the seller-signed receipt (binds buyer's acceptance to the exact seller sig). */
export async function countersignReceipt(receipt: Receipt, privateKey: Hex): Promise<Receipt> {
  if (!receipt.seller.sig) {
    throw new Error("cannot countersign a receipt with no seller signature");
  }
  const account = privateKeyToAccount(privateKey);
  const countersig = await account.signTypedData({
    domain: domainFor(receipt.payment.chain_id),
    types: COUNTERSIGN_TYPES,
    primaryType: "CounterSign",
    message: {
      receipt: sellerMessage(receipt),
      sellerSig: receipt.seller.sig,
    },
  });
  return {
    ...receipt,
    buyer: { countersig },
  };
}

export async function verifySellerSig(receipt: Receipt, sellerAddress: Address): Promise<boolean> {
  if (!receipt.seller.sig) return false;
  return verifyTypedData({
    address: sellerAddress,
    domain: domainFor(receipt.payment.chain_id),
    types: SELLER_TYPES,
    primaryType: "Receipt",
    message: sellerMessage(receipt),
    signature: receipt.seller.sig,
  });
}

export async function verifyBuyerCountersig(receipt: Receipt, buyerAddress: Address): Promise<boolean> {
  if (!receipt.buyer.countersig || !receipt.seller.sig) return false;
  return verifyTypedData({
    address: buyerAddress,
    domain: domainFor(receipt.payment.chain_id),
    types: COUNTERSIGN_TYPES,
    primaryType: "CounterSign",
    message: {
      receipt: sellerMessage(receipt),
      sellerSig: receipt.seller.sig,
    },
    signature: receipt.buyer.countersig,
  });
}
