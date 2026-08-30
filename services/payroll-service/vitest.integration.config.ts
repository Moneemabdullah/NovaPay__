import { defineConfig } from "vitest/config";

// Runs the DB-backed integration tests. Requires local Postgres + Redis
// (docker compose up -d postgres redis) with migrations applied (make migrate).
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.integration.test.ts"],
    exclude: ["node_modules/**"],
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 30_000,
  },
});