const env = (key: string, fallback: string) => process.env[key] ?? fallback;

export const config = {
  nodeEnv: env("NODE_ENV", "development"),
  port: Number(process.env.PORT ?? 3001),
  logLevel: env("LOG_LEVEL", "info"),
  databaseUrl: env(
    "DATABASE_URL",
    "postgres://novapay:novapay@localhost:5432/account_db",
  ),
  fieldEncryptionKek: env("FIELD_ENCRYPTION_KEK", "local-development-kek-only"),
} as const;
