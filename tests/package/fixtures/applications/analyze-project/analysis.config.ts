import { defineConfig } from "@hesperia/tooling";
import { createAnalyzeProjectPlugin } from "./plugins/analyze-project-plugin.mjs";

export default defineConfig({ plugins: [createAnalyzeProjectPlugin()] });
