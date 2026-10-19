import "dotenv/config";

export interface Config {
  discordToken: string;
  discordAppId: string;
  discordGuildId: string | null;
  send21ApiKey: string | null;
  send21ApiBase: string;
  webhookSecret: string;
  port: number;
  publicUrl: string;
  tipMax: number;
  tipExpiryHours: number;
  shortfallPercent: number;
  dataFile: string;
  mock: boolean;
}

const num = (v: string | undefined, def: number, min: number, max: number, name: string): number => {
  const n = v === undefined || v === "" ? def : Number(v);
  if (!Number.isFinite(n) || n < min || n > max) throw new Error(`${name} must be between ${min} and ${max}`);
  return n;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const need = (k: string) => {
    const v = env[k]?.trim();
    if (!v) throw new Error(`${k} is missing. Copy .env.example to .env and fill it in.`);
    return v;
  };
  const apiKey = env.SEND21_API_KEY?.trim() || null;
  const mock = !apiKey;
  const port = num(env.PORT, 3000, 1, 65535, "PORT");
  // In live mode the secret is required; in mock mode a random one is made per run.
  const webhookSecret = mock ? env.SEND21_WEBHOOK_SECRET?.trim() || cryptoRandom() : need("SEND21_WEBHOOK_SECRET");
  if (apiKey && !apiKey.startsWith("s21_")) throw new Error("SEND21_API_KEY should start with s21_");
  return {
    discordToken: need("DISCORD_TOKEN"),
    discordAppId: need("DISCORD_APP_ID"),
    discordGuildId: env.DISCORD_GUILD_ID?.trim() || null,
    send21ApiKey: apiKey,
    send21ApiBase: env.SEND21_API_BASE?.trim() || "https://send21.io",
    webhookSecret,
    port,
    publicUrl: (env.PUBLIC_URL?.trim() || `http://localhost:${port}`).replace(/\/$/, ""),
    tipMax: num(env.TIP_MAX_AMOUNT, 500, 1, 1_000_000, "TIP_MAX_AMOUNT"),
    tipExpiryHours: Math.round(num(env.TIP_EXPIRY_HOURS, 24, 1, 720, "TIP_EXPIRY_HOURS")),
    shortfallPercent: num(env.TIP_SHORTFALL_PERCENT, 2, 0, 10, "TIP_SHORTFALL_PERCENT"),
    dataFile: env.DATA_FILE?.trim() || "./data/tipbot.json",
    mock,
  };
}

function cryptoRandom(): string {
  return globalThis.crypto.randomUUID().replace(/-/g, "") + globalThis.crypto.randomUUID().replace(/-/g, "");
}
