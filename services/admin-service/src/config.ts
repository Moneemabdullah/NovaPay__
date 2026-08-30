const env = (key: string, fallback: string) => process.env[key] ?? fallback;

export const config = {
  nodeEnv: env("NODE_ENV", "development"),
  port: Number(process.env.PORT ?? 3006),
  databaseUrl: env(
    "DATABASE_URL",
    "postgres://novapay:novapay@localhost:5432/admin_db",
  ),
  ledgerServiceUrl: env("LEDGER_SERVICE_URL", "http://ledger-service:3003"),
} as const;
