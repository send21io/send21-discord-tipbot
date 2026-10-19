import { randomUUID } from "node:crypto";
import type { Config } from "./config.js";
import { coinById, formatFiat, isFiat, parseTipAmount } from "./currencies.js";
import { cleanNote, plain } from "./sanitize.js";
import type { Send21Client } from "./send21.js";
import type { Store } from "./store.js";
import type { PayOption, Tip } from "./types.js";

export interface TipInput {
  guildId: string;
  channelId: string;
  fromId: string;
  toId: string;
  toIsBot: boolean;
  amount: unknown;
  currency: string;
  note: string | null;
}

export type Prepared = { ok: true; amount: number; fiat: string; note: string | null; options: PayOption[] } | { ok: false; error: string };

/** Everything that can be checked before calling send21. Pure apart from reading the store. */
export function prepareTip(store: Store, cfg: Pick<Config, "tipMax">, input: TipInput): Prepared {
  if (input.toId === input.fromId) return { ok: false, error: "🪞 you can't tip yourself" };
  if (input.toIsBot) return { ok: false, error: "🤖 bots don't take tips" };
  const fiat = input.currency.toUpperCase();
  if (!isFiat(fiat)) return { ok: false, error: "💱 pick a currency from the list" };
  const amount = parseTipAmount(input.amount, fiat, cfg.tipMax);
  if (!amount.ok) return amount;
  const note = cleanNote(input.note);
  if (!note.ok) return note;
  // The receiver's own addresses, set by the receiver with /tipme set. The tipper never picks an address.
  const options: PayOption[] = [];
  for (const saved of store.getCoins(input.toId)) {
    const coin = coinById(saved.coin);
    if (!coin) continue;
    options.push({ currency: coin.currency, network: coin.network, address: saved.address, ...(coin.method ? { method: coin.method } : {}) });
  }
  if (!options.length) return { ok: false, error: `🙈 <@${input.toId}> hasn't set up tips yet → \`/tipme set\`` };
  return { ok: true, amount: amount.amount, fiat, note: note.note, options };
}

/** Create the send21 pay link and store the tip. */
export async function createTip(store: Store, send21: Send21Client, cfg: Pick<Config, "tipExpiryHours" | "shortfallPercent">, input: TipInput, prepared: Extract<Prepared, { ok: true }>): Promise<Tip> {
  const id = randomUUID();
  const orderId = `tip-${id}`;
  const pr = await send21.createPaymentRequest(
    {
      fiatCurrency: prepared.fiat,
      fiatAmount: prepared.amount,
      orderId,
      // The memo is shown on the public pay page: no Discord names or ids.
      memo: `Discord tip ${formatFiat(prepared.amount, prepared.fiat)}${prepared.note ? `: ${plain(prepared.note)}` : ""}`.slice(0, 140),
      options: prepared.options,
      expiryHours: cfg.tipExpiryHours,
      declineNote: "Nothing happens. It's a tip, no pressure.",
      ...(cfg.shortfallPercent > 0 ? { shortfallPolicy: { absorbUpToPercent: cfg.shortfallPercent, absorbedBy: "receiver" as const } } : {}),
    },
    // Idempotency-Key: a retry of this call returns the same pay link.
    orderId,
  );
  const now = new Date().toISOString();
  const tip: Tip = {
    id,
    orderId,
    guildId: input.guildId,
    channelId: input.channelId,
    messageId: null,
    fromId: input.fromId,
    toId: input.toId,
    fiatAmount: prepared.amount,
    fiatCurrency: prepared.fiat,
    note: prepared.note,
    options: prepared.options,
    paymentRequestId: pr.id,
    payUrl: send21.payUrl(pr.payPath),
    expiresAt: pr.expiresAt,
    status: "open",
    createdAt: now,
    updatedAt: now,
  };
  store.putTip(tip);
  return tip;
}
