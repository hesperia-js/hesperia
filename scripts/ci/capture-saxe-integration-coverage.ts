import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import {
  closeSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { checkSaxeIntegrationCoverage } from "./check-saxe-integration-coverage.ts";

const repoPath = resolve(import.meta.dir, "../..");
const testPath = "tests/tooling/builtin-assets.test.ts";
const command = ["bun", "run", "scripts/ci/run-coverage.ts", testPath];
const supportedFiles = ["namespace.ts", "parser.ts", "chars.ts", "xml_decl.ts", "error.ts"].map(
  (name) => `packages/tooling/src/vendor/saxe/${name}`,
);
const sha256 = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex");

function git(...args: string[]): string {
  return execFileSync("git", args, { cwd: repoPath, encoding: "utf8" }).trim();
}

async function main(): Promise<void> {
  if (
    process.env.BUN_OPTIONS ||
    process.env.NODE_OPTIONS ||
    process.env.NODE_PATH ||
    Object.entries(process.env).some(
      ([name, value]) => name.startsWith("HESPERIA_COVERAGE_") && value,
    )
  )
    throw new Error("Saxe coverage cannot inherit runtime or coverage preload options");

  const candidate = git("rev-parse", "HEAD");

  if (git("status", "--porcelain=v1", "--untracked-files=all"))
    throw new Error("Saxe coverage requires a clean candidate");

  const lockSha256 = sha256(readFileSync(join(repoPath, "bun.lock")));
  const testSha256 = sha256(readFileSync(join(repoPath, testPath)));
  const evidenceRoot = join(repoPath, ".hesperia", "saxe-integration-coverage");

  mkdirSync(evidenceRoot, { recursive: true });

  const evidence = mkdtempSync(join(evidenceRoot, "capture-"));
  const stdoutPath = join(evidence, "stdout.log");
  const stderrPath = join(evidence, "stderr.log");
  const stdoutFd = openSync(stdoutPath, "wx");
  const stderrFd = openSync(stderrPath, "wx");
  let result: ReturnType<typeof spawnSync>;

  try {
    result = spawnSync(process.execPath, command.slice(1), {
      cwd: repoPath,
      stdio: ["ignore", stdoutFd, stderrFd],
      env: process.env,
      windowsHide: true,
    });
  } finally {
    closeSync(stdoutFd);

    closeSync(stderrFd);
  }

  if (result.error || result.signal || result.status !== 0)
    throw new Error(`Saxe coverage owner failed; logs retained at ${evidence}`, {
      cause: result.error,
    });

  const stdout = readFileSync(stdoutPath);
  const stderr = readFileSync(stderrPath);
  const summaries: Record<string, unknown>[] = [];

  for (const line of stdout.toString("utf8").split(/\r?\n/u)) {
    try {
      const value: unknown = JSON.parse(line);

      if (
        value &&
        typeof value === "object" &&
        "status" in value &&
        value.status === "completed" &&
        "ownerId" in value &&
        value.ownerId === "bun-tests"
      )
        summaries.push(value as Record<string, unknown>);
    } catch {}
  }

  const summary = summaries[0];
  const runId = summary?.runId;

  if (
    summaries.length !== 1 ||
    typeof runId !== "string" ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(runId)
  )
    throw new Error(
      `Saxe coverage owner did not produce one valid run; logs retained at ${evidence}`,
    );

  const runRoot = join(repoPath, ".hesperia", "coverage", "runs", runId);
  const names = readdirSync(runRoot).sort();
  const seedName = names.find((name) => name.includes("-bun-tests-coverage-runner-seed-"));

  if (!seedName) throw new Error(`Saxe coverage run has no seed; logs retained at ${evidence}`);

  const seed: unknown = JSON.parse(readFileSync(join(runRoot, seedName), "utf8"));

  if (
    !seed ||
    typeof seed !== "object" ||
    !("populationFingerprint" in seed) ||
    typeof seed.populationFingerprint !== "string"
  )
    throw new Error(`Saxe coverage seed has no population identity; logs retained at ${evidence}`);

  const classification = { schema: 1, supportedFiles, exclusions: [] };
  const inputs = {
    format: "hesperia-saxe-integration-capture-inputs",
    version: 1,
    candidate,
    lockSha256,
    testInputs: [{ path: testPath, sha256: testSha256 }],
    execution: {
      command,
      testPaths: [testPath],
      exitCode: result.status,
      runId,
      ownerId: "bun-tests",
      platform: process.platform,
      runtime: { name: "bun", version: process.versions.bun },
      stdout: { file: "stdout.log", sha256: sha256(stdout) },
      stderr: { file: "stderr.log", sha256: sha256(stderr) },
    },
    populationFingerprint: seed.populationFingerprint,
    classification: { ...classification, sha256: sha256(JSON.stringify(classification)) },
    artifacts: names.map((name) => ({ name, sha256: sha256(readFileSync(join(runRoot, name))) })),
  };
  const inputsPath = join(evidence, "capture-inputs.json");

  writeFileSync(inputsPath, `${JSON.stringify(inputs, null, 2)}\n`, { flag: "wx" });

  const report = await checkSaxeIntegrationCoverage({ repoPath, runRoot, inputsPath });

  writeFileSync(join(evidence, "report.json"), `${JSON.stringify(report, null, 2)}\n`, {
    flag: "wx",
  });

  console.log(JSON.stringify({ evidence, runRoot, report }));

  if (!report.supportedFive.floorPassed) process.exitCode = 1;
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    console.error(error);

    process.exitCode = 1;
  }
}
