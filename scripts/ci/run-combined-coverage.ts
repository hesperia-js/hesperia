import { createRequire } from "node:module";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  mergePlatformCoverageCaptures,
  writeLcovReport,
  type CoverageMap,
  type CoveragePlatform,
  type PlatformCoverageCapture,
} from "./coverage-collector.ts";
import { checkCoverage, type CoverageResult } from "./check-coverage.ts";

const require = createRequire(import.meta.url);
const { createContext } = require("istanbul-lib-report") as {
  createContext(options: {
    coverageMap: CoverageMap;
    dir: string;
    defaultSummarizer: "flat";
  }): object;
};
const { create: createReporter } = require("istanbul-reports") as {
  create(
    name: "json" | "html",
    options: Record<string, unknown>,
  ): { execute(context: object): void };
};

const repoPath = resolve(import.meta.dir, "../..");
const runIdentity = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;

export interface CombinedCoverageOptions {
  readonly windowsRoot: string;
  readonly linuxRoot: string;
  readonly output: string;
  readonly repoPath?: string;
}

export interface CombinedCoverageSummary {
  readonly format: "hesperia-combined-coverage";
  readonly version: 1;
  readonly status: "accepted" | "below-threshold";
  readonly accepted: boolean;
  readonly acceptance: {
    readonly lines: ">85%";
    readonly functions: ">=90%";
    readonly branches: "informational";
  };
  readonly outputDirectory: string;
  readonly populationFingerprint: string;
  readonly sourceCount: number;
  readonly platforms: Readonly<
    Record<CoveragePlatform, { readonly runId: string; readonly familyRuns: readonly unknown[] }>
  >;
  readonly lineFound: number;
  readonly lineHit: number;
  readonly linePercent: number;
  readonly functionFound: number;
  readonly functionHit: number;
  readonly functionPercent: number;
  readonly branchRecordsPresent: boolean;
}

function readCapture(root: string, expectedPlatform: CoveragePlatform): PlatformCoverageCapture {
  const finalRunsRoot = resolve(root, "coverage", "final-runs");

  if (!existsSync(finalRunsRoot) || !statSync(finalRunsRoot).isDirectory()) {
    throw new Error(`The ${expectedPlatform} artifact has no coverage/final-runs directory`);
  }

  const receiptPaths: string[] = [];

  for (const entry of readdirSync(finalRunsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || !runIdentity.test(entry.name)) continue;

    const receiptPath = join(finalRunsRoot, entry.name, "platform-coverage-capture.json");

    if (!existsSync(receiptPath)) continue;

    if (!statSync(receiptPath).isFile()) {
      throw new Error(`The ${expectedPlatform} capture receipt is not a file`);
    }

    receiptPaths.push(receiptPath);
  }

  if (receiptPaths.length !== 1) {
    throw new Error(
      `Expected exactly one ${expectedPlatform} platform-coverage-capture.json; found ${receiptPaths.length}`,
    );
  }

  const receiptPath = receiptPaths[0]!;
  const value = JSON.parse(readFileSync(receiptPath, "utf8")) as unknown;

  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    (value as Record<string, unknown>).platform !== expectedPlatform ||
    (value as Record<string, unknown>).runId !== receiptPaths[0]!.split(/[\\/]/u).at(-2)
  ) {
    throw new Error(`The ${expectedPlatform} receipt does not match its unique run directory`);
  }

  return value as PlatformCoverageCapture;
}

function passesThresholds(summary: {
  readonly lineFound: number;
  readonly lineHit: number;
  readonly functionFound: number;
  readonly functionHit: number;
}): boolean {
  return (
    BigInt(summary.lineHit) * 100n > 85n * BigInt(summary.lineFound) &&
    BigInt(summary.functionHit) * 100n >= 90n * BigInt(summary.functionFound)
  );
}

function writeCombinedReports(
  coverage: ReturnType<typeof mergePlatformCoverageCaptures>["coverage"],
  output: string,
  projectRoot: string,
): void {
  mkdirSync(output, { recursive: true });

  writeLcovReport(coverage, join(output, "lcov.info"), projectRoot);

  const context = createContext({
    coverageMap: coverage,
    dir: output,
    defaultSummarizer: "flat",
  });

  createReporter("json", { file: "coverage-final.json" }).execute(context);

  createReporter("html", { subdir: "html" }).execute(context);
}

export function runCombinedCoverage(options: CombinedCoverageOptions): CombinedCoverageSummary {
  const root = resolve(options.repoPath ?? repoPath);
  const windowsRoot = resolve(options.windowsRoot);
  const linuxRoot = resolve(options.linuxRoot);
  const output = resolve(options.output);

  if (windowsRoot === linuxRoot) {
    throw new Error("Windows and Linux coverage must come from separate artifact roots");
  }

  if (existsSync(output)) throw new Error(`Combined coverage output already exists: ${output}`);

  const windowsCapture = readCapture(windowsRoot, "win32");
  const linuxCapture = readCapture(linuxRoot, "linux");
  const merged = mergePlatformCoverageCaptures({
    repoPath: root,
    captures: [windowsCapture, linuxCapture],
    artifactRoots: { win32: windowsRoot, linux: linuxRoot },
  });

  const temporaryRoot = mkdtempSync(join(tmpdir(), "hesperia-combined-coverage-"));
  let measurement: CoverageResult;

  try {
    const measurementPath = join(temporaryRoot, "lcov.info");

    writeLcovReport(merged.coverage, measurementPath, root);

    measurement = checkCoverage({ lcovPath: measurementPath, repoPath: root, threshold: 0 });

    if (measurement.unmeasuredSources.length > 0) {
      throw new Error(
        `Combined coverage omitted executable population sources: ${measurement.unmeasuredSources.join(", ")}`,
      );
    }
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }

  const accepted = passesThresholds(measurement);
  const summary: CombinedCoverageSummary = {
    format: "hesperia-combined-coverage",
    version: 1,
    status: accepted ? "accepted" : "below-threshold",
    accepted,
    acceptance: { lines: ">85%", functions: ">=90%", branches: "informational" },
    outputDirectory: output,
    populationFingerprint: merged.population.fingerprint,
    sourceCount: merged.population.files.length,
    platforms: {
      win32: {
        runId: merged.captures.find((capture) => capture.platform === "win32")!.runId,
        familyRuns: merged.captures.find((capture) => capture.platform === "win32")!.runs,
      },
      linux: {
        runId: merged.captures.find((capture) => capture.platform === "linux")!.runId,
        familyRuns: merged.captures.find((capture) => capture.platform === "linux")!.runs,
      },
    },
    lineFound: measurement.lineFound,
    lineHit: measurement.lineHit,
    linePercent: measurement.linePercent,
    functionFound: measurement.functionFound,
    functionHit: measurement.functionHit,
    functionPercent: measurement.functionPercent,
    branchRecordsPresent: measurement.branchRecordsPresent,
  };

  writeCombinedReports(merged.coverage, output, root);

  writeFileSync(join(output, "combined-coverage-summary.json"), JSON.stringify(summary), {
    flag: "wx",
  });

  return summary;
}

function parseArguments(args: readonly string[]): CombinedCoverageOptions {
  const parsed: Partial<Record<"windowsRoot" | "linuxRoot" | "output", string>> = {};
  const flags = new Map<string, "windowsRoot" | "linuxRoot" | "output">([
    ["--windows-root", "windowsRoot"],
    ["--linux-root", "linuxRoot"],
    ["--output", "output"],
  ]);

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;

    if (argument === "--help" || argument === "-h") {
      throw new Error(
        "Usage: bun run scripts/ci/run-combined-coverage.ts --windows-root <artifact-root> --linux-root <artifact-root> --output <new-directory>",
      );
    }

    const key = flags.get(argument);
    const value = args[index + 1];

    if (!key || !value || value.startsWith("--") || parsed[key] !== undefined) {
      throw new Error(
        "Usage: bun run scripts/ci/run-combined-coverage.ts --windows-root <artifact-root> --linux-root <artifact-root> --output <new-directory>",
      );
    }

    parsed[key] = value;
    index += 1;
  }

  if (!parsed.windowsRoot || !parsed.linuxRoot || !parsed.output) {
    throw new Error(
      "Usage: bun run scripts/ci/run-combined-coverage.ts --windows-root <artifact-root> --linux-root <artifact-root> --output <new-directory>",
    );
  }

  return {
    windowsRoot: parsed.windowsRoot,
    linuxRoot: parsed.linuxRoot,
    output: parsed.output,
  };
}

async function main(): Promise<void> {
  try {
    const summary = runCombinedCoverage({
      ...parseArguments(Bun.argv.slice(2)),
      repoPath,
    });

    console.log(JSON.stringify(summary));

    process.exitCode = summary.accepted ? 0 : 1;
  } catch (error) {
    console.error(
      JSON.stringify({
        format: "hesperia-combined-coverage",
        version: 1,
        status: "invalid",
        error: error instanceof Error ? error.message : String(error),
      }),
    );

    process.exitCode = 2;
  }
}

if (import.meta.main) await main();
