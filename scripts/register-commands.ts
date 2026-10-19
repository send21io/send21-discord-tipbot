// npm run register: push /tip and /tipme to Discord.
// With DISCORD_GUILD_ID they show up in that server at once; without it, globally.
import "dotenv/config";
import { REST, Routes } from "discord.js";
import { commands } from "../src/commands.js";

const token = process.env.DISCORD_TOKEN;
const appId = process.env.DISCORD_APP_ID;
const guildId = process.env.DISCORD_GUILD_ID;
if (!token || !appId) throw new Error("DISCORD_TOKEN and DISCORD_APP_ID are required");

const rest = new REST().setToken(token);
const route = guildId ? Routes.applicationGuildCommands(appId, guildId) : Routes.applicationCommands(appId);
await rest.put(route, { body: commands });
console.log(`✅ ${commands.length} commands registered ${guildId ? `in guild ${guildId}` : "globally"}`);
