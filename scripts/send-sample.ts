// npm run send-sample -- [event] [tipId]
// Sends one signed delivery for a stored tip (default: the newest) to your
// local receiver, like send21 would. Handy for trying the flow without paying.
//   npm run send-sample -- draft.confirmed
//   npm run send-sample -- payment_request.expired <tipId>
import "dotenv/config";
import { randomUUID } from "node:crypto";
import { Store } from "../src/store.js";
import { signV2 } from "../src/verify.js";

const [event = "draft.confirmed", tipId] = process.argv.slice(2);
const secret = process.env.SEND21_WEBHOOK_SECRET;
if (!secret) throw new Error("SEND21_WEBHOOK_SECRET is required (the same one the bot uses)");
const store = new Store(process.env.DATA_FILE ?? "./data/tipbot.json");
const tip = tipId ? store.getTip(tipId) : store.latestTip();
if (!tip) throw new Error("no tip found: run /tip first");
const option = tip.options[0]!;

const raw = JSON.stringify({
  event,
  data: {
    draftId: randomUUID(),
    status: event === "draft.confirmed" ? "Confirmed" : "AwaitingPayment",
    txId: `sample-${randomUUID()}`,
    confirmations: 1,
    sentCurrency: option.currency.toUpperCase(),
    network: option.network,
    amountSats: 5_000_000,
    fiatCurrency: tip.fiatCurrency,
    fiatAmount: tip.fiatAmount,
    paymentRequestId: tip.paymentRequestId,
    orderId: tip.orderId,
    occurredAt: new Date().toISOString(),
  },
});
const deliveryId = randomUUID();
const res = await fetch(`http://127.0.0.1:${process.env.PORT ?? 3000}/webhooks/send21`, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "x-send21-event": event,
    "x-send21-delivery": deliveryId,
    "x-send21-signature-v2": signV2(raw, deliveryId, Math.floor(Date.now() / 1000), secret),
  },
  body: raw,
});
console.log(res.status, await res.text());
