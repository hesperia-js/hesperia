import { elysia } from "@hesperia/elysia";
import { defineConfig } from "@hesperia/tooling";

export default defineConfig({
  mountURL: "/",
  plugins: [elysia({ serverModule: "./src/server.ts", appExport: "app" })],
});
