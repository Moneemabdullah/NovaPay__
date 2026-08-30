const env = (key: string, fallback: string) => process.env[key] ?? fallback;

export const config = {
  nodeEnv: env("NODE_ENV", "development"),
  port: Number(process.env.PORT ?? 3002),
  databaseUrl: env(
    "DATABASE_URL",
    "postgres://novapay:novapay@localhost:5432/transaction_db",
  ),
  serviceUrls: {
    account: env("ACCOUNT_SERVICE_URL", "http://account-service:3001"),
    ledger: env("LEDGER_SERVICE_URL", "http://ledger-service:3003"),
    fx: env("FX_SERVICE_URL", "http://fx-service:3004"),
  },
} as const;
