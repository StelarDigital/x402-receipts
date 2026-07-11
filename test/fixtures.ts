import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { buildReceipt, sha256Hex, type BuildReceiptInput, type Hex } from "../src/receipt.js";

export function makeSellerKey() {
  return generatePrivateKey();
}

export function makeBuyerKey() {
  return generatePrivateKey();
}

export function addressOf(privateKey: Hex) {
  return privateKeyToAccount(privateKey).address;
}

export function sampleInput(overrides: Partial<BuildReceiptInput> = {}): BuildReceiptInput {
  const sellerKey = makeSellerKey();
  const buyerKey = makeBuyerKey();
  return {
    payment: {
      chain_id: 8453,
      tx_hash: `0x${"a".repeat(64)}` as Hex,
      asset: "USDC",
      amount: "1000000",
      payer: addressOf(buyerKey),
      payee: addressOf(sellerKey),
      ...overrides.payment,
    },
    request: {
      method: "GET",
      url_hash: sha256Hex("https://api.example.com/v1/signal"),
      params_hash: sha256Hex(JSON.stringify({ symbol: "BTC-USD" })),
      ts: "2026-07-10T12:00:00.000Z",
      ...overrides.request,
    },
    response: {
      status: 200,
      body_sha256: sha256Hex(JSON.stringify({ ok: true })),
      content_type: "application/json",
      ts: "2026-07-10T12:00:00.500Z",
      latency_ms: 500,
      ...overrides.response,
    },
    seller_agent_id: overrides.seller_agent_id ?? "erc8004:8453:0x1234",
  };
}

export function sampleReceipt(overrides: Partial<BuildReceiptInput> = {}) {
  return buildReceipt(sampleInput(overrides));
}
