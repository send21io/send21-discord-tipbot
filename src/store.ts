import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { SavedCoin, Tip } from "./types.js";

// One JSON file, written atomically (temp file + rename). Every change runs in
// `transaction()`: the in-memory state is changed, the file is written, and
// only then does the caller answer send21 with 2xx. If the write fails, the
// state is reloaded from disk and the error is thrown (send21 retries later).
//
// Good for one bot process. For many processes use SQLite (see
// send21-examples/examples/webhook-receiver-sqlite) or Postgres.

interface Data {
  version: 1;
  users: Record<string, { coins: SavedCoin[] }>;
  tips: Record<string, Tip>;
  /** X-Send21-Delivery id -> first seen (ms) */
  deliveries: Record<string, number>;
  /** sha256 of event + raw body -> first seen (ms): the same event under a new delivery id */
  events: Record<string, number>;
}

const empty = (): Data => ({ version: 1, users: {}, tips: {}, deliveries: {}, events: {} });
const KEEP_MS = 30 * 24 * 3600_000; // retries span hours; 30 days is plenty

export class Store {
  private data: Data;

  constructor(private readonly file: string) {
    this.data = this.load();
  }

  private load(): Data {
    if (this.file === ":memory:" || !existsSync(this.file)) return empty();
    const parsed = JSON.parse(readFileSync(this.file, "utf8")) as Partial<Data>;
    return { ...empty(), ...parsed, version: 1 };
  }

  private persist(): void {
    if (this.file === ":memory:") return;
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data), { mode: 0o600 });
    renameSync(tmp, this.file);
  }

  /** Run fn against the data and write it. All or nothing. */
  transaction<T>(fn: (d: Data) => T): T {
    try {
      const result = fn(this.data);
      this.persist();
      return result;
    } catch (err) {
      this.data = this.load();
      throw err;
    }
  }

  // ---------- users ----------
  getCoins(userId: string): SavedCoin[] {
    return this.data.users[userId]?.coins ?? [];
  }

  saveCoin(userId: string, coin: string, address: string): void {
    this.transaction((d) => {
      const coins = (d.users[userId]?.coins ?? []).filter((c) => c.coin !== coin);
      coins.push({ coin, address, savedAt: new Date().toISOString() });
      d.users[userId] = { coins };
    });
  }

  removeCoin(userId: string, coin: string | null): number {
    return this.transaction((d) => {
      const before = d.users[userId]?.coins ?? [];
      const after = coin ? before.filter((c) => c.coin !== coin) : [];
      if (after.length) d.users[userId] = { coins: after };
      else delete d.users[userId];
      return before.length - after.length;
    });
  }

  // ---------- tips ----------
  putTip(tip: Tip): void {
    this.transaction((d) => {
      d.tips[tip.id] = tip;
    });
  }

  getTip(id: string): Tip | undefined {
    return this.data.tips[id];
  }

  latestTip(): Tip | undefined {
    return Object.values(this.data.tips).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  }

  findTip({ orderId, paymentRequestId }: { orderId?: unknown; paymentRequestId?: unknown }): Tip | undefined {
    const tips = Object.values(this.data.tips);
    if (typeof orderId === "string" && orderId) return tips.find((t) => t.orderId === orderId);
    if (typeof paymentRequestId === "string" && paymentRequestId) return tips.find((t) => t.paymentRequestId === paymentRequestId);
    return undefined;
  }

  // ---------- dedupe (call inside a transaction) ----------
  /**
   * Remember a verified delivery. Returns false when the delivery id, or the
   * exact same event body, was already handled.
   */
  static remember(d: Data, deliveryId: string, eventKey: string, now = Date.now()): boolean {
    if (d.deliveries[deliveryId] !== undefined || d.events[eventKey] !== undefined) return false;
    d.deliveries[deliveryId] = now;
    d.events[eventKey] = now;
    for (const map of [d.deliveries, d.events]) {
      for (const [k, at] of Object.entries(map)) if (now - at > KEEP_MS) delete map[k];
    }
    return true;
  }
}

export type StoreData = Data;
