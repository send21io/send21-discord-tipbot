import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { createTip, prepareTip, type TipInput } from "../src/create-tip.js";
import { createMockClient } from "../src/send21.js";
import { Store } from "../src/store.js";
import type { Tip } from "../src/types.js";
import { createWebhookApp } from "../src/webhook.js";
import { listen, SECRET } from "./helpers.js";

const input: TipInput = { guildId: "g", channelId: "c", fromId: "a", toId: "b", toIsBot: false, amount: 5, currency: "EUR", note: null };
const cfg = { tipMax: 500, tipExpiryHours: 24, shortfallPercent: 2 };
const closers: (() => Promise<void>)[] = [];
afterEach(async () => void (await Promise.all(closers.splice(0).map((c) => c()))));

async function world() {
  const store = new Store(":memory:");
  store.saveCoin("b", "usdc-sol", "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU");
  store.saveCoin("b", "btc-ln", "b@wallet.example");
  const client = createMockClient("http://localhost:3000");
  const changed: Tip[] = [];
  const mock = { client, selfUrl: "" };
  const server = await listen(createWebhookApp({ store, secret: SECRET, onTipChanged: async (t) => void changed.push(t), log: () => undefined, mock }));
  mock.selfUrl = server.url;
  closers.push(server.close);
  const prepared = prepareTip(store, cfg, input);
  if (!prepared.ok) throw new Error(prepared.error);
  const tip = await createTip(store, client, cfg, input, prepared);
  const path = new URL(tip.payUrl).pathname;
  const act = (a: string, coin = "0") => fetch(`${server.url}${path}/${a}`, { method: "POST", body: new URLSearchParams({ coin }) });
  return { store, tip, changed, url: server.url, path, act };
}

describe("🧪 mock pay page", () => {
  it("renders a dark, labelled page with a coin picker", async () => {
    const w = await world();
    const html = await (await fetch(`${w.url}${w.path}`)).text();
    expect(html).toContain('<html lang="en">');
    expect(html).toContain('<label for="coin">');
    expect(html).toContain("USDC · Solana");
    expect(html).toContain("BTC · Lightning");
  });

  it("✅ pays with the coin you picked (it always used the first one)", async () => {
    const w = await world();
    const r = await w.act("paid", "1");
    expect(await r.text()).toContain("📨 sent <code>draft.confirmed</code>");
    const tip = w.store.getTip(w.tip.id)!;
    expect(tip.status).toBe("paid");
    expect(tip.paid).toMatchObject({ currency: "BTC", network: "Mainnet" });
  });

  it("an unknown action is a 404 and does NOT expire the tip (it used to)", async () => {
    const w = await world();
    expect((await w.act("oops")).status).toBe(404);
    expect(w.store.getTip(w.tip.id)?.status).toBe("open");
  });

  it("👍 accept the short pay → paid with a different amount; ↩️ decline → declined", async () => {
    const w = await world();
    await w.act("short");
    expect(w.store.getTip(w.tip.id)?.status).toBe("review");
    expect(await (await w.act("accept")).text()).toContain("draft.mismatch_accepted → draft.confirmed");
    expect(w.store.getTip(w.tip.id)?.paid?.differentAmount).toBe(true);

    const v = await world();
    await v.act("short");
    await v.act("decline");
    expect(v.store.getTip(v.tip.id)?.status).toBe("declined");
  });
});

describe("config", () => {
  const env = { DISCORD_TOKEN: "t", DISCORD_APP_ID: "1" };
  it("mock pay links stay on this machine even with the example PUBLIC_URL (they pointed at tips.example.com)", () => {
    expect(loadConfig({ ...env, PUBLIC_URL: "https://tips.example.com", PORT: "3005" }).mockPayBase).toBe("http://localhost:3005");
  });
  it("explains that Discord is needed even in mock mode", () => {
    expect(() => loadConfig({})).toThrow(/DISCORD_TOKEN is missing.*even in mock mode/);
  });
});
