#!/usr/bin/env bun
const { runToolingMain }: typeof import("./cli-main.ts") = await import(
  import.meta.resolve("#hesperia-cli-main")
);

await runToolingMain(process.argv.slice(2));
