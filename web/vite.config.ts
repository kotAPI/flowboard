/// <reference types="vitest" />
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // same-origin in dev too: the SPA calls /v1/* and Vite forwards it, like nginx does in Docker
    proxy: { "/v1": process.env.API_PROXY_TARGET ?? "http://localhost:3000" },
  },
  test: {
    environment: "jsdom",
    setupFiles: ["src/test/setup.ts"],
  },
});
