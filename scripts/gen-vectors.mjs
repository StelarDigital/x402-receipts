import { writeFileSync, mkdirSync } from "node:fs";
import {
  buildReceipt,
  canonicalizeJCS,
  envelopeDigest,
  hashPaymentRequirements,
  sha256Hex,
} from "../dist/index.js";
import { signReceipt } from "../dist/index.js";
import { privateKeyToAccount } from "viem/accounts";

// Fixed, publicly-labeled VECTOR-ONLY signing keys (never used for any real receipt;
// these are throwaway keys generated solely to produce reproducible EIP-712 signatures
// over these fixtures, not the production seller key for the real on-chain payee below).
const VECTOR_SELLER_KEY = "0x" + "11".repeat(31) + "aa";
const VECTOR_BUYER_KEY = "0x" + "22".repeat(31) + "bb";
const sellerAddr = privateKeyToAccount(VECTOR_SELLER_KEY).address;
const buyerAddr = privateKeyToAccount(VECTOR_BUYER_KEY).address;

const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

// Real settled Base mainnet tx, independently confirmed against a public Base RPC
// (eth_getTransactionReceipt, status 0x1) — see VECTORS.md for the raw confirmation.
const REAL_TX = "0xdeb5872c039a88ae37b66ae490c0c8da9b6a4c652d84494ddcc9a05211d6cc80";
const REAL_PAYER = "0xe61Bd34fcEdF14E0b41B582166eed69E3a6deF89";
const REAL_PAYEE = "0x32d711C66dD1AD0c42D0cFe48e58ee5f2dE7c243";
const REAL_AMOUNT = "5000";

mkdirSync("vectors", { recursive: true });

function write(name, obj) {
  writeFileSync(`vectors/${name}.json`, JSON.stringify(obj, null, 2) + "\n");
  console.log(name, "digest:", envelopeDigest(obj.receipt));
}

// ---------------------------------------------------------------------------
// PASS: settled-and-delivered, using the REAL Base tx above.
// ---------------------------------------------------------------------------
{
  const requirements = {
    payTo: REAL_PAYEE,
    amount: REAL_AMOUNT,
    asset: BASE_USDC,
    scheme: "exact",
    resource: "https://x402api.stelardigital.workers.dev/v1/signal",
    timeout: 60,
  };
  const receipt = buildReceipt({
    payment: {
      chain_id: 8453,
      tx_hash: REAL_TX,
      asset: BASE_USDC,
      asset_address: BASE_USDC,
      amount: REAL_AMOUNT,
      payer: REAL_PAYER,
      payee: REAL_PAYEE,
    },
    request: {
      method: "GET",
      url_hash: "84d14f74996f93224e9e9db28ff4a39b5cc45b443486a3bb2c5bf0f3546ab7d8",
      params_hash: "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a",
      ts: "2026-07-11T21:03:55Z",
      payment_requirements_sha256: hashPaymentRequirements(requirements),
    },
    response: {
      status: 200,
      body_sha256: "5545e4424324ee42fd5b739544f462a47b81f122b02ec859af986e9316fadee4",
      content_type: "application/json",
      ts: "2026-07-11T21:03:55Z",
      latency_ms: 296,
    },
    seller_agent_id: `erc8004:8453:${REAL_PAYEE}`,
    delivery: { status: "delivered" },
  });
  const signed = await signReceipt(receipt, VECTOR_SELLER_KEY);

  write("pass-settled-delivered", {
    id: "pass-settled-delivered",
    description:
      "Settlement truth AND delivery truth both hold. payment/tx_hash/payer/payee/amount/asset are a REAL settled Base mainnet USDC transfer (independently confirmed via eth_getTransactionReceipt, status 0x1, Transfer log matches payer/payee/amount/asset exactly). seller.sig is produced by a labeled VECTOR-ONLY test key (not the production seller key) so verification must pass sellerAddress explicitly rather than rely on the payment.payee default.",
    predicate: "verifyReceipt(receipt,{sellerAddress:vectorSellerAddress}).valid === true AND verifySettlement(receipt,{client:mockMatchingRealTx}).settled === true",
    vectorSellerAddress: sellerAddr,
    vectorBuyerAddress: buyerAddr,
    mockOnChain: {
      status: "success",
      blockNumber: 100,
      currentBlock: 103,
      transferLog: { contract: BASE_USDC, from: REAL_PAYER, to: REAL_PAYEE, value: REAL_AMOUNT },
    },
    receipt: signed,
  });
}

// ---------------------------------------------------------------------------
// NEGATIVE 1: funded-not-delivered — payment settled, delivery.status != delivered
// while a goods claim is attached.
// ---------------------------------------------------------------------------
{
  const receipt = buildReceipt({
    payment: {
      chain_id: 8453,
      tx_hash: REAL_TX,
      asset: BASE_USDC,
      asset_address: BASE_USDC,
      amount: REAL_AMOUNT,
      payer: REAL_PAYER,
      payee: REAL_PAYEE,
    },
    request: {
      method: "GET",
      url_hash: "84d14f74996f93224e9e9db28ff4a39b5cc45b443486a3bb2c5bf0f3546ab7d8",
      params_hash: "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a",
      ts: "2026-07-11T21:03:55Z",
    },
    response: {
      status: 502,
      body_sha256: sha256Hex("upstream timeout"),
      content_type: "application/json",
      ts: "2026-07-11T21:03:55Z",
      latency_ms: 30000,
    },
    seller_agent_id: `erc8004:8453:${REAL_PAYEE}`,
    goods: {
      description: "market-brief: SOL regime+sentiment+price+risk",
      kind: "api-response",
      summary: null,
      body_sha256: sha256Hex("upstream timeout"),
      bytes: 16,
      preview: null,
    },
    delivery: { status: "failed" },
  });
  const signed = await signReceipt(receipt, VECTOR_SELLER_KEY);

  write("neg-funded-not-delivered", {
    id: "neg-funded-not-delivered",
    description:
      "The buyer's payment settled on-chain (same REAL tx as the PASS vector, reused here to isolate the delivery predicate from the settlement predicate) but the seller's own delivery.status claims failure while a goods block is attached — a funded-but-undelivered outcome. Must fail closed on the delivery predicate regardless of settlement truth.",
    predicate:
      "deliveryStatusOk(receipt) === false; verifyReceipt(receipt).valid === false with an error matching /delivery.status is \"failed\"/",
    vectorSellerAddress: sellerAddr,
    vectorBuyerAddress: buyerAddr,
    mockOnChain: {
      status: "success",
      blockNumber: 100,
      currentBlock: 103,
      transferLog: { contract: BASE_USDC, from: REAL_PAYER, to: REAL_PAYEE, value: REAL_AMOUNT },
    },
    receipt: signed,
  });
}

// ---------------------------------------------------------------------------
// NEGATIVE 2: delivered-not-settled — delivery.status says delivered, but the
// on-chain transaction reverted (synthetic tx — a real reverted x402 settlement
// would be a production incident, not something we have or want on record).
// ---------------------------------------------------------------------------
{
  const SYNTHETIC_TX = "0x" + "de".repeat(32);
  const receipt = buildReceipt({
    payment: {
      chain_id: 8453,
      tx_hash: SYNTHETIC_TX,
      asset: BASE_USDC,
      asset_address: BASE_USDC,
      amount: REAL_AMOUNT,
      payer: REAL_PAYER,
      payee: REAL_PAYEE,
    },
    request: {
      method: "GET",
      url_hash: "84d14f74996f93224e9e9db28ff4a39b5cc45b443486a3bb2c5bf0f3546ab7d8",
      params_hash: "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a",
      ts: "2026-07-11T21:03:55Z",
    },
    response: {
      status: 200,
      body_sha256: "5545e4424324ee42fd5b739544f462a47b81f122b02ec859af986e9316fadee4",
      content_type: "application/json",
      ts: "2026-07-11T21:03:55Z",
      latency_ms: 296,
    },
    seller_agent_id: `erc8004:8453:${REAL_PAYEE}`,
    delivery: { status: "delivered" },
  });
  const signed = await signReceipt(receipt, VECTOR_SELLER_KEY);

  write("neg-delivered-not-settled", {
    id: "neg-delivered-not-settled",
    description:
      "Seller claims delivery.status=delivered, but tx_hash is a SYNTHETIC transaction (clearly not the real tx used in the PASS vector) whose mocked receipt status is 'reverted' — the payment never actually settled on-chain. Must fail closed on the settlement predicate regardless of the delivery claim.",
    predicate:
      "verifySettlement(receipt,{client:mockReverted}).settled === false with an error matching /did not succeed on-chain/",
    vectorSellerAddress: sellerAddr,
    vectorBuyerAddress: buyerAddr,
    mockOnChain: {
      status: "reverted",
      blockNumber: 100,
      currentBlock: 103,
      transferLog: null,
    },
    receipt: signed,
  });
}

// ---------------------------------------------------------------------------
// NEGATIVE 3: settled-to-expected-solver mismatch — funds moved on-chain, but
// to a different recipient than the receipt's claimed payee (solver substitution).
// ---------------------------------------------------------------------------
{
  const WRONG_SOLVER = "0x000000000000000000000000000000000BADBAD";
  const receipt = buildReceipt({
    payment: {
      chain_id: 8453,
      tx_hash: REAL_TX,
      asset: BASE_USDC,
      asset_address: BASE_USDC,
      amount: REAL_AMOUNT,
      payer: REAL_PAYER,
      payee: REAL_PAYEE,
    },
    request: {
      method: "GET",
      url_hash: "84d14f74996f93224e9e9db28ff4a39b5cc45b443486a3bb2c5bf0f3546ab7d8",
      params_hash: "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a",
      ts: "2026-07-11T21:03:55Z",
    },
    response: {
      status: 200,
      body_sha256: "5545e4424324ee42fd5b739544f462a47b81f122b02ec859af986e9316fadee4",
      content_type: "application/json",
      ts: "2026-07-11T21:03:55Z",
      latency_ms: 296,
    },
    seller_agent_id: `erc8004:8453:${REAL_PAYEE}`,
    delivery: { status: "delivered" },
  });
  const signed = await signReceipt(receipt, VECTOR_SELLER_KEY);

  write("neg-settled-to-expected-solver-mismatch", {
    id: "neg-settled-to-expected-solver-mismatch",
    description:
      "Receipt claims payee = the expected solver/seller address, and delivery.status=delivered, but the mocked on-chain Transfer log (same asset/amount/chain as the PASS vector) actually moved funds to a DIFFERENT address (WRONG_SOLVER) — modeling a solver-substitution/front-running scenario where settlement happened but not to the party the receipt names. Must fail closed on the settlement predicate.",
    predicate:
      "verifySettlement(receipt,{client:mockWrongRecipient}).settled === false with an error matching /none match the receipt/",
    vectorSellerAddress: sellerAddr,
    vectorBuyerAddress: buyerAddr,
    mockOnChain: {
      status: "success",
      blockNumber: 100,
      currentBlock: 103,
      transferLog: { contract: BASE_USDC, from: REAL_PAYER, to: WRONG_SOLVER, value: REAL_AMOUNT },
    },
    receipt: signed,
  });
}

console.log("done");
