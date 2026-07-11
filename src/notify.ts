import type { Receipt } from "./receipt.js";

export type MomentTier = "spark" | "fire" | "gold" | "diamond";

export interface Moment {
  title: string;
  lines: string[];
  links: {
    settlement?: string;
    anchor?: string;
  };
  tier: MomentTier;
  /** The sign-off line, if any — also the last entry in `lines`. See RenderMomentOptions.signature. */
  signature?: string;
}

export interface RenderMomentOptions {
  /** Human-readable name for what was sold. Caller resolves request.url_hash -> name. */
  productName?: string;
  /** Who sold it. Defaults to "Your agent". */
  sellerName?: string;
  /** Running lifetime stats to append as an extra line, if provided. */
  lifetime?: { totalUsd: number; count: number };
  /**
   * EAS attestation UID for this receipt's batch anchor, if known. Rendered as
   * links.anchor pointing at base.easscan.org. Not read from the receipt itself
   * (an anchor covers a whole batch, not a single receipt) — the caller supplies it.
   */
  anchorUID?: string;
  /**
   * The sign-off line appended to Moment.lines. Defaults to the coined phrase; pass
   * `false` to omit it entirely.
   */
  signature?: string | false;
}

export const DEFAULT_SIGNATURE = "You've been x402'd.";

const TIER_TITLES: Record<MomentTier, string> = {
  spark: "⚡ AGENT SALE",
  fire: "🔥 AGENT SALE",
  gold: "💰 BIG AGENT SALE",
  diamond: "💎🚀 HUGE AGENT SALE",
};

/**
 * Tier bucketing done entirely in BigInt on the raw base-units string — never round-trips
 * through `Number`, so amounts beyond Number.MAX_SAFE_INTEGER (2^53) still bucket exactly,
 * and no floating-point rounding can push a value across a tier boundary.
 */
function tierForAmount(amountBaseUnits: string): MomentTier {
  const n = BigInt(amountBaseUnits);
  if (n >= 100_000_000n) return "diamond";
  if (n >= 10_000_000n) return "gold";
  if (n >= 1_000_000n) return "fire";
  return "spark";
}

/**
 * Exact USDC display from raw base-units string (6 decimals), BigInt-parsed so precision
 * survives past 2^53 and never rounds — "999999" renders "0.999999", not "1" (which would
 * contradict a "spark" tier), "1" renders "0.000001", not "0" (see landmine this fixes:
 * Number(amountBaseUnits)/1e6 then toFixed() rounds the display across the tier boundary
 * it was just bucketed against).
 */
function formatUsdExact(amountBaseUnits: string): string {
  const n = BigInt(amountBaseUnits);
  const neg = n < 0n;
  const abs = neg ? -n : n;
  const whole = abs / 1_000_000n;
  const frac = abs % 1_000_000n;
  const fracStr = frac.toString().padStart(6, "0").replace(/0+$/, "");
  const result = fracStr.length > 0 ? `${whole.toString()}.${fracStr}` : whole.toString();
  return neg ? `-${result}` : result;
}

function chainName(chainId: number): string {
  if (chainId === 8453) return "Base";
  if (chainId === 84532) return "Base Sepolia";
  return `chain ${chainId}`;
}

function basescanTxUrl(chainId: number, txHash: string): string | undefined {
  if (chainId === 8453) return `https://basescan.org/tx/${txHash}`;
  if (chainId === 84532) return `https://sepolia.basescan.org/tx/${txHash}`;
  return undefined;
}

function easscanAttestationUrl(chainId: number, uid: string): string | undefined {
  if (chainId === 8453) return `https://base.easscan.org/attestation/view/${uid}`;
  if (chainId === 84532) return `https://base-sepolia.easscan.org/attestation/view/${uid}`;
  return undefined;
}

/** Formats a plain float USD value (used only for opts.lifetime.totalUsd — a caller-supplied aggregate, not raw base units). */
function formatLifetimeUsd(usd: number): string {
  return usd.toFixed(usd < 1 ? 3 : 2).replace(/0+$/, "").replace(/\.$/, "");
}

/**
 * Renders a settled receipt as a human moment: a sale ALERT, not a balance change. Pure,
 * no I/O — see momentToText/momentToMarkdown/momentToEmailHTML for the actual renders,
 * and sendWebhook/sendTelegram/sendDiscord/sendSlack for delivery.
 */
export function renderMoment(receipt: Receipt, opts: RenderMomentOptions = {}): Moment {
  const tier = tierForAmount(receipt.payment.amount);
  const productName = opts.productName ?? "a paid API call";
  const sellerName = opts.sellerName ?? "Your agent";
  const chain = chainName(receipt.payment.chain_id);

  const lines: string[] = [
    `${sellerName} just sold ${productName} to an AI agent`,
    `+${formatUsdExact(receipt.payment.amount)} USDC — settled on ${chain} ✓`,
  ];
  if (opts.lifetime) {
    lines.push(`Lifetime: $${formatLifetimeUsd(opts.lifetime.totalUsd)} across ${opts.lifetime.count} sales`);
  }
  const signature = opts.signature === undefined ? DEFAULT_SIGNATURE : opts.signature;
  if (signature !== false) {
    lines.push(signature);
  }

  const links: Moment["links"] = {};
  if (receipt.payment.tx_hash) {
    const url = basescanTxUrl(receipt.payment.chain_id, receipt.payment.tx_hash);
    if (url) links.settlement = url;
  }
  if (opts.anchorUID) {
    const url = easscanAttestationUrl(receipt.payment.chain_id, opts.anchorUID);
    if (url) links.anchor = url;
  }

  const moment: Moment = { title: TIER_TITLES[tier], lines, links, tier };
  if (signature !== false) moment.signature = signature;
  return moment;
}

/** Plain text render (Telegram/SMS/console) — emoji included. */
export function momentToText(moment: Moment): string {
  const parts = [moment.title, ...moment.lines];
  if (moment.links.settlement) parts.push(`Receipt: ${moment.links.settlement}`);
  if (moment.links.anchor) parts.push(`Anchor: ${moment.links.anchor}`);
  return parts.join("\n");
}

/**
 * Generic markdown render — `[label](url)` links, `*bold*` title. Used by sendWebhook's
 * payload for consumers with no specific platform dialect. Slack and Discord have
 * different link syntax and bold syntax — use momentToSlackMrkdwn / momentToDiscordMarkdown
 * for those, not this one.
 */
export function momentToMarkdown(moment: Moment): string {
  const parts = [`*${moment.title}*`, ...moment.lines];
  if (moment.links.settlement) parts.push(`[View settlement](${moment.links.settlement})`);
  if (moment.links.anchor) parts.push(`[View anchor](${moment.links.anchor})`);
  return parts.join("\n");
}

/** Slack mrkdwn — `*bold*` title, links as `<url|label>` (Slack's own link syntax). */
export function momentToSlackMrkdwn(moment: Moment): string {
  const parts = [`*${moment.title}*`, ...moment.lines];
  if (moment.links.settlement) parts.push(`<${moment.links.settlement}|View settlement>`);
  if (moment.links.anchor) parts.push(`<${moment.links.anchor}|View anchor>`);
  return parts.join("\n");
}

/** Discord markdown — `**bold**` title, plain URLs (Discord auto-embeds/links bare URLs). */
export function momentToDiscordMarkdown(moment: Moment): string {
  const parts = [`**${moment.title}**`, ...moment.lines];
  if (moment.links.settlement) parts.push(`View settlement: ${moment.links.settlement}`);
  if (moment.links.anchor) parts.push(`View anchor: ${moment.links.anchor}`);
  return parts.join("\n");
}

export interface EmailHTMLOptions {
  brandColor?: string;
}

const DEFAULT_BRAND_COLOR = "#00e5ff";
/** CSS color keyword or hex (3-8 hex digits) — anything else falls back to DEFAULT_BRAND_COLOR
 *  rather than being interpolated raw into a style attribute. */
const SAFE_CSS_COLOR_RE = /^#[0-9a-fA-F]{3,8}$|^[a-zA-Z]+$/;

function safeBrandColor(input?: string): string {
  if (input && SAFE_CSS_COLOR_RE.test(input)) return input;
  return DEFAULT_BRAND_COLOR;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Self-contained dark HTML email (inline CSS only — no external assets, no <link>/<img>
 * network fetches, safe for any email client). Amount line is the visual anchor; product
 * line and check-mark lines below it; links rendered as buttons; footer credits the
 * receipt this moment is backed by.
 */
export function momentToEmailHTML(moment: Moment, opts: EmailHTMLOptions = {}): string {
  const brand = safeBrandColor(opts.brandColor);
  const bg = "#0a0e1c";
  const bodyLines = moment.signature
    ? moment.lines.slice(0, -1)
    : moment.lines;
  const [headline, ...rest] = bodyLines;
  const buttons: string[] = [];
  if (moment.links.settlement) {
    buttons.push(
      `<a href="${escapeHtml(moment.links.settlement)}" style="display:inline-block;margin:8px 8px 0 0;padding:10px 18px;border-radius:6px;background:${brand};color:${bg};text-decoration:none;font-weight:bold;">View settlement</a>`
    );
  }
  if (moment.links.anchor) {
    buttons.push(
      `<a href="${escapeHtml(moment.links.anchor)}" style="display:inline-block;margin:8px 0 0 0;padding:10px 18px;border-radius:6px;border:1px solid ${brand};color:${brand};text-decoration:none;font-weight:bold;">View anchor</a>`
    );
  }

  return `<!DOCTYPE html>
<html>
  <body style="margin:0;padding:0;background:${bg};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;">
    <table role="presentation" width="100%" style="background:${bg};padding:32px 0;">
      <tr>
        <td align="center">
          <table role="presentation" width="480" style="background:#10162b;border-radius:12px;padding:32px;">
            <tr>
              <td style="color:${brand};font-size:14px;letter-spacing:2px;text-transform:uppercase;font-weight:bold;">
                ${escapeHtml(moment.title)}
              </td>
            </tr>
            <tr>
              <td style="color:#f5f7ff;font-size:16px;padding-top:16px;">
                ${escapeHtml(headline)}
              </td>
            </tr>
            <tr>
              <td style="color:${brand};font-size:40px;font-weight:bold;padding-top:12px;">
                ${escapeHtml(rest[0] ?? "")}
              </td>
            </tr>
            ${rest
              .slice(1)
              .map(
                (line) =>
                  `<tr><td style="color:#9aa3c0;font-size:14px;padding-top:8px;">${escapeHtml(line)}</td></tr>`
              )
              .join("\n            ")}
            <tr>
              <td style="padding-top:20px;">
                ${buttons.join("\n                ")}
              </td>
            </tr>
            ${
              moment.signature
                ? `<tr>
              <td style="color:${brand};font-size:13px;font-style:italic;opacity:0.85;padding-top:24px;">
                ${escapeHtml(moment.signature)}
              </td>
            </tr>`
                : ""
            }
            <tr>
              <td style="color:#5a6285;font-size:12px;padding-top:28px;border-top:1px solid #1e2542;margin-top:20px;">
                backed by an x402 receipt · via x402-receipts
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

export interface TransportResult {
  ok: boolean;
  status?: number;
  error?: string;
}

export interface TransportOptions {
  fetchFn?: typeof fetch;
}

function momentPayload(moment: Moment) {
  return {
    moment,
    text: momentToText(moment),
    markdown: momentToMarkdown(moment),
    slack: momentToSlackMrkdwn(moment),
    discord: momentToDiscordMarkdown(moment),
  };
}

async function post(
  url: string,
  body: unknown,
  fetchFn: typeof fetch
): Promise<TransportResult> {
  try {
    const res = await fetchFn(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { ok: res.ok, status: res.status };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** POSTs {moment, text, markdown} as JSON. Never throws — see TransportResult. */
export async function sendWebhook(
  url: string,
  moment: Moment,
  opts: TransportOptions = {}
): Promise<TransportResult> {
  const fetchFn = opts.fetchFn ?? globalThis.fetch;
  return post(url, momentPayload(moment), fetchFn);
}

export interface TelegramTarget {
  botToken: string;
  chatId: string | number;
}

/**
 * Sends via the Telegram Bot API sendMessage. Never throws — see TransportResult. The
 * bot token is embedded in the request URL; if delivery fails, any occurrence of the
 * token in the resulting error string is redacted (defense in depth — a fetch
 * implementation could echo the request URL back in an error message).
 */
export async function sendTelegram(
  target: TelegramTarget,
  moment: Moment,
  opts: TransportOptions = {}
): Promise<TransportResult> {
  const fetchFn = opts.fetchFn ?? globalThis.fetch;
  const url = `https://api.telegram.org/bot${target.botToken}/sendMessage`;
  const result = await post(url, { chat_id: target.chatId, text: momentToText(moment) }, fetchFn);
  if (result.error) {
    return { ...result, error: result.error.split(target.botToken).join("<token>") };
  }
  return result;
}

/** Sends to a Discord incoming webhook, using Discord's markdown dialect. Never throws — see TransportResult. */
export async function sendDiscord(
  webhookUrl: string,
  moment: Moment,
  opts: TransportOptions = {}
): Promise<TransportResult> {
  const fetchFn = opts.fetchFn ?? globalThis.fetch;
  return post(webhookUrl, { content: momentToDiscordMarkdown(moment) }, fetchFn);
}

/** Sends to a Slack incoming webhook, using Slack's mrkdwn dialect. Never throws — see TransportResult. */
export async function sendSlack(
  webhookUrl: string,
  moment: Moment,
  opts: TransportOptions = {}
): Promise<TransportResult> {
  const fetchFn = opts.fetchFn ?? globalThis.fetch;
  return post(webhookUrl, { text: momentToSlackMrkdwn(moment) }, fetchFn);
}

// Email SENDING is deliberately NOT included here — this library stays zero-dep, and
// email transport (SES/SendGrid/Postmark/SMTP/etc.) is provider-specific enough that any
// choice here would either add a dependency or pick a favorite for you. Plug the output
// of momentToEmailHTML(moment) into whatever sender you already use, e.g.:
//
//   await sesClient.send({ ...otherFields, Html: momentToEmailHTML(moment) });
//
// watchLedger (a simple ledger-tailing poller) is intentionally NOT implemented here: it
// would need setInterval/timer machinery that doesn't fit this repo's no-network,
// no-timer test convention (see tests/*.test.ts — every existing suite is pure/sync
// against injected fixtures). Wire it yourself with readLedger (src/ledger.ts) on a
// setInterval/cron of your choosing, diffing against the last-seen ledger length.
