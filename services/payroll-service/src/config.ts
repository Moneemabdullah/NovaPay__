const env = (key: string, fallback: string) => process.env[key] ?? fallback;

export const config = {
  nodeEnv: env("NODE_ENV", "development"),
  port: Number(process.env.PORT ?? 3005),
  databaseUrl: env(
    "DATABASE_URL",
    "postgres://novapay:novapay@localhost:5432/payroll_db",
  ),
  redisUrl: env("REDIS_URL", "redis://redis:6379"),
  transactionServiceUrl: env(
    "TRANSACTION_SERVICE_URL",
    "http://transaction-service:3002",
  ),
  queueName: env("QUEUE_NAME", "payroll"),
} as const;
