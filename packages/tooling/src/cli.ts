#!/usr/bin/env bun
import { checkApplication } from "./check.ts";
import { parseCommand, usage } from "./cli-arguments.ts";
import { prepareBuild, ProjectError, writeBuild } from "./project.ts";
import { devProject, previewProject, type ProjectServer } from "./server.ts";

function reportDiagnostics(items: readonly { filename: string; code: string; message: string }[]) {
  for (const item of items) console.error(`${item.filename}: ${item.code}: ${item.message}`);
}

function serve(name: string, server: ProjectServer): void {
  console.log(`Hesperia ${name}: ${server.url}`);

  const stop = () => {
    void server.close();
  };

  process.once("SIGINT", stop);

  process.once("SIGTERM", stop);
}

try {
  const command = parseCommand(process.argv.slice(2));
  const root = process.cwd();
  switch (command.name) {
    case "help":
      console.log(usage);

      break;
    case "check": {
      const result = await checkApplication(root, {
        fix: command.fix,

        report(report) {
          if (report.kind === "diagnostics") reportDiagnostics(report.items);
          else console.error(report.message);
        },
      });

      if (result.failed) process.exitCode = 1;
      else console.log("Hesperia checking passed");

      break;
    }
    case "build":
      console.log(
        `Built browser application in ${await writeBuild(root, await prepareBuild(root))}`,
      );

      break;
    case "init":
      serve(command.name, await previewProject(root));

      break;
    case "dev":
      serve(command.name, await devProject(root, { port: command.port }));

      break;
    case "preview":
      serve(command.name, await previewProject(root, command.port));

      break;
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));

  if (error instanceof ProjectError) reportDiagnostics(error.diagnostics);

  process.exitCode = 1;
}
