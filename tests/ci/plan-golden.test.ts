import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { GoldenSelection } from "../../scripts/ci/select-golden.ts";
import {
  createGoldenPlan,
  toGitHubOutputs,
  type GoldenPlanOptions,
} from "../../scripts/ci/plan-golden.ts";

const catalog = {
  version: 1,
  behaviors: [
    { id: "a", paths: ["packages/demo/src/a.ts", "golden/tests/a.spec.ts"] },
    { id: "b", paths: ["packages/demo/src/b.ts", "golden/tests/b.spec.ts"] },
  ],
  cases: [
    { id: "case-a", title: "test a", suite: "tests/a.spec.ts", behaviors: ["a"] },
    { id: "case-b", title: "test b", suite: "tests/b.spec.ts", behaviors: ["b"] },
  ],
};

function selection(overrides: Partial<GoldenSelection> = {}): GoldenSelection {
  return {
    schemaVersion: 1,
    base: "base",
    head: "head",
    catalogPath: "golden/catalog.json",
    graphPath: "golden/dependency-graph.json",
    releaseCandidate: false,
    fullSuite: false,
    fallbackReasons: [],
    changedPaths: [{ path: "packages/demo/src/a.ts", status: "M" }],
    affectedPaths: [],
    affectedBehaviors: ["a"],
    selectedCaseIds: ["case-a"],
    selectedCases: [{ id: "case-a", suite: "tests/a.spec.ts", reasons: ["mapped"] }],
    ...overrides,
  };
}

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "hesperia-golden-plan-"));

  await mkdir(join(root, "golden", "tests"), { recursive: true });

  await writeFile(
    join(root, "golden", "tests", "a.spec.ts"),
    'import { test } from "@playwright/test";\n\ntest("test a", () => {});\n',
  );

  await writeFile(
    join(root, "golden", "tests", "b.spec.ts"),
    'import { test } from "@playwright/test";\n\ntest("test b", () => {});\n',
  );

  await writeFile(join(root, "golden", "catalog.json"), `${JSON.stringify(catalog, null, 2)}\n`);

  await writeFile(
    join(root, "golden", "dependency-graph.json"),
    '{"version":1,"nodes":[],"dependencies":[]}\n',
  );

  return root;
}

function git(repo: string, args: readonly string[]): string {
  const result = Bun.spawnSync(["git", "-C", repo, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });

  if (!result.success) {
    const detail = new TextDecoder().decode(result.stderr).trim();
    throw new Error(
      `Fixture Git command failed: git ${args.join(" ")}${detail ? `: ${detail}` : ""}`,
    );
  }

  return new TextDecoder().decode(result.stdout).trim();
}

async function writeRepoFile(repo: string, path: string, contents: string): Promise<void> {
  const absolutePath = join(repo, path);

  await mkdir(dirname(absolutePath), { recursive: true });

  await writeFile(absolutePath, contents);
}

function commit(repo: string, message: string): string {
  git(repo, ["add", "--all"]);

  git(repo, ["commit", "--quiet", "-m", message]);

  return git(repo, ["rev-parse", "HEAD"]);
}

function matrixFor(suites: readonly string[], caseIds: readonly string[]) {
  return ["ubuntu-24.04", "windows-2025"].flatMap((platform) =>
    ["chromium", "firefox", "webkit"].map((project) => ({
      platform,
      project,
      suites,
      caseIds,
      caseToSuite: caseIds.map((caseId) => ({
        caseId,
        suite: caseId === "case-a" ? "tests/a.spec.ts" : "tests/b.spec.ts",
      })),
    })),
  );
}

function verifyGitHubOutput(
  contents: string,
  expected: {
    readonly fullSuite: boolean;
    readonly catalogValid?: boolean;
    readonly suites: string[];
    readonly caseIds: string[];
    readonly fallbackReasons: string[];
    readonly diagnostics?: string[];
    readonly diagnosticIncludes?: string[];
  },
): void {
  const lines = contents.trimEnd().split("\n");

  expect(lines[0]).toBe("sentinel=preserve");

  const fields = new Map(
    lines.slice(1).map((line) => {
      const delimiter = line.indexOf("=");
      return [line.slice(0, delimiter), line.slice(delimiter + 1)];
    }),
  );

  expect([...fields.keys()].sort()).toStrictEqual([
    "catalog_valid",
    "full_suite",
    "matrix",
    "selection_summary",
  ]);

  expect(fields.get("full_suite")).toBe(String(expected.fullSuite));

  const catalogValid = expected.catalogValid ?? true;

  expect(fields.get("catalog_valid")).toBe(String(catalogValid));

  const expectedMatrix = matrixFor(expected.suites, expected.caseIds).map(
    ({ platform, project, suites }) => ({
      platform,
      project,
      suites,
    }),
  );
  const matrix = JSON.parse(fields.get("matrix") ?? "null") as { include: unknown[] };

  expect(matrix).toStrictEqual({
    include: expect.arrayContaining(expectedMatrix),
  });

  expect(matrix.include).toHaveLength(expectedMatrix.length);

  const summary = JSON.parse(fields.get("selection_summary") ?? "null") as {
    schemaVersion: number;
    caseScope: string;
    fullSuite: boolean;
    catalogValid: boolean;
    diagnostics: string[];
    selectedCaseIds: string[];
    caseToSuite: { caseId: string; suite: string }[];
    fallbackReasons: string[];
  };
  const expectedSummary = {
    schemaVersion: 1,
    caseScope: "suite",
    fullSuite: expected.fullSuite,
    catalogValid,
    diagnostics: expected.diagnostics ?? [],
    selectedCaseIds: expected.caseIds,
    caseToSuite: expected.caseIds.map((caseId) => ({
      caseId,
      suite: caseId === "case-a" ? "tests/a.spec.ts" : "tests/b.spec.ts",
    })),
    fallbackReasons: expected.fallbackReasons,
  };

  if (expected.diagnosticIncludes) {
    const { diagnostics, ...summaryWithoutDiagnostics } = summary;
    const { diagnostics: _expectedDiagnostics, ...expectedWithoutDiagnostics } = expectedSummary;

    expect(summaryWithoutDiagnostics).toStrictEqual(expectedWithoutDiagnostics);

    expect(diagnostics).toHaveLength(1);

    for (const fragment of expected.diagnosticIncludes)
      expect(diagnostics.join("\n")).toContain(fragment);
  } else {
    expect(summary).toStrictEqual(expectedSummary);
  }
}

function options(root: string, overrides: Partial<GoldenPlanOptions> = {}): GoldenPlanOptions {
  return {
    repoPath: root,
    base: "base",
    head: "head",
    catalogPath: "golden/catalog.json",
    graphPath: "golden/dependency-graph.json",
    testInventory: () => [
      { suite: "tests/a.spec.ts", title: "test a" },
      { suite: "tests/b.spec.ts", title: "test b" },
    ],
    ...overrides,
  };
}

test("maps logical cases to the three browser projects on both supported platforms", async () => {
  const root = await fixture();

  try {
    const plan = createGoldenPlan(options(root, { selector: () => selection() }));

    expect(plan.fullSuite).toBe(false);

    expect(plan.catalogValid).toBe(true);

    expect(plan.caseScope).toBe("suite");

    expect(plan.caseToSuite).toStrictEqual([{ caseId: "case-a", suite: "tests/a.spec.ts" }]);

    expect(plan.matrix).toHaveLength(6);

    expect(new Set(plan.matrix.map(({ platform }) => platform))).toStrictEqual(
      new Set(["ubuntu-24.04", "windows-2025"]),
    );

    expect(new Set(plan.matrix.map(({ project }) => project))).toStrictEqual(
      new Set(["chromium", "firefox", "webkit"]),
    );

    expect(
      plan.matrix.every(
        ({ suites, caseIds }) =>
          suites.length === 1 && suites[0] === "tests/a.spec.ts" && caseIds[0] === "case-a",
      ),
    ).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runs the whole discovered suite when selection fails or returns no cases", async () => {
  const root = await fixture();

  try {
    const failed = createGoldenPlan(
      options(root, {
        selector: () => {
          throw new Error("catalog could not be read from head");
        },
      }),
    );

    expect(failed.fullSuite).toBe(true);

    expect(failed.matrix).toHaveLength(6);

    expect(new Set(failed.matrix.flatMap(({ suites }) => suites))).toStrictEqual(
      new Set(["tests/a.spec.ts", "tests/b.spec.ts"]),
    );

    expect(failed.diagnostics[0]).toContain("selection could not be trusted");

    const empty = createGoldenPlan(
      options(root, {
        selector: () =>
          selection({ selectedCaseIds: [], selectedCases: [], affectedBehaviors: [] }),
      }),
    );

    expect(empty.fullSuite).toBe(true);

    expect(empty.matrix).toHaveLength(6);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("falls back to all suites when a selected suite is absent or a changed golden path is unmapped", async () => {
  const root = await fixture();

  try {
    const missingSuite = createGoldenPlan(
      options(root, {
        selector: () =>
          selection({
            selectedCases: [{ id: "case-a", suite: "tests/missing.spec.ts", reasons: ["mapped"] }],
          }),
      }),
    );

    expect(missingSuite.fullSuite).toBe(true);

    expect(new Set(missingSuite.matrix.flatMap(({ suites }) => suites))).toStrictEqual(
      new Set(["tests/a.spec.ts", "tests/b.spec.ts"]),
    );

    expect(missingSuite.diagnostics.join("\n")).toContain("has no implemented Playwright spec");

    const unmappedGolden = createGoldenPlan(
      options(root, {
        selector: () =>
          selection({
            changedPaths: [
              { path: "golden/fixtures/new-scenario.tsx", status: "A" },
              { path: "packages/demo/src/a.ts", status: "M" },
            ],
          }),
      }),
    );

    expect(unmappedGolden.fullSuite).toBe(true);

    expect(unmappedGolden.diagnostics.join("\n")).toContain("not mapped to a behavior");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runs every discovered spec when the catalog is missing or malformed", async () => {
  const root = await fixture();

  try {
    const missing = createGoldenPlan(
      options(root, {
        catalogPath: "golden/missing.json",
        selector: () => {
          throw new Error("missing catalog");
        },
      }),
    );

    expect(missing.fullSuite).toBe(true);

    expect(missing.catalogValid).toBe(false);

    expect(missing.matrix).toHaveLength(6);

    await writeFile(join(root, "golden", "catalog.json"), "not-json\n");

    const malformed = createGoldenPlan(
      options(root, {
        selector: () => {
          throw new Error("malformed catalog");
        },
      }),
    );

    expect(malformed.fullSuite).toBe(true);

    expect(malformed.catalogValid).toBe(false);

    expect(malformed.matrix).toHaveLength(6);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runs the complete suite and marks the catalog invalid when a test title is uncataloged", async () => {
  const root = await fixture();

  try {
    const plan = createGoldenPlan(
      options(root, {
        selector: () => selection(),
        testInventory: () => [
          { suite: "tests/a.spec.ts", title: "test a" },
          { suite: "tests/b.spec.ts", title: "test b" },
          { suite: "tests/b.spec.ts", title: "new implemented test" },
        ],
      }),
    );

    expect(plan.fullSuite).toBe(true);

    expect(plan.catalogValid).toBe(false);

    expect(plan.matrix).toHaveLength(6);

    expect(plan.diagnostics.join("\n")).toContain("is not cataloged");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("serializes a compact explicit GitHub matrix and selector summary", async () => {
  const root = await fixture();

  try {
    const plan = createGoldenPlan(options(root, { selector: () => selection() }));
    const outputs = toGitHubOutputs(plan);

    expect(outputs).toContain("full_suite=false");

    expect(outputs).toContain("catalog_valid=true");

    const matrixLine = outputs.split("\n").find((line) => line.startsWith("matrix="));

    if (!matrixLine) throw new Error("matrix output was not written");

    const matrix = JSON.parse(matrixLine.slice("matrix=".length)) as {
      include: { platform: string; project: string; suites: string[] }[];
    };

    expect(matrix.include).toHaveLength(6);

    expect(
      matrix.include.every(({ suites }) => suites.length === 1 && suites[0] === "tests/a.spec.ts"),
    ).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("CLI handles inventory fallback, output publication failure, and release-candidate selection", async () => {
  const root = await fixture();
  const outputDirectory = await mkdtemp(join(tmpdir(), "hesperia-golden-output-"));
  const listingFailureEnvironment = "HESPERIA_GOLDEN_PLAN_FIXTURE_FAIL_LISTING";
  const listingFailureValue = "playwright-inventory";
  const listingFailureSentinel = "HESPERIA_GOLDEN_PLAN_FIXTURE_LISTING_FAILURE";

  try {
    await writeFile(join(root, ".gitignore"), "node_modules/\n");

    await writeRepoFile(
      root,
      "golden/playwright.config.ts",
      `import { defineConfig } from "@playwright/test";\n\n` +
        `if (process.env.${listingFailureEnvironment} === "${listingFailureValue}") {\n` +
        `  throw new Error("${listingFailureSentinel}");\n` +
        `}\n\n` +
        "export default defineConfig({\n" +
        '  testDir: "./tests",\n' +
        '  projects: [{ name: "chromium", use: { browserName: "chromium" } }],\n' +
        "});\n",
    );

    await writeRepoFile(root, "packages/demo/src/a.ts", 'export const value = "base";\n');

    await writeRepoFile(root, "packages/demo/src/b.ts", 'export const other = "unchanged";\n');

    await symlink(
      resolve(import.meta.dir, "../../node_modules"),
      join(root, "node_modules"),
      "junction",
    );

    git(root, ["init", "--quiet"]);

    git(root, ["config", "user.name", "Hesperia CI fixture"]);

    git(root, ["config", "user.email", "ci-fixture@example.invalid"]);

    const base = commit(root, "baseline");

    await writeFile(
      join(root, "packages", "demo", "src", "a.ts"),
      'export const value = "changed";\n',
    );

    const head = commit(root, "change mapped behavior a");
    const cliPath = resolve(import.meta.dir, "../../scripts/ci/plan-golden.ts");
    const childEnvironment = { ...process.env };
    delete childEnvironment.BUN_OPTIONS;
    delete childEnvironment.NODE_OPTIONS;

    for (const name of Object.keys(childEnvironment)) {
      if (name.startsWith("HESPERIA_COVERAGE_")) delete childEnvironment[name];
    }

    type CliResult = {
      readonly exitCode: number | null;
      readonly stdout: string;
      readonly stderr: string;
      readonly githubOutputPath: string;
    };

    type CliPlan = {
      readonly catalogValid: boolean;
      readonly diagnostics: string[];
      readonly fullSuite: boolean;
      readonly fallbackReasons: string[];
      readonly selectedCaseIds: string[];
      readonly caseToSuite: { caseId: string; suite: string }[];
      readonly matrix: { platform: string; project: string; suites: string[] }[];
      readonly selection: {
        releaseCandidate: boolean;
        fullSuite: boolean;
        fallbackReasons: string[];
      };
    };

    type PlanExpectation = {
      readonly releaseCandidate: boolean;
      readonly fullSuite: boolean;
      readonly catalogValid: boolean;
      readonly suites: string[];
      readonly caseIds: string[];
      readonly fallbackReasons: string[];
      readonly selectionFullSuite: boolean;
      readonly selectionFallbackReasons: string[];
      readonly diagnostics?: string[];
      readonly diagnosticIncludes?: string[];
    };

    const runCli = async (
      releaseCandidate: boolean,
      runOptions: {
        readonly failPlaywrightListing?: boolean;
        readonly githubOutputPath?: string;
        readonly initializeOutput?: boolean;
      } = {},
    ): Promise<CliResult> => {
      const githubOutputPath =
        runOptions.githubOutputPath ??
        join(outputDirectory, releaseCandidate ? "release-output.txt" : "partial-output.txt");

      if (runOptions.initializeOutput !== false)
        await writeFile(githubOutputPath, "sentinel=preserve\n");

      const args = [
        process.execPath,
        cliPath,
        "--repo",
        root,
        "--base",
        base,
        "--head",
        head,
        "--catalog-path",
        "golden/catalog.json",
        "--graph-path",
        "golden/dependency-graph.json",
        ...(releaseCandidate ? ["--release-candidate"] : []),
      ];

      expect(git(root, ["status", "--porcelain"])).toBe("");

      const result = Bun.spawnSync(args, {
        cwd: root,
        env: {
          ...childEnvironment,
          GITHUB_OUTPUT: githubOutputPath,
          [listingFailureEnvironment]: runOptions.failPlaywrightListing ? listingFailureValue : "",
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      return {
        exitCode: result.exitCode,
        stdout: new TextDecoder().decode(result.stdout),
        stderr: new TextDecoder().decode(result.stderr),
        githubOutputPath,
      };
    };

    const verifyPlan = (stdout: string, expected: PlanExpectation): void => {
      const plan = JSON.parse(stdout) as CliPlan;

      expect(plan.fullSuite).toBe(expected.fullSuite);

      expect(plan.catalogValid).toBe(expected.catalogValid);

      expect(plan.fallbackReasons).toStrictEqual(expected.fallbackReasons);

      expect(plan.selectedCaseIds).toStrictEqual(expected.caseIds);

      expect(plan.caseToSuite).toStrictEqual(
        expected.caseIds.map((caseId) => ({
          caseId,
          suite: caseId === "case-a" ? "tests/a.spec.ts" : "tests/b.spec.ts",
        })),
      );

      const expectedMatrix = matrixFor(expected.suites, expected.caseIds);

      expect(plan.matrix).toStrictEqual(expect.arrayContaining(expectedMatrix));

      expect(plan.matrix).toHaveLength(expectedMatrix.length);

      expect(plan.selection.releaseCandidate).toBe(expected.releaseCandidate);

      expect(plan.selection.fullSuite).toBe(expected.selectionFullSuite);

      expect(plan.selection.fallbackReasons).toStrictEqual(expected.selectionFallbackReasons);

      if (expected.diagnostics !== undefined)
        expect(plan.diagnostics).toStrictEqual(expected.diagnostics);

      for (const fragment of expected.diagnosticIncludes ?? [])
        expect(plan.diagnostics.join("\n")).toContain(fragment);
    };

    const partialExpected: PlanExpectation = {
      releaseCandidate: false,
      fullSuite: false,
      catalogValid: true,
      suites: ["tests/a.spec.ts"],
      caseIds: ["case-a"],
      fallbackReasons: [],
      selectionFullSuite: false,
      selectionFallbackReasons: [],
      diagnostics: [],
    };
    const partial = await runCli(false);

    expect(partial.exitCode).toBe(0);

    expect(partial.stderr).toBe("");

    verifyPlan(partial.stdout, partialExpected);

    verifyGitHubOutput(await readFile(partial.githubOutputPath, "utf8"), partialExpected);

    const releaseExpected: PlanExpectation = {
      releaseCandidate: true,
      fullSuite: true,
      catalogValid: true,
      suites: ["tests/a.spec.ts", "tests/b.spec.ts"],
      caseIds: ["case-a", "case-b"],
      fallbackReasons: ["release candidates require the complete golden suite"],
      selectionFullSuite: true,
      selectionFallbackReasons: ["release candidates require the complete golden suite"],
      diagnostics: [],
    };
    const release = await runCli(true);

    expect(release.exitCode).toBe(0);

    expect(release.stderr).toBe("");

    verifyPlan(release.stdout, releaseExpected);

    verifyGitHubOutput(await readFile(release.githubOutputPath, "utf8"), releaseExpected);

    const inventoryFallbackReason =
      "Playwright inventory could not be verified against the catalog";
    const inventoryDiagnostic = "Playwright inventory could not be read:";
    const listingFailure = await runCli(false, {
      failPlaywrightListing: true,
      githubOutputPath: join(outputDirectory, "inventory-failure-output.txt"),
    });

    expect(listingFailure.exitCode).toBe(0);

    expect(listingFailure.stderr).toBe("");

    const inventoryFailureExpected: PlanExpectation = {
      releaseCandidate: false,
      fullSuite: true,
      catalogValid: false,
      suites: ["tests/a.spec.ts", "tests/b.spec.ts"],
      caseIds: ["case-a", "case-b"],
      fallbackReasons: [inventoryFallbackReason],
      selectionFullSuite: false,
      selectionFallbackReasons: [],
      diagnosticIncludes: [inventoryDiagnostic, listingFailureSentinel],
    };

    verifyPlan(listingFailure.stdout, inventoryFailureExpected);

    verifyGitHubOutput(
      await readFile(listingFailure.githubOutputPath, "utf8"),
      inventoryFailureExpected,
    );

    const directoryOutputPath = join(outputDirectory, "github-output-directory");
    const independentSentinelPath = join(directoryOutputPath, "independent-sentinel.txt");

    await mkdir(directoryOutputPath);

    await writeFile(independentSentinelPath, "sentinel=preserve\n");

    const directoryEntriesBefore = await readdir(directoryOutputPath);
    const directoryOutputFailure = await runCli(false, {
      githubOutputPath: directoryOutputPath,
      initializeOutput: false,
    });

    expect(directoryOutputFailure.exitCode).toBe(2);

    const [nativeDiagnostic] = directoryOutputFailure.stderr.split(/\r?\n/u);

    expect(nativeDiagnostic?.trim().length).toBeGreaterThan(0);

    expect(directoryOutputFailure.stderr).toContain("\nUsage: bun run scripts/ci/plan-golden.ts");

    verifyPlan(directoryOutputFailure.stdout, partialExpected);

    expect((await stat(directoryOutputPath)).isDirectory()).toBe(true);

    expect(await readdir(directoryOutputPath)).toStrictEqual(directoryEntriesBefore);

    expect(await readFile(independentSentinelPath, "utf8")).toBe("sentinel=preserve\n");
  } finally {
    await rm(outputDirectory, { recursive: true, force: true });

    await rm(root, { recursive: true, force: true });
  }
});
