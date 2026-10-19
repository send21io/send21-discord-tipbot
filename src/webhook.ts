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

const MOCK_ACTIONS: [string, string][] = [["paid", "✅ pay"], ["seen", "👀 start paying"], ["short", "⚠️ pay 5% short"], ["accept", "👍 accept the short pay"], ["decline", "↩️ decline the short pay"], ["expire", "⌛ let it expire"]];

const MOCK_CSS = `:root{--o:#f7931a;--o2:#ffad42;--ink:#f4f1ea;--mut:#a29c90;--line:#ffffff17}*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:grid;place-items:center;padding:16px 0;font:16px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:var(--ink);background:radial-gradient(900px 600px at 50% -10%,#f7931a26,transparent 70%),#0b0b0f}
:focus-visible{outline:2px solid var(--o);outline-offset:2px}
main{width:min(92vw,400px);background:#15161b;border:1px solid var(--line);border-radius:24px;padding:22px;box-shadow:0 20px 60px #0009;text-align:center}
.tag{display:inline-block;margin:0 0 6px;padding:4px 12px;border-radius:999px;background:#f7931a22;color:var(--o2);font-size:13px}
.big{font-size:38px;font-weight:800;margin:6px 0 2px}.memo,.foot{color:var(--mut)}.memo{margin:0 0 12px}.foot{font-size:13px;margin:12px 0 0}
.pill{display:inline-block;margin:0 0 8px;padding:5px 12px;border-radius:999px;font-size:13px}.ok{background:#3ddc8422;color:#3ddc84}.bad{background:#ff6b6b22;color:#ff6b6b}
code{font:12px ui-monospace,monospace}form{text-align:left;margin-top:8px}label{display:block;color:var(--mut);font-weight:700;font-size:14px;margin-bottom:6px}
select{width:100%;background:#0f1013;color:var(--ink);border:1px solid var(--line);border-radius:14px;padding:12px;font:inherit;font-weight:700}
.acts{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:10px}
.acts button{min-height:48px;border:1px solid var(--line);border-radius:14px;padding:9px;background:#ffffff10;color:var(--ink);font:700 14px system-ui,sans-serif;cursor:pointer}
.acts button:hover{background:#ffffff1c}.acts .main{grid-column:1/-1;min-height:54px;font-size:18px;border:0;background:linear-gradient(180deg,var(--o2),var(--o));color:#1b1100}
.acts button:last-child:nth-child(even){grid-column:1/-1}`;

const page = (body: string) =>
  `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#0b0b0f"><link rel="icon" href="data:,"><title>mock pay · send21</title><style>${MOCK_CSS}</style><main>${body}</main></html>`;

const unknown = (what: string) => page(`<p class="big">🤷</p><p>${what}</p><p class="foot">↩️ go back to Discord</p>`);

type MockEntry = NonNullable<ReturnType<ReturnType<typeof createMockClient>["requests"]["get"]>>;

/** Webhook bodies shaped like send21's (docs/webhooks "Payload") for one simulated action, or null for an unknown one. */
export function mockEvents(entry: MockEntry, coin: number, action: string) {
  const option = entry.body.options[coin] ?? entry.body.options[0]!;
  const units = option.currency === "Btc" ? 1e8 : option.currency === "Sol" || option.currency === "Eth" ? 1e9 : 1e6;
  const price = option.currency === "Btc" ? 60000 : option.currency === "Eth" ? 3000 : option.currency === "Sol" ? 150 : 1;
  const amountSats = Math.max(1, Math.round((entry.body.fiatAmount / price) * units));
  const short = Math.round(amountSats * 0.95);
  const base = {
    draftId: `mock-draft-${entry.response.id}`,
    paymentRequestId: entry.response.id,
    orderId: entry.body.orderId,
    sentCurrency: option.currency.toUpperCase(),
    network: option.network,
    fiatCurrency: entry.body.fiatCurrency,
    fiatAmount: entry.body.fiatAmount,
    amountSats,
    sentAmount: (amountSats / units).toFixed(Math.log10(units)),
    occurredAt: new Date().toISOString(),
  };
  const tx = `mock-${randomUUID()}`;
  switch (action) {
    case "paid":
      return [{ event: "draft.confirmed", data: { ...base, status: "Confirmed", txId: tx, confirmations: 1 } }];
    case "seen":
      return [{ event: "draft.seen", data: { ...base, status: "Seen", txId: tx, confirmations: 0 } }];
    case "short":
      return [{ event: "draft.amount_mismatch", data: { ...base, status: "AwaitingPayment", reviewState: "pending", receivedAmountSats: short } }];
    case "accept":
      return [
        { event: "draft.mismatch_accepted", data: { ...base, status: "AwaitingPayment", receivedAmountSats: short, acceptReason: "mock: accepted" } },
        { event: "draft.confirmed", data: { ...base, status: "Confirmed", txId: tx, confirmations: 1, receivedAmountSats: short } },
      ];
    case "decline":
      return [{ event: "draft.mismatch_rejected", data: { ...base, receivedAmountSats: short, rejectReason: "mock: declined", refund: "manual" } }];
    case "expire":
      return [{ event: "payment_request.expired", data: { paymentRequestId: entry.response.id, orderId: entry.body.orderId, opened: true, quoteRequested: false } }];
    default:
      return null;
  }
}

function mountMock(app: Express, store: Store, secret: string, mock: NonNullable<WebhookDeps["mock"]>): void {
  const { client } = mock;
  const find = (token: string) => {
    const entry = client.requests.get(token);
    return entry && store.findTip({ orderId: entry.body.orderId }) ? entry : null;
  };
  const payPage = (token: string, entry: MockEntry, sent?: { ok: boolean; events: string }) => {
    const t = esc(token);
    const coins = entry.body.options.map((o, i) => `<option value="${i}">${esc(`${o.currency.toUpperCase()} · ${o.method ?? o.network}`)}</option>`).join("");
    return page(`<p class="tag">🧪 mock send21 · no real money</p><p class="big">${esc(formatFiat(entry.body.fiatAmount, entry.body.fiatCurrency))}</p><p class="memo">💸 ${esc(entry.body.memo)}</p>
${sent ? `<p class="pill ${sent.ok ? "ok" : "bad"}" role="status">${sent.ok ? "📨 sent" : "❌ refused"} <code>${esc(sent.events)}</code></p>` : ""}
<form method="post" action="/mock/pay/${t}/paid"><label for="coin">🪙 pay with</label><select id="coin" name="coin">${coins}</select>
<div class="acts">${MOCK_ACTIONS.map(([a, l]) => `<button formaction="/mock/pay/${t}/${a}"${a === "paid" ? ' class="main"' : ""}>${l}</button>`).join("")}</div></form>
<p class="foot">Each button sends a signed webhook, like send21 would. 👍 / ↩️ are what the bot admin does with a short pay on send21. ↩️ Then check Discord: the tip message updates by itself.</p>`);
  };

  app.get("/mock/pay/:token", (req, res) => {
    const entry = find(req.params.token);
    if (!entry) {
      res.status(404).type("html").send(unknown("unknown pay link"));
      return;
    }
    res.type("html").send(payPage(req.params.token, entry));
  });

  app.post("/mock/pay/:token/:action", express.urlencoded({ extended: false, limit: "1kb" }), async (req, res) => {
    const entry = find(req.params.token);
    const events = entry ? mockEvents(entry, Number((req.body as { coin?: string } | undefined)?.coin ?? 0), req.params.action) : null;
    if (!entry || !events) {
      res.status(404).type("html").send(unknown(entry ? "unknown action" : "unknown pay link"));
      return;
    }
    let ok = true;
    for (const body of events) {
      const raw = JSON.stringify(body);
      const deliveryId = randomUUID();
      const r = await fetch(`${mock.selfUrl}/webhooks/send21`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-send21-event": body.event, "x-send21-delivery": deliveryId, "x-send21-signature-v2": signV2(raw, deliveryId, Math.floor(Date.now() / 1000), secret) },
        body: raw,
      });
      ok &&= r.ok;
    }
    res.status(ok ? 200 : 502).type("html").send(payPage(req.params.token, entry, { ok, events: events.map((e) => e.event).join(" → ") }));
  });
}
