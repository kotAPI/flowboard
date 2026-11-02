import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // integration tests share one database and reset it per test
    fileParallelism: false,
    testTimeout: 20_000,
    hookTimeout: 30_000,
    env: {
      JWT_SECRET: "test-secret-at-least-16-chars",
      DATABASE_URL: process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? "postgres://flowboard:flowboard@localhost:55432/flowboard_test",
    },
  },
});
