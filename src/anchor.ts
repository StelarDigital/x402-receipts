import { createPublicClient, createWalletClient, encodeAbiParameters, http, keccak256, encodePacked } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base, baseSepolia } from "viem/chains";
import type { Address, Hex, Receipt } from "./receipt.js";
import { receiptDigest } from "./receipt.js";
import { buildMerkleTree } from "./merkle.js";

/**
 * M2b: on-chain anchor posting via EAS (Ethereum Attestation Service) on Base.
 *
 * Why EAS and not a bespoke contract or ERC-8004: ERC-8004 explicitly forbids an agent
 * self-anchoring its own reputation data. EAS is a neutral, already-deployed attestation
 * registry (an OP-stack predeploy on Base and Base Sepolia, so no deployment step or
 * contract audit of our own is required) that gives every anchor a public, timestamped,
 * queryable UID for free via base.easscan.org — see README "On-chain anchoring".
 *
 * Anchoring a batch's merkle root here proves ONLY that this root was committed
 * on-chain at this time by this wallet. It does not, by itself, prove any receipt in
 * the batch settled — that is verifySettlement's job (src/settlement.ts). Treat an
 * anchor as a public commitment/timestamp, not a settlement proof.
 */

/** OP-stack predeploy address, identical on Base mainnet (8453) and Base Sepolia (84532). */
export const EAS_ADDRESS = "0x4200000000000000000000000000000000000021" as Address;
/** OP-stack predeploy address, identical on Base mainnet (8453) and Base Sepolia (84532). */
export const SCHEMA_REGISTRY_ADDRESS = "0x4200000000000000000000000000000000000020" as Address;

/** The schema this library registers/anchors against. Register once per network. */
export const ANCHOR_SCHEMA =
  "uint256 agentId,bytes32 merkleRoot,uint64 receiptCount,uint64 periodStart,uint64 periodEnd,string receiptsURI";

/** encodeAbiParameters/decodeAbiParameters shape for ANCHOR_SCHEMA's 6 fields, in order. */
export const ANCHOR_SCHEMA_PARAMS = [
  { name: "agentId", type: "uint256" },
  { name: "merkleRoot", type: "bytes32" },
  { name: "receiptCount", type: "uint64" },
  { name: "periodStart", type: "uint64" },
  { name: "periodEnd", type: "uint64" },
  { name: "receiptsURI", type: "string" },
] as const;

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as Address;
const ZERO_BYTES32 = `0x${"0".repeat(64)}` as Hex;

const SCHEMA_REGISTRY_ABI = [
  {
    type: "function",
    name: "register",
    stateMutability: "nonpayable",
    inputs: [
      { name: "schema", type: "string" },
      { name: "resolver", type: "address" },
      { name: "revocable", type: "bool" },
    ],
    outputs: [{ name: "", type: "bytes32" }],
  },
] as const;

const EAS_ABI = [
  {
    type: "function",
    name: "attest",
    stateMutability: "payable",
    inputs: [
      {
        name: "request",
        type: "tuple",
        components: [
          { name: "schema", type: "bytes32" },
          {
            name: "data",
            type: "tuple",
            components: [
              { name: "recipient", type: "address" },
              { name: "expirationTime", type: "uint64" },
              { name: "revocable", type: "bool" },
              { name: "refUID", type: "bytes32" },
              { name: "data", type: "bytes" },
              { name: "value", type: "uint256" },
            ],
          },
        ],
      },
    ],
    outputs: [{ name: "", type: "bytes32" }],
  },
] as const;

/**
 * Minimal shape of what registerSchema/anchorBatch need from a wallet, decoupled from
 * viem so tests can inject a plain mock (no network calls in the test suite). Mirrors
 * the simulate-then-write pattern viem itself uses: simulateContract performs an
 * eth_call against the not-yet-mined state and returns the function's return value
 * (the schema/attestation UID) plus a prepared request; writeContract then actually
 * submits that request as a transaction. Both steps are required because the UID is a
 * return value, not something recoverable from a transaction hash alone.
 */
export interface AnchorWalletClient {
  simulateContract(args: {
    address: Address;
    abi: readonly unknown[];
    functionName: string;
    args: readonly unknown[];
  }): Promise<{ result: unknown; request: unknown }>;
  writeContract(request: unknown): Promise<Hex>;
}

export interface CreateAnchorWalletClientOptions {
  rpcUrl: string;
  privateKey: Hex;
  /** Defaults to Base mainnet (8453). Pass 84532 for Base Sepolia. */
  chainId?: number;
}

/**
 * Builds a real viem-backed AnchorWalletClient. Only ever constructed lazily — i.e.
 * only when registerSchema/anchorBatch are called WITHOUT an injected client — so it
 * never runs (and never needs network access) in the test suite.
 */
export function createAnchorWalletClient(opts: CreateAnchorWalletClientOptions): AnchorWalletClient {
  const chain = opts.chainId === baseSepolia.id ? baseSepolia : base;
  const account = privateKeyToAccount(opts.privateKey);
  const transport = http(opts.rpcUrl);
  const publicClient = createPublicClient({ chain, transport });
  const walletClient = createWalletClient({ account, chain, transport });

  return {
    async simulateContract(args) {
      const { result, request } = await publicClient.simulateContract({ ...args, account });
      return { result, request };
    },
    async writeContract(request) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return walletClient.writeContract(request as any);
    },
  };
}

/**
 * schemaUID is deterministic: keccak256(abi.encodePacked(schema, resolver, revocable)).
 * Registering the same (schema, resolver, revocable) tuple twice does not mint a new
 * UID — the SchemaRegistry contract reverts with AlreadyExists() on a duplicate
 * register() call. Computing the UID locally lets registerSchema recover it without a
 * second network round-trip when that revert happens (see registerSchema below).
 */
function computeSchemaUID(schema: string, resolver: Address, revocable: boolean): Hex {
  return keccak256(encodePacked(["string", "address", "bool"], [schema, resolver, revocable]));
}

export interface RegisterSchemaOptions {
  /** Defaults to ANCHOR_SCHEMA. */
  schema?: string;
  /** Defaults to the zero address (no resolver). */
  resolver?: Address;
  /** Defaults to true. */
  revocable?: boolean;
  schemaRegistryAddress?: Address;
  /** Used only to lazily build a default client when no `walletClient` is passed. */
  rpcUrl?: string;
  privateKey?: Hex;
  chainId?: number;
}

/**
 * Registers ANCHOR_SCHEMA (or a caller-supplied schema string) with the EAS
 * SchemaRegistry and returns its schemaUID. Idempotent-safe: if the schema is already
 * registered, the contract call reverts (AlreadyExists) rather than returning a fresh
 * UID — that revert is caught here and the deterministic UID is computed locally
 * instead of surfacing an error, so calling registerSchema twice is always safe.
 */
export async function registerSchema(
  walletClient: AnchorWalletClient | undefined,
  opts: RegisterSchemaOptions = {}
): Promise<Hex> {
  const schema = opts.schema ?? ANCHOR_SCHEMA;
  const resolver = opts.resolver ?? ZERO_ADDRESS;
  const revocable = opts.revocable ?? true;
  const client = walletClient ?? createAnchorWalletClient(requireLazyClientOptions(opts));

  try {
    const { result, request } = await client.simulateContract({
      address: opts.schemaRegistryAddress ?? SCHEMA_REGISTRY_ADDRESS,
      abi: SCHEMA_REGISTRY_ABI,
      functionName: "register",
      args: [schema, resolver, revocable],
    });
    await client.writeContract(request);
    return result as Hex;
  } catch (err) {
    // Already registered: the SchemaRegistry contract reverts (AlreadyExists) on a
    // duplicate register() call rather than returning the existing UID. The UID is a
    // pure function of (schema, resolver, revocable), so recover it locally instead of
    // surfacing this as an error — this is what makes registerSchema idempotent-safe.
    // Only swallow the AlreadyExists revert; a transient RPC/gas failure on a genuine
    // first-ever registration must propagate loudly, not report false success.
    const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
    if (msg.includes("alreadyexists") || msg.includes("already exists")) {
      return computeSchemaUID(schema, resolver, revocable);
    }
    throw err;
  }
}

export interface AnchorBatchInput {
  agentId: bigint;
  merkleRoot: Hex;
  receiptCount: bigint;
  periodStart: bigint;
  periodEnd: bigint;
  receiptsURI: string;
  /** UID of the previous anchor in this agent's chain, or omitted/zero for the first anchor. */
  refUID?: Hex;
}

export interface AnchorBatchOptions {
  easAddress?: Address;
  /** Used only to lazily build a default client when no `walletClient` is passed. */
  rpcUrl?: string;
  privateKey?: Hex;
  chainId?: number;
}

function requireLazyClientOptions(opts: { rpcUrl?: string; privateKey?: Hex; chainId?: number }): CreateAnchorWalletClientOptions {
  if (!opts.rpcUrl || !opts.privateKey) {
    throw new Error(
      "no walletClient was injected and no { rpcUrl, privateKey } was provided to construct a default one"
    );
  }
  return { rpcUrl: opts.rpcUrl, privateKey: opts.privateKey, chainId: opts.chainId };
}

/** Encodes the 6 ANCHOR_SCHEMA fields as EAS attestation `data`, in schema-declared order. */
export function encodeAnchorData(input: Omit<AnchorBatchInput, "refUID">): Hex {
  return encodeAbiParameters(ANCHOR_SCHEMA_PARAMS, [
    input.agentId,
    input.merkleRoot,
    input.receiptCount,
    input.periodStart,
    input.periodEnd,
    input.receiptsURI,
  ]);
}

/**
 * Attests a batch anchor (merkle root + period + receipt count) via EAS.attest() and
 * returns the attestationUID. recipient is always the zero address (this is a
 * self-published log commitment, not addressed to a counterparty); refUID chains this
 * anchor to the previous one for the same agent, so an anchor's history can be walked
 * back through EAS without any off-chain index.
 */
export async function anchorBatch(
  walletClient: AnchorWalletClient | undefined,
  params: { schemaUID: Hex } & AnchorBatchInput,
  opts: AnchorBatchOptions = {}
): Promise<Hex> {
  const client = walletClient ?? createAnchorWalletClient(requireLazyClientOptions(opts));
  const data = encodeAnchorData(params);

  const request = {
    schema: params.schemaUID,
    data: {
      recipient: ZERO_ADDRESS,
      expirationTime: 0n,
      revocable: true,
      refUID: params.refUID ?? ZERO_BYTES32,
      data,
      value: 0n,
    },
  };

  const { result, request: writeRequest } = await client.simulateContract({
    address: opts.easAddress ?? EAS_ADDRESS,
    abi: EAS_ABI,
    functionName: "attest",
    args: [request],
  });

  await client.writeContract(writeRequest);
  return result as Hex;
}

export interface BuildAnchorFromLedgerOptions {
  agentId: bigint;
  /** Where the full receipt batch (not just the root) can be fetched/verified against. */
  receiptsURI: string;
}

/**
 * Pure helper (no network calls): given a batch of already-verified receipts, computes
 * the RFC-6962 merkle root (src/merkle.ts) over their digests, the receipt count, and
 * the period bounds (min/max response.ts across the batch), and returns the
 * anchorBatch input for that batch (minus schemaUID/refUID, which the caller supplies —
 * refUID because it depends on chain state this function never touches).
 */
export function buildAnchorFromLedger(
  receipts: Receipt[],
  opts: BuildAnchorFromLedgerOptions
): Omit<AnchorBatchInput, "refUID"> {
  if (receipts.length === 0) {
    throw new Error("buildAnchorFromLedger: cannot build an anchor batch from zero receipts");
  }

  const leaves = receipts.map(receiptDigest);
  const tree = buildMerkleTree(leaves);

  const timestampsMs = receipts.map((receipt) => Date.parse(receipt.response.ts));
  const periodStartMs = Math.min(...timestampsMs);
  const periodEndMs = Math.max(...timestampsMs);

  return {
    agentId: opts.agentId,
    merkleRoot: `0x${tree.root}` as Hex,
    receiptCount: BigInt(receipts.length),
    periodStart: BigInt(Math.floor(periodStartMs / 1000)),
    periodEnd: BigInt(Math.floor(periodEndMs / 1000)),
    receiptsURI: opts.receiptsURI,
  };
}
