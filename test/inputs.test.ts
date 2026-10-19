import { describe, expect, it } from "vitest";
import { createTip, prepareTip, type TipInput } from "../src/create-tip.js";
import { checkAddress, COINS, coinById, parseTipAmount } from "../src/currencies.js";
import { tipMessage } from "../src/embed.js";
import { cleanNote } from "../src/sanitize.js";
import { createMockClient } from "../src/send21.js";
import { Store } from "../src/store.js";
import { makeTip } from "./helpers.js";

describe("coins", () => {
  it("lists only pairs send21 supports", () => {
    const pairs = COINS.map((c) => `${c.currency}/${c.network}`);
    for (const bad of ["Usdt/Base", "Usdt/Arbitrum", "Usdt/Polygon", "Btc/Base", "Eurc/Arbitrum", "Eth/Polygon"]) expect(pairs).not.toContain(bad);
    expect(pairs).toContain("Usdt/Solana");
    expect(pairs).toContain("Usdt/Ethereum");
  });
});

describe("addresses", () => {
  const coin = (id: string) => coinById(id)!;
  it("accepts real-looking addresses", () => {
    expect(checkAddress(coin("btc"), "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq").ok).toBe(true);
    expect(checkAddress(coin("btc-ln"), "Name@Wallet.example")).toEqual({ ok: true, address: "name@wallet.example" });
    expect(checkAddress(coin("usdc-sol"), "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU").ok).toBe(true);
    expect(checkAddress(coin("eth-base"), "0x52908400098527886E0F7030069857D2E4169EE7").ok).toBe(true);
  });
  it("refuses wrong networks, the zero address and secrets", () => {
    expect(checkAddress(coin("usdc-sol"), "0x52908400098527886E0F7030069857D2E4169EE7").ok).toBe(false);
    expect(checkAddress(coin("eth-eth"), "0x" + "0".repeat(40)).ok).toBe(false);
    const seed = "abandon ability able about above absent absorb abstract absurd abuse access accident";
    expect(checkAddress(coin("btc"), seed)).toMatchObject({ ok: false, error: expect.stringContaining("seed phrase") });
    expect(checkAddress(coin("eth-eth"), "0x" + "ab".repeat(32))).toMatchObject({ ok: false, error: expect.stringContaining("private key") });
  });
});

describe("amounts and notes", () => {
  it("parses strictly", () => {
    expect(parseTipAmount(5, "EUR", 500)).toEqual({ ok: true, amount: 5 });
    expect(parseTipAmount(2.5, "USD", 500)).toEqual({ ok: true, amount: 2.5 });
    expect(parseTipAmount(1.234, "EUR", 500).ok).toBe(false);
    expect(parseTipAmount(0.2, "EUR", 500).ok).toBe(false);
    expect(parseTipAmount(501, "EUR", 500).ok).toBe(false);
    expect(parseTipAmount(10.5, "JPY", 500).ok).toBe(false);
    expect(parseTipAmount(Number.NaN, "EUR", 500).ok).toBe(false);
  });
  it("cleans notes", () => {
    expect(cleanNote("  gg\u200b  wp ")).toEqual({ ok: true, note: "gg wp" });
    expect(cleanNote("free nitro https://evil.example").ok).toBe(false);
    expect(cleanNote("hi @everyone").ok).toBe(false);
    expect(cleanNote("**bold** [x]").ok && cleanNote("**bold** [x]")).toMatchObject({ note: "\\*\\*bold\\*\\* \\[x\\]" });
    expect(cleanNote("\u202egnp.exe").ok && cleanNote("\u202egnp.exe")).toMatchObject({ note: "gnp.exe" });
  });
});

describe("creating a tip", () => {
  const input: TipInput = { guildId: "g", channelId: "c", fromId: "a", toId: "b", toIsBot: false, amount: 5, currency: "EUR", note: "gg" };
  const cfg = { tipMax: 500, tipExpiryHours: 24, shortfallPercent: 2 };

  it("needs a receiver who set up a coin, and no self or bot tips", () => {
    const store = new Store(":memory:");
    expect(prepareTip(store, cfg, input)).toMatchObject({ ok: false, error: expect.stringContaining("/tipme set") });
    expect(prepareTip(store, cfg, { ...input, toId: "a" })).toMatchObject({ ok: false });
    expect(prepareTip(store, cfg, { ...input, toIsBot: true })).toMatchObject({ ok: false });
  });

  it("creates a pay link with the receiver's own addresses", async () => {
    const store = new Store(":memory:");
    store.saveCoin("b", "usdc-sol", "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU");
    store.saveCoin("b", "btc-ln", "b@wallet.example");
    const prepared = prepareTip(store, cfg, input);
    if (!prepared.ok) throw new Error(prepared.error);
    const mock = createMockClient("http://localhost:3000");
    const tip = await createTip(store, mock, cfg, input, prepared);
    const body = [...mock.requests.values()][0]!.body;
    expect(body).toMatchObject({
      fiatCurrency: "EUR",
      fiatAmount: 5,
      orderId: tip.orderId,
      expiryHours: 24,
      shortfallPolicy: { absorbUpToPercent: 2, absorbedBy: "receiver" },
      options: [
        { currency: "Usdc", network: "Solana", address: "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU" },
        { currency: "Btc", network: "Mainnet", address: "b@wallet.example", method: "Lightning" },
      ],
    });
    expect(body.memo).toBe("Discord tip 5.00 EUR: gg"); // no Discord names or ids on the public pay page
    expect(tip.payUrl).toMatch(/^http:\/\/localhost:3000\/mock\/pay\//);
    expect(store.getTip(tip.id)?.status).toBe("open");
  });
});

describe("embed", () => {
  it("shows a Pay button while open and none once paid", () => {
    const open = tipMessage(makeTip(), Buffer.from("png")).components[0]!.toJSON();
    expect(open.components[0]).toMatchObject({ label: "Pay", url: "https://send21.io/pay/abc" });
    const paid = tipMessage(makeTip({ status: "paid", paid: { currency: "USDC", network: "Solana", amount: "5.430000", txId: "x", differentAmount: false, at: "2026-10-19T10:05:00.000Z" } }));
    expect(paid.components).toHaveLength(0);
    expect(paid.embeds[0]!.toJSON().title).toBe("✅ 5.00 EUR");
  });
});
