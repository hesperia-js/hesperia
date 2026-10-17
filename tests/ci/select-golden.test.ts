import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { selectGoldenCases } from "../../scripts/ci/select-golden.ts";

const CATALOG_PATH = ".ci/golden-catalog.json";
const GRAPH_PATH = ".ci/dependency-graph.json";

const standardCatalog = {
  version: 1,
  behaviors: [
    { id: "changed", paths: ["src/changed.ts"] },
    { id: "consumer", paths: ["src/consumer.ts"] },
    { id: "related", paths: ["src/related.ts"], dependsOn: ["changed"] },
    { id: "unrelated", paths: ["src/unrelated.ts"] },
  ],
  cases: [
    { id: "changed-case", suite: "behavioral", behaviors: ["changed"] },
    { id: "consumer-case", suite: "applications", behaviors: ["consumer"] },
    { id: "related-case", suite: "behavioral", behaviors: ["related"] },
    { id: "unrelated-case", suite: "applications", behaviors: ["unrelated"] },
  ],
} as const;

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

async function writeRepoFile(repo: string, path: string, value: string): Promise<void> {
  const absolutePath = join(repo, path);

  await mkdir(dirname(absolutePath), { recursive: true });

  await writeFile(absolutePath, value);
}

async function writeJson(repo: string, path: string, value: unknown): Promise<void> {
  await writeRepoFile(repo, path, `${JSON.stringify(value, null, 2)}\n`);
}

async function initializeRepo(): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), "hesperia-ci-selector-fixture-"));

  git(repo, ["init", "--quiet"]);

  git(repo, ["config", "user.name", "Hesperia CI fixture"]);

  git(repo, ["config", "user.email", "ci-fixture@example.invalid"]);

  return repo;
}

function commit(repo: string, message: string): string {
  git(repo, ["add", "--all"]);

  git(repo, ["commit", "--quiet", "-m", message]);

  return git(repo, ["rev-parse", "HEAD"]);
}

function selection(repo: string, base: string, head: string, releaseCandidate = false) {
  return selectGoldenCases({
    repoPath: repo,
    base,
    head,
    catalogPath: CATALOG_PATH,
    graphPath: GRAPH_PATH,
    releaseCandidate,
  });
}

async function removeRepoFile(repo: string, path: string): Promise<void> {
  await rm(join(repo, path), { force: true });
}

test(
  "selects checklist cases from their source, fixture, and spec paths",
  async () => {
    const repo = await initializeRepo();

    try {
      const catalog = await readFile(resolve(import.meta.dir, "../../golden/catalog.json"), "utf8");

      await writeRepoFile(repo, CATALOG_PATH, catalog);

      await writeJson(repo, GRAPH_PATH, { version: 1, nodes: [], dependencies: [] });

      await writeRepoFile(
        repo,
        "packages/hesperia/src/data/contract.ts",
        "export const contractVersion = 1;\n",
      );

      await writeRepoFile(
        repo,
        "golden/fixtures/checklist/src/api.ts",
        "export const fixtureVersion = 1;\n",
      );

      await writeRepoFile(
        repo,
        "golden/tests/checklist.spec.ts",
        "export const specVersion = 1;\n",
      );

      const base = commit(repo, "base with the current golden catalog");

      await writeRepoFile(
        repo,
        "packages/hesperia/src/data/contract.ts",
        "export const contractVersion = 2;\n",
      );

      const sourceHead = commit(repo, "change checklist contract source");
      const sourceResult = selection(repo, base, sourceHead);

      expect(sourceResult.fullSuite).toBe(false);

      expect(sourceResult.fallbackReasons).toEqual([]);

      expect(sourceResult.selectedCaseIds).toEqual([
        "checklist-cached-page-restoration",
        "checklist-crud-live-queries-cleanup",
        "checklist-seeded-model-keyed-rows",
        "lifecycle-query-boundary-success",
        "lifecycle-query-error-cleanup",
        "lifecycle-shared-stream-idle-expiry",
      ]);

      await writeRepoFile(
        repo,
        "golden/fixtures/checklist/src/api.ts",
        "export const fixtureVersion = 2;\n",
      );

      const fixtureHead = commit(repo, "change checklist API fixture");
      const fixtureResult = selection(repo, sourceHead, fixtureHead);

      expect(
        fixtureResult.fullSuite,
        JSON.stringify({
          fallbackReasons: fixtureResult.fallbackReasons,
          changedPaths: fixtureResult.changedPaths,
          affectedBehaviors: fixtureResult.affectedBehaviors,
          selectedCaseIds: fixtureResult.selectedCaseIds,
        }),
      ).toBe(false);

      expect(fixtureResult.fallbackReasons).toEqual([]);

      expect(fixtureResult.selectedCaseIds).toEqual([
        "checklist-cached-page-restoration",
        "checklist-crud-live-queries-cleanup",
        "checklist-latest-run-suppression",
        "checklist-seeded-model-keyed-rows",
      ]);

      await writeRepoFile(
        repo,
        "golden/tests/checklist.spec.ts",
        "export const specVersion = 2;\n",
      );

      const specHead = commit(repo, "change checklist spec");
      const specResult = selection(repo, fixtureHead, specHead);

      expect(specResult.fullSuite).toBe(false);

      expect(specResult.fallbackReasons).toEqual([]);

      expect(specResult.selectedCaseIds).toEqual([
        "checklist-cached-page-restoration",
        "checklist-crud-live-queries-cleanup",
        "checklist-latest-run-suppression",
        "checklist-seeded-model-keyed-rows",
      ]);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  },
  { timeout: 30_000 },
);

test(
  "uses both Git dependency graphs and explicit behavior relationships with reasons",
  async () => {
    const repo = await initializeRepo();

    try {
      await writeJson(repo, CATALOG_PATH, standardCatalog);

      await writeJson(repo, GRAPH_PATH, {
        version: 1,
        nodes: [
          "src/changed.ts",
          "src/middle.ts",
          "src/consumer.ts",
          "src/related.ts",
          "src/unrelated.ts",
        ],
        dependencies: [
          { consumer: "src/middle.ts", dependency: "src/changed.ts" },
          { consumer: "src/consumer.ts", dependency: "src/middle.ts" },
        ],
      });

      await writeRepoFile(repo, "src/changed.ts", "export const changed = 1;\n");

      await writeRepoFile(repo, "src/middle.ts", "import { changed } from './changed';\n");

      await writeRepoFile(repo, "src/consumer.ts", "import './middle';\n");

      await writeRepoFile(repo, "src/related.ts", "export const related = true;\n");

      await writeRepoFile(repo, "src/unrelated.ts", "export const unrelated = true;\n");

      const base = commit(repo, "base");

      await writeRepoFile(repo, "src/changed.ts", "export const changed = 2;\n");

      const head = commit(repo, "change source");
      const result = selection(repo, base, head);

      expect(result.fallbackReasons).toEqual([]);

      expect(result.fullSuite).toBe(false);

      expect(result.selectedCaseIds).toEqual(["changed-case", "consumer-case", "related-case"]);

      expect(result.selectedCaseIds).not.toContain("unrelated-case");

      expect(result.affectedPaths).toContainEqual({
        path: "src/consumer.ts",
        changedPath: "src/changed.ts",
        dependencyChain: ["src/changed.ts", "src/middle.ts", "src/consumer.ts"],
        revisions: ["base", "head"],
      });

      expect(
        result.selectedCases.find((item) => item.id === "related-case")?.reasons.join("\n"),
      ).toContain("behavior dependency changed -> related");

      expect(
        result.selectedCases.find((item) => item.id === "consumer-case")?.reasons.join("\n"),
      ).toContain("src/changed.ts -> src/middle.ts -> src/consumer.ts");

      const cli = Bun.spawnSync(
        [
          "bun",
          "run",
          resolve(import.meta.dir, "../../scripts/ci/select-golden.ts"),
          "--base",
          base,
          "--head",
          head,
          "--repo",
          repo,
          "--catalog-path",
          CATALOG_PATH,
          "--graph-path",
          GRAPH_PATH,
        ],
        { stdout: "pipe", stderr: "pipe" },
      );

      expect(cli.success).toBe(true);

      const cliResult = JSON.parse(new TextDecoder().decode(cli.stdout)) as {
        selectedCaseIds: readonly string[];
      };

      expect(cliResult.selectedCaseIds).toEqual(result.selectedCaseIds);

      const allCaseIds = ["changed-case", "consumer-case", "related-case", "unrelated-case"];
      const unrelatedPath = join(repo, "src/unrelated.ts");
      const originalUnrelatedSource = await readFile(unrelatedPath, "utf8");

      await writeRepoFile(repo, "src/unrelated.ts", "export const unrelated = false;\n");

      const dirtyWorkspace = selection(repo, base, head);

      expect(dirtyWorkspace.fullSuite).toBe(true);

      expect(dirtyWorkspace.selectedCaseIds).toEqual(allCaseIds);

      expect(dirtyWorkspace.fallbackReasons).toEqual([
        "the workspace has uncommitted or untracked files; selection uses the complete golden suite",
      ]);

      await writeFile(unrelatedPath, originalUnrelatedSource);

      git(repo, ["checkout", "--quiet", "--detach", base]);

      const staleCheckout = selection(repo, base, head);

      expect(staleCheckout.fullSuite).toBe(true);

      expect(staleCheckout.selectedCaseIds).toEqual(allCaseIds);

      expect(staleCheckout.fallbackReasons).toEqual([
        `the checked-out workspace HEAD ${base} does not match requested head ${head}`,
      ]);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  },
  { timeout: 20_000 },
);

test("acquires a newly changed source import from the head workspace", async () => {
  const repo = await initializeRepo();

  try {
    await writeJson(repo, CATALOG_PATH, {
      version: 1,
      behaviors: [
        { id: "feature", paths: ["tests/feature.test.ts"] },
        { id: "unrelated", paths: ["src/unrelated.ts"] },
      ],
      cases: [
        { id: "feature-case", suite: "behavioral", behaviors: ["feature"] },
        { id: "unrelated-case", suite: "applications", behaviors: ["unrelated"] },
      ],
    });

    await writeJson(repo, GRAPH_PATH, { version: 1, nodes: [], dependencies: [] });

    await writeRepoFile(repo, "src/old-dependency.ts", "export const oldValue = true;\n");

    await writeRepoFile(repo, "src/new-dependency.ts", "export const newValue = 1;\n");

    await writeRepoFile(
      repo,
      "src/consumer.ts",
      "import { oldValue } from './old-dependency.ts';\nexport { oldValue };\n",
    );

    await writeRepoFile(repo, "tests/feature.test.ts", "import '../src/consumer.ts';\n");

    await writeRepoFile(repo, "src/unrelated.ts", "export const unrelated = true;\n");

    const base = commit(repo, "base imports old module");

    await writeRepoFile(repo, "src/new-dependency.ts", "export const newValue = 2;\n");

    await writeRepoFile(
      repo,
      "src/consumer.ts",
      "import { newValue } from './new-dependency.js';\nexport { newValue };\n",
    );

    const head = commit(repo, "head imports new module");
    const result = selection(repo, base, head);

    expect(result.fallbackReasons).toEqual([]);

    expect(result.fullSuite).toBe(false);

    expect(result.selectedCaseIds).toEqual(["feature-case"]);

    expect(result.selectedCaseIds).not.toContain("unrelated-case");

    expect(result.affectedPaths).toContainEqual({
      path: "tests/feature.test.ts",
      changedPath: "src/new-dependency.ts",
      dependencyChain: ["src/new-dependency.ts", "src/consumer.ts", "tests/feature.test.ts"],
      revisions: ["base", "head"],
    });
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("falls back when a workspace-style import has no known graph edge", async () => {
  const repo = await initializeRepo();

  try {
    await writeJson(repo, CATALOG_PATH, {
      version: 1,
      behaviors: [
        { id: "feature", paths: ["src/consumer.ts"] },
        { id: "unrelated", paths: ["src/unrelated.ts"] },
      ],
      cases: [
        { id: "feature-case", suite: "behavioral", behaviors: ["feature"] },
        { id: "unrelated-case", suite: "applications", behaviors: ["unrelated"] },
      ],
    });

    await writeJson(repo, GRAPH_PATH, { version: 1, nodes: [], dependencies: [] });

    await writeRepoFile(
      repo,
      "src/consumer.ts",
      "import { runtime } from '@hesperia/runtime';\nexport { runtime };\n",
    );

    await writeRepoFile(repo, "src/unrelated.ts", "export const unrelated = true;\n");

    const base = commit(repo, "base with workspace import");

    await writeRepoFile(
      repo,
      "src/consumer.ts",
      "import { runtime } from '@hesperia/runtime';\nexport const current = runtime;\n",
    );

    const head = commit(repo, "change source with unknown workspace edge");
    const result = selection(repo, base, head);

    expect(result.fullSuite).toBe(true);

    expect(result.selectedCaseIds).toEqual(["feature-case", "unrelated-case"]);

    expect(
      result.fallbackReasons.some((reason) =>
        reason.includes(
          'local import "@hesperia/runtime" from src/consumer.ts has no unique tracked source export',
        ),
      ),
    ).toBe(true);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("resolves a nested package import from its own manifest", async () => {
  const repo = await initializeRepo();

  try {
    await writeJson(repo, CATALOG_PATH, {
      version: 1,
      behaviors: [
        { id: "package", paths: ["packages/hesperia/src/index.ts"] },
        { id: "application", paths: ["apps/example.ts"] },
        { id: "unrelated", paths: ["src/unrelated.ts"] },
      ],
      cases: [
        { id: "package-case", suite: "behavioral", behaviors: ["package"] },
        { id: "application-case", suite: "applications", behaviors: ["application"] },
        { id: "unrelated-case", suite: "applications", behaviors: ["unrelated"] },
      ],
    });

    await writeJson(repo, GRAPH_PATH, { version: 1, nodes: [], dependencies: [] });

    await writeJson(repo, "package.json", {
      name: "hesperia-workspace",
      private: true,
      workspaces: ["packages/*"],
    });

    await writeJson(repo, "packages/hesperia/package.json", {
      name: "hesperia",
      exports: { ".": "./dist/index.js" },
    });

    await writeRepoFile(repo, "packages/hesperia/src/index.ts", "export const count = 1;\n");

    await writeRepoFile(
      repo,
      "apps/example.ts",
      'import { count } from "hesperia"; export const display = count;\n',
    );

    await writeRepoFile(repo, "src/unrelated.ts", "export const unrelated = true;\n");

    const base = commit(repo, "base with nested workspace package");

    await writeRepoFile(repo, "packages/hesperia/src/index.ts", "export const count = 2;\n");

    const head = commit(repo, "change nested workspace package source");
    const result = selection(repo, base, head);

    expect(result.fullSuite).toBe(false);

    expect(result.fallbackReasons).toEqual([]);

    expect(result.selectedCaseIds).toEqual(["application-case", "package-case"]);

    expect(result.selectedCaseIds).not.toContain("unrelated-case");

    expect(result.affectedPaths).toContainEqual({
      path: "apps/example.ts",
      changedPath: "packages/hesperia/src/index.ts",
      dependencyChain: ["packages/hesperia/src/index.ts", "apps/example.ts"],
      revisions: ["base", "head"],
    });
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("retains the base workspace import edge when a package is renamed", async () => {
  const repo = await initializeRepo();

  try {
    await writeJson(repo, CATALOG_PATH, {
      version: 1,
      behaviors: [
        { id: "package", paths: ["packages/renamed/src/index.ts"] },
        { id: "application", paths: ["apps/example.ts"] },
        { id: "unrelated", paths: ["src/unrelated.ts"] },
      ],
      cases: [
        { id: "package-case", suite: "behavioral", behaviors: ["package"] },
        { id: "application-case", suite: "applications", behaviors: ["application"] },
        { id: "unrelated-case", suite: "applications", behaviors: ["unrelated"] },
      ],
    });

    await writeJson(repo, GRAPH_PATH, { version: 1, nodes: [], dependencies: [] });

    await writeJson(repo, "package.json", {
      name: "fixture-workspace",
      private: true,
      workspaces: ["packages/*"],
    });

    await writeJson(repo, "packages/hesperia/package.json", {
      name: "hesperia",
      exports: { ".": "./dist/index.js" },
    });

    await writeRepoFile(repo, "packages/hesperia/src/index.ts", "export const count = 1;\n");

    await writeRepoFile(
      repo,
      "apps/example.ts",
      'import { count } from "hesperia"; export const display = count;\n',
    );

    await writeRepoFile(repo, "src/unrelated.ts", "export const unrelated = true;\n");

    const base = commit(repo, "base with hesperia workspace package");

    await removeRepoFile(repo, "packages/hesperia/package.json");

    await removeRepoFile(repo, "packages/hesperia/src/index.ts");

    await writeJson(repo, "packages/renamed/package.json", {
      name: "@fixture/runtime",
      exports: { ".": "./dist/index.js" },
    });

    await writeRepoFile(repo, "packages/renamed/src/index.ts", "export const count = 2;\n");

    await writeRepoFile(
      repo,
      "apps/example.ts",
      'import { count } from "@fixture/runtime"; export const display = count;\n',
    );

    const head = commit(repo, "rename workspace package and import");
    const result = selection(repo, base, head);

    expect(result.fullSuite).toBe(true);

    expect(result.fallbackReasons).toContain(
      "workspace package manifest changed: packages/hesperia/package.json",
    );

    expect(result.selectedCaseIds).toContain("application-case");

    expect(result.affectedPaths).toContainEqual({
      path: "apps/example.ts",
      changedPath: "packages/hesperia/src/index.ts",
      dependencyChain: ["packages/hesperia/src/index.ts", "apps/example.ts"],
      revisions: ["base"],
    });

    expect(result.affectedPaths).toContainEqual({
      path: "apps/example.ts",
      changedPath: "packages/renamed/src/index.ts",
      dependencyChain: ["packages/renamed/src/index.ts", "apps/example.ts"],
      revisions: ["head"],
    });
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("falls back when duplicate workspace exports map one import to multiple sources", async () => {
  const repo = await initializeRepo();

  try {
    await writeJson(repo, CATALOG_PATH, {
      version: 1,
      behaviors: [
        { id: "package", paths: ["packages/one/src/index.ts"] },
        { id: "application", paths: ["apps/example.ts"] },
      ],
      cases: [
        { id: "package-case", suite: "behavioral", behaviors: ["package"] },
        { id: "application-case", suite: "applications", behaviors: ["application"] },
      ],
    });

    await writeJson(repo, GRAPH_PATH, { version: 1, nodes: [], dependencies: [] });

    await writeJson(repo, "package.json", {
      name: "fixture-workspace",
      private: true,
      workspaces: ["packages/*"],
    });

    for (const packagePath of ["packages/one", "packages/two"]) {
      await writeJson(repo, `${packagePath}/package.json`, {
        name: "@fixture/shared",
        exports: { ".": "./dist/index.js" },
      });

      await writeRepoFile(repo, `${packagePath}/src/index.ts`, "export const value = 1;\n");
    }

    await writeRepoFile(
      repo,
      "apps/example.ts",
      'import { value } from "@fixture/shared"; export { value };\n',
    );

    const base = commit(repo, "base with duplicate workspace package names");

    await writeRepoFile(repo, "packages/one/src/index.ts", "export const value = 2;\n");

    const head = commit(repo, "change ambiguous workspace source");
    const result = selection(repo, base, head);

    expect(result.fullSuite).toBe(true);

    expect(result.selectedCaseIds).toEqual(["application-case", "package-case"]);

    expect(
      result.fallbackReasons.some((reason) => reason.includes("no unique tracked source export")),
    ).toBe(true);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("falls back when a tracked workspace package manifest cannot be parsed", async () => {
  const repo = await initializeRepo();

  try {
    await writeJson(repo, CATALOG_PATH, {
      version: 1,
      behaviors: [{ id: "changed", paths: ["src/changed.ts"] }],
      cases: [{ id: "changed-case", suite: "behavioral", behaviors: ["changed"] }],
    });

    await writeJson(repo, GRAPH_PATH, { version: 1, nodes: [], dependencies: [] });

    await writeJson(repo, "package.json", {
      name: "fixture-workspace",
      private: true,
      workspaces: ["packages/*"],
    });

    await writeRepoFile(repo, "packages/broken/package.json", "{ invalid manifest\n");

    await writeRepoFile(repo, "src/changed.ts", "export const changed = 1;\n");

    const base = commit(repo, "base with malformed nested manifest");

    await writeRepoFile(repo, "src/changed.ts", "export const changed = 2;\n");

    const head = commit(repo, "change known source with malformed manifest present");
    const result = selection(repo, base, head);

    expect(result.fullSuite).toBe(true);

    expect(
      result.fallbackReasons.some((reason) =>
        reason.includes("Could not parse tracked package manifest packages/broken/package.json"),
      ),
    ).toBe(true);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("falls back when import() or require() has a non-literal dependency", async () => {
  const repo = await initializeRepo();

  try {
    await writeJson(repo, CATALOG_PATH, {
      version: 1,
      behaviors: [
        { id: "dynamic", paths: ["src/dynamic.ts"] },
        { id: "unrelated", paths: ["src/unrelated.ts"] },
      ],
      cases: [
        { id: "dynamic-case", suite: "behavioral", behaviors: ["dynamic"] },
        { id: "unrelated-case", suite: "applications", behaviors: ["unrelated"] },
      ],
    });

    await writeJson(repo, GRAPH_PATH, { version: 1, nodes: [], dependencies: [] });

    await writeRepoFile(
      repo,
      "src/dynamic.ts",
      "export async function load(specifier: string) { return [await import(specifier), require(specifier)]; }\n",
    );

    await writeRepoFile(repo, "src/unrelated.ts", "export const unrelated = true;\n");

    const base = commit(repo, "base with dynamic dependency expressions");

    await writeRepoFile(
      repo,
      "src/dynamic.ts",
      "export async function load(specifier: string) { const value = await import(specifier); return [value, require(specifier)]; }\n",
    );

    const head = commit(repo, "change dynamic dependency source");
    const result = selection(repo, base, head);

    expect(result.fullSuite).toBe(true);

    expect(result.selectedCaseIds).toEqual(["dynamic-case", "unrelated-case"]);

    expect(result.fallbackReasons.some((reason) => reason.includes("non-literal import()"))).toBe(
      true,
    );

    expect(result.fallbackReasons.some((reason) => reason.includes("non-literal require()"))).toBe(
      true,
    );
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("ignores incomplete imports outside catalog and affected paths", async () => {
  const repo = await initializeRepo();

  try {
    await writeJson(repo, CATALOG_PATH, {
      version: 1,
      behaviors: [
        { id: "changed", paths: ["src/changed.ts"] },
        { id: "unrelated", paths: ["src/unrelated.ts"] },
      ],
      cases: [
        { id: "changed-case", suite: "behavioral", behaviors: ["changed"] },
        { id: "unrelated-case", suite: "applications", behaviors: ["unrelated"] },
      ],
    });

    await writeJson(repo, GRAPH_PATH, { version: 1, nodes: [], dependencies: [] });

    await writeRepoFile(repo, "src/changed.ts", "export const changed = 1;\n");

    await writeRepoFile(repo, "src/unrelated.ts", "export const unrelated = true;\n");

    await writeRepoFile(
      repo,
      "tests/compiler/conditional-capture.test.ts",
      "const moduleUrl = URL.createObjectURL(new Blob());\nawait import(moduleUrl);\n",
    );

    const base = commit(repo, "base with unrelated dynamic test import");

    await writeRepoFile(repo, "src/changed.ts", "export const changed = 2;\n");

    const head = commit(repo, "change catalog-mapped source");
    const result = selection(repo, base, head);

    expect(result.fullSuite).toBe(false);

    expect(result.fallbackReasons).toEqual([]);

    expect(result.selectedCaseIds).toEqual(["changed-case"]);

    expect(result.selectedCaseIds).not.toContain("unrelated-case");
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("retains a deleted source's base-only dependency edge", async () => {
  const repo = await initializeRepo();

  try {
    const catalog = {
      version: 1,
      behaviors: [
        { id: "consumer", paths: ["src/consumer.ts"] },
        { id: "other", paths: ["src/other.ts"] },
      ],
      cases: [
        { id: "consumer-case", suite: "applications", behaviors: ["consumer"] },
        { id: "other-case", suite: "applications", behaviors: ["other"] },
      ],
    };

    await writeJson(repo, CATALOG_PATH, catalog);

    await writeJson(repo, GRAPH_PATH, { version: 1, nodes: [], dependencies: [] });

    await writeRepoFile(repo, "src/legacy.ts", "export const oldBehavior = true;\n");

    await writeRepoFile(repo, "src/consumer.ts", "import './legacy';\n");

    await writeRepoFile(repo, "src/other.ts", "export const stable = true;\n");

    const base = commit(repo, "base with legacy edge");

    await removeRepoFile(repo, "src/legacy.ts");

    await writeRepoFile(repo, "src/consumer.ts", "export const consumer = true;\n");

    await writeJson(repo, GRAPH_PATH, { version: 1, nodes: [], dependencies: [] });

    const head = commit(repo, "remove legacy edge and source");
    const result = selection(repo, base, head);

    expect(result.fullSuite).toBe(false);

    expect(result.fallbackReasons).toEqual([]);

    expect(result.changedPaths).toContainEqual({ path: "src/legacy.ts", status: "D" });

    expect(result.selectedCaseIds).toEqual(["consumer-case"]);

    expect(result.affectedPaths).toContainEqual({
      path: "src/consumer.ts",
      changedPath: "src/legacy.ts",
      dependencyChain: ["src/legacy.ts", "src/consumer.ts"],
      revisions: ["base"],
    });
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("falls back to every case for an unknown changed path", async () => {
  const repo = await initializeRepo();

  try {
    await writeJson(repo, CATALOG_PATH, standardCatalog);

    await writeJson(repo, GRAPH_PATH, {
      version: 1,
      nodes: ["src/changed.ts", "src/consumer.ts", "src/related.ts", "src/unrelated.ts"],
      dependencies: [],
    });

    await writeRepoFile(repo, "src/changed.ts", "export const changed = 1;\n");

    const base = commit(repo, "base");

    await writeRepoFile(
      repo,
      "docs/unmapped.md",
      "No catalog or graph entry describes this path.\n",
    );

    const head = commit(repo, "add unknown path");
    const result = selection(repo, base, head);

    expect(result.fullSuite).toBe(true);

    expect(result.selectedCaseIds).toEqual([
      "changed-case",
      "consumer-case",
      "related-case",
      "unrelated-case",
    ]);

    expect(result.fallbackReasons).toContain(
      "impact is unknown for changed path docs/unmapped.md; it appears in neither Git dependency graph nor the behavior catalog",
    );
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("falls back when the golden catalog changes even if no case maps to it", async () => {
  const repo = await initializeRepo();

  try {
    await writeJson(repo, CATALOG_PATH, standardCatalog);

    await writeJson(repo, GRAPH_PATH, { version: 1, nodes: ["src/changed.ts"], dependencies: [] });

    await writeRepoFile(repo, "src/changed.ts", "export const changed = 1;\n");

    const base = commit(repo, "base");

    await writeRepoFile(repo, CATALOG_PATH, `${JSON.stringify(standardCatalog, null, 2)}\n\n`);

    const catalogHead = commit(repo, "edit catalog");
    const catalogResult = selection(repo, base, catalogHead);

    expect(catalogResult.fullSuite).toBe(true);

    expect(catalogResult.fallbackReasons).toContain(
      `the golden case catalog changed: ${CATALOG_PATH}`,
    );
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("falls back when the selector implementation changes even if no case maps to it", async () => {
  const repo = await initializeRepo();

  try {
    await writeJson(repo, CATALOG_PATH, standardCatalog);

    await writeJson(repo, GRAPH_PATH, { version: 1, nodes: ["src/changed.ts"], dependencies: [] });

    await writeRepoFile(repo, "src/changed.ts", "export const changed = 1;\n");

    const base = commit(repo, "base");

    await writeRepoFile(repo, "scripts/ci/select-golden.ts", "// fixture selector edit\n");

    const head = commit(repo, "edit selector");
    const result = selection(repo, base, head);

    expect(result.fullSuite).toBe(true);

    expect(result.fallbackReasons).toContain(
      "the selector implementation, tests, or guidance changed: scripts/ci/select-golden.ts",
    );
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("falls back for a release candidate", async () => {
  const repo = await initializeRepo();

  try {
    await writeJson(repo, CATALOG_PATH, standardCatalog);

    await writeJson(repo, GRAPH_PATH, { version: 1, nodes: ["src/changed.ts"], dependencies: [] });

    await writeRepoFile(repo, "src/changed.ts", "export const changed = 1;\n");

    const base = commit(repo, "base");

    await writeRepoFile(repo, "src/changed.ts", "export const changed = 2;\n");

    const sourceHead = commit(repo, "change known source");
    const releaseResult = selection(repo, base, sourceHead, true);

    expect(releaseResult.fullSuite).toBe(true);

    expect(releaseResult.fallbackReasons).toContain(
      "release candidates require the complete golden suite",
    );
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("falls back when a graph-only change maps to no cases", async () => {
  const repo = await initializeRepo();

  try {
    await writeJson(repo, CATALOG_PATH, standardCatalog);

    await writeJson(repo, GRAPH_PATH, { version: 1, nodes: ["src/changed.ts"], dependencies: [] });

    await writeRepoFile(repo, "src/changed.ts", "export const changed = 1;\n");

    const base = commit(repo, "base");

    await writeJson(repo, GRAPH_PATH, {
      version: 1,
      nodes: ["src/changed.ts", "src/orphan.ts"],
      dependencies: [],
    });

    const head = commit(repo, "change graph input only");
    const result = selection(repo, base, head);

    expect(result.fullSuite).toBe(true);

    expect(result.fallbackReasons).toContain("the known code impact maps to no golden cases");
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("falls back for an empty Git diff", async () => {
  const repo = await initializeRepo();

  try {
    await writeJson(repo, CATALOG_PATH, standardCatalog);

    await writeJson(repo, GRAPH_PATH, { version: 1, nodes: ["src/changed.ts"], dependencies: [] });

    await writeRepoFile(repo, "src/changed.ts", "export const changed = 1;\n");

    const head = commit(repo, "base");
    const result = selection(repo, head, head);

    expect(result.fullSuite).toBe(true);

    expect(result.fallbackReasons).toContain("the base-to-head diff contains no changed paths");
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("falls back when the base dependency graph is unavailable", async () => {
  const repo = await initializeRepo();

  try {
    await writeJson(repo, CATALOG_PATH, standardCatalog);

    await writeRepoFile(repo, "src/changed.ts", "export const changed = 1;\n");

    const base = commit(repo, "base without graph");

    await writeJson(repo, GRAPH_PATH, { version: 1, nodes: ["src/changed.ts"], dependencies: [] });

    await writeRepoFile(repo, "src/changed.ts", "export const changed = 2;\n");

    const head = commit(repo, "add graph and change source");
    const result = selection(repo, base, head);

    expect(result.fullSuite).toBe(true);

    expect(
      result.fallbackReasons.some((reason) =>
        reason.includes("Could not load the base supplemental dependency graph"),
      ),
    ).toBe(true);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});
