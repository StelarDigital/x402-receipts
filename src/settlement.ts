import { createPublicClient, decodeEventLog, http, parseAbiItem } from "viem";
import { base, baseSepolia } from "viem/chains";
import type { Address, Hex, Receipt } from "./receipt.js";
import { sameAddress } from "./verify.js";
import { verifyReceipt, type VerifyReceiptOptions, type VerifyReceiptResult } from "./verify.js";

/**
 * Why this file exists: a signed receipt alone is sybil-forgeable. An attacker who
 * controls both a "seller" wallet and a "buyer" wallet can produce a perfectly valid
 * signature + countersignature over a receipt whose payment.tx_hash is fabricated or
 * refers to a transaction that never happened, was reverted, or moved a different
 * amount/asset/parties than claimed. verifySettlement closes that hole by asking a
 * real Base RPC node what actually settled on-chain, and comparing it field-by-field
 * against what the receipt claims. See README "Settlement-grounded reputation".
 */

const TRANSFER_EVENT = parseAbiItem(
  "event Transfer(address indexed from, address indexed to, uint256 value)"
);

const NATIVE_ASSET_SYMBOLS = new Set(["ETH", "NATIVE"]);

/**
 * Known ERC-20 contract addresses by symbol, per chain. receipt.payment.asset may
 * also be a literal "0x..." contract address, in which case this lookup is skipped.
 * This map is intentionally small and explicit — an unrecognized symbol fails closed
 * (verifySettlement reports an error and settled:false) rather than guessing.
 */
/** Base mainnet USDC contract address, exported for callers populating `payment.asset_address` (v0.3). */
export const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as Address;

const KNOWN_ERC20_CONTRACTS: Record<string, Record<number, Address>> = {
  USDC: {
    8453: BASE_USDC, // Base mainnet
    84532: "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as Address, // Base Sepolia
  },
};

/** Chain ids this package knows a default public RPC for. Anything else fails closed. */
const KNOWN_CHAIN_IDS = new Set<number>([base.id, baseSepolia.id]);

/** Minimal shape of a chain transaction, decoupled from viem so it can be mocked in tests. */
export interface SettlementTransaction {
  hash: Hex;
  from: Address;
  to: Address | null;
  value: bigint;
}

export interface SettlementTransactionReceiptLog {
  address: Address;
  topics: Hex[];
  data: Hex;
}

/** Minimal shape of a chain transaction receipt, decoupled from viem so it can be mocked in tests. */
export interface SettlementTransactionReceipt {
  status: "success" | "reverted";
  logs: SettlementTransactionReceiptLog[];
  blockNumber: bigint;
}

/**
 * Everything verifySettlement needs from a chain node. Real usage gets this from viem's
 * createPublicClient (see createDefaultSettlementClient); tests inject a plain object
 * mock so the test suite never touches the network.
 */
export interface SettlementClient {
  /**
   * Asks the RPC endpoint itself which chain it is on (eth_chainId), rather than trusting
   * a value the caller configured. This is what makes the chain_id check on the receipt
   * meaningful instead of a tautology — see verifySettlement.
   */
  getChainId(): Promise<number>;
  getTransaction(args: { hash: Hex }): Promise<SettlementTransaction>;
  getTransactionReceipt(args: { hash: Hex }): Promise<SettlementTransactionReceipt>;
  /** Confirmations gate settlement (see minConfirmations); a failure here fails closed. */
  getBlockNumber(): Promise<bigint>;
}

export interface VerifySettlementOptions {
  /** Injectable client (tests use a mock). Defaults to a real viem client over `rpcUrl`. */
  client?: SettlementClient;
  /** Base RPC URL. Defaults to https://mainnet.base.org, or the Base Sepolia public RPC if the receipt's chain_id is 84532. */
  rpcUrl?: string;
  /**
   * Minimum block confirmations required for settled:true. Defaults to 2. If the
   * confirmation count can't be determined (e.g. getBlockNumber throws), verification
   * fails closed (settled:false) rather than treating unknown confirmations as sufficient.
   */
  minConfirmations?: number;
}

export interface VerifySettlementResult {
  settled: boolean;
  confirmations: number;
  errors: string[];
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Resolves receipt.payment.asset to a token contract address, but ONLY if it is a
 * recognized asset: either a symbol present in KNOWN_ERC20_CONTRACTS for this chain, or
 * a literal 0x address that matches one of THOSE known contract addresses. An arbitrary
 * "0xFAKE..." address that isn't in the allowlist is never accepted — a raw address is
 * not, by itself, evidence that the contract is a real, non-freely-mintable asset.
 * Accepting arbitrary contracts here would let an attacker deploy a worthless ERC-20,
 * mint freely to N sybil wallets, and claim on-chain "settlement" for each. Anything
 * unrecognized returns null and verifySettlement fails closed.
 */
function resolveAssetContract(asset: string, chainId: number): Address | null {
  const bySymbol = KNOWN_ERC20_CONTRACTS[asset.toUpperCase()]?.[chainId];
  if (bySymbol) return bySymbol;

  if (asset.startsWith("0x") && asset.length === 42) {
    for (const byChain of Object.values(KNOWN_ERC20_CONTRACTS)) {
      const known = byChain[chainId];
      if (known && sameAddress(known, asset as Address)) return known;
    }
  }

  return null;
}

interface DecodedTransfer {
  from: Address;
  to: Address;
  value: bigint;
}

/** Decodes every Transfer(address,address,uint256) log emitted by `contract`, skipping anything that doesn't decode. */
function decodeTransferLogs(
  logs: SettlementTransactionReceiptLog[],
  contract: Address
): DecodedTransfer[] {
  const out: DecodedTransfer[] = [];
  for (const log of logs) {
    if (!sameAddress(log.address, contract)) continue;
    try {
      const decoded = decodeEventLog({
        abi: [TRANSFER_EVENT],
        data: log.data,
        topics: log.topics as [Hex, ...Hex[]],
      });
      if (decoded.eventName === "Transfer") {
        out.push({
          from: decoded.args.from as Address,
          to: decoded.args.to as Address,
          value: decoded.args.value as bigint,
        });
      }
    } catch {
      // Not a Transfer event (or a differently-shaped log) on this contract — ignore.
    }
  }
  return out;
}

/** Real Base RPC client, used when no client is injected. */
function createDefaultSettlementClient(rpcUrl: string | undefined, chainId: number): SettlementClient {
  const chain = chainId === base.id ? base : chainId === baseSepolia.id ? baseSepolia : undefined;
  const defaultUrl = chainId === baseSepolia.id ? "https://sepolia.base.org" : "https://mainnet.base.org";
  const viemClient = createPublicClient({ chain, transport: http(rpcUrl ?? defaultUrl) });

  return {
    getChainId: () => viemClient.getChainId(),
    async getTransaction({ hash }) {
      const tx = await viemClient.getTransaction({ hash });
      return { hash: tx.hash, from: tx.from, to: tx.to ?? null, value: tx.value };
    },
    async getTransactionReceipt({ hash }) {
      const receipt = await viemClient.getTransactionReceipt({ hash });
      return {
        status: receipt.status,
        blockNumber: receipt.blockNumber,
        logs: receipt.logs.map((log) => ({
          address: log.address,
          topics: log.topics as Hex[],
          data: log.data,
        })),
      };
    },
    getBlockNumber: () => viemClient.getBlockNumber(),
  };
}

/**
 * Verifies that receipt.payment actually settled on-chain: the tx exists, succeeded,
 * is on the claimed chain, and its transfer (native or ERC-20) matches asset/amount/
 * payer/payee exactly. Address comparisons are case-insensitive (sameAddress).
 */
export async function verifySettlement(
  receipt: Receipt,
  options: VerifySettlementOptions = {}
): Promise<VerifySettlementResult> {
  const errors: string[] = [];

  if (!options.client && !KNOWN_CHAIN_IDS.has(receipt.payment.chain_id)) {
    errors.push(
      `unrecognized chain_id ${receipt.payment.chain_id}: no default RPC route configured for it`
    );
    return { settled: false, confirmations: 0, errors };
  }

  const client = options.client ?? createDefaultSettlementClient(options.rpcUrl, receipt.payment.chain_id);

  let actualChainId: number;
  try {
    actualChainId = await client.getChainId();
  } catch (err) {
    errors.push(`could not determine RPC's chain id: ${errorMessage(err)}`);
    return { settled: false, confirmations: 0, errors };
  }

  if (actualChainId !== receipt.payment.chain_id) {
    errors.push(
      `chain mismatch: receipt claims chain_id ${receipt.payment.chain_id}, RPC is actually on chain ${actualChainId}`
    );
    return { settled: false, confirmations: 0, errors };
  }

  let txReceipt: SettlementTransactionReceipt;
  try {
    // Both are fetched (not just the receipt) so a node that only has one of the two
    // records available still fails closed rather than half-verifying.
    [, txReceipt] = await Promise.all([
      client.getTransaction({ hash: receipt.payment.tx_hash }),
      client.getTransactionReceipt({ hash: receipt.payment.tx_hash }),
    ]);
  } catch (err) {
    errors.push(`transaction not found or not yet confirmed: ${errorMessage(err)}`);
    return { settled: false, confirmations: 0, errors };
  }

  if (txReceipt.status !== "success") {
    errors.push(`transaction did not succeed on-chain (status: ${txReceipt.status})`);
  }

  let confirmations = 0;
  let confirmationsKnown = false;
  try {
    const currentBlock = await client.getBlockNumber();
    confirmations = Math.max(0, Number(currentBlock - txReceipt.blockNumber + 1n));
    confirmationsKnown = true;
  } catch (err) {
    errors.push(`could not determine confirmations: ${errorMessage(err)}`);
  }

  const minConfirmations = options.minConfirmations ?? 2;
  if (!confirmationsKnown) {
    // Fail closed: an RPC that can't report the current head must not be treated as
    // "sufficiently confirmed" by omission.
    errors.push("confirmations unknown: failing closed");
  } else if (confirmations < minConfirmations) {
    errors.push(
      `insufficient confirmations: ${confirmations} < required ${minConfirmations}`
    );
  }

  /**
   * v0.3 asset binding: when payment.asset_address is present, it must resolve to a
   * recognized contract for the claimed chain via the same allowlist as a raw `asset`
   * address (resolveAssetContract) — an unrecognized asset_address fails closed, same
   * rationale as the unrecognized-symbol/unrecognized-address cases above.
   */
  if (receipt.payment.asset_address) {
    const recognized = resolveAssetContract(receipt.payment.asset_address, receipt.payment.chain_id);
    if (!recognized) {
      errors.push(
        `unrecognized asset_address "${receipt.payment.asset_address}" on chain ${receipt.payment.chain_id}: not a recognized contract`
      );
    }
  }

  if (NATIVE_ASSET_SYMBOLS.has(receipt.payment.asset.toUpperCase())) {
    errors.push("native settlement not supported");
  } else {
    const contract = resolveAssetContract(receipt.payment.asset, receipt.payment.chain_id);
    if (!contract) {
      errors.push(
        `unrecognized ERC-20 asset "${receipt.payment.asset}" on chain ${receipt.payment.chain_id}: cannot resolve token contract address`
      );
    } else {
      const transfers = decodeTransferLogs(txReceipt.logs, contract);
      if (transfers.length === 0) {
        errors.push("no ERC-20 Transfer log for the receipt's asset contract in this transaction");
      } else {
        const match = transfers.find(
          (t) =>
            sameAddress(t.from, receipt.payment.payer) &&
            sameAddress(t.to, receipt.payment.payee) &&
            t.value.toString() === receipt.payment.amount
        );
        if (!match) {
          const first = transfers[0];
          errors.push(
            `ERC-20 Transfer log(s) found but none match the receipt: e.g. on-chain from=${first.from} to=${first.to} value=${first.value.toString()}, receipt expects payer=${receipt.payment.payer} payee=${receipt.payment.payee} amount=${receipt.payment.amount}`
          );
        }
      }
    }
  }

  return { settled: errors.length === 0, confirmations, errors };
}

export interface VerifyReceiptFullOptions extends VerifyReceiptOptions, VerifySettlementOptions {}

export interface VerifyReceiptFullResult extends VerifyReceiptResult {
  settlement: VerifySettlementResult;
}

/**
 * The check a reputation scorer should actually call: signatures/schema/self-deal
 * (verifyReceipt) AND on-chain settlement (verifySettlement). A receipt is `valid`
 * only if both pass.
 */
export async function verifyReceiptFull(
  receipt: Receipt,
  options: VerifyReceiptFullOptions = {}
): Promise<VerifyReceiptFullResult> {
  const [receiptResult, settlement] = await Promise.all([
    verifyReceipt(receipt, options),
    verifySettlement(receipt, options),
  ]);
  return {
    valid: receiptResult.valid && settlement.settled,
    errors: [...receiptResult.errors, ...settlement.errors],
    settlement,
  };
}
