import { createHash, randomUUID } from "node:crypto";
import express, { type Express } from "express";
import { formatFiat } from "./currencies.js";
import type { createMockClient } from "./send21.js";
import { Store } from "./store.js";
import { applyEvent } from "./tips.js";
import type { Tip } from "./types.js";
import { signV2, verifySignatureV2 } from "./verify.js";

export interface WebhookDeps {
  store: Store;
  secret: string;
  /** Called after the change is on disk and send21 got its 200. Edits the Discord message. */
  onTipChanged: (tip: Tip) => Promise<void>;
  log?: (line: string) => void;
  /** Mock mode only: serves /mock/pay/<token> to simulate payments. */
  mock?: { client: ReturnType<typeof createMockClient>; selfUrl: string };
}

export function createWebhookApp({ store, secret, onTipChanged, log = console.log, mock }: WebhookDeps): Express {
  const app = express();
  app.disable("x-powered-by");
  app.get("/healthz", (_req, res) => {
    res.json({ ok: true });
  });

  // Raw bytes: the signature covers the exact body, so never parse JSON before verifying.
  app.post("/webhooks/send21", express.raw({ type: () => true, limit: "64kb" }), (req, res) => {
    const raw: Buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const deliveryId = req.get("x-send21-delivery");
    // 1. Signature V2 + 300 s window. Nothing is stored for a request that fails.
    if (!verifySignatureV2(raw, req.get("x-send21-signature-v2"), deliveryId, secret)) {
      res.status(401).json({ error: "invalid signature" });
      return;
    }
    let body: { event?: unknown; data?: unknown };
    try {
      body = JSON.parse(raw.toString("utf8"));
      if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("not an object");
    } catch {
      res.status(400).json({ error: "invalid json" });
      return;
    }
    // 2 + 3. Dedupe and apply in one write: either both are on disk or neither.
    const eventKey = createHash("sha256").update(raw).digest("hex");
    let applied;
    try {
      applied = store.transaction((d) => (Store.remember(d, deliveryId as string, eventKey) ? applyEvent(d, body) : null));
    } catch (err) {
      log(`webhook: store write failed, send21 will retry: ${(err as Error).message}`);
      res.status(500).json({ error: "try again" });
      return;
    }
    if (applied === null) {
      res.status(200).json({ ok: true, duplicate: true });
      return;
    }
    log(`webhook ${String(body.event)} ${deliveryId}: ${applied.outcome}${applied.tip?.problems?.length ? ` (${applied.tip.problems.join("; ")})` : ""}`);
    res.status(200).json({ ok: true, outcome: applied.outcome });
    // 4. Only now touch Discord. A failed edit never makes send21 retry.
    if (applied.tip) onTipChanged(applied.tip).catch((err) => log(`discord edit failed for tip ${applied.tip?.id}: ${(err as Error).message}`));
  });

  if (mock) mountMock(app, store, secret, mock);
  return app;
}

// ---------- mock mode: a tiny local "pay page" that sends signed deliveries ----------

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function mountMock(app: Express, store: Store, secret: string, { client, selfUrl }: NonNullable<WebhookDeps["mock"]>): void {
  const find = (token: string) => {
    const entry = client.requests.get(token);
    return entry ? { entry, tip: store.findTip({ orderId: entry.body.orderId }) } : null;
  };

  app.get("/mock/pay/:token", (req, res) => {
    const found = find(req.params.token);
    if (!found) {
      res.status(404).send("unknown pay link");
      return;
    }
    const { entry } = found;
    const t = esc(req.params.token);
    res.type("html").send(`<!doctype html><meta name="viewport" content="width=device-width"><title>mock pay</title>
<body style="font:16px system-ui;background:#1b1c20;color:#fef8ec;max-width:420px;margin:40px auto;padding:0 16px">
<p>🧪 MOCK · no real money</p><h1>💸 ${esc(formatFiat(entry.body.fiatAmount, entry.body.fiatCurrency))}</h1>
<p>${entry.body.options.map((o) => esc(`${o.currency} · ${o.method ?? o.network}`)).join("<br>")}</p>
${["paid", "short", "expire"].map((a) => `<form method="post" action="/mock/pay/${t}/${a}"><button style="font-size:18px;margin:6px 0;padding:10px 16px">${{ paid: "✅ pay", short: "⚠️ pay 5% short", expire: "⌛ expire" }[a]}</button></form>`).join("")}
</body>`);
  });

  app.post("/mock/pay/:token/:action", async (req, res) => {
    const found = find(req.params.token);
    if (!found || !found.tip) {
      res.status(404).send("unknown pay link");
      return;
    }
    const { entry, tip } = found;
    const option = entry.body.options[0]!;
    const units = option.currency === "Btc" ? 1e8 : option.currency === "Sol" || option.currency === "Eth" ? 1e9 : 1e6;
    const amountSats = Math.max(1, Math.round((entry.body.fiatAmount / (option.currency === "Btc" ? 60000 : option.currency === "Eth" ? 3000 : option.currency === "Sol" ? 150 : 1)) * units));
    const base = {
      draftId: randomUUID(),
      paymentRequestId: entry.response.id,
      orderId: tip.orderId,
      sentCurrency: option.currency.toUpperCase(),
      network: option.network,
      fiatCurrency: entry.body.fiatCurrency,
      fiatAmount: entry.body.fiatAmount,
      amountSats,
      sentAmount: (amountSats / units).toFixed(Math.log10(units)),
      occurredAt: new Date().toISOString(),
    };
    const body =
      req.params.action === "paid"
        ? { event: "draft.confirmed", data: { ...base, status: "Confirmed", txId: `mock-${randomUUID()}`, confirmations: 1 } }
        : req.params.action === "short"
          ? { event: "draft.amount_mismatch", data: { ...base, status: "AwaitingPayment", reviewState: "pending", receivedAmountSats: Math.round(amountSats * 0.95) } }
          : { event: "payment_request.expired", data: { paymentRequestId: entry.response.id, orderId: tip.orderId, opened: true, quoteRequested: false } };
    const raw = JSON.stringify(body);
    const deliveryId = randomUUID();
    const r = await fetch(`${selfUrl}/webhooks/send21`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-send21-event": body.event,
        "x-send21-delivery": deliveryId,
        "x-send21-signature-v2": signV2(raw, deliveryId, Math.floor(Date.now() / 1000), secret),
      },
      body: raw,
    });
    res.type("html").send(`<body style="font:18px system-ui;background:#1b1c20;color:#fef8ec;text-align:center;padding:60px">${r.ok ? "📨 sent " + esc(body.event) : "❌ " + r.status}<p>Check Discord.</p></body>`);
  });
}
