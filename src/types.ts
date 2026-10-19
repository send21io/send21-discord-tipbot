import type { Send21Currency, Send21Network } from "./currencies.js";

/** One receiving option on a pay link, exactly as POST /payment-requests takes it. */
export interface PayOption {
  currency: Send21Currency;
  network: Send21Network;
  address: string;
  method?: "Lightning";
}

/** A coin a Discord user registered with /tipme set. */
export interface SavedCoin {
  coin: string; // Coin.id
  address: string;
  savedAt: string;
}

export type TipStatus =
  | "open" // ⏳ pay link created, nothing seen
  | "seen" // 👀 a payment is on its way
  | "review" // ⚠️ a different amount arrived; the send21 account owner decides
  | "accepted" // 👍 different amount accepted, waiting for confirmation
  | "paid" // ✅ confirmed and checked against this tip
  | "declined" // ↩️ different amount declined, refund is manual
  | "unresolved" // ⚠️ expired while a different amount was undecided
  | "expired" // ⌛ nobody paid
  | "flagged"; // 🚩 a confirmed payment did NOT match this tip (not marked paid)

export interface Tip {
  id: string;
  orderId: string;
  guildId: string;
  channelId: string;
  messageId: string | null;
  fromId: string;
  toId: string;
  fiatAmount: number;
  fiatCurrency: string;
  note: string | null;
  options: PayOption[];
  paymentRequestId: string;
  payUrl: string;
  expiresAt: string;
  status: TipStatus;
  paid?: { currency: string; network: string; amount: string | null; txId: string; differentAmount: boolean; at: string };
  problems?: string[];
  createdAt: string;
  updatedAt: string;
}
