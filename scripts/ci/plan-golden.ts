import { appendFileSync, readFileSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { isAbsolute, join, posix, relative, resolve } from "node:path";
import { selectGoldenCases, type GoldenSelection, type SelectorOptions } from "./select-golden.ts";

export const GOLDEN_PROJECTS = ["chromium", "firefox", "webkit"] as const;
export const GOLDEN_PLATFORMS = ["ubuntu-24.04", "windows-2025"] as const;

type GoldenProject = (typeof GOLDEN_PROJECTS)[number];

type GoldenPlatform = (typeof GOLDEN_PLATFORMS)[number];

type GoldenSelector = (options: SelectorOptions) => GoldenSelection;

interface CatalogCase {
  readonly id: string;
  readonly title: string;
  readonly suite: string;
  readonly behaviors: readonly string[];
}

interface ParsedCatalog {
  readonly cases: readonly CatalogCase[];
  readonly behaviorPaths: ReadonlySet<string>;
}

export interface GoldenMatrixEntry {
  readonly platform: GoldenPlatform;
  readonly project: GoldenProject;
  readonly suites: readonly string[];
  readonly caseIds: readonly string[];
  readonly caseToSuite: readonly { readonly caseId: string; readonly suite: string }[];
}

export interface GoldenPlan {
  readonly schemaVersion: 1;
  readonly caseScope: "suite";
  readonly fullSuite: boolean;
  readonly catalogValid: boolean;
  readonly diagnostics: readonly string[];
  readonly selectedCaseIds: readonly string[];
  readonly caseToSuite: readonly { readonly caseId: string; readonly suite: string }[];
  readonly fallbackReasons: readonly string[];
  readonly matrix: readonly GoldenMatrixEntry[];
  readonly selection?: GoldenSelection;
}

export interface GoldenPlanOptions {
  readonly repoPath: string;
  readonly base: string;
  readonly head: string;
  readonly catalogPath: string;
  readonly graphPath: string;
  readonly testsDirectory?: string;
  readonly releaseCandidate?: boolean;
  readonly selector?: GoldenSelector;
  readonly testInventory?: () => readonly PlaywrightInventoryEntry[];
  readonly projects?: readonly GoldenProject[];
  readonly platforms?: readonly GoldenPlatform[];
}

export interface PlaywrightInventoryEntry {
  readonly suite: string;
  readonly title: string;
}

function readCatalog(path: string): ParsedCatalog {
  const value: unknown = JSON.parse(readFileSync(path, "utf8"));

  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("catalog must be a JSON object");
  }

  const record = value as Record<string, unknown>;

  if (record.version !== 1 || !Array.isArray(record.behaviors) || !Array.isArray(record.cases)) {
    throw new Error("catalog must use version 1 with behaviors and cases arrays");
  }

  const behaviorPaths = new Set<string>();

  for (const item of record.behaviors) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw new Error("every catalog behavior must be an object");
    }

    const behavior = item as Record<string, unknown>;

    if (typeof behavior.id !== "string" || !Array.isArray(behavior.paths)) {
      throw new Error("every catalog behavior needs an id and paths array");
    }

    for (const pathValue of behavior.paths) {
      if (typeof pathValue !== "string") throw new Error("catalog behavior paths must be strings");

      behaviorPaths.add(pathValue.replaceAll("\\", "/"));
    }
  }

  const cases: CatalogCase[] = record.cases.map((item, index) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw new Error(`catalog case ${index} must be an object`);
    }

    const candidate = item as Record<string, unknown>;

    if (
      typeof candidate.id !== "string" ||
      typeof candidate.title !== "string" ||
      typeof candidate.suite !== "string" ||
      !Array.isArray(candidate.behaviors) ||
      candidate.behaviors.some((behavior) => typeof behavior !== "string")
    ) {
      throw new Error(`catalog case ${index} needs an id, suite, and behaviors array`);
    }

    return {
      id: candidate.id,
      title: candidate.title,
      suite: candidate.suite.replaceAll("\\", "/"),
      behaviors: candidate.behaviors as string[],
    };
  });

  if (cases.length === 0) throw new Error("catalog has no implemented cases");

  return { cases, behaviorPaths };
}

function readPlaywrightInventory(repoPath: string): readonly PlaywrightInventoryEntry[] {
  const goldenRoot = join(repoPath, "golden");
  const cliPath = join(repoPath, "node_modules", "@playwright", "test", "cli.js");
  const result = spawnSync(
    "node",
    [cliPath, "test", "--list", "--project=chromium", "--reporter=json"],
    { cwd: goldenRoot, encoding: "utf8" },
  );

  if (result.error) throw new Error(`could not list Playwright tests: ${result.error.message}`);

  if (result.status !== 0) {
    throw new Error(
      `Playwright test listing failed: ${result.stderr.trim() || result.stdout.trim()}`,
    );
  }

  const report: unknown = JSON.parse(result.stdout);

  if (!isObject(report) || !Array.isArray(report.suites)) {
    throw new Error("Playwright returned a malformed JSON test inventory");
  }

  const testsDirectory = resolve(goldenRoot, "tests");
  const inventory: PlaywrightInventoryEntry[] = [];

  const visit = (suites: readonly unknown[], inheritedFile?: string) => {
    for (const value of suites) {
      if (!isObject(value)) throw new Error("Playwright returned a malformed suite record");

      const file = typeof value.file === "string" ? value.file : inheritedFile;

      if (Array.isArray(value.specs)) {
        for (const specValue of value.specs) {
          if (!isObject(specValue) || typeof specValue.title !== "string") {
            throw new Error("Playwright returned a malformed test record");
          }

          const testFile = typeof specValue.file === "string" ? specValue.file : file;

          if (!testFile) throw new Error(`Playwright test ${specValue.title} has no file path`);

          const filePath = isAbsolute(testFile)
            ? relative(testsDirectory, testFile).replaceAll("\\", "/")
            : testFile.replaceAll("\\", "/").replace(/^tests\//u, "");

          inventory.push({ suite: `tests/${filePath}`, title: specValue.title });
        }
      }

      if (Array.isArray(value.suites)) visit(value.suites, file);
    }
  };

  visit(report.suites);

  if (inventory.length === 0) throw new Error("Playwright found no implemented tests");

  return inventory;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function compareCatalogInventory(
  catalog: ParsedCatalog,
  inventory: readonly PlaywrightInventoryEntry[],
): readonly string[] {
  const counts = new Map<string, number>();

  const identity = (suite: string, title: string) => `${suite}\0${title}`;

  for (const test of inventory) {
    const key = identity(test.suite, test.title);

    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  const issues: string[] = [];

  for (const item of catalog.cases) {
    const key = identity(item.suite, item.title);
    const count = counts.get(key) ?? 0;

    if (count === 0)
      issues.push(`catalog case ${item.id} does not match an implemented Playwright test`);
    else counts.set(key, count - 1);
  }

  for (const [key, count] of counts) {
    if (count <= 0) continue;

    const [suite, title] = key.split("\0");

    issues.push(
      `implemented Playwright test ${JSON.stringify(title)} in ${suite} is not cataloged`,
    );
  }

  return issues;
}

function listSuites(testsDirectory: string): readonly string[] {
  const suites: string[] = [];

  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name);

      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile() && entry.name.endsWith(".spec.ts")) {
        suites.push(`tests/${relative(testsDirectory, absolute).replaceAll("\\", "/")}`);
      }
    }
  };

  visit(testsDirectory);

  return suites.sort((left, right) => left.localeCompare(right));
}

function validateSuite(value: string, knownSuites: ReadonlySet<string>): string | undefined {
  const normalized = value.replaceAll("\\", "/");

  if (
    !normalized.startsWith("tests/") ||
    normalized !== posix.normalize(normalized) ||
    normalized.includes("../") ||
    !normalized.endsWith(".spec.ts")
  ) {
    return `suite path is not a Playwright spec path: ${value}`;
  }

  if (!knownSuites.has(normalized))
    return `suite path has no implemented Playwright spec: ${value}`;

  return undefined;
}

function buildMatrix(
  suites: readonly string[],
  caseToSuite: readonly { readonly caseId: string; readonly suite: string }[],
  projects: readonly GoldenProject[],
  platforms: readonly GoldenPlatform[],
): readonly GoldenMatrixEntry[] {
  return platforms.flatMap((platform) =>
    projects.map((project) => ({
      platform,
      project,
      suites,
      caseIds: caseToSuite.map(({ caseId }) => caseId),
      caseToSuite,
    })),
  );
}

export function createGoldenPlan(options: GoldenPlanOptions): GoldenPlan {
  const repoPath = resolve(options.repoPath);
  const catalogPath = resolve(repoPath, options.catalogPath);
  const testsDirectory = resolve(options.testsDirectory ?? join(repoPath, "golden", "tests"));
  const knownSuites = listSuites(testsDirectory);

  if (knownSuites.length === 0) {
    throw new Error(`no implemented golden Playwright specs were found under ${testsDirectory}`);
  }

  const diagnostics: string[] = [];
  const fallbackReasons: string[] = [];
  let catalogValid = false;
  let catalog: ParsedCatalog | undefined;

  try {
    catalog = readCatalog(catalogPath);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);

    diagnostics.push(`catalog is unavailable or malformed: ${detail}`);

    fallbackReasons.push("catalog validation failed");
  }

  let inventory: readonly PlaywrightInventoryEntry[] | undefined;

  try {
    inventory = options.testInventory?.() ?? readPlaywrightInventory(repoPath);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);

    diagnostics.push(`Playwright inventory could not be read: ${detail}`);

    fallbackReasons.push("Playwright inventory could not be verified against the catalog");
  }

  if (catalog && inventory) {
    const inventoryIssues = compareCatalogInventory(catalog, inventory);

    if (inventoryIssues.length > 0) {
      diagnostics.push(...inventoryIssues);

      fallbackReasons.push("catalog does not match the implemented Playwright test inventory");
    } else {
      catalogValid = true;
    }
  }

  const selector = options.selector ?? selectGoldenCases;
  let selection: GoldenSelection | undefined;

  try {
    selection = selector({
      repoPath,
      base: options.base,
      head: options.head,
      catalogPath: options.catalogPath,
      graphPath: options.graphPath,
      releaseCandidate: options.releaseCandidate ?? false,
    });

    fallbackReasons.push(...selection.fallbackReasons);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);

    diagnostics.push(`selection could not be trusted: ${detail}`);

    fallbackReasons.push("selection failed; all discovered golden specs are required");
  }

  if (catalog) {
    const known = new Set(knownSuites);

    for (const item of catalog.cases) {
      const issue = validateSuite(item.suite, known);

      if (issue) {
        catalogValid = false;

        diagnostics.push(`catalog case ${item.id}: ${issue}`);

        fallbackReasons.push("catalog references a suite with no implemented test file");
      }
    }
  }

  const selectedChangedPaths = selection?.changedPaths ?? [];

  if (catalog) {
    for (const changed of selectedChangedPaths) {
      const path = changed.path.replaceAll("\\", "/");

      if (
        path.startsWith("golden/") &&
        path !== options.catalogPath.replaceAll("\\", "/") &&
        path !== options.graphPath.replaceAll("\\", "/") &&
        !catalog.behaviorPaths.has(path)
      ) {
        diagnostics.push(`changed golden path is not mapped to a behavior: ${path}`);

        fallbackReasons.push("a changed golden path is not represented in the case catalog");
      }
    }
  }

  const selectedCases = selection?.selectedCases ?? [];
  const known = new Set(knownSuites);

  for (const item of selectedCases) {
    const issue = validateSuite(item.suite, known);

    if (issue) {
      diagnostics.push(`selected case ${item.id}: ${issue}`);

      fallbackReasons.push("selection referenced a suite that cannot be run");
    }
  }

  if (selectedCases.length === 0) fallbackReasons.push("selection returned no runnable cases");

  const uniqueFallbackReasons = [...new Set(fallbackReasons)];
  const fullSuite = Boolean(selection?.fullSuite) || uniqueFallbackReasons.length > 0;
  const allCaseToSuite = (catalog?.cases ?? []).flatMap((item) =>
    known.has(item.suite) ? [{ caseId: item.id, suite: item.suite }] : [],
  );
  const selectedCaseIds = fullSuite
    ? allCaseToSuite.map(({ caseId }) => caseId)
    : selectedCases.map(({ id }) => id);
  const caseToSuite = fullSuite
    ? allCaseToSuite
    : selectedCases.map(({ id, suite }) => ({ caseId: id, suite }));
  const suites = fullSuite
    ? knownSuites
    : [...new Set(selectedCases.map(({ suite }) => suite))].sort((left, right) =>
        left.localeCompare(right),
      );
  const projects = options.projects ?? GOLDEN_PROJECTS;
  const platforms = options.platforms ?? GOLDEN_PLATFORMS;

  if (projects.length === 0 || platforms.length === 0) {
    throw new Error("the golden matrix must include at least one project and platform");
  }

  const matrix = buildMatrix(suites, caseToSuite, projects, platforms);

  if (matrix.length === 0)
    throw new Error("the golden matrix is empty; refusing to skip verification");

  return {
    schemaVersion: 1,
    caseScope: "suite",
    fullSuite,
    catalogValid,
    diagnostics,
    selectedCaseIds,
    caseToSuite,
    fallbackReasons: uniqueFallbackReasons,
    matrix,
    ...(selection ? { selection } : {}),
  };
}

export function toGitHubOutputs(plan: GoldenPlan): string {
  const matrix = {
    include: plan.matrix.map(({ platform, project, suites }) => ({ platform, project, suites })),
  };
  const summary = {
    schemaVersion: plan.schemaVersion,
    caseScope: plan.caseScope,
    fullSuite: plan.fullSuite,
    catalogValid: plan.catalogValid,
    diagnostics: plan.diagnostics,
    selectedCaseIds: plan.selectedCaseIds,
    caseToSuite: plan.caseToSuite,
    fallbackReasons: plan.fallbackReasons,
  };
  return [
    `matrix=${JSON.stringify(matrix)}`,
    `full_suite=${plan.fullSuite}`,
    `catalog_valid=${plan.catalogValid}`,
    `selection_summary=${JSON.stringify(summary)}`,
    "",
  ].join("\n");
}

function parseArguments(args: readonly string[]): GoldenPlanOptions | undefined {
  const values = new Map<string, string>();
  let releaseCandidate = false;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];

    if (argument === "--help" || argument === "-h") return undefined;

    if (argument === "--release-candidate") {
      releaseCandidate = true;
      continue;
    }

    if (
      argument !== "--base" &&
      argument !== "--head" &&
      argument !== "--repo" &&
      argument !== "--catalog-path" &&
      argument !== "--graph-path" &&
      argument !== "--tests-directory"
    ) {
      throw new Error(`unknown option: ${argument ?? ""}`);
    }

    const value = args[index + 1];

    if (!value || value.startsWith("--")) throw new Error(`${argument} requires a value`);

    values.set(argument, value);

    index += 1;
  }

  for (const required of ["--base", "--head", "--catalog-path", "--graph-path"]) {
    if (!values.has(required)) throw new Error(`${required} is required`);
  }

  return {
    repoPath: resolve(values.get("--repo") ?? process.cwd()),
    base: values.get("--base") ?? "",
    head: values.get("--head") ?? "",
    catalogPath: values.get("--catalog-path") ?? "",
    graphPath: values.get("--graph-path") ?? "",
    ...(values.has("--tests-directory")
      ? { testsDirectory: resolve(values.get("--tests-directory") ?? "") }
      : {}),
    releaseCandidate,
  };
}

const usage = `Usage: bun run scripts/ci/plan-golden.ts --base <git-ref> --head <git-ref> --catalog-path golden/catalog.json --graph-path golden/dependency-graph.json [--repo <directory>] [--release-candidate]

Prints the selected suites and a Windows/Linux, Chromium/Firefox/WebKit matrix. Selection failures run every discovered golden spec.`;

if (import.meta.main) {
  try {
    const options = parseArguments(Bun.argv.slice(2));

    if (!options) {
      console.log(usage);
    } else {
      const plan = createGoldenPlan(options);

      console.log(JSON.stringify(plan, null, 2));

      const outputPath = process.env.GITHUB_OUTPUT;

      if (outputPath) appendFileSync(outputPath, toGitHubOutputs(plan));
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));

    console.error(usage);

    process.exitCode = 2;
  }
}
