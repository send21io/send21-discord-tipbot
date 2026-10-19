import { Events } from "discord.js";
import { createBot } from "./bot.js";
import { loadConfig } from "./config.js";
import { createMockClient, createSend21Client } from "./send21.js";
import { Store } from "./store.js";
import { createWebhookApp } from "./webhook.js";

const cfg = loadConfig();
const store = new Store(cfg.dataFile);
const selfUrl = `http://127.0.0.1:${cfg.port}`;
const mockClient = cfg.mock ? createMockClient(cfg.mockPayBase) : null;
const send21 = mockClient ?? createSend21Client({ apiBase: cfg.send21ApiBase, apiKey: cfg.send21ApiKey as string });

const bot = createBot(cfg, store, send21);
const app = createWebhookApp({
  store,
  secret: cfg.webhookSecret,
  onTipChanged: bot.updateTipMessage,
  ...(mockClient ? { mock: { client: mockClient, selfUrl } } : {}),
});

app.listen(cfg.port, () => {
  console.log(`🪝 webhook on :${cfg.port}/webhooks/send21${cfg.mock ? "  🧪 MOCK mode: no send21 calls, pay links open ${cfg.mockPayBase}/mock/pay/…" : ""}`);
});
bot.client.once(Events.ClientReady, (c) => console.log(`🤖 logged in as ${c.user.tag}`));
await bot.login();
