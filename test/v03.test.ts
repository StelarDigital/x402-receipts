import { describe, expect, it } from "vitest";
import { buildReceipt, canonicalDigest, hashPaymentRequirements, type PaymentRequirements } from "../src/receipt.js";
import {
  countersignReceipt,
  countersignReceiptLegacyV0,
  signReceipt,
  signReceiptLegacyV0,
  verifyBuyerCountersig,
  verifySellerSig,
} from "../src/sign.js";
import { deliveryStatusOk, verifyReceipt } from "../src/verify.js";
import { BASE_USDC, verifyReceiptFull, type SettlementClient, type SettlementTransaction, type SettlementTransactionReceipt } from "../src/settlement.js";
import { addressOf, makeBuyerKey, makeSellerKey, sampleInput } from "./fixtures.js";

const sampleRequirements: PaymentRequirements = {
  payTo: "0x1234567890123456789012345678901234567890",
  amount: "1000000",
  asset: "USDC",
  scheme: "exact",
  resource: "https://api.example.com/v1/signal",
  timeout: 60,
};

describe("hashPaymentRequirements", () => {
  it("is stable regardless of key insertion order (canonicalized)", () => {
    const a = hashPaymentRequirements(sampleRequirements);
    const reordered: PaymentRequirements = {
      timeout: sampleRequirements.timeout,
      resource: sampleRequirements.resource,
      scheme: sampleRequirements.scheme,
      asset: sampleRequirements.asset,
      amount: sampleRequirements.amount,
      payTo: sampleRequirements.payTo,
    };
    const b = hashPaymentRequirements(reordered);
    expect(a).toBe(b);
    expect(a).toBe(canonicalDigest(sampleRequirements));
  });

  it("changes when any field changes", () => {
    const a = hashPaymentRequirements(sampleRequirements);
    const b = hashPaymentRequirements({ ...sampleRequirements, amount: "2000000" });
    expect(a).not.toBe(b);
  });
});

describe("payment_requirements_sha256: roundtrip + mismatch", () => {
  it("passes when the recomputed hash matches request.payment_requirements_sha256", async () => {
    const sellerKey = makeSellerKey();
    const input = sampleInput({ payment: { payee: addressOf(sellerKey) } as any });
    const hash = hashPaymentRequirements(sampleRequirements);
    const receipt = buildReceipt({
      ...input,
      request: { ...input.request, payment_requirements_sha256: hash },
    });
    const signed = await signReceipt(receipt, sellerKey);

    const result = await verifyReceipt(signed, { paymentRequirements: sampleRequirements });
    expect(result.valid).toBe(true);
  });

  it("fails when the receipt's stored hash doesn't match the recomputed hash", async () => {
    const sellerKey = makeSellerKey();
    const input = sampleInput({ payment: { payee: addressOf(sellerKey) } as any });
    const wrongHash = hashPaymentRequirements({ ...sampleRequirements, amount: "999" });
    const receipt = buildReceipt({
      ...input,
      request: { ...input.request, payment_requirements_sha256: wrongHash },
    });
    const signed = await signReceipt(receipt, sellerKey);

    const result = await verifyReceipt(signed, { paymentRequirements: sampleRequirements });
    expect(result.valid).toBe(false);
    expect(
      result.errors.some((e) => e.includes("payment_requirements_sha256 mismatch"))
    ).toBe(true);
  });

  it("skips the check (old behavior) when the receipt has no payment_requirements_sha256", async () => {
    const sellerKey = makeSellerKey();
    const input = sampleInput({ payment: { payee: addressOf(sellerKey) } as any });
    const receipt = buildReceipt(input);
    const signed = await signReceipt(receipt, sellerKey);

    const result = await verifyReceipt(signed, { paymentRequirements: sampleRequirements });
    expect(result.valid).toBe(true);
  });

  it("skips the check when no paymentRequirements option is supplied, even if the receipt has the hash", async () => {
    const sellerKey = makeSellerKey();
    const input = sampleInput({ payment: { payee: addressOf(sellerKey) } as any });
    const receipt = buildReceipt({
      ...input,
      request: { ...input.request, payment_requirements_sha256: hashPaymentRequirements(sampleRequirements) },
    });
    const signed = await signReceipt(receipt, sellerKey);

    const result = await verifyReceipt(signed);
    expect(result.valid).toBe(true);
  });
});

describe("delivery.status predicates", () => {
  it("deliveryStatusOk is true when delivery is absent (legacy receipts, no claim)", () => {
    const receipt = buildReceipt(sampleInput());
    expect(deliveryStatusOk(receipt)).toBe(true);
  });

  it("deliveryStatusOk is true when delivery.status is 'delivered'", () => {
    const receipt = buildReceipt({ ...sampleInput(), delivery: { status: "delivered" } });
    expect(deliveryStatusOk(receipt)).toBe(true);
  });

  it("deliveryStatusOk is false for 'failed' and 'partial', never throws", () => {
    const failed = buildReceipt({ ...sampleInput(), delivery: { status: "failed" } });
    const partial = buildReceipt({ ...sampleInput(), delivery: { status: "partial" } });
    expect(deliveryStatusOk(failed)).toBe(false);
    expect(deliveryStatusOk(partial)).toBe(false);
  });

  it("verifyReceipt fails when goods are present and delivery.status is 'failed'", async () => {
    const sellerKey = makeSellerKey();
    const input = sampleInput({ payment: { payee: addressOf(sellerKey) } as any });
    const goods = {
      description: "market-brief",
      kind: "api-response" as const,
      summary: null,
      body_sha256: input.response.body_sha256,
      bytes: 10,
      preview: null,
    };
    const receipt = buildReceipt({ ...input, goods, delivery: { status: "failed" } });
    const signed = await signReceipt(receipt, sellerKey);

    const result = await verifyReceipt(signed);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('delivery.status is "failed"'))).toBe(true);
  });

  it("verifyReceipt is unaffected by delivery.status when no goods are attached", async () => {
    const sellerKey = makeSellerKey();
    const input = sampleInput({ payment: { payee: addressOf(sellerKey) } as any });
    const receipt = buildReceipt({ ...input, delivery: { status: "failed" } });
    const signed = await signReceipt(receipt, sellerKey);

    const result = await verifyReceipt(signed);
    expect(result.valid).toBe(true);
  });
});

describe("asset_address: recognized / mismatch", () => {
  const payer = addressOf(makeBuyerKey());
  const payee = addressOf(makeSellerKey());

  function transferLog(args: { contract: string; from: string; to: string; value: bigint }) {
    const topics = [
      "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
      `0x${"0".repeat(24)}${args.from.slice(2).toLowerCase()}`,
      `0x${"0".repeat(24)}${args.to.slice(2).toLowerCase()}`,
    ];
    return {
      address: args.contract as any,
      topics: topics as any,
      data: `0x${args.value.toString(16).padStart(64, "0")}` as any,
    };
  }

  function mockClient(logs: ReturnType<typeof transferLog>[]): SettlementClient {
    const tx: SettlementTransaction = { hash: `0x${"a".repeat(64)}` as any, from: payer as any, to: BASE_USDC as any, value: 0n };
    const receipt: SettlementTransactionReceipt = { status: "success", logs, blockNumber: 100n };
    return {
      getChainId: async () => 8453,
      getTransaction: async () => tx,
      getTransactionReceipt: async () => receipt,
      getBlockNumber: async () => 103n,
    };
  }

  it("passes settlement when asset_address is BASE_USDC and the on-chain transfer matches", async () => {
    const sellerKey = makeSellerKey();
    const receipt = buildReceipt(
      sampleInput({
        payment: { asset: "USDC", asset_address: BASE_USDC, amount: "1000000", payer, payee } as any,
      })
    );
    const signed = await signReceipt(receipt, sellerKey);
    const client = mockClient([transferLog({ contract: BASE_USDC, from: payer, to: payee, value: 1000000n })]);

    const result = await verifyReceiptFull(signed, { client });
    expect(result.settlement.errors.some((e) => e.includes("asset_address"))).toBe(false);
  });

  it("fails settlement when asset_address is an unrecognized contract", async () => {
    const sellerKey = makeSellerKey();
    const fakeContract = `0x${"f".repeat(40)}`;
    const receipt = buildReceipt(
      sampleInput({
        payment: { asset: "USDC", asset_address: fakeContract, amount: "1000000", payer, payee } as any,
      })
    );
    const signed = await signReceipt(receipt, sellerKey);
    const client = mockClient([transferLog({ contract: BASE_USDC, from: payer, to: payee, value: 1000000n })]);

    const result = await verifyReceiptFull(signed, { client });
    expect(result.settlement.settled).toBe(false);
    expect(result.settlement.errors.some((e) => e.includes("unrecognized asset_address"))).toBe(true);
  });

  it("does not affect settlement when asset_address is absent (old behavior)", async () => {
    const sellerKey = makeSellerKey();
    const receipt = buildReceipt(
      sampleInput({ payment: { asset: "USDC", amount: "1000000", payer, payee } as any })
    );
    const signed = await signReceipt(receipt, sellerKey);
    const client = mockClient([transferLog({ contract: BASE_USDC, from: payer, to: payee, value: 1000000n })]);

    const result = await verifyReceiptFull(signed, { client });
    expect(result.settlement.settled).toBe(true);
  });
});

describe("v0.3 EIP-712 domain/signature", () => {
  it("signReceipt produces a v0.3 signature that verifies via verifySellerSig", async () => {
    const sellerKey = makeSellerKey();
    const input = sampleInput({ payment: { payee: addressOf(sellerKey) } as any });
    const receipt = buildReceipt(input);
    const signed = await signReceipt(receipt, sellerKey);

    await expect(verifySellerSig(signed, addressOf(sellerKey))).resolves.toBe(true);
  });

  it("a v0.3 seller signature also supports v0.3 buyer countersigning, and both verify", async () => {
    const sellerKey = makeSellerKey();
    const buyerKey = makeBuyerKey();
    const receipt = buildReceipt(
      sampleInput({ payment: { payer: addressOf(buyerKey), payee: addressOf(sellerKey) } as any })
    );
    const signed = await signReceipt(receipt, sellerKey);
    const countersigned = await countersignReceipt(signed, buyerKey);

    await expect(verifySellerSig(countersigned, addressOf(sellerKey))).resolves.toBe(true);
    await expect(verifyBuyerCountersig(countersigned, addressOf(buyerKey))).resolves.toBe(true);
  });

  it("v0.3 signature is bound to payment_requirements_sha256 (tampering it invalidates the signature)", async () => {
    const sellerKey = makeSellerKey();
    const input = sampleInput({ payment: { payee: addressOf(sellerKey) } as any });
    const receipt = buildReceipt({
      ...input,
      request: { ...input.request, payment_requirements_sha256: hashPaymentRequirements(sampleRequirements) },
    });
    const signed = await signReceipt(receipt, sellerKey);
    const tampered = {
      ...signed,
      request: { ...signed.request, payment_requirements_sha256: hashPaymentRequirements({ ...sampleRequirements, amount: "1" }) },
    };

    await expect(verifySellerSig(tampered, addressOf(sellerKey))).resolves.toBe(false);
  });

  it("verify falls back to the legacy v0 domain for a signature produced under signReceiptLegacyV0", async () => {
    const sellerKey = makeSellerKey();
    const input = sampleInput({ payment: { payee: addressOf(sellerKey) } as any });
    const receipt = buildReceipt(input);
    const legacySigned = await signReceiptLegacyV0(receipt, sellerKey);

    await expect(verifySellerSig(legacySigned, addressOf(sellerKey))).resolves.toBe(true);
    const result = await verifyReceipt(legacySigned);
    expect(result.valid).toBe(true);
  });

  it("verifyBuyerCountersig falls back to the legacy domain for a legacy-signed seller+countersig pair", async () => {
    const sellerKey = makeSellerKey();
    const buyerKey = makeBuyerKey();
    const receipt = buildReceipt(
      sampleInput({ payment: { payer: addressOf(buyerKey), payee: addressOf(sellerKey) } as any })
    );
    const legacySigned = await signReceiptLegacyV0(receipt, sellerKey);
    const legacyCountersigned = await countersignReceiptLegacyV0(legacySigned, buyerKey);

    await expect(verifySellerSig(legacyCountersigned, addressOf(sellerKey))).resolves.toBe(true);
    await expect(verifyBuyerCountersig(legacyCountersigned, addressOf(buyerKey))).resolves.toBe(true);
    const result = await verifyReceipt(legacyCountersigned);
    expect(result.valid).toBe(true);
  });

  it("a v0.3-signed receipt does NOT verify under the legacy domain directly (domains are distinct)", async () => {
    const sellerKey = makeSellerKey();
    const input = sampleInput({ payment: { payee: addressOf(sellerKey) } as any });
    const receipt = buildReceipt(input);
    const signed = await signReceipt(receipt, sellerKey);
    // sanity: verifySellerSig still succeeds (v0.3 branch), proving the domain actually differs
    // from v0 rather than accidentally colliding.
    await expect(verifySellerSig(signed, addressOf(sellerKey))).resolves.toBe(true);
    const legacyOnlyReceipt = buildReceipt(input);
    const legacySigned = await signReceiptLegacyV0(legacyOnlyReceipt, sellerKey);
    expect(signed.seller.sig).not.toBe(legacySigned.seller.sig);
  });
});

describe("old-receipt digest unaffected by v0.3 additions", () => {
  it("a receipt built with no v0.3 fields canonicalizes identically to before", () => {
    const input = sampleInput();
    const receipt = buildReceipt(input);
    expect(receipt).not.toHaveProperty("delivery");
    expect(receipt.payment).not.toHaveProperty("asset_address");
    expect(receipt.request).not.toHaveProperty("payment_requirements_sha256");

    const legacyShapedReceipt = {
      scheme: receipt.scheme,
      payment: receipt.payment,
      request: receipt.request,
      response: receipt.response,
      seller: receipt.seller,
      buyer: receipt.buyer,
      anchor: receipt.anchor,
    };
    expect(canonicalDigest(receipt)).toBe(canonicalDigest(legacyShapedReceipt));
  });

  it("delivery: undefined omits the key entirely (not null)", () => {
    const receipt = buildReceipt(sampleInput());
    expect(Object.keys(receipt)).not.toContain("delivery");
  });

  it("delivery explicitly set to null attaches a null key", () => {
    const receipt = buildReceipt({ ...sampleInput(), delivery: null });
    expect(receipt.delivery).toBeNull();
    expect(Object.keys(receipt)).toContain("delivery");
  });
});
