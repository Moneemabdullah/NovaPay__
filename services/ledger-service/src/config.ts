const env = (key: string, fallback: string) => process.env[key] ?? fallback;

export const config = {
  nodeEnv: env("NODE_ENV", "development"),
  port: Number(process.env.PORT ?? 3003),
  databaseUrl: env(
    "DATABASE_URL",
    "postgres://novapay:novapay@localhost:5432/ledger_db",
  ),
} as const;
