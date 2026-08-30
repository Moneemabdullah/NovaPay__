import { defineConfig } from "vitest/config";

// Runs the DB-backed integration tests. Requires a local Postgres
// (docker compose up -d postgres) with migrations applied (make migrate).
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.integration.test.ts"],
    exclude: ["node_modules/**"],
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});