import { describe, expect, it, vi } from "vitest";
import {
  momentToDiscordMarkdown,
  momentToEmailHTML,
  momentToMarkdown,
  momentToSlackMrkdwn,
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

  it("display never contradicts tier at the just-under-$1 boundary (999999 base units)", () => {
    const moment = renderMoment(receiptWithAmount("999999"));
    expect(moment.tier).toBe("spark");
    expect(moment.lines[1]).toContain("+0.999999 USDC");
  });

  it("displays the smallest possible unit exactly (1 base unit = $0.000001)", () => {
    const moment = renderMoment(receiptWithAmount("1"));
    expect(moment.tier).toBe("spark");
    expect(moment.lines[1]).toContain("+0.000001 USDC");
  });

  it("buckets and displays a value past Number.MAX_SAFE_INTEGER exactly via BigInt", () => {
    // 2^53 = 9007199254740992 base units, well past Number.MAX_SAFE_INTEGER — a
    // Number-based parse would silently lose precision here. In dollars (6 decimals)
    // that's exactly 9007199254.740992 USDC.
    const huge = "9007199254740992";
    const moment = renderMoment(receiptWithAmount(huge));
    expect(moment.tier).toBe("diamond");
    expect(moment.lines[1]).toContain("+9007199254.740992 USDC");
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

describe("renderMoment: signature sign-off", () => {
  it("appends the default phrase as the final line", () => {
    const moment = renderMoment(receiptWithAmount("1000000"));
    expect(moment.lines[moment.lines.length - 1]).toBe("You've been x402'd.");
    expect(moment.signature).toBe("You've been x402'd.");
  });

  it("omits the signature entirely when opts.signature is false", () => {
    const moment = renderMoment(receiptWithAmount("1000000"), { signature: false });
    expect(moment.lines).not.toContain("You've been x402'd.");
    expect(moment.signature).toBeUndefined();
  });

  it("uses a custom signature string when provided", () => {
    const moment = renderMoment(receiptWithAmount("1000000"), { signature: "Nice." });
    expect(moment.lines[moment.lines.length - 1]).toBe("Nice.");
    expect(moment.signature).toBe("Nice.");
  });

  it("keeps the signature after the lifetime line", () => {
    const moment = renderMoment(receiptWithAmount("1000000"), {
      lifetime: { totalUsd: 12.5, count: 7 },
    });
    expect(moment.lines[moment.lines.length - 1]).toBe("You've been x402'd.");
    expect(moment.lines[moment.lines.length - 2]).toBe("Lifetime: $12.5 across 7 sales");
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

describe("momentToSlackMrkdwn / momentToDiscordMarkdown: platform dialects", () => {
  const moment: Moment = {
    title: "🔥 AGENT SALE",
    lines: ["Your agent just sold a paid API call to an AI agent", "+1 USDC — settled on Base ✓"],
    links: { settlement: "https://basescan.org/tx/0xabc", anchor: "https://base.easscan.org/attestation/view/0xdead" },
    tier: "fire",
  };

  it("momentToSlackMrkdwn uses *bold* and Slack's <url|label> link syntax", () => {
    const md = momentToSlackMrkdwn(moment);
    expect(md).toContain("*🔥 AGENT SALE*");
    expect(md).toContain("<https://basescan.org/tx/0xabc|View settlement>");
    expect(md).toContain("<https://base.easscan.org/attestation/view/0xdead|View anchor>");
    expect(md).not.toContain("**");
    expect(md).not.toContain("[View settlement]");
  });

  it("momentToDiscordMarkdown uses **bold** and plain URLs", () => {
    const md = momentToDiscordMarkdown(moment);
    expect(md).toContain("**🔥 AGENT SALE**");
    expect(md).toContain("View settlement: https://basescan.org/tx/0xabc");
    expect(md).toContain("View anchor: https://base.easscan.org/attestation/view/0xdead");
    expect(md).not.toContain("[View settlement]");
    expect(md).not.toContain("<https://basescan.org/tx/0xabc|");
  });
});

describe("momentToEmailHTML", () => {
  const moment: Moment = {
    title: "💰 BIG AGENT SALE",
    lines: [
      "Stelar just sold live P&L telemetry to an AI agent",
      "+15 USDC — settled on Base ✓",
      "You've been x402'd.",
    ],
    links: { settlement: "https://basescan.org/tx/0xabc" },
    tier: "gold",
    signature: "You've been x402'd.",
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

  it("accepts a named CSS color", () => {
    const html = momentToEmailHTML(moment, { brandColor: "orange" });
    expect(html).toContain("orange");
  });

  it("falls back to the default brand color when brandColor cannot be a valid attribute value", () => {
    const malicious = '"></td></tr></table><script>alert(1)</script>';
    const html = momentToEmailHTML(moment, { brandColor: malicious });
    expect(html).not.toContain(malicious);
    expect(html).not.toContain("<script>");
    expect(html).toContain("#00e5ff");
  });

  it("includes the receipts footer", () => {
    const html = momentToEmailHTML(moment);
    expect(html).toContain("backed by an x402 receipt");
    expect(html).toContain("x402-receipts");
  });

  it("renders the signature as the closing line above the footer, in subtle cyan italic", () => {
    const html = momentToEmailHTML(moment);
    expect(html).toContain("You&#39;ve been x402&#39;d.");
    const sigIndex = html.indexOf("You&#39;ve been x402&#39;d.");
    const footerIndex = html.indexOf("backed by an x402 receipt");
    expect(sigIndex).toBeGreaterThan(-1);
    expect(sigIndex).toBeLessThan(footerIndex);
    expect(html).toContain("font-style:italic");
  });

  it("omits the signature block when moment.signature is unset", () => {
    const noSig: Moment = { ...moment, signature: undefined, lines: moment.lines.slice(0, -1) };
    const html = momentToEmailHTML(noSig);
    expect(html).not.toContain("x402&#39;d");
  });
});

const moment: Moment = {
  title: "🔥 AGENT SALE",
  lines: ["line one", "+1 USDC — settled on Base ✓"],
  links: {},
  tier: "fire",
};

describe("transports", () => {
  it("sendWebhook POSTs JSON with moment/text/markdown/slack/discord to the given URL", async () => {
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
    expect(body.slack).toBe(momentToSlackMrkdwn(moment));
    expect(body.discord).toBe(momentToDiscordMarkdown(moment));
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

  it("sendTelegram redacts the bot token from any error message", async () => {
    const fetchFn = vi.fn().mockRejectedValue(new Error("fetch failed for https://api.telegram.org/botSECRET123/sendMessage"));
    const result = await sendTelegram({ botToken: "SECRET123", chatId: 1 }, moment, { fetchFn: fetchFn as any });

    expect(result.ok).toBe(false);
    expect(result.error).not.toContain("SECRET123");
    expect(result.error).toContain("<token>");
  });

  it("sendDiscord POSTs {content: discord markdown} to the webhook URL", async () => {
    const fetchFn = vi.fn().mockResolvedValue({ ok: true, status: 204 });
    const result = await sendDiscord("https://discord.com/api/webhooks/x", moment, {
      fetchFn: fetchFn as any,
    });

    expect(result.ok).toBe(true);
    const [, init] = fetchFn.mock.calls[0];
    const body = JSON.parse(init.body);
    expect(body.content).toBe(momentToDiscordMarkdown(moment));
    expect(body.content).toContain("**🔥 AGENT SALE**");
  });

  it("sendSlack POSTs {text: slack mrkdwn} to the webhook URL", async () => {
    const fetchFn = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    const result = await sendSlack("https://hooks.slack.com/services/x", moment, {
      fetchFn: fetchFn as any,
    });

    expect(result.ok).toBe(true);
    const [, init] = fetchFn.mock.calls[0];
    const body = JSON.parse(init.body);
    expect(body.text).toBe(momentToSlackMrkdwn(moment));
    expect(body.text).toContain("*🔥 AGENT SALE*");
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
