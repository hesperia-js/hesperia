#!/usr/bin/env bun
import { defineCommand, runCommand } from "citty";
import { createInterface } from "node:readline/promises";
import {
  executeCreator,
  resolveCreator,
  type CreatorCleanup,
  type CreatorProgress,
  type HostIntegration,
} from "./creator.ts";

const usage = "Usage: bun create hesperia <destination> [--no-install] [--host <elysia|none>]";

function validateRawCreatorArguments(args: readonly string[]): void {
  let destinationSeen = false;

  for (let index = 0; index < args.length; index++) {
    const argument = args[index]!;

    if (argument === "--no-install") continue;

    if (argument === "--host") {
      const value = args[index + 1];

      if (value === undefined || value.startsWith("-"))
        throw new Error(`Option --host requires a value: choose "elysia" or "none".\n${usage}`);

      if (value !== "elysia" && value !== "none")
        throw new Error(
          `Unknown host integration "${value}". Choose "elysia" or "none".\n${usage}`,
        );

      index++;
      continue;
    }

    if (argument.startsWith("-")) {
      throw new Error(`Unknown option: ${argument}\n${usage}`);
    }

    if (destinationSeen) {
      throw new Error(`Expected one destination.\n${usage}`);
    }

    if (argument.length === 0) throw new Error(`Destination cannot be empty.\n${usage}`);

    destinationSeen = true;
  }
}

async function chooseHostIntegration(signal: AbortSignal): Promise<HostIntegration> {
  if (signal.aborted) throw new Error("Creation cancelled.");

  if (process.stdin.isTTY !== true || process.stdout.isTTY !== true) return "elysia";

  const prompt = createInterface({ input: process.stdin, output: process.stdout });

  try {
    while (true) {
      if (signal.aborted) throw new Error("Creation cancelled.");

      const answer = (
        await prompt.question(
          "Choose a host integration:\n  1) Elysia (default)\n  2) No host integration\nHost [1]: ",
          { signal },
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

function printProgress(progress: CreatorProgress): void {
  if (progress.kind === "created") {
    console.log(`Created ${progress.packageName} at ${progress.projectRoot}.`);
  }
}

function printCleanup(cleanup: CreatorCleanup): void {
  if (cleanup.status !== "retained") return;

  const location =
    cleanup.retainedPaths.length > 0
      ? cleanup.retainedPaths.join(", ")
      : "the generated project";
  const reason = cleanup.reason === undefined ? "" : ` ${cleanup.reason}`;

  console.error(`Creator output was retained at ${location}.${reason}`);
}

async function main(): Promise<void> {
  const controller = new AbortController();
  let receivedSignal: "SIGINT" | "SIGTERM" | undefined;
  const stop = (signal: "SIGINT" | "SIGTERM"): void => {
    receivedSignal ??= signal;

    if (!controller.signal.aborted) controller.abort(new Error("Creation cancelled."));
  };
  const onInterrupt = (): void => stop("SIGINT");
  const onTerminate = (): void => stop("SIGTERM");

  process.once("SIGINT", onInterrupt);
  process.once("SIGTERM", onTerminate);

  try {
    const rawArgs = process.argv.slice(2);
    validateRawCreatorArguments(rawArgs);

    const command = defineCommand({
      meta: { name: "create-hesperia", description: "Create a Hesperia application" },
      args: {
        destination: {
          type: "positional",
          required: false,
          description: "Application destination",
        },
        host: { type: "string", description: "Host integration: elysia or none" },
        install: {
          type: "boolean",
          default: true,
          description: "Install dependencies after creating the application",
        },
      },
      run: async ({ args }) => {
        if (args.destination === undefined) throw new Error(usage);

        if (args._.length > 0) throw new Error(`Expected one destination.\n${usage}`);

        const hostIntegration =
          (args.host as HostIntegration | undefined) ??
          (await chooseHostIntegration(controller.signal));
        const plan = resolveCreator({
          destination: args.destination,
          hostIntegration,
          install: args.install,
        });
        const result = await executeCreator(plan, {
          signal: controller.signal,
          installerOutput: { stdout: process.stdout.fd, stderr: process.stderr.fd },
          onProgress: printProgress,
        });

        if (result.status === "created") {
          if (result.installation === "skipped") {
            console.log("Dependencies were not installed. Run `bun install`, then `bun run dev`.");
          } else {
            console.log("Dependencies installed. Run `bun run dev` to start the application.");
          }

          return;
        }

        if (result.status === "cancelled") {
          console.error("Creation cancelled.");
          printCleanup(result.cleanup);

          if (result.installer?.pendingResource) {
            console.error(`Bun install may still be active with PID ${result.installer.pid}.`);
          }

          process.exitCode = receivedSignal === "SIGTERM" ? 143 : 130;
          return;
        }

        console.error(result.message);
        printCleanup(result.cleanup);
        process.exitCode = 1;
      },
    });

    await runCommand(command, { rawArgs });
  } catch (error) {
    if (controller.signal.aborted) {
      console.error("Creation cancelled.");
      process.exitCode = receivedSignal === "SIGTERM" ? 143 : 130;
    } else {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  } finally {
    process.removeListener("SIGINT", onInterrupt);
    process.removeListener("SIGTERM", onTerminate);
  }
}

await main();
