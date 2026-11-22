#!/usr/bin/env bun
import { defineCommand, runCommand } from "citty";
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import {
  executeCreator,
  resolveCreator,
  type CreatorCleanup,
  type CreatorPlan,
  type CreatorProgress,
  type CreatorResult,
  type HostIntegration,
} from "./creator.ts";

const usage =
  "Usage: bun create hesperia <destination> [--no-install] [--host <elysia|none>] [--json]";

function printCreatorHelp(): void {
  console.log(
    [
      usage,
      "",
      "Options:",
      "  --no-install          Skip dependency installation after creating the application",
      "  --host <elysia|none>  Choose the host integration",
      "  --json                Emit one final JSON result on stdout",
      "  -h, --help            Show available options",
      "  --version             Show the package version",
    ].join("\n"),
  );
}

function readCreatorVersion(): string {
  const manifest = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  ) as {
    version?: unknown;
  };

  if (typeof manifest.version !== "string" || manifest.version.length === 0) {
    throw new Error("Unable to read the create-hesperia package version.");
  }

  return manifest.version;
}

function validateRawCreatorArguments(args: readonly string[]): void {
  let destinationSeen = false;

  for (let index = 0; index < args.length; index++) {
    const argument = args[index]!;

    if (argument === "--no-install" || argument === "--json") continue;

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
    cleanup.retainedPaths.length > 0 ? cleanup.retainedPaths.join(", ") : "the generated project";
  const reason = cleanup.reason === undefined ? "" : ` ${cleanup.reason}`;

  console.error(`Creator output was retained at ${location}.${reason}`);
}

interface CreatorJsonResult {
  readonly schemaVersion: 1;
  readonly status: "created" | "failed" | "cancelled";
  readonly projectRoot?: string;
  readonly packageName?: string;
  readonly installation?: "installed" | "skipped";
  readonly message?: string;
  readonly cleanup?: CreatorCleanup;
  readonly retirement: "not-started" | "complete" | "incomplete";
}

function jsonResult(result: CreatorResult, plan: CreatorPlan): CreatorJsonResult {
  const incompleteSuccess = result.status === "created" && result.retirement !== "complete";

  return {
    schemaVersion: 1,
    status: incompleteSuccess ? "failed" : result.status,
    projectRoot: result.projectRoot,
    packageName: plan.packageName,
    ...(result.status === "created" && !incompleteSuccess
      ? { installation: result.installation }
      : {}),
    ...(result.status === "failed"
      ? { message: result.message }
      : incompleteSuccess
        ? { message: "Creation finished, but operation retirement was not confirmed." }
        : {}),
    cleanup: result.cleanup,
    retirement: result.retirement,
  };
}

async function writeJsonResult(result: CreatorJsonResult): Promise<void> {
  try {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => reject(error);
      process.stdout.on("error", onError);

      try {
        process.stdout.write(`${JSON.stringify(result)}\n`, (error) => {
          if (error) {
            reject(error);
            return;
          }

          process.stdout.removeListener("error", onError);
          resolve();
        });
      } catch (error) {
        reject(error);
      }
    });
  } catch (error) {
    console.error(
      `Unable to write the creator JSON result: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}

async function main(): Promise<void> {
  const rawArgs = process.argv.slice(2);
  const jsonMode = rawArgs.includes("--json");
  const controller = new AbortController();
  let plan: CreatorPlan | undefined;
  let engineStarted = false;
  let finalJson: CreatorJsonResult | undefined;
  let receivedSignal: "SIGINT" | "SIGTERM" | undefined;
  const stop = (signal: "SIGINT" | "SIGTERM"): void => {
    receivedSignal ??= signal;

    if (!controller.signal.aborted) controller.abort(new Error("Creation cancelled."));
  };
  const onInterrupt = (): void => stop("SIGINT");
  const onTerminate = (): void => stop("SIGTERM");

  if (jsonMode) {
    process.on("SIGINT", onInterrupt);
    process.on("SIGTERM", onTerminate);
  } else {
    process.once("SIGINT", onInterrupt);
    process.once("SIGTERM", onTerminate);
  }

  try {
    if (rawArgs.length === 1 && (rawArgs[0] === "--help" || rawArgs[0] === "-h")) {
      printCreatorHelp();
      return;
    }

    if (rawArgs.length === 1 && rawArgs[0] === "--version") {
      console.log(readCreatorVersion());
      return;
    }

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
        json: { type: "boolean", description: "Emit one final JSON result on stdout" },
      },
      run: async ({ args }) => {
        if (args.destination === undefined) throw new Error(usage);

        const hostIntegration =
          (args.host as HostIntegration | undefined) ??
          (jsonMode ? "elysia" : await chooseHostIntegration(controller.signal));
        plan = resolveCreator({
          destination: args.destination,
          hostIntegration,
          install: args.install,
        });
        engineStarted = true;
        const result = await executeCreator(plan, {
          signal: controller.signal,
          installerOutput: {
            stdout: jsonMode ? process.stderr.fd : process.stdout.fd,
            stderr: process.stderr.fd,
          },
          onProgress: jsonMode
            ? (progress) => {
                if (progress.kind === "created")
                  console.error(`Created ${progress.packageName} at ${progress.projectRoot}.`);
              }
            : printProgress,
        });

        if (jsonMode) {
          finalJson = jsonResult(result, plan);

          if (finalJson.status === "created") {
            console.error(
              result.status === "created" && result.installation === "skipped"
                ? "Dependencies were not installed. Run `bun install`, then `bun run dev`."
                : "Dependencies installed. Run `bun run dev` to start the application.",
            );
          } else if (finalJson.status === "cancelled") {
            console.error("Creation cancelled.");
            printCleanup(result.cleanup);

            if (result.status === "cancelled" && result.installer?.pendingResource)
              console.error(`Bun install may still be active with PID ${result.installer.pid}.`);

            process.exitCode = receivedSignal === "SIGTERM" ? 143 : 130;
          } else {
            if (finalJson.message !== undefined) console.error(finalJson.message);
            printCleanup(result.cleanup);
            process.exitCode = 1;
          }

          if (finalJson.retirement === "incomplete")
            console.error("Creator operation retirement could not be confirmed.");

          return;
        }

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
    if (jsonMode && finalJson !== undefined) {
      process.exitCode = 1;
    } else if (jsonMode) {
      const cancelled = controller.signal.aborted;
      const message = error instanceof Error ? error.message : String(error);
      finalJson = {
        schemaVersion: 1,
        status: cancelled ? "cancelled" : "failed",
        ...(plan === undefined
          ? {}
          : { projectRoot: plan.projectRoot, packageName: plan.packageName }),
        ...(cancelled ? {} : { message }),
        retirement: engineStarted ? "incomplete" : "not-started",
      };
      console.error(cancelled ? "Creation cancelled." : message);
      if (engineStarted) console.error("Creator operation retirement could not be confirmed.");
      process.exitCode = cancelled ? (receivedSignal === "SIGTERM" ? 143 : 130) : 1;
    } else if (controller.signal.aborted) {
      console.error("Creation cancelled.");
      process.exitCode = receivedSignal === "SIGTERM" ? 143 : 130;
    } else {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  } finally {
    if (finalJson !== undefined) await writeJsonResult(finalJson);
    process.removeListener("SIGINT", onInterrupt);
    process.removeListener("SIGTERM", onTerminate);
  }
}

await main();
