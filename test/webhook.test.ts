import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Store } from "../src/store.js";
import type { Tip } from "../src/types.js";
import { createWebhookApp } from "../src/webhook.js";
import { confirmed, deliver, listen, makeTip, SECRET } from "./helpers.js";

let dir: string;
let file: string;
let server: Awaited<ReturnType<typeof listen>>;
let store: Store;
let changed: Tip[];

async function start() {
  store = new Store(file);
  changed = [];
  const app = createWebhookApp({ store, secret: SECRET, onTipChanged: async (t) => void changed.push(t), log: () => undefined });
  server = await listen(app);
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "tipbot-"));
  file = join(dir, "tipbot.json");
  new Store(file).putTip(makeTip());
  await start();
});
afterEach(async () => {
  await server.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("webhook receiver", () => {
  it("marks a matching tip paid and edits the message once", async () => {
    const res = await deliver(server.url, confirmed());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, outcome: "paid" });
    await vi.waitFor(() => expect(changed).toHaveLength(1));
    expect(store.getTip(makeTip().id)?.status).toBe("paid");
  });

  it("answers 401 for a bad signature and stores nothing", async () => {
    const res = await deliver(server.url, confirmed(), { secret: "wrong", deliveryId: "d-1" });
    expect(res.status).toBe(401);
    expect(store.getTip(makeTip().id)?.status).toBe("open");
    // The forged try did not burn the delivery id: the real delivery still counts.
    expect(await (await deliver(server.url, confirmed(), { deliveryId: "d-1" })).json()).toMatchObject({ outcome: "paid" });
  });

  it("answers 401 for a delivery older than 300 s", async () => {
    const res = await deliver(server.url, confirmed(), { t: Math.floor(Date.now() / 1000) - 301 });
    expect(res.status).toBe(401);
  });

  it("answers 400 for a signed body that is not a JSON object", async () => {
    expect((await deliver(server.url, null, { raw: "not json" })).status).toBe(400);
    expect((await deliver(server.url, null, { raw: "[1,2]" })).status).toBe(400);
  });
});

describe("dedupe", () => {
  it("applies a retried delivery id once", async () => {
    const a = await deliver(server.url, confirmed(), { deliveryId: "same" });
    const b = await deliver(server.url, confirmed({ txId: "other" }), { deliveryId: "same" });
    expect(await a.json()).toMatchObject({ outcome: "paid" });
    expect(b.status).toBe(200);
    expect(await b.json()).toEqual({ ok: true, duplicate: true });
    await vi.waitFor(() => expect(changed).toHaveLength(1));
    expect(store.getTip(makeTip().id)?.paid?.txId).toBe("5KqZ9bQ");
  });

  it("treats the same event body under a new delivery id as a duplicate", async () => {
    await deliver(server.url, confirmed(), { deliveryId: "one" });
    const b = await deliver(server.url, confirmed(), { deliveryId: "two" });
    expect(await b.json()).toEqual({ ok: true, duplicate: true });
  });

  it("remembers delivery ids across a restart", async () => {
    await deliver(server.url, { event: "draft.seen", data: { orderId: makeTip().orderId, paymentRequestId: makeTip().paymentRequestId } }, { deliveryId: "keep" });
    await server.close();
    await start();
    const again = await deliver(server.url, { event: "draft.seen", data: { orderId: makeTip().orderId } }, { deliveryId: "keep" });
    expect(await again.json()).toEqual({ ok: true, duplicate: true });
  });

  it("answers 500 and forgets the delivery when the write fails, so send21 retries", async () => {
    const spy = vi.spyOn(store as unknown as { persist: () => void }, "persist").mockImplementationOnce(() => {
      throw new Error("disk full");
    });
    expect((await deliver(server.url, confirmed(), { deliveryId: "retry-me" })).status).toBe(500);
    expect(store.getTip(makeTip().id)?.status).toBe("open");
    spy.mockRestore();
    expect(await (await deliver(server.url, confirmed(), { deliveryId: "retry-me" })).json()).toMatchObject({ outcome: "paid" });
  });

  it("never marks paid twice", async () => {
    await deliver(server.url, confirmed());
    const b = await deliver(server.url, confirmed({ txId: "second-tx" }));
    expect(await b.json()).toMatchObject({ outcome: "already_paid" });
    expect(store.getTip(makeTip().id)?.paid?.txId).toBe("5KqZ9bQ");
  });
});
