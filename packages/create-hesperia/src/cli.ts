#!/usr/bin/env bun
import { createInterface } from "node:readline/promises";
import {
  installDependencies,
  prepareProject,
  writeProject,
  type HostIntegration,
} from "./creator.ts";

const usage = "Usage: bun create hesperia <destination> [--no-install] [--host <elysia|none>]";

interface Options {
  readonly destination: string;
  readonly install: boolean;
  readonly hostIntegration?: HostIntegration;
}

function parseArguments(args: readonly string[]): Options {
  let destination: string | undefined;
  let install = true;
  let hostIntegration: HostIntegration | undefined;

  for (let index = 0; index < args.length; index++) {
    const argument = args[index]!;

    if (argument === "--no-install") {
      install = false;
      continue;
    }

    if (argument === "--host") {
      const value = args[index + 1];

      if (value === undefined || value.startsWith("-"))
        throw new Error(`Option --host requires a value: choose "elysia" or "none".\n${usage}`);

      if (value !== "elysia" && value !== "none")
        throw new Error(
          `Unknown host integration "${value}". Choose "elysia" or "none".\n${usage}`,
        );

      hostIntegration = value;
      index++;
      continue;
    }

    if (argument.startsWith("-")) {
      throw new Error(`Unknown option: ${argument}\n${usage}`);
    }

    if (destination !== undefined) {
      throw new Error(`Expected one destination.\n${usage}`);
    }

    if (argument.length === 0) throw new Error(`Destination cannot be empty.\n${usage}`);

    destination = argument;
  }

  if (destination === undefined) throw new Error(usage);

  return { destination, install, hostIntegration };
}

async function chooseHostIntegration(): Promise<HostIntegration> {
  if (process.stdin.isTTY !== true || process.stdout.isTTY !== true) return "elysia";

  const prompt = createInterface({ input: process.stdin, output: process.stdout });

  try {
    while (true) {
      const answer = (
        await prompt.question(
          "Choose a host integration:\n  1) Elysia (default)\n  2) No host integration\nHost [1]: ",
        )
      )
        .trim()
        .toLowerCase();

      if (answer.length === 0 || answer === "1") return "elysia";

      if (answer === "2") return "none";

      process.stdout.write("Enter 1 or 2.\n");
    }
  } finally {
    prompt.close();
  }
}

try {
  const options = parseArguments(process.argv.slice(2));
  const project = await prepareProject(options.destination);
  const hostIntegration = options.hostIntegration ?? (await chooseHostIntegration());

  await writeProject(project, hostIntegration);

  console.log(`Created ${project.packageName} at ${project.projectRoot}.`);

  if (!options.install) {
    console.log("Dependencies were not installed. Run `bun install`, then `bun run dev`.");
  } else {
    await installDependencies(project, { stdout: process.stdout.fd, stderr: process.stderr.fd });

    console.log("Dependencies installed. Run `bun run dev` to start the application.");
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));

  process.exitCode = 1;
}
