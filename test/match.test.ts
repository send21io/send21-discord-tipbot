import { describe, expect, it } from "vitest";
import type { StoreData } from "../src/store.js";
import { applyEvent, checkPaymentAgainstTip } from "../src/tips.js";
import type { Tip, TipStatus } from "../src/types.js";
import { confirmed, makeTip } from "./helpers.js";

const dataFor = (tip: Tip): StoreData => ({ version: 1, users: {}, tips: { [tip.id]: tip }, deliveries: {}, events: {} });
const run = (body: { event: string; data: Record<string, unknown> }, status: TipStatus = "open", over: Partial<Tip> = {}) => {
  const d = dataFor(makeTip({ status, ...over }));
  const applied = applyEvent(d, body);
  return { applied, tip: d.tips[makeTip().id]! };
};
const ref = { orderId: makeTip().orderId, paymentRequestId: makeTip().paymentRequestId };

describe("amount and asset matching", () => {
  it("accepts the exact tip", () => {
    expect(checkPaymentAgainstTip(confirmed().data, makeTip())).toEqual([]);
  });

  it.each([
    ["a different fiat amount", { fiatAmount: 4.99 }, "amount"],
    ["a different fiat currency", { fiatCurrency: "USD" }, "fiat"],
    ["a coin the receiver did not offer", { sentCurrency: "USDT" }, "asset"],
    ["the right coin on another network", { network: "Base" }, "asset"],
    ["another pay link", { paymentRequestId: "00000000-0000-4000-8000-000000000000" }, "pay link"],
    ["a status other than Confirmed", { status: "Seen" }, "status"],
    ["no txId", { txId: undefined }, "txId"],
    ["no amountSats", { amountSats: 0 }, "amountSats"],
  ])("refuses %s", (_name, over, word) => {
    const problems = checkPaymentAgainstTip(confirmed(over).data, makeTip());
    expect(problems.join(" ")).toContain(word);
  });

  it("compares in minor units, not floats", () => {
    expect(checkPaymentAgainstTip(confirmed({ fiatAmount: 0.1 + 0.2 }).data, makeTip({ fiatAmount: 0.3 }))).toEqual([]);
    expect(checkPaymentAgainstTip(confirmed({ fiatAmount: 500, fiatCurrency: "JPY" }).data, makeTip({ fiatAmount: 500, fiatCurrency: "JPY" }))).toEqual([]);
  });

  it("matches Lightning (BTC on Mainnet) when it was offered", () => {
    expect(checkPaymentAgainstTip(confirmed({ sentCurrency: "BTC", network: "Mainnet" }).data, makeTip())).toEqual([]);
  });

  it("flags a confirmed payment that does not match, never shows paid", () => {
    const { applied, tip } = run(confirmed({ fiatAmount: 1 }));
    expect(applied.outcome).toBe("flagged");
    expect(tip.status).toBe("flagged");
    expect(tip.paid).toBeUndefined();
  });

  it("ignores events for unknown tips and foreign pay links", () => {
    expect(run(confirmed({ orderId: "shop-1042" })).applied.outcome).toBe("unknown_tip");
    expect(run({ event: "draft.seen", data: { ...ref, paymentRequestId: "nope" } }).applied.outcome).toBe("unknown_tip");
  });
});

describe("tip states", () => {
  it("open → seen → paid, and a late draft.seen does not undo paid", () => {
    expect(run({ event: "draft.seen", data: ref }).tip.status).toBe("seen");
    expect(run(confirmed(), "seen").tip.status).toBe("paid");
    expect(run({ event: "draft.seen", data: ref }, "paid").applied.outcome).toBe("unchanged");
  });

  it("different amount: review, then accepted, then paid with the flag", () => {
    expect(run({ event: "draft.amount_mismatch", data: { ...ref, reviewState: "pending" } }).tip.status).toBe("review");
    expect(run({ event: "draft.mismatch_accepted", data: ref }, "review").tip.status).toBe("accepted");
    const { tip } = run(confirmed({ receivedAmountSats: 5_300_000, receivedAmount: "5.300000" }), "accepted");
    expect(tip.status).toBe("paid");
    expect(tip.paid).toMatchObject({ differentAmount: true, amount: "5.300000" });
  });

  it("different amount declined or left undecided", () => {
    expect(run({ event: "draft.mismatch_rejected", data: ref }, "review").tip.status).toBe("declined");
    expect(run({ event: "draft.mismatch_unresolved", data: ref }, "review").tip.status).toBe("unresolved");
    expect(run({ event: "draft.expired", data: { ...ref, reviewState: "unresolved" } }, "review").tip.status).toBe("unresolved");
  });

  it("expiry: pay link or draft expired unpaid", () => {
    expect(run({ event: "payment_request.expired", data: { ...ref, opened: true, quoteRequested: false } }).tip.status).toBe("expired");
    expect(run({ event: "draft.expired", data: ref }, "seen").tip.status).toBe("expired");
    expect(run({ event: "payment_request.expired", data: ref }, "paid").applied.outcome).toBe("unchanged");
  });

  it("a valid payment after expiry still shows paid (the money arrived)", () => {
    expect(run(confirmed(), "expired").tip.status).toBe("paid");
  });

  it("test and informational events change nothing", () => {
    expect(run({ event: "test", data: {} }).applied.outcome).toBe("test");
    for (const event of ["draft.created", "draft.cancelled", "draft.mismatch_reminder"]) {
      expect(run({ event, data: ref }).applied.outcome).toBe("ignored");
    }
  });

  it("finds a tip by pay link id when a payload has no orderId", () => {
    expect(run({ event: "payment_request.expired", data: { paymentRequestId: ref.paymentRequestId } }).tip.status).toBe("expired");
  });
});
