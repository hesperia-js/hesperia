import assert from "node:assert/strict";
import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const workflow = Bun.YAML.parse(
  await Bun.file(new URL("../../.github/workflows/verify.yml", import.meta.url)).text(),
) as {
  jobs: Record<string, { steps: { name?: string; run?: string; env?: Record<string, string> }[] }>;
};

function workflowScript(job: string, name: string) {
  const run = workflow.jobs[job]?.steps.find((step) => step.name === name)?.run;

  assert.ok(run, `Missing executable workflow gate: ${name}`);

  const match = /^bun -e '\s*([\s\S]*?)\s*'\s*$/.exec(run);

  assert.ok(match?.[1], `Expected an inline Bun gate: ${name}`);

  return match[1];
}

const branchScript = workflowScript("checks", "Check repository branch name");
const resultScript = workflowScript("result", "Require every selected verification job");
const scopeExpression = workflow.jobs.checks!.steps.find(
  (step) => step.name === "Resolve verification scope",
)!.env!.FULL!;

function requestsFull(outcome: string, outputs: Record<string, string>, full = false) {
  const expression = scopeExpression
    .slice("${{ ".length, -" }}".length)
    .replaceAll(" != ", " !== ")
    .replaceAll(" == ", " === ");
  return new Function("inputs", "steps", `return (${expression});`)(
    { full },
    { paths: { outcome, outputs } },
  ) as boolean;
}

describe("verification scope fallback", () => {
  const known = { all_count: "1", full: "false", policy: "false" };

  test("retains partial verification only after a nonempty known comparison", () => {
    expect(requestsFull("success", known)).toBe(false);
  });

  test("requests full verification for uncertainty, policy changes, and explicit full runs", () => {
    for (const outcome of ["failure", "cancelled", "skipped"]) {
      expect(requestsFull(outcome, known)).toBe(true);
    }

    for (const outputs of [
      {},
      { ...known, all_count: "" },
      { ...known, all_count: "0" },
      { ...known, full: "" },
      { ...known, full: "true" },
      { ...known, policy: "true" },
    ]) {
      expect(requestsFull("success", outputs)).toBe(true);
    }

    expect(requestsFull("success", known, true)).toBe(true);
  });
});

function execute(script: string, env: Record<string, string>) {
  return Bun.spawnSync([process.execPath, "-e", script], {
    cwd: root,
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
}

const { version } = await Bun.file(new URL("../../package.json", import.meta.url)).json();

describe("repository branch gate", () => {
  test("accepts feature, fix, and the authored release version", () => {
    for (const branch of [
      "feature/compiler",
      "feature/compiler/scopes",
      "fix/hotfix",
      `release/${version}`,
    ]) {
      expect(execute(branchScript, { HESPERIA_HEAD_BRANCH: branch }).exitCode).toBe(0);
    }
  });

  test("rejects wrong prefixes and invalid or mismatched release versions", () => {
    for (const branch of [
      "main",
      "feature/",
      "fix/",
      "hotfix/parser",
      "release/v1.0.0",
      "release/01.0.0",
      "release/1.0.0+build",
      "release/999.0.0",
    ]) {
      expect(execute(branchScript, { HESPERIA_HEAD_BRANCH: branch }).exitCode).not.toBe(0);
    }
  });
});

type Result = "success" | "failure" | "cancelled" | "skipped";

function verification(full: boolean, integrations: boolean, behavior = true) {
  const outputs = Object.fromEntries(
    ["browser", "package", "vscode", "golden"].map((key) => [key, String(integrations)]),
  );
  return {
    checks: {
      result: "success" as Result,
      outputs: { ...outputs, full: String(full), behavior: String(behavior) },
    },
    "source-quality": { result: (behavior ? "success" : "skipped") as Result },
    "combined-coverage": { result: (full ? "success" : "skipped") as Result },
    ...Object.fromEntries(
      ["browser", "package", "vscode", "golden-plan", "golden"].map((name) => [
        name,
        { result: (integrations ? "success" : "skipped") as Result },
      ]),
    ),
  } as Record<string, { result: Result; outputs?: Record<string, string> }>;
}

function aggregate(jobs: ReturnType<typeof verification>) {
  return execute(resultScript, { RESULTS: JSON.stringify(jobs) });
}

describe("verification result gate", () => {
  test("accepts successful full verification and explicitly excluded partial gates", () => {
    expect(aggregate(verification(true, true)).exitCode).toBe(0);

    expect(aggregate(verification(false, true)).exitCode).toBe(0);

    expect(aggregate(verification(false, false)).exitCode).toBe(0);

    expect(aggregate(verification(false, false, false)).exitCode).toBe(0);
  });

  test("rejects failure, cancellation, and every unexpected skip on full verification", () => {
    for (const name of Object.keys(verification(true, true))) {
      for (const result of ["failure", "cancelled", "skipped"] as const) {
        const jobs = verification(true, true);
        jobs[name]!.result = result;
        const probe = aggregate(jobs);

        expect(probe.exitCode).not.toBe(0);

        expect(probe.stderr.toString()).toContain(name);
      }
    }
  });

  test("rejects selected partial skips and failures even on excluded gates", () => {
    for (const name of Object.keys(verification(false, true)).filter(
      (name) => name !== "combined-coverage",
    )) {
      const jobs = verification(false, true);
      jobs[name]!.result = "skipped";

      expect(aggregate(jobs).exitCode).not.toBe(0);
    }

    for (const name of [
      "combined-coverage",
      "browser",
      "package",
      "vscode",
      "golden-plan",
      "golden",
    ]) {
      for (const result of ["failure", "cancelled"] as const) {
        const jobs = verification(false, false);
        jobs[name]!.result = result;

        expect(aggregate(jobs).exitCode).not.toBe(0);
      }
    }
  });
});
