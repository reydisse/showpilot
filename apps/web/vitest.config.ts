import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    environment: "jsdom",
    globals: true,
    // Native adapter tests use JavaScript to keep React Native ambient globals
    // out of the web TypeScript project. Their source is checked by mobile tsc.
    include: ["src/**/*.test.{js,ts,tsx}"],
    exclude: ["src/**/*.worker.test.{ts,tsx}"],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      "cloudflare:workers": path.resolve(__dirname, "./src/test/cloudflare-workers.ts"),
    },
  },
});
