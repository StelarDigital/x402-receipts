import { encodeAbiParameters, encodeEventTopics, parseAbiItem } from "viem";
import { describe, expect, it } from "vitest";
import { buildReceipt } from "../src/receipt.js";
import { signReceipt } from "../src/sign.js";
import {
  verifyReceiptFull,
  verifySettlement,
  type SettlementClient,
  type SettlementTransaction,
  type SettlementTransactionReceipt,
} from "../src/settlement.js";
import { addressOf, makeBuyerKey, makeSellerKey, sampleInput } from "./fixtures.js";

const TRANSFER_EVENT = parseAbiItem(
  "event Transfer(address indexed from, address indexed to, uint256 value)"
);

const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

function transferLog(args: { contract: string; from: string; to: string; value: bigint }) {
  return {
    address: args.contract as `0x${string}`,
    topics: encodeEventTopics({
      abi: [TRANSFER_EVENT],
      eventName: "Transfer",
      args: { from: args.from as `0x${string}`, to: args.to as `0x${string}` },
    }),
    data: encodeAbiParameters([{ type: "uint256" }], [args.value]),
  };
}

interface MockClientOptions {
  chainId?: number;
  chainIdThrows?: boolean;
  txThrows?: boolean;
  status?: "success" | "reverted";
  blockNumber?: bigint;
  currentBlock?: bigint;
  blockNumberThrows?: boolean;
  tx?: Partial<SettlementTransaction>;
  logs?: SettlementTransactionReceipt["logs"];
}

function mockClient(opts: MockClientOptions = {}): SettlementClient {
  const chainId = opts.chainId ?? 8453;
  return {
    async getChainId() {
      if (opts.chainIdThrows) throw new Error("chain id unavailable");
      return chainId;
    },
    async getTransaction() {
      if (opts.txThrows) throw new Error("transaction not found");
      return {
        hash: `0x${"a".repeat(64)}` as `0x${string}`,
        from: "0x0000000000000000000000000000000000000001" as `0x${string}`,
        to: "0x0000000000000000000000000000000000000002" as `0x${string}`,
        value: 0n,
        ...opts.tx,
      };
    },
    async getTransactionReceipt() {
      if (opts.txThrows) throw new Error("transaction not found");
      return {
        status: opts.status ?? "success",
        blockNumber: opts.blockNumber ?? 100n,
        logs: opts.logs ?? [],
      };
    },
    async getBlockNumber() {
      if (opts.blockNumberThrows) throw new Error("block number unavailable");
      return opts.currentBlock ?? 110n;
    },
  };
}

describe("verifySettlement: ERC-20 happy path and mismatches", () => {
  it("settles true when a matching Transfer log exists", async () => {
    const sellerKey = makeSellerKey();
    const buyerKey = makeBuyerKey();
    const payer = addressOf(buyerKey);
    const payee = addressOf(sellerKey);
    const receipt = buildReceipt(
      sampleInput({ payment: { asset: "USDC", amount: "1000000", payer, payee } as any })
    );

    const client = mockClient({
      logs: [transferLog({ contract: USDC_BASE, from: payer, to: payee, value: 1000000n })],
    });

    const result = await verifySettlement(receipt, { client });
    expect(result.settled).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.confirmations).toBe(11);
  });

  it("fails when the on-chain amount does not match the receipt", async () => {
    const sellerKey = makeSellerKey();
    const buyerKey = makeBuyerKey();
    const payer = addressOf(buyerKey);
    const payee = addressOf(sellerKey);
    const receipt = buildReceipt(
      sampleInput({ payment: { asset: "USDC", amount: "1000000", payer, payee } as any })
    );

    const client = mockClient({
      logs: [transferLog({ contract: USDC_BASE, from: payer, to: payee, value: 999n })],
    });

    const result = await verifySettlement(receipt, { client });
    expect(result.settled).toBe(false);
  });

  it("fails when the on-chain from/to do not match the receipt's payer/payee", async () => {
    const sellerKey = makeSellerKey();
    const buyerKey = makeBuyerKey();
    const payer = addressOf(buyerKey);
    const payee = addressOf(sellerKey);
    const stranger = "0x9999999999999999999999999999999999999999";
    const receipt = buildReceipt(
      sampleInput({ payment: { asset: "USDC", amount: "1000000", payer, payee } as any })
    );

    const client = mockClient({
      logs: [transferLog({ contract: USDC_BASE, from: stranger, to: payee, value: 1000000n })],
    });

    const result = await verifySettlement(receipt, { client });
    expect(result.settled).toBe(false);
  });

  it("fails when the transaction is not found", async () => {
    const receipt = buildReceipt(sampleInput());
    const client = mockClient({ txThrows: true });

    const result = await verifySettlement(receipt, { client });
    expect(result.settled).toBe(false);
    expect(result.errors.some((e) => e.includes("not found"))).toBe(true);
  });

  it("fails when the transaction reverted", async () => {
    const sellerKey = makeSellerKey();
    const buyerKey = makeBuyerKey();
    const payer = addressOf(buyerKey);
    const payee = addressOf(sellerKey);
    const receipt = buildReceipt(
      sampleInput({ payment: { asset: "USDC", amount: "1000000", payer, payee } as any })
    );

    const client = mockClient({
      status: "reverted",
      logs: [transferLog({ contract: USDC_BASE, from: payer, to: payee, value: 1000000n })],
    });

    const result = await verifySettlement(receipt, { client });
    expect(result.settled).toBe(false);
    expect(result.errors.some((e) => e.includes("status"))).toBe(true);
  });

  it("fails when the RPC's actual chain_id does not match the receipt's claimed chain_id", async () => {
    const receipt = buildReceipt(sampleInput({ payment: { chain_id: 8453 } as any }));
    const client = mockClient({ chainId: 84532 });

    const result = await verifySettlement(receipt, { client });
    expect(result.settled).toBe(false);
    expect(result.errors.some((e) => e.includes("chain mismatch"))).toBe(true);
  });

  it("fails closed when the RPC's chain id can't be determined", async () => {
    const receipt = buildReceipt(sampleInput({ payment: { chain_id: 8453 } as any }));
    const client = mockClient({ chainIdThrows: true });

    const result = await verifySettlement(receipt, { client });
    expect(result.settled).toBe(false);
    expect(result.errors.some((e) => e.includes("chain id"))).toBe(true);
  });

  it("fails closed on an unrecognized chain_id with no injected client (no default RPC route)", async () => {
    const receipt = buildReceipt(sampleInput({ payment: { chain_id: 999999 } as any }));

    const result = await verifySettlement(receipt);
    expect(result.settled).toBe(false);
    expect(result.errors.some((e) => e.includes("unrecognized chain_id"))).toBe(true);
  });

  it("FIX 1 regression: rejects a raw 0x asset address not on the allowlist, even with a perfectly matching Transfer log", async () => {
    const sellerKey = makeSellerKey();
    const buyerKey = makeBuyerKey();
    const payer = addressOf(buyerKey);
    const payee = addressOf(sellerKey);
    const fakeContract = "0xFAFAFAFAFAFAFAFAFAFAFAFAFAFAFAFAFAFAFAFA";
    const receipt = buildReceipt(
      sampleInput({ payment: { asset: fakeContract, amount: "1000000", payer, payee } as any })
    );

    const client = mockClient({
      logs: [transferLog({ contract: fakeContract, from: payer, to: payee, value: 1000000n })],
    });

    const result = await verifySettlement(receipt, { client });
    expect(result.settled).toBe(false);
    expect(result.errors.some((e) => e.includes("unrecognized"))).toBe(true);
  });

  it("FIX 2 regression: fails with 1 confirmation and default minConfirmations", async () => {
    const sellerKey = makeSellerKey();
    const buyerKey = makeBuyerKey();
    const payer = addressOf(buyerKey);
    const payee = addressOf(sellerKey);
    const receipt = buildReceipt(
      sampleInput({ payment: { asset: "USDC", amount: "1000000", payer, payee } as any })
    );

    const client = mockClient({
      blockNumber: 100n,
      currentBlock: 100n, // 100 - 100 + 1 = 1 confirmation
      logs: [transferLog({ contract: USDC_BASE, from: payer, to: payee, value: 1000000n })],
    });

    const result = await verifySettlement(receipt, { client });
    expect(result.settled).toBe(false);
    expect(result.errors.some((e) => e.includes("insufficient confirmations"))).toBe(true);
  });

  it("FIX 2 regression: settles true with enough confirmations", async () => {
    const sellerKey = makeSellerKey();
    const buyerKey = makeBuyerKey();
    const payer = addressOf(buyerKey);
    const payee = addressOf(sellerKey);
    const receipt = buildReceipt(
      sampleInput({ payment: { asset: "USDC", amount: "1000000", payer, payee } as any })
    );

    const client = mockClient({
      blockNumber: 100n,
      currentBlock: 105n, // 6 confirmations >= default minConfirmations 2
      logs: [transferLog({ contract: USDC_BASE, from: payer, to: payee, value: 1000000n })],
    });

    const result = await verifySettlement(receipt, { client });
    expect(result.settled).toBe(true);
  });

  it("FIX 2 regression: fails closed when confirmations can't be determined at all", async () => {
    const sellerKey = makeSellerKey();
    const buyerKey = makeBuyerKey();
    const payer = addressOf(buyerKey);
    const payee = addressOf(sellerKey);
    const receipt = buildReceipt(
      sampleInput({ payment: { asset: "USDC", amount: "1000000", payer, payee } as any })
    );

    const client = mockClient({
      blockNumberThrows: true,
      logs: [transferLog({ contract: USDC_BASE, from: payer, to: payee, value: 1000000n })],
    });

    const result = await verifySettlement(receipt, { client });
    expect(result.settled).toBe(false);
    expect(result.errors.some((e) => e.includes("confirmations unknown"))).toBe(true);
  });

  it("native settlement is not supported and fails closed", async () => {
    const sellerKey = makeSellerKey();
    const buyerKey = makeBuyerKey();
    const payer = addressOf(buyerKey);
    const payee = addressOf(sellerKey);
    const receipt = buildReceipt(
      sampleInput({ payment: { asset: "ETH", amount: "1000000", payer, payee } as any })
    );

    const client = mockClient({
      tx: { from: payer, to: payee, value: 1000000n },
    });

    const result = await verifySettlement(receipt, { client });
    expect(result.settled).toBe(false);
    expect(result.errors.some((e) => e.includes("native settlement not supported"))).toBe(true);
  });

  it("matches addresses case-insensitively in the on-chain log vs receipt", async () => {
    const sellerKey = makeSellerKey();
    const buyerKey = makeBuyerKey();
    const payer = addressOf(buyerKey);
    const payee = addressOf(sellerKey);
    const receipt = buildReceipt(
      sampleInput({ payment: { asset: "USDC", amount: "1000000", payer, payee } as any })
    );

    const client = mockClient({
      logs: [
        transferLog({
          contract: USDC_BASE,
          from: payer.toLowerCase(),
          to: payee.toLowerCase(),
          value: 1000000n,
        }),
      ],
    });

    const result = await verifySettlement(receipt, { client });
    expect(result.settled).toBe(true);
  });
});

describe("verifyReceiptFull", () => {
  it("is valid when both signature and settlement pass", async () => {
    const sellerKey = makeSellerKey();
    const buyerKey = makeBuyerKey();
    const payer = addressOf(buyerKey);
    const payee = addressOf(sellerKey);
    const receipt = buildReceipt(
      sampleInput({ payment: { asset: "USDC", amount: "1000000", payer, payee } as any })
    );
    const signed = await signReceipt(receipt, sellerKey);

    const client = mockClient({
      logs: [transferLog({ contract: USDC_BASE, from: payer, to: payee, value: 1000000n })],
    });

    const result = await verifyReceiptFull(signed, { client });
    expect(result.valid).toBe(true);
    expect(result.settlement.settled).toBe(true);
  });

  it("is invalid when the signature is valid but settlement did not happen", async () => {
    const sellerKey = makeSellerKey();
    const buyerKey = makeBuyerKey();
    const payer = addressOf(buyerKey);
    const payee = addressOf(sellerKey);
    const receipt = buildReceipt(
      sampleInput({ payment: { asset: "USDC", amount: "1000000", payer, payee } as any })
    );
    const signed = await signReceipt(receipt, sellerKey);

    const client = mockClient({ logs: [] }); // no matching Transfer log at all

    const result = await verifyReceiptFull(signed, { client });
    expect(result.valid).toBe(false);
    expect(result.settlement.settled).toBe(false);
  });
});
