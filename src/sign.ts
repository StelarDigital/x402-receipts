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

/** Legacy (v0) EIP-712 domain. Kept unchanged so old receipts still verify. */
function domainFor(chainId: number) {
  return {
    name: "x402-receipts",
    version: "0",
    chainId,
  } as const;
}

/**
 * Versioned (v0.3) EIP-712 domain — the "canonical digest/domain" reviewers asked for
 * on x402-foundation/x402#2833. New signatures use this; verify tries it first, then
 * falls back to the legacy v0 domain so pre-v0.3 receipts keep verifying unchanged.
 */
function domainForV03(chainId: number) {
  return {
    name: "x402-receipts",
    version: "0.3",
    chainId,
  } as const;
}

/**
 * v0.3 typed struct: adds `paymentRequirementsHash` (a dedicated bytes32 commitment to
 * `hashPaymentRequirements`'s output — the "canonical digest" reviewers asked for) and
 * an extended `PaymentV03` struct carrying `assetAddress` alongside the legacy fields,
 * while reusing the unchanged `Request`/`Response` sub-structs so tx_hash/url_hash/
 * params_hash/body_sha256 keep the exact same format validation as the legacy path.
 * EIP-712 struct nesting hashes each sub-struct (hashStruct) before folding it into the
 * parent digest — this is the "typed digest that commits to payment +
 * payment_requirements_sha256 + request + response hashes" reviewers asked for.
 */
const PAYMENT_V03_FIELDS = [
  { name: "chainId", type: "uint256" },
  { name: "txHash", type: "bytes32" },
  { name: "asset", type: "string" },
  { name: "amount", type: "string" },
  { name: "payer", type: "address" },
  { name: "payee", type: "address" },
  { name: "assetAddress", type: "string" },
] as const;

const V03_TYPES = {
  ReceiptV03: [
    { name: "scheme", type: "string" },
    { name: "sellerAgentId", type: "string" },
    { name: "payment", type: "PaymentV03" },
    { name: "paymentRequirementsHash", type: "bytes32" },
    { name: "request", type: "Request" },
    { name: "response", type: "Response" },
  ],
  PaymentV03: PAYMENT_V03_FIELDS,
  Request: SELLER_TYPES.Request,
  Response: SELLER_TYPES.Response,
} as const;

const COUNTERSIGN_V03_TYPES = {
  ...V03_TYPES,
  CounterSignV03: [
    { name: "receipt", type: "ReceiptV03" },
    { name: "sellerSig", type: "bytes" },
  ],
};

const ZERO_BYTES32: Hex = `0x${"0".repeat(64)}`;

function toBytes32(hexDigest: string): Hex {
  const clean = hexDigest.startsWith("0x") ? hexDigest.slice(2) : hexDigest;
  if (clean.length !== 64) {
    throw new Error(`expected 32-byte hex digest, got ${clean.length / 2} bytes`);
  }
  return `0x${clean}` as Hex;
}

function paymentMessage(payment: Receipt["payment"]) {
  return {
    chainId: BigInt(payment.chain_id),
    txHash: payment.tx_hash,
    asset: payment.asset,
    amount: payment.amount,
    payer: payment.payer,
    payee: payment.payee,
  };
}

function requestMessage(request: Receipt["request"]) {
  return {
    method: request.method,
    urlHash: toBytes32(request.url_hash),
    paramsHash: toBytes32(request.params_hash),
    ts: request.ts,
  };
}

function responseMessage(response: Receipt["response"]) {
  return {
    status: BigInt(response.status),
    bodySha256: toBytes32(response.body_sha256),
    contentType: response.content_type,
    ts: response.ts,
    latencyMs: BigInt(response.latency_ms),
  };
}

function sellerMessage(receipt: Receipt) {
  return {
    scheme: receipt.scheme,
    sellerAgentId: receipt.seller.erc8004_agent_id,
    payment: paymentMessage(receipt.payment),
    request: requestMessage(receipt.request),
    response: responseMessage(receipt.response),
  };
}

function v03Message(receipt: Receipt) {
  return {
    scheme: receipt.scheme,
    sellerAgentId: receipt.seller.erc8004_agent_id,
    payment: {
      ...paymentMessage(receipt.payment),
      assetAddress: receipt.payment.asset_address ?? "",
    },
    paymentRequirementsHash: receipt.request.payment_requirements_sha256
      ? toBytes32(receipt.request.payment_requirements_sha256)
      : ZERO_BYTES32,
    request: requestMessage(receipt.request),
    response: responseMessage(receipt.response),
  };
}

/** Seller signs the receipt (payment + payment_requirements_sha256 + request + response binding), producing seller.sig. New signatures use the v0.3 domain (see domainForV03). */
export async function signReceipt(receipt: Receipt, privateKey: Hex): Promise<Receipt> {
  const account = privateKeyToAccount(privateKey);
  const sig = await account.signTypedData({
    domain: domainForV03(receipt.payment.chain_id),
    types: V03_TYPES,
    primaryType: "ReceiptV03",
    message: v03Message(receipt),
  });
  return {
    ...receipt,
    seller: { ...receipt.seller, sig },
  };
}

/**
 * Signs under the legacy (v0) EIP-712 domain instead of v0.3. Exists so callers/tests
 * can exercise the legacy-signature fallback path in `verifySellerSig`; new integrations
 * should use `signReceipt`, which now signs v0.3 by default.
 */
export async function signReceiptLegacyV0(receipt: Receipt, privateKey: Hex): Promise<Receipt> {
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

/**
 * Countersigns under the legacy (v0) EIP-712 domain instead of v0.3. Exists so
 * callers/tests can exercise the legacy-countersignature fallback path in
 * `verifyBuyerCountersig`; new integrations should use `countersignReceipt`.
 */
export async function countersignReceiptLegacyV0(receipt: Receipt, privateKey: Hex): Promise<Receipt> {
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

/** Buyer countersigns the seller-signed receipt (binds buyer's acceptance to the exact seller sig). New countersignatures use the v0.3 domain. */
export async function countersignReceipt(receipt: Receipt, privateKey: Hex): Promise<Receipt> {
  if (!receipt.seller.sig) {
    throw new Error("cannot countersign a receipt with no seller signature");
  }
  const account = privateKeyToAccount(privateKey);
  const countersig = await account.signTypedData({
    domain: domainForV03(receipt.payment.chain_id),
    types: COUNTERSIGN_V03_TYPES,
    primaryType: "CounterSignV03",
    message: {
      receipt: v03Message(receipt),
      sellerSig: receipt.seller.sig,
    },
  });
  return {
    ...receipt,
    buyer: { countersig },
  };
}

/** Verifies seller.sig: tries the v0.3 domain first, falls back to the legacy v0 domain so old receipts keep verifying. */
export async function verifySellerSig(receipt: Receipt, sellerAddress: Address): Promise<boolean> {
  if (!receipt.seller.sig) return false;

  const v03Ok = await verifyTypedData({
    address: sellerAddress,
    domain: domainForV03(receipt.payment.chain_id),
    types: V03_TYPES,
    primaryType: "ReceiptV03",
    message: v03Message(receipt),
    signature: receipt.seller.sig,
  });
  if (v03Ok) return true;

  return verifyTypedData({
    address: sellerAddress,
    domain: domainFor(receipt.payment.chain_id),
    types: SELLER_TYPES,
    primaryType: "Receipt",
    message: sellerMessage(receipt),
    signature: receipt.seller.sig,
  });
}

/** Verifies buyer.countersig: tries the v0.3 domain first, falls back to the legacy v0 domain. */
export async function verifyBuyerCountersig(receipt: Receipt, buyerAddress: Address): Promise<boolean> {
  if (!receipt.buyer.countersig || !receipt.seller.sig) return false;

  const v03Ok = await verifyTypedData({
    address: buyerAddress,
    domain: domainForV03(receipt.payment.chain_id),
    types: COUNTERSIGN_V03_TYPES,
    primaryType: "CounterSignV03",
    message: {
      receipt: v03Message(receipt),
      sellerSig: receipt.seller.sig,
    },
    signature: receipt.buyer.countersig,
  });
  if (v03Ok) return true;

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
