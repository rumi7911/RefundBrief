/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Frontend dev server proxies API calls to the loopback-only backend.
export default defineConfig({
  plugins: [react()],
  ssr: { external: ["node:sqlite"] },
  test: {
    environment: "node",
    include: ["server/**/*.test.{ts,tsx}"],
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:4100",
        changeOrigin: false,
      },
    },
  },
  build: {
    outDir: "dist",
    sourcemap: false,
  },
});
