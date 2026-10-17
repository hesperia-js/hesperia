import { defineConfig } from "@hesperia/tooling";
import { elysia } from "@hesperia/elysia";

export default defineConfig({
  mountURL: "/dashboard",
  plugins: [elysia({ serverModule: "./src/server.ts", appExport: "app" })],
});
