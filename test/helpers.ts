import type { AddressInfo } from "node:net";
import type { Express } from "express";
import type { Tip } from "../src/types.js";
import { signV2 } from "../src/verify.js";

export const SECRET = "whsec_test_only_not_a_real_secret";

export function makeTip(over: Partial<Tip> = {}): Tip {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    orderId: "tip-11111111-1111-4111-8111-111111111111",
    guildId: "g1",
    channelId: "c1",
    messageId: "m1",
    fromId: "u-from",
    toId: "u-to",
    fiatAmount: 5,
    fiatCurrency: "EUR",
    note: null,
    options: [
      { currency: "Usdc", network: "Solana", address: "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU" },
      { currency: "Btc", network: "Mainnet", address: "you@wallet.example", method: "Lightning" },
    ],
    paymentRequestId: "8d1e4b7a-0c2f-4e6d-b3a9-7f5c1e2d4a6b",
    payUrl: "https://send21.io/pay/abc",
    expiresAt: "2026-10-20T10:00:00.000Z",
    status: "open",
    createdAt: "2026-10-19T10:00:00.000Z",
    updatedAt: "2026-10-19T10:00:00.000Z",
    ...over,
  };
}

/** A draft.confirmed payload that matches makeTip() exactly (shape from docs/webhooks "Payload"). */
export function confirmed(over: Record<string, unknown> = {}) {
  return {
    event: "draft.confirmed",
    data: {
      draftId: "3f6c2a9e-5d1b-4c8e-9a7f-2b4d6e8f0a1c",
      quoteId: "9b2e7c41-6a3d-4f8e-b1c5-0d9a8e7f6c2b",
      status: "Confirmed",
      txId: "5KqZ9bQ",
      confirmations: 1,
      sentCurrency: "USDC",
      network: "Solana",
      amountSats: 5_430_000,
      sentAmount: "5.430000",
      fiatCurrency: "EUR",
      fiatAmount: 5,
      conversionRate: 0.92,
      rateSource: "coinbase",
      paymentRequestId: "8d1e4b7a-0c2f-4e6d-b3a9-7f5c1e2d4a6b",
      orderId: "tip-11111111-1111-4111-8111-111111111111",
      occurredAt: "2026-10-19T10:05:00.000Z",
      ...over,
    },
  };
}

export async function listen(app: Express): Promise<{ url: string; close: () => Promise<void> }> {
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", () => r()));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(() => r())) };
}

export function deliver(url: string, body: unknown, { deliveryId = crypto.randomUUID(), t = Math.floor(Date.now() / 1000), secret = SECRET, raw }: { deliveryId?: string; t?: number; secret?: string; raw?: string } = {}) {
  const payload = raw ?? JSON.stringify(body);
  return fetch(`${url}/webhooks/send21`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-send21-delivery": deliveryId,
      "x-send21-signature-v2": signV2(payload, deliveryId, t, secret),
    },
    body: payload,
  });
}
