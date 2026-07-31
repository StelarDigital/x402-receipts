import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import {
  buildReceipt,
  buildMerkleTree,
  canonicalizeJCS,
  envelopeDigest,
  getProof,
  hashPaymentRequirements,
  sha256Hex,
  verifyInclusion,
} from "../dist/index.js";
import { countersignReceipt, signReceipt } from "../dist/index.js";
import { privateKeyToAccount } from "viem/accounts";

// Fixed, publicly-labeled VECTOR-ONLY signing keys (never used for any real receipt;
// these are throwaway keys generated solely to produce reproducible EIP-712 signatures
// over these fixtures, not the production seller key for the real on-chain payee below).
const VECTOR_SELLER_KEY = "0x" + "11".repeat(31) + "aa";
const VECTOR_BUYER_KEY = "0x" + "22".repeat(31) + "bb";
// A third vector-only key belonging to NO party named in the receipt — used solely to
// produce the impostor countersignature in `neg-countersig-not-payer`.
const VECTOR_IMPOSTOR_KEY = "0x" + "33".repeat(31) + "cc";
const sellerAddr = privateKeyToAccount(VECTOR_SELLER_KEY).address;
const buyerAddr = privateKeyToAccount(VECTOR_BUYER_KEY).address;
const impostorAddr = privateKeyToAccount(VECTOR_IMPOSTOR_KEY).address;

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

// ---------------------------------------------------------------------------
// Tier-2 vectors (v0.5.1): countersignature + anchor inclusion.
//
// The four vectors above all carry `buyer.countersig: null` and `anchor: null`, so a
// suite-wide PASS only ever meant "seller-signature tier". These three exercise the two
// tiers that were shipped-but-unexercised (`countersignReceipt`, `verifyInclusion` /
// `verifyAnchored`): one PASS twin that is countersigned AND anchored, and two negatives
// that fail exactly one of those two predicates each.
// ---------------------------------------------------------------------------

/** Same economic facts as the PASS vector, seller-signed with the vector-only key. */
async function buildTier2Signed() {
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
  return signReceipt(receipt, VECTOR_SELLER_KEY);
}

const MOCK_MATCHING_REAL_TX = {
  status: "success",
  blockNumber: 100,
  currentBlock: 103,
  transferLog: { contract: BASE_USDC, from: REAL_PAYER, to: REAL_PAYEE, value: REAL_AMOUNT },
};

// Sibling leaves for the anchored batches are the REAL envelope digests of the four
// vectors written above — read back off disk, never hand-written, so a canonicalization
// change to any of them changes these batches' roots too.
const SIBLING_LEAVES = [
  "neg-funded-not-delivered",
  "neg-delivered-not-settled",
  "neg-settled-to-expected-solver-mismatch",
].map((id) => envelopeDigest(JSON.parse(readFileSync(`vectors/${id}.json`, "utf8")).receipt));

// The anchor's on-chain transaction hash is SYNTHETIC: no new EAS attestation was posted
// to Base to produce these vectors (posting one is a funded, irreversible on-chain write,
// out of scope for a fixture). The merkle root, leaf and proof below are NOT synthetic —
// they are the real output of buildMerkleTree/getProof over real envelope digests.
const SYNTHETIC_ANCHOR_TX = "0x" + "a5".repeat(32);

// ---------------------------------------------------------------------------
// PASS (tier 2): countersigned AND anchored.
// ---------------------------------------------------------------------------
{
  const signed = await buildTier2Signed();
  const countersigned = await countersignReceipt(signed, VECTOR_BUYER_KEY);

  // The merkle leaf is the envelope digest of the receipt in its PRE-ANCHOR state: the
  // anchor block cannot commit to a root computed over a digest that already contains
  // that root. See SPEC.md §8.
  const anchoredLeaf = envelopeDigest(countersigned);
  const leafIndex = 1;
  const leaves = [SIBLING_LEAVES[0], anchoredLeaf, SIBLING_LEAVES[1], SIBLING_LEAVES[2]];
  const tree = buildMerkleTree(leaves);
  const proof = getProof(tree, leafIndex);
  if (!verifyInclusion(anchoredLeaf, proof, tree.root)) {
    throw new Error("generator invariant broken: PASS twin's leaf is not in its own root");
  }

  const anchored = {
    ...countersigned,
    anchor: {
      batch_merkle_root: `0x${tree.root}`,
      base_tx: SYNTHETIC_ANCHOR_TX,
      leaf_index: leafIndex,
    },
  };

  write("pass-countersigned-anchored", {
    id: "pass-countersigned-anchored",
    description:
      "PASS twin of pass-settled-delivered at the next trust tier: same real settled Base mainnet USDC transfer, same delivered status, but buyer.countersig is populated (produced by the vector-only buyer key over the exact seller-signed receipt) AND anchor is populated with a real RFC-6962 merkle root/inclusion proof over real envelope digests. anchor.base_tx is SYNTHETIC — no EAS attestation was posted on-chain to build this fixture — and the anchor is an existence/ordering bound only, never an independent attestation of the receipt's truth (SPEC.md §6.1).",
    predicate:
      "verifyReceipt(receipt,{sellerAddress:vectorSellerAddress,buyerAddress:vectorBuyerAddress,requireCountersig:true}).valid === true AND verifySettlement(receipt,{client:mockMatchingRealTx}).settled === true AND verifyInclusion(anchoredLeaf,merkleProof,anchor.batch_merkle_root) === true",
    vectorSellerAddress: sellerAddr,
    vectorBuyerAddress: buyerAddr,
    mockOnChain: MOCK_MATCHING_REAL_TX,
    anchoredLeaf,
    merkleProof: proof,
    batchLeaves: leaves,
    receipt: anchored,
  });
}

// ---------------------------------------------------------------------------
// NEGATIVE 4: countersignature by a key that is NOT payment.payer.
// ---------------------------------------------------------------------------
{
  const signed = await buildTier2Signed();
  const countersigned = await countersignReceipt(signed, VECTOR_IMPOSTOR_KEY);

  write("neg-countersig-not-payer", {
    id: "neg-countersig-not-payer",
    description:
      "Identical to the PASS twin except buyer.countersig was produced by a third vector-only key belonging to NO party named in the receipt (vectorImpostorAddress) — modeling a relayer or bystander attaching an acceptance signature the buyer never gave. The countersignature is a real, well-formed EIP-712 signature; it simply does not recover to the expected buyer. Must fail closed against BOTH the expected buyer address and the default (payment.payer).",
    predicate:
      "verifyReceipt(receipt,{sellerAddress:vectorSellerAddress,buyerAddress:vectorBuyerAddress}).valid === false with an error matching /buyer countersignature invalid/; same with the default buyerAddress (payment.payer)",
    vectorSellerAddress: sellerAddr,
    vectorBuyerAddress: buyerAddr,
    vectorImpostorAddress: impostorAddr,
    mockOnChain: MOCK_MATCHING_REAL_TX,
    receipt: countersigned,
  });
}

// ---------------------------------------------------------------------------
// NEGATIVE 5: leaf absent from the anchored root.
// ---------------------------------------------------------------------------
{
  const signed = await buildTier2Signed();
  const countersigned = await countersignReceipt(signed, VECTOR_BUYER_KEY);
  const absentLeaf = envelopeDigest(countersigned);

  // A batch this receipt is genuinely NOT part of: every leaf is some other receipt's
  // real envelope digest.
  const decoyLeaf = envelopeDigest(
    JSON.parse(readFileSync("vectors/pass-settled-delivered.json", "utf8")).receipt
  );
  const leafIndex = 1;
  const leaves = [SIBLING_LEAVES[0], decoyLeaf, SIBLING_LEAVES[1], SIBLING_LEAVES[2]];
  const tree = buildMerkleTree(leaves);
  const proof = getProof(tree, leafIndex);

  // The proof itself is genuine — it verifies for the leaf actually at that index. What
  // fails is this receipt's claim to be that leaf.
  if (!verifyInclusion(decoyLeaf, proof, tree.root)) {
    throw new Error("generator invariant broken: decoy leaf is not in its own root");
  }
  if (verifyInclusion(absentLeaf, proof, tree.root)) {
    throw new Error("generator invariant broken: absent leaf verified against the root");
  }

  const anchored = {
    ...countersigned,
    anchor: {
      batch_merkle_root: `0x${tree.root}`,
      base_tx: SYNTHETIC_ANCHOR_TX,
      leaf_index: leafIndex,
    },
  };

  write("neg-leaf-not-in-anchored-root", {
    id: "neg-leaf-not-in-anchored-root",
    description:
      "The receipt is correctly signed, correctly countersigned, and points at an anchored batch — but its envelope digest is NOT one of that batch's leaves. The supplied inclusion proof is a genuine proof for the OTHER receipt that actually occupies leaf_index 1 (assertable: verifyInclusion(decoyLeaf,proof,root) === true), so the failure isolates the inclusion predicate itself rather than a malformed proof. Models a seller attaching a real anchor to a receipt that was never in the anchored batch.",
    predicate:
      "verifyInclusion(anchoredLeaf,merkleProof,anchor.batch_merkle_root) === false AND verifyAnchored(preAnchorReceipt,merkleProof,anchor.batch_merkle_root) === false, while verifyInclusion(decoyLeaf,merkleProof,root) === true",
    vectorSellerAddress: sellerAddr,
    vectorBuyerAddress: buyerAddr,
    mockOnChain: MOCK_MATCHING_REAL_TX,
    anchoredLeaf: absentLeaf,
    decoyLeaf,
    merkleProof: proof,
    batchLeaves: leaves,
    receipt: anchored,
  });
}

console.log("done");
