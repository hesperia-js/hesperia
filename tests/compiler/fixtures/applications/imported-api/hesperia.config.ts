import { defineConfig } from "@hesperia/tooling";
import { elysia } from "@hesperia/elysia";

export default defineConfig({
  plugins: [
    elysia({
      serverModule: "./src/server.ts",
      appExport: "app",
      clientEffectsModule: "./src/client-effects.ts",
      clientEffectsExport: "effects",
    }),
  ],
});
