#!/usr/bin/env bun
import { resolve } from "node:path";
import {
  checkSources,
  initProject,
  prepareBuild,
  ProjectError,
  readProject,
  writeBuild,
} from "./project.ts";
import { devProject, previewProject } from "./server.ts";
import { readConfiguration } from "./configuration.ts";
import { writeProjectTypes } from "./page-types.ts";

const [command, ...args] = process.argv.slice(2);
try {
  if (!command || command === "--help" || command === "help") {
    console.log(
      "hesperia init <directory>\nhesperia check\nhesperia build\nhesperia dev [--port <number>]\nhesperia preview [--port <number>]\nhesperia language-server",
    );
  } else if (command === "language-server") {
    if (args.length) throw new Error("Usage: hesperia language-server");
    const { startLanguageServer } = await import("../editor/server.ts");
    startLanguageServer();
  } else if (command === "init") {
    if (args.length !== 1) throw new Error("Usage: hesperia init <empty-directory>");
    await initProject(resolve(args[0]!));
    console.log(
      `Created Hesperia application in ${resolve(args[0]!)}. Run bun install there, then bun run dev.`,
    );
  } else if (command === "check") {
    if (args.length) throw new Error("Usage: hesperia check");
    const sources = await readProject(process.cwd());
    const diagnostics = checkSources(
      sources,
      process.cwd(),
      await readConfiguration(process.cwd()),
    );
    if (!diagnostics.some((item) => item.code === "HES-ROUTE-SCAN"))
      await writeProjectTypes(process.cwd(), sources);
    for (const item of diagnostics)
      console.error(`${item.filename}: ${item.code}: ${item.message}`);
    if (diagnostics.some((item) => item.severity === "error")) process.exitCode = 1;
    else console.log("Hesperia checking passed");
  } else if (command === "build") {
    if (args.length) throw new Error("Usage: hesperia build");
    console.log(
      `Built browser application in ${await writeBuild(process.cwd(), await prepareBuild(process.cwd()))}`,
    );
  } else if (command === "dev" || command === "preview") {
    let port: number | undefined;
    if (args.length) {
      if (args.length !== 2 || args[0] !== "--port" || !/^\d+$/.test(args[1]!))
        throw new Error(`Usage: hesperia ${command} [--port <number>]`);
      port = Number(args[1]);
      if (port > 65535) throw new Error("Port must be between 0 and 65535");
    }
    const server =
      command === "dev"
        ? await devProject(process.cwd(), { port })
        : await previewProject(process.cwd(), port);
    console.log(`Hesperia ${command}: ${server.url}`);
    const stop = () => {
      void server.close();
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  } else throw new Error(`Unknown Hesperia command: ${command}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  if (error instanceof ProjectError)
    for (const item of error.diagnostics)
      console.error(`${item.filename}: ${item.code}: ${item.message}`);
  process.exitCode = 1;
}
