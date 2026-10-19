import { toMinor } from "./currencies.js";
import type { StoreData } from "./store.js";
import type { Tip, TipStatus } from "./types.js";

// What a verified send21 delivery does to a tip.
//
// send21 protects its side (exact-amount matching, a second-source lookup
// before confirming, rate locks). The bot still checks every draft.confirmed
// against the tip it stored before it shows ✅, as the webhook docs ask:
// "Before you ship goods, check that the amount, currency and orderId are the
// ones you expect." (https://send21.io/docs/webhooks)

/** Fields of a draft webhook payload that the bot reads. See docs/webhooks "Payload". */
export interface DraftEventData {
  draftId?: string;
  status?: string;
  txId?: string;
  sentCurrency?: string;
  network?: string;
  amountSats?: number;
  sentAmount?: string;
  receivedAmountSats?: number;
  receivedAmount?: string;
  fiatCurrency?: string;
  fiatAmount?: number;
  paymentRequestId?: string;
  orderId?: string;
  reviewState?: string;
  occurredAt?: string;
}

const eq = (a: unknown, b: unknown) => String(a ?? "").toLowerCase() === String(b ?? "").toLowerCase();
const isPosInt = (n: unknown) => typeof n === "number" && Number.isSafeInteger(n) && n > 0;

/**
 * Compare a draft.confirmed payload with the stored tip.
 * @returns problems; empty when the payment is exactly this tip
 */
export function checkPaymentAgainstTip(data: DraftEventData, tip: Tip): string[] {
  const problems: string[] = [];
  if (data.orderId !== tip.orderId) problems.push(`orderId ${data.orderId} != ${tip.orderId}`);
  if (data.paymentRequestId !== tip.paymentRequestId) problems.push(`pay link ${data.paymentRequestId} != ${tip.paymentRequestId}`);
  if (data.status !== "Confirmed") problems.push(`status ${data.status} != Confirmed`);
  if (!data.txId) problems.push("no txId");
  // Amount: the fiat price of the pay link, in integer minor units.
  if (!eq(data.fiatCurrency, tip.fiatCurrency)) problems.push(`fiat ${data.fiatCurrency} != ${tip.fiatCurrency}`);
  if (typeof data.fiatAmount !== "number" || toMinor(data.fiatAmount, tip.fiatCurrency) !== toMinor(tip.fiatAmount, tip.fiatCurrency)) {
    problems.push(`amount ${data.fiatAmount} != ${tip.fiatAmount}`);
  }
  // The crypto that was actually sent (base units) must be there and positive.
  if (!isPosInt(data.amountSats)) problems.push("no amountSats");
  if (data.receivedAmountSats !== undefined && !isPosInt(data.receivedAmountSats)) problems.push("bad receivedAmountSats");
  // Asset: sentCurrency is upper case in payloads ("USDC"), options use API enums ("Usdc").
  const offered = tip.options.some((o) => eq(o.currency, data.sentCurrency) && eq(o.network, data.network));
  if (!offered) problems.push(`asset ${data.sentCurrency} on ${data.network} was not offered on this tip`);
  return problems;
}

/** Statuses after which nothing but a valid payment changes the tip again. */
const FINAL: ReadonlySet<TipStatus> = new Set(["paid", "declined"]);

export type Outcome =
  | "test"
  | "ignored"
  | "unknown_tip"
  | "unchanged"
  | "paid"
  | "already_paid"
  | "flagged"
  | TipStatus;

export interface Applied {
  outcome: Outcome;
  /** Set when the tip changed and its Discord message should be edited. */
  tip?: Tip;
}

/**
 * Apply one verified, de-duplicated event to the store data. Call inside
 * store.transaction() together with Store.remember().
 */
export function applyEvent(d: StoreData, body: { event?: unknown; data?: unknown }, nowIso = new Date().toISOString()): Applied {
  const event = typeof body.event === "string" ? body.event : "";
  if (event === "test") return { outcome: "test" };
  const data = (body.data && typeof body.data === "object" ? body.data : {}) as DraftEventData;

  // Our own orderId first (tip-<id>), the pay link id only as a fallback.
  const tips = Object.values(d.tips);
  const tip =
    (data.orderId ? tips.find((t) => t.orderId === data.orderId) : undefined) ??
    (!data.orderId && data.paymentRequestId ? tips.find((t) => t.paymentRequestId === data.paymentRequestId) : undefined);
  if (!tip) return { outcome: "unknown_tip" };
  // A payload that names a different pay link than ours is not about this tip.
  if (data.paymentRequestId && data.paymentRequestId !== tip.paymentRequestId) return { outcome: "unknown_tip" };

  const set = (status: TipStatus, extra: Partial<Tip> = {}): Applied => {
    const next: Tip = { ...tip, ...extra, status, updatedAt: nowIso };
    d.tips[tip.id] = next;
    return { outcome: status, tip: next };
  };
  const is = (...s: TipStatus[]) => s.includes(tip.status);

  switch (event) {
    case "draft.confirmed": {
      if (tip.status === "paid") return { outcome: "already_paid" };
      const problems = checkPaymentAgainstTip(data, tip);
      if (problems.length) return set("flagged", { problems });
      return set("paid", {
        problems: undefined,
        paid: {
          currency: String(data.sentCurrency),
          network: String(data.network),
          amount: data.receivedAmount ?? data.sentAmount ?? null,
          txId: String(data.txId),
          // Set when a different amount arrived and the receiver's side accepted it on send21.
          differentAmount: data.receivedAmountSats !== undefined && data.receivedAmountSats !== data.amountSats,
          at: data.occurredAt ?? nowIso,
        },
      });
    }
    case "draft.seen":
      return is("open", "expired") ? set("seen") : { outcome: "unchanged" };
    case "draft.amount_mismatch":
      return is("open", "seen", "expired") ? set("review") : { outcome: "unchanged" };
    case "draft.mismatch_accepted":
      return FINAL.has(tip.status) ? { outcome: "unchanged" } : set("accepted");
    case "draft.mismatch_rejected":
      return tip.status === "paid" ? { outcome: "unchanged" } : set("declined");
    case "draft.mismatch_unresolved":
      return is("open", "seen", "review", "expired") ? set("unresolved") : { outcome: "unchanged" };
    case "draft.expired":
      if (data.reviewState === "unresolved") return is("open", "seen", "review", "expired") ? set("unresolved") : { outcome: "unchanged" };
      return is("open", "seen") ? set("expired") : { outcome: "unchanged" };
    case "payment_request.expired":
      return is("open", "seen") ? set("expired") : { outcome: "unchanged" };
    // draft.created, draft.cancelled, draft.mismatch_reminder: nothing to show.
    // A pay link can create a new draft when the payer picks another coin.
    default:
      return { outcome: "ignored" };
  }
}
