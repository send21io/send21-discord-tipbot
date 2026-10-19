import { InteractionContextType, SlashCommandBuilder } from "discord.js";
import { COINS, FIATS } from "./currencies.js";

export const tipCommand = new SlashCommandBuilder()
  .setName("tip")
  .setDescription("💸 Tip someone in crypto")
  .setContexts(InteractionContextType.Guild)
  .addUserOption((o) => o.setName("user").setDescription("Who gets it").setRequired(true))
  .addNumberOption((o) => o.setName("amount").setDescription("How much").setRequired(true).setMinValue(0.5).setMaxValue(1_000_000))
  .addStringOption((o) =>
    o
      .setName("currency")
      .setDescription("Priced in")
      .setRequired(true)
      .addChoices(...FIATS.map((f) => ({ name: f, value: f }))),
  )
  .addStringOption((o) => o.setName("note").setDescription("Say thanks (optional)").setMaxLength(80));

export const tipmeCommand = new SlashCommandBuilder()
  .setName("tipme")
  .setDescription("🪙 Where you get tips")
  .setContexts(InteractionContextType.Guild)
  .addSubcommand((s) =>
    s
      .setName("set")
      .setDescription("➕ Add a coin + your own address")
      .addStringOption((o) =>
        o
          .setName("coin")
          .setDescription("Coin · network")
          .setRequired(true)
          .addChoices(...COINS.map((c) => ({ name: `${c.emoji} ${c.label}`, value: c.id }))),
      )
      .addStringOption((o) => o.setName("address").setDescription("Your receiving address (never a seed phrase)").setRequired(true).setMaxLength(120)),
  )
  .addSubcommand((s) => s.setName("show").setDescription("👀 What you've set"))
  .addSubcommand((s) =>
    s
      .setName("remove")
      .setDescription("🗑️ Remove a coin (or all)")
      .addStringOption((o) =>
        o
          .setName("coin")
          .setDescription("Leave empty to remove all")
          .addChoices(...COINS.map((c) => ({ name: `${c.emoji} ${c.label}`, value: c.id }))),
      ),
  );

export const commands = [tipCommand, tipmeCommand].map((c) => c.toJSON());
