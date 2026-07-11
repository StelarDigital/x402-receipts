import { describe, expect, it, vi } from "vitest";
import {
  momentToEmailHTML,
  momentToMarkdown,
  momentToText,
  renderMoment,
  sendDiscord,
  sendSlack,
  sendTelegram,
  sendWebhook,
  type Moment,
} from "../src/notify.js";
import { sampleReceipt } from "./fixtures.js";

function receiptWithAmount(amountBaseUnits: string, overrides: Record<string, unknown> = {}) {
  return sampleReceipt({
    payment: { amount: amountBaseUnits, ...overrides } as any,
  });
}

describe("renderMoment: drama tiers", () => {
  it("$0.99 -> spark", () => {
    expect(renderMoment(receiptWithAmount("990000")).tier).toBe("spark");
  });
  it("$1.00 -> fire", () => {
    expect(renderMoment(receiptWithAmount("1000000")).tier).toBe("fire");
  });
  it("$9.99 -> fire", () => {
    expect(renderMoment(receiptWithAmount("9990000")).tier).toBe("fire");
  });
  it("$10.00 -> gold", () => {
    expect(renderMoment(receiptWithAmount("10000000")).tier).toBe("gold");
  });
  it("$99.99 -> gold", () => {
    expect(renderMoment(receiptWithAmount("99990000")).tier).toBe("gold");
  });
  it("$100.00 -> diamond", () => {
    expect(renderMoment(receiptWithAmount("100000000")).tier).toBe("diamond");
  });

  it("sets the title matching the tier", () => {
    expect(renderMoment(receiptWithAmount("990000")).title).toBe("⚡ AGENT SALE");
    expect(renderMoment(receiptWithAmount("1000000")).title).toBe("🔥 AGENT SALE");
    expect(renderMoment(receiptWithAmount("10000000")).title).toBe("💰 BIG AGENT SALE");
    expect(renderMoment(receiptWithAmount("100000000")).title).toBe("💎🚀 HUGE AGENT SALE");
  });
});

describe("renderMoment: lines", () => {
  it("renders the real-production first-sale example", () => {
    const receipt = receiptWithAmount("5000"); // $0.005
    const moment = renderMoment(receipt, { productName: "live P&L telemetry" });
    expect(moment.lines[0]).toBe("Your agent just sold live P&L telemetry to an AI agent");
    expect(moment.lines[1]).toBe("+0.005 USDC — settled on Base ✓");
  });

  it("defaults productName and sellerName when not given", () => {
    const moment = renderMoment(receiptWithAmount("1000000"));
    expect(moment.lines[0]).toBe("Your agent just sold a paid API call to an AI agent");
  });

  it("respects a custom sellerName", () => {
    const moment = renderMoment(receiptWithAmount("1000000"), { sellerName: "Stelar" });
    expect(moment.lines[0]).toBe("Stelar just sold a paid API call to an AI agent");
  });

  it("appends a lifetime line when opts.lifetime is provided", () => {
    const moment = renderMoment(receiptWithAmount("1000000"), {
      lifetime: { totalUsd: 12.5, count: 7 },
    });
    expect(moment.lines).toContain("Lifetime: $12.5 across 7 sales");
  });

  it("omits the lifetime line when not provided", () => {
    const moment = renderMoment(receiptWithAmount("1000000"));
    expect(moment.lines.some((l) => l.startsWith("Lifetime"))).toBe(false);
  });
});

describe("renderMoment: chain name mapping", () => {
  it("8453 -> Base", () => {
    const moment = renderMoment(receiptWithAmount("1000000", { chain_id: 8453 }));
    expect(moment.lines[1]).toContain("settled on Base");
  });
  it("84532 -> Base Sepolia", () => {
    const moment = renderMoment(receiptWithAmount("1000000", { chain_id: 84532 }));
    expect(moment.lines[1]).toContain("settled on Base Sepolia");
  });
  it("unknown chain -> 'chain <id>'", () => {
    const moment = renderMoment(receiptWithAmount("1000000", { chain_id: 999 }));
    expect(moment.lines[1]).toContain("settled on chain 999");
  });
});

describe("renderMoment: links", () => {
  it("sets links.settlement to a basescan URL when tx_hash is present on Base", () => {
    const receipt = receiptWithAmount("1000000", { chain_id: 8453, tx_hash: `0x${"b".repeat(64)}` });
    const moment = renderMoment(receipt);
    expect(moment.links.settlement).toBe(`https://basescan.org/tx/0x${"b".repeat(64)}`);
  });

  it("uses sepolia.basescan.org for Base Sepolia", () => {
    const receipt = receiptWithAmount("1000000", { chain_id: 84532, tx_hash: `0x${"b".repeat(64)}` });
    const moment = renderMoment(receipt);
    expect(moment.links.settlement).toBe(`https://sepolia.basescan.org/tx/0x${"b".repeat(64)}`);
  });

  it("omits links.settlement for an unrecognized chain", () => {
    const receipt = receiptWithAmount("1000000", { chain_id: 999, tx_hash: `0x${"b".repeat(64)}` });
    const moment = renderMoment(receipt);
    expect(moment.links.settlement).toBeUndefined();
  });

  it("sets links.anchor to an easscan URL when anchorUID is provided", () => {
    const receipt = receiptWithAmount("1000000", { chain_id: 8453 });
    const moment = renderMoment(receipt, { anchorUID: "0xdead" });
    expect(moment.links.anchor).toBe("https://base.easscan.org/attestation/view/0xdead");
  });

  it("omits links.anchor when anchorUID is not provided", () => {
    const moment = renderMoment(receiptWithAmount("1000000"));
    expect(moment.links.anchor).toBeUndefined();
  });
});

describe("momentToText / momentToMarkdown", () => {
  const moment: Moment = {
    title: "🔥 AGENT SALE",
    lines: ["Your agent just sold a paid API call to an AI agent", "+1 USDC — settled on Base ✓"],
    links: { settlement: "https://basescan.org/tx/0xabc", anchor: "https://base.easscan.org/attestation/view/0xdead" },
    tier: "fire",
  };

  it("momentToText includes title, lines, and both links", () => {
    const text = momentToText(moment);
    expect(text).toContain("🔥 AGENT SALE");
    expect(text).toContain("+1 USDC — settled on Base ✓");
    expect(text).toContain("https://basescan.org/tx/0xabc");
    expect(text).toContain("https://base.easscan.org/attestation/view/0xdead");
  });

  it("momentToMarkdown bolds the title and links the URLs", () => {
    const md = momentToMarkdown(moment);
    expect(md).toContain("*🔥 AGENT SALE*");
    expect(md).toContain("[View settlement](https://basescan.org/tx/0xabc)");
    expect(md).toContain("[View anchor](https://base.easscan.org/attestation/view/0xdead)");
  });

  it("omits link lines when links are absent", () => {
    const noLinks: Moment = { ...moment, links: {} };
    expect(momentToText(noLinks)).not.toContain("Receipt:");
    expect(momentToMarkdown(noLinks)).not.toContain("View settlement");
  });
});

describe("momentToEmailHTML", () => {
  const moment: Moment = {
    title: "💰 BIG AGENT SALE",
    lines: [
      "Stelar just sold live P&L telemetry to an AI agent",
      "+15 USDC — settled on Base ✓",
    ],
    links: { settlement: "https://basescan.org/tx/0xabc" },
    tier: "gold",
  };

  it("is a self-contained HTML document", () => {
    const html = momentToEmailHTML(moment);
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("</html>");
  });

  it("contains the amount and product line", () => {
    const html = momentToEmailHTML(moment);
    expect(html).toContain("+15 USDC");
    expect(html).toContain("live P&amp;L telemetry");
  });

  it("contains no external asset URLs (no <img>/<link> tags)", () => {
    const html = momentToEmailHTML(moment);
    expect(html).not.toMatch(/<img/i);
    expect(html).not.toMatch(/<link/i);
    expect(html).not.toMatch(/@import/i);
  });

  it("respects a custom brandColor", () => {
    const html = momentToEmailHTML(moment, { brandColor: "#ff00ff" });
    expect(html).toContain("#ff00ff");
  });

  it("includes the receipts footer", () => {
    const html = momentToEmailHTML(moment);
    expect(html).toContain("backed by an x402 receipt");
    expect(html).toContain("x402-receipts");
  });
});

const moment: Moment = {
  title: "🔥 AGENT SALE",
  lines: ["line one", "+1 USDC — settled on Base ✓"],
  links: {},
  tier: "fire",
};

describe("transports", () => {
  it("sendWebhook POSTs JSON with moment/text/markdown to the given URL", async () => {
    const fetchFn = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    const result = await sendWebhook("https://example.com/hook", moment, { fetchFn: fetchFn as any });

    expect(result).toEqual({ ok: true, status: 200 });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toBe("https://example.com/hook");
    expect(init.method).toBe("POST");
    const body = JSON.parse(init.body);
    expect(body.moment).toEqual(moment);
    expect(body.text).toBe(momentToText(moment));
    expect(body.markdown).toBe(momentToMarkdown(moment));
  });

  it("sendTelegram POSTs to the bot API with chat_id and text", async () => {
    const fetchFn = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    const result = await sendTelegram({ botToken: "TOKEN", chatId: 123 }, moment, { fetchFn: fetchFn as any });

    expect(result.ok).toBe(true);
    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toBe("https://api.telegram.org/botTOKEN/sendMessage");
    const body = JSON.parse(init.body);
    expect(body.chat_id).toBe(123);
    expect(body.text).toBe(momentToText(moment));
  });

  it("sendDiscord POSTs {content: markdown} to the webhook URL", async () => {
    const fetchFn = vi.fn().mockResolvedValue({ ok: true, status: 204 });
    const result = await sendDiscord("https://discord.com/api/webhooks/x", moment, {
      fetchFn: fetchFn as any,
    });

    expect(result.ok).toBe(true);
    const [, init] = fetchFn.mock.calls[0];
    const body = JSON.parse(init.body);
    expect(body.content).toBe(momentToMarkdown(moment));
  });

  it("sendSlack POSTs {text: markdown} to the webhook URL", async () => {
    const fetchFn = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    const result = await sendSlack("https://hooks.slack.com/services/x", moment, {
      fetchFn: fetchFn as any,
    });

    expect(result.ok).toBe(true);
    const [, init] = fetchFn.mock.calls[0];
    const body = JSON.parse(init.body);
    expect(body.text).toBe(momentToMarkdown(moment));
  });

  it("never throws when fetch rejects, for every transport", async () => {
    const fetchFn = vi.fn().mockRejectedValue(new Error("network down"));

    const webhookResult = await sendWebhook("https://x.test", moment, { fetchFn: fetchFn as any });
    const telegramResult = await sendTelegram({ botToken: "T", chatId: 1 }, moment, {
      fetchFn: fetchFn as any,
    });
    const discordResult = await sendDiscord("https://x.test", moment, { fetchFn: fetchFn as any });
    const slackResult = await sendSlack("https://x.test", moment, { fetchFn: fetchFn as any });

    for (const result of [webhookResult, telegramResult, discordResult, slackResult]) {
      expect(result.ok).toBe(false);
      expect(result.error).toBe("network down");
    }
  });

  it("reports ok:false with status when the endpoint returns a non-ok response", async () => {
    const fetchFn = vi.fn().mockResolvedValue({ ok: false, status: 500 });
    const result = await sendWebhook("https://x.test", moment, { fetchFn: fetchFn as any });
    expect(result).toEqual({ ok: false, status: 500 });
  });
});
