const env = (key: string, fallback: string) => process.env[key] ?? fallback;

export const config = {
  nodeEnv: env("NODE_ENV", "development"),
  port: Number(process.env.PORT ?? 3000),
  serviceUrls: {
    accounts: env("ACCOUNT_SERVICE_URL", "http://account-service:3001"),
    transactions: env(
      "TRANSACTION_SERVICE_URL",
      "http://transaction-service:3002",
    ),
    ledger: env("LEDGER_SERVICE_URL", "http://ledger-service:3003"),
    fx: env("FX_SERVICE_URL", "http://fx-service:3004"),
    payroll: env("PAYROLL_SERVICE_URL", "http://payroll-service:3005"),
    admin: env("ADMIN_SERVICE_URL", "http://admin-service:3006"),
  },
} as const;
