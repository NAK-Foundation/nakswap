import { fileURLToPath, URL } from "url";
import { defineConfig, mergeConfig } from "vitest/config";
import viteConfig from "./vite.config.js";

// Vitest uses this file INSTEAD of vite.config.js when present, so the app's
// own Vite config (the `@` alias, the React plugin, env injection) is merged in
// explicitly rather than silently dropped.
export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      environment: "jsdom",
      setupFiles: [fileURLToPath(new URL("./src/__tests__/setup.ts", import.meta.url))],
      include: ["src/**/*.{test,spec}.{ts,tsx}"],
      // The backend lane lives under app/test/ and must never be collected by
      // the frontend suite.
      exclude: ["**/node_modules/**", "**/dist/**"],
      // The build container sets conflicting thread bounds that make Vitest's
      // default pool throw `options.minThreads and options.maxThreads must not
      // conflict`. Pinning a single fork sidesteps the conflict and keeps the
      // suite deterministic.
      pool: "forks",
      poolOptions: {
        forks: { minForks: 1, maxForks: 1 },
      },
    },
  }),
);
