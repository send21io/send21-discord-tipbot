import { ActionRowBuilder, AttachmentBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from "discord.js";
import QRCode from "qrcode";
import { coinFor, formatFiat } from "./currencies.js";
import type { Tip, TipStatus } from "./types.js";

// The tip message. Very little text: the amount is the headline, emoji carry
// the status, the Pay button and the QR do the rest.

const ORANGE = 0xf7931a; // send21 orange
export const STATUS: Record<TipStatus, { emoji: string; word: string; color: number; live: boolean }> = {
  open: { emoji: "⏳", word: "waiting", color: ORANGE, live: true },
  seen: { emoji: "👀", word: "on its way", color: 0x5865f2, live: true },
  review: { emoji: "⚠️", word: "different amount · admin decides", color: 0xfee75c, live: false },
  accepted: { emoji: "👍", word: "accepted · confirming", color: 0x5865f2, live: false },
  paid: { emoji: "✅", word: "paid", color: 0x57f287, live: false },
  declined: { emoji: "↩️", word: "declined · refund is manual", color: 0xed4245, live: false },
  unresolved: { emoji: "⚠️", word: "expired undecided", color: 0xfee75c, live: false },
  expired: { emoji: "⌛", word: "expired", color: 0x4f545c, live: false },
  flagged: { emoji: "🚩", word: "payment didn't match · check", color: 0xed4245, live: false },
};

/** "🔵 USDC · ⚡ BTC · 💎 ETH": one entry per coin the receiver takes. */
const coinsLine = (tip: Tip) =>
  [...new Set(tip.options.map((o) => {
    const coin = coinFor(o.currency, o.network, o.method);
    return `${coin?.emoji ?? "🪙"} ${o.currency.toUpperCase()}`;
  }))].join(" · ");

export interface TipMessage {
  embeds: EmbedBuilder[];
  components: ActionRowBuilder<ButtonBuilder>[];
  files: AttachmentBuilder[];
}

/** Pure: the embed and button for a tip in its current state. */
export function tipMessage(tip: Tip, qrPng?: Buffer): TipMessage {
  const s = STATUS[tip.status];
  const amount = formatFiat(tip.fiatAmount, tip.fiatCurrency);
  const embed = new EmbedBuilder()
    .setColor(s.color)
    .setTitle(tip.status === "paid" ? `✅ ${amount}` : `💸 ${amount}`)
    .setDescription([`<@${tip.fromId}> ➜ <@${tip.toId}>`, tip.note ? `> ${tip.note}` : null].filter(Boolean).join("\n"))
    .setFooter({ text: `${s.emoji} ${s.word} · send21` })
    .setTimestamp(new Date(tip.updatedAt));

  if (tip.status === "paid" && tip.paid) {
    const coin = coinFor(tip.paid.currency, tip.paid.network);
    embed.addFields({ name: "🪙", value: `${tip.paid.amount ?? ""} ${coin?.label ?? `${tip.paid.currency} · ${tip.paid.network}`}${tip.paid.differentAmount ? " · ≈ accepted" : ""}`.trim(), inline: true });
  } else if (s.live) {
    embed.addFields({ name: "🪙", value: coinsLine(tip), inline: true }, { name: "⏰", value: `<t:${Math.floor(Date.parse(tip.expiresAt) / 1000)}:R>`, inline: true });
  }

  const files: AttachmentBuilder[] = [];
  const components: ActionRowBuilder<ButtonBuilder>[] = [];
  if (s.live) {
    if (qrPng) {
      files.push(new AttachmentBuilder(qrPng, { name: "qr.png" }));
      embed.setThumbnail("attachment://qr.png");
    }
    components.push(new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel("Pay").setEmoji("💳").setURL(tip.payUrl)));
  }
  return { embeds: [embed], components, files };
}

/** QR of the pay link: dark modules on cream, readable from a phone screen. */
export const qrFor = (url: string): Promise<Buffer> =>
  QRCode.toBuffer(url, { errorCorrectionLevel: "M", margin: 2, width: 256, color: { dark: "#1b1c20", light: "#fef8ec" } });
