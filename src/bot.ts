import { Client, Events, GatewayIntentBits, MessageFlags, type ChatInputCommandInteraction } from "discord.js";
import type { Config } from "./config.js";
import { createTip, prepareTip } from "./create-tip.js";
import { checkAddress, coinById, shortAddress } from "./currencies.js";
import { qrFor, STATUS, tipMessage } from "./embed.js";
import { friendlyError, type Send21Client } from "./send21.js";
import type { Store } from "./store.js";
import type { Tip } from "./types.js";

// Small in-memory limiter: 5 tips per user per minute.
const recent = new Map<string, number[]>();
export function allowTip(userId: string, now = Date.now(), limit = 5, windowMs = 60_000): boolean {
  const hits = (recent.get(userId) ?? []).filter((t) => now - t < windowMs);
  if (hits.length >= limit) return false;
  hits.push(now);
  recent.set(userId, hits);
  return true;
}

export function createBot(cfg: Config, store: Store, send21: Send21Client) {
  // Only the Guilds intent: no message content, no member lists.
  const client = new Client({ intents: [GatewayIntentBits.Guilds] });

  const ephemeral = (i: ChatInputCommandInteraction, content: string) =>
    i.replied || i.deferred ? i.editReply({ content, embeds: [], components: [], files: [] }) : i.reply({ content, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });

  async function onTip(i: ChatInputCommandInteraction) {
    if (!i.inGuild() || !i.channelId) return ephemeral(i, "🏠 tips work in servers only");
    const to = i.options.getUser("user", true);
    const input = {
      guildId: i.guildId,
      channelId: i.channelId,
      fromId: i.user.id,
      toId: to.id,
      toIsBot: to.bot,
      amount: i.options.getNumber("amount", true),
      currency: i.options.getString("currency", true),
      note: i.options.getString("note"),
    };
    const prepared = prepareTip(store, cfg, input);
    if (!prepared.ok) return ephemeral(i, prepared.error);
    if (!allowTip(i.user.id)) return ephemeral(i, "🐢 slow down, try again in a minute");

    await i.deferReply();
    let tip: Tip;
    try {
      tip = await createTip(store, send21, cfg, input, prepared);
    } catch (err) {
      console.error(`tip failed: ${(err as Error).message}`);
      await i.editReply({ content: friendlyError(err) });
      return;
    }
    const msg = await i.editReply({ ...tipMessage(tip, await qrFor(tip.payUrl)), allowedMentions: { users: [tip.toId] } });
    store.putTip({ ...(store.getTip(tip.id) ?? tip), messageId: msg.id });
  }

  async function onTipme(i: ChatInputCommandInteraction) {
    const sub = i.options.getSubcommand();
    if (sub === "set") {
      const coin = coinById(i.options.getString("coin", true));
      if (!coin) return ephemeral(i, "❌ unknown coin");
      const check = checkAddress(coin, i.options.getString("address", true));
      if (!check.ok) return ephemeral(i, check.error);
      store.saveCoin(i.user.id, coin.id, check.address);
      return ephemeral(i, `✅ ${coin.emoji} ${coin.label} → \`${shortAddress(check.address)}\`\n-# Tips go straight to this address. Double-check it.`);
    }
    if (sub === "show") {
      const coins = store.getCoins(i.user.id);
      if (!coins.length) return ephemeral(i, "🫥 nothing yet → `/tipme set`");
      return ephemeral(i, coins.map((c) => { const coin = coinById(c.coin); return `${coin?.emoji ?? "🪙"} ${coin?.label ?? c.coin} → \`${shortAddress(c.address)}\``; }).join("\n"));
    }
    const removed = store.removeCoin(i.user.id, i.options.getString("coin"));
    return ephemeral(i, removed ? `🗑️ removed ${removed}` : "🫥 nothing to remove");
  }

  client.on(Events.InteractionCreate, async (i) => {
    if (!i.isChatInputCommand()) return;
    try {
      if (i.commandName === "tip") await onTip(i);
      else if (i.commandName === "tipme") await onTipme(i);
    } catch (err) {
      console.error(`interaction failed: ${(err as Error).message}`);
      await ephemeral(i, "😵 something broke. Try again.").catch(() => undefined);
    }
  });

  // Edits for one tip run one after the other and always render the latest stored state.
  const queue = new Map<string, Promise<void>>();
  async function render(tipId: string) {
    const tip = store.getTip(tipId);
    if (!tip?.messageId) return;
    const channel = await client.channels.fetch(tip.channelId);
    if (!channel?.isTextBased()) return;
    const qr = STATUS[tip.status].live ? await qrFor(tip.payUrl) : undefined;
    await channel.messages.edit(tip.messageId, { ...tipMessage(tip, qr), attachments: [], allowedMentions: { parse: [] } });
  }
  const updateTipMessage = (tip: Tip): Promise<void> => {
    const next = (queue.get(tip.id) ?? Promise.resolve()).catch(() => undefined).then(() => render(tip.id));
    queue.set(tip.id, next);
    return next.finally(() => { if (queue.get(tip.id) === next) queue.delete(tip.id); });
  };

  return { client, updateTipMessage, login: () => client.login(cfg.discordToken) };
}
