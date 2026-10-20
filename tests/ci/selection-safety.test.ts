import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { selectGoldenCases } from "../../scripts/ci/select-golden.ts";
import { selectVerification } from "../../scripts/ci/select-verification.ts";

const workflow = Bun.YAML.parse(
  await Bun.file(new URL("../../.github/workflows/ci.yml", import.meta.url)).text(),
) as { jobs: { verify: { with: { full: string } } } };

interface EventContext {
  readonly event_name: string;
  readonly ref: string;
  readonly repository: string;
  readonly base_ref: string;
  readonly head_ref: string;
  readonly event: {
    readonly pull_request: { readonly head: { readonly repo: { readonly full_name: string } } };
  };
}

function requiresFull(event: Partial<EventContext>): boolean {
  const expression = workflow.jobs.verify.with.full
    .slice("${{ ".length, -" }}".length)
    .replaceAll(" != ", " !== ")
    .replaceAll(" == ", " === ");
  const context: EventContext = {
    event_name: "pull_request",
    ref: "refs/pull/1/merge",
    repository: "example/hesperia",
    base_ref: "main",
    head_ref: "fix/narrow-change",
    event: { pull_request: { head: { repo: { full_name: "example/hesperia" } } } },
    ...event,
  };

  return new Function("github", "startsWith", `return (${expression});`)(
    context,
    (value: string, prefix: string) => value.startsWith(prefix),
  ) as boolean;
}

test.each([
  { name: "main push", event: { event_name: "push", ref: "refs/heads/main" } },
  { name: "version tag", event: { event_name: "push", ref: "refs/tags/v1.0.0" } },
  { name: "manual dispatch", event: { event_name: "workflow_dispatch", ref: "refs/heads/main" } },
  { name: "same-repository release PR", event: { head_ref: "release/1.0.0" } },
  { name: "ordinary PR into a release branch", event: { base_ref: "release/1.0.0" } },
])("the workflow keeps $name full before path selection", ({ event }) => {
  expect(requiresFull(event)).toBe(true);
});

test("a fresh dependency cannot hide from a golden case with an aliased module loader", async () => {
  const repo = await mkdtemp(join(tmpdir(), "hesperia-golden-selection-safety-"));

  try {
    fixtureGit(repo, "init", "--quiet");

    await fixtureFile(
      repo,
      "src/loader.ts",
      'import { createRequire } from "node:module"; const load = createRequire(import.meta.url); export const read = (specifier: string) => load(specifier);\n',
    );

    await fixtureFile(repo, "src/changed.ts", "export const value = 1;\n");

    await fixtureFile(repo, "src/unrelated.ts", "export const unrelated = true;\n");

    await fixtureFile(
      repo,
      "golden/catalog.json",
      JSON.stringify({
        version: 1,
        behaviors: [
          { id: "opaque", paths: ["src/loader.ts"] },
          { id: "changed", paths: ["src/changed.ts"] },
          { id: "unrelated", paths: ["src/unrelated.ts"] },
        ],
        cases: [
          { id: "opaque-case", suite: "opaque", behaviors: ["opaque"] },
          { id: "changed-case", suite: "changed", behaviors: ["changed"] },
          { id: "unrelated-case", suite: "unrelated", behaviors: ["unrelated"] },
        ],
      }),
    );

    await fixtureFile(
      repo,
      "golden/dependency-graph.json",
      JSON.stringify({ version: 1, nodes: [], dependencies: [] }),
    );

    const base = fixtureCommit(repo);

    await fixtureFile(repo, "src/changed.ts", "export const value = 2;\n");

    await fixtureFile(repo, "src/new-dependency.ts", "export const newValue = true;\n");

    const head = fixtureCommit(repo);
    const selected = selectGoldenCases({
      repoPath: repo,
      base,
      head,
      catalogPath: "golden/catalog.json",
      graphPath: "golden/dependency-graph.json",
    });

    expect(selected.selectedCaseIds).toContain("changed-case");

    expect(selected.selectedCaseIds).toContain("opaque-case");

    if (!selected.fullSuite) expect(selected.selectedCaseIds).not.toContain("unrelated-case");
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test.each([
  { name: "ordinary PR into main", event: {} },
  {
    name: "fork release branch without release authority",
    event: {
      head_ref: "release/1.0.0",
      event: { pull_request: { head: { repo: { full_name: "contributor/hesperia" } } } },
    },
  },
])("the workflow lets $name reach conservative path selection", ({ event }) => {
  expect(requiresFull(event)).toBe(false);
});

function fixtureGit(repo: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", "-C", repo, ...args], { stdout: "pipe", stderr: "pipe" });

  if (!result.success) throw new Error(new TextDecoder().decode(result.stderr));

  return new TextDecoder().decode(result.stdout).trim();
}

async function fixtureFile(repo: string, path: string, source: string): Promise<void> {
  const filename = join(repo, path);

  await mkdir(dirname(filename), { recursive: true });

  await writeFile(filename, source);
}

function fixtureCommit(repo: string): string {
  fixtureGit(repo, "add", "--all");

  fixtureGit(
    repo,
    "-c",
    "user.name=Selection safety fixture",
    "-c",
    "user.email=selection-safety@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "--quiet",
    "-m",
    "fixture revision",
  );

  return fixtureGit(repo, "rev-parse", "HEAD");
}

test.each(["unchanged reader and fresh source", "changed reader", "new reader"] as const)(
  "golden fails closed for an unreviewed filesystem input boundary: %s",
  async (variant) => {
    const repo = await mkdtemp(join(tmpdir(), "hesperia-golden-reader-safety-"));
    const reader = "src/reader.ts";
    const fixture = "golden/fixtures/example/input.ts";

    try {
      fixtureGit(repo, "init", "--quiet");
      await fixtureFile(repo, fixture, "export const value = 1;\n");
      await fixtureFile(repo, "src/changed.ts", "export const value = 1;\n");
      await fixtureFile(
        repo,
        reader,
        variant === "new reader"
          ? "export const read = () => 1;\n"
          : 'import { readFile } from "node:fs/promises"; export const read = (path: string) => readFile(path, "utf8");\n',
      );
      await fixtureFile(
        repo,
        "golden/catalog.json",
        JSON.stringify({
          version: 1,
          behaviors: [
            { id: "reader", paths: [reader] },
            { id: "fixture", paths: [fixture, "src/changed.ts"] },
            { id: "unrelated", paths: ["src/unrelated.ts"] },
          ],
          cases: [
            { id: "reader-case", suite: "reader", behaviors: ["reader"] },
            { id: "fixture-case", suite: "fixture", behaviors: ["fixture"] },
            { id: "unrelated-case", suite: "unrelated", behaviors: ["unrelated"] },
          ],
        }),
      );
      await fixtureFile(repo, "src/unrelated.ts", "export const unrelated = true;\n");
      await fixtureFile(
        repo,
        "golden/dependency-graph.json",
        JSON.stringify({ version: 1, nodes: [], dependencies: [] }),
      );
      const base = fixtureCommit(repo);
      await fixtureFile(repo, fixture, "export const value = 2;\n");
      if (variant === "unchanged reader and fresh source") {
        await fixtureFile(repo, "src/changed.ts", "export const value = 2;\n");
        await fixtureFile(repo, "src/new-input.ts", "export const hidden = true;\n");
      } else {
        await fixtureFile(
          repo,
          reader,
          "export const read = (path: string) => Bun.file(path).text();\n",
        );
      }
      const selected = selectGoldenCases({
        repoPath: repo,
        base,
        head: fixtureCommit(repo),
        catalogPath: "golden/catalog.json",
        graphPath: "golden/dependency-graph.json",
      });
      expect(selected.fullSuite, JSON.stringify(selected.fallbackReasons)).toBe(true);
      expect(selected.selectedCaseIds).toStrictEqual([
        "fixture-case",
        "reader-case",
        "unrelated-case",
      ]);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  },
);

test("a directory-discovered fixture reader cannot hide outside the static catalog closure", async () => {
  const repo = await mkdtemp(join(tmpdir(), "hesperia-golden-discovered-reader-"));
  try {
    fixtureGit(repo, "init", "--quiet");
    const reader = "golden/verify-packages.ts";
    const fixture = "golden/fixtures/native-identity/Counter.tsx";
    const discovered = "golden/fixtures/native-identity/src/routes/new.ts";
    await fixtureFile(
      repo,
      reader,
      await Bun.file(new URL("../../golden/verify-packages.ts", import.meta.url)).text(),
    );
    await fixtureFile(repo, fixture, "export const value = 1;\n");
    await fixtureFile(
      repo,
      "golden/catalog.json",
      JSON.stringify({
        version: 1,
        behaviors: [
          { id: "reader", paths: [reader] },
          { id: "fixture", paths: [fixture] },
        ],
        cases: [
          { id: "reader-case", suite: "tests/reader.spec.ts", behaviors: ["reader"] },
          { id: "fixture-case", suite: "tests/native-identity.spec.ts", behaviors: ["fixture"] },
        ],
      }),
    );
    await fixtureFile(
      repo,
      "golden/dependency-graph.json",
      JSON.stringify({ version: 1, nodes: [], dependencies: [] }),
    );
    const base = fixtureCommit(repo);
    await fixtureFile(
      repo,
      discovered,
      "export const read = (path: string) => Bun.file(path).text();\n",
    );
    const head = fixtureCommit(repo);
    const selected = selectGoldenCases({
      repoPath: repo,
      base,
      head,
      catalogPath: "golden/catalog.json",
      graphPath: "golden/dependency-graph.json",
    });
    expect(selected.fullSuite, JSON.stringify(selected.fallbackReasons)).toBe(true);
    expect(selected.fallbackReasons).toContain(
      `golden input reader has no reviewed input contract: ${discovered}`,
    );
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("a changed reviewed reader invalidates its clean fixture-only input contract", async () => {
  const repo = await mkdtemp(join(tmpdir(), "hesperia-golden-stale-reader-"));
  try {
    fixtureGit(repo, "init", "--quiet");
    const reader = "golden/verify-packages.ts";
    const original = await Bun.file(
      new URL("../../golden/verify-packages.ts", import.meta.url),
    ).text();
    const fixture = "golden/fixtures/native-identity/Counter.tsx";
    await fixtureFile(repo, reader, original);
    await fixtureFile(repo, fixture, "export const value = 1;\n");
    await fixtureFile(repo, "src/unrelated.ts", "export const unrelated = true;\n");
    await fixtureFile(
      repo,
      "golden/catalog.json",
      JSON.stringify({
        version: 1,
        behaviors: [
          { id: "reader", paths: [reader] },
          { id: "fixture", paths: [fixture] },
          { id: "unrelated", paths: ["src/unrelated.ts"] },
        ],
        cases: [
          { id: "reader-case", suite: "tests/reader.spec.ts", behaviors: ["reader"] },
          { id: "fixture-case", suite: "tests/native-identity.spec.ts", behaviors: ["fixture"] },
          { id: "unrelated-case", suite: "tests/unrelated.spec.ts", behaviors: ["unrelated"] },
        ],
      }),
    );
    await fixtureFile(
      repo,
      "golden/dependency-graph.json",
      JSON.stringify({ version: 1, nodes: [], dependencies: [] }),
    );
    const base = fixtureCommit(repo);
    await fixtureFile(repo, fixture, "export const value = 2;\n");
    const validHead = fixtureCommit(repo);
    const valid = selectGoldenCases({
      repoPath: repo,
      base,
      head: validHead,
      catalogPath: "golden/catalog.json",
      graphPath: "golden/dependency-graph.json",
    });
    expect(valid.fullSuite, JSON.stringify(valid.fallbackReasons)).toBe(false);
    expect(valid.fallbackReasons).toStrictEqual([]);
    expect(valid.selectedCaseIds).toStrictEqual(["fixture-case"]);
    await fixtureFile(
      repo,
      reader,
      `${original}\n// A new reader revision requires input review.\n`,
    );
    await fixtureFile(repo, fixture, "export const value = 3;\n");
    const head = fixtureCommit(repo);
    expect(fixtureGit(repo, "status", "--porcelain")).toBe("");
    expect(fixtureGit(repo, "rev-parse", "HEAD")).toBe(head);
    const selected = selectGoldenCases({
      repoPath: repo,
      base: validHead,
      head,
      catalogPath: "golden/catalog.json",
      graphPath: "golden/dependency-graph.json",
    });
    expect(selected.fullSuite, JSON.stringify(selected.fallbackReasons)).toBe(true);
    expect(selected.fallbackReasons).toContain(
      `golden input reader contract is stale in head: ${reader}`,
    );
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test.each([
  {
    name: "dynamic import",
    source: "export const loadProducedModule = (specifier: string) => import(specifier);\n",
  },
  {
    name: "aliased createRequire",
    source:
      'import { createRequire } from "node:module"; const load = createRequire(import.meta.url); export const loadProducedModule = (specifier: string) => load(specifier);\n',
  },
  {
    name: "destructured Bun file reader",
    source:
      "const { file } = Bun; export const loadProducedModule = (specifier: string) => file(specifier).text();\n",
  },
])(
  "a fresh source commit retains an unchanged $name consumer without a known target edge",
  async ({ source }) => {
    const repo = await mkdtemp(join(tmpdir(), "hesperia-selection-safety-"));
    const loader = "tests/hosting/load-produced-module.test.ts";
    const addedSource = "packages/hesperia/src/runtime/new-module.ts";

    try {
      fixtureGit(repo, "init", "--quiet");

      await fixtureFile(repo, loader, source);

      await fixtureFile(repo, "tests/data/unrelated.test.ts", "export const unrelated = true;\n");

      const base = fixtureCommit(repo);

      await fixtureFile(repo, addedSource, "export const addedBehavior = 1;\n");

      const head = fixtureCommit(repo);
      const selected = selectVerification({ repoPath: repo, base, head });

      expect(selected.full).toBe(false);

      expect(selected.fallbackReasons).toStrictEqual([]);

      expect(selected.changedPaths).toStrictEqual([{ path: addedSource, status: "A" }]);

      expect(selected.roots).toStrictEqual(["runtime", "hosting"]);

      expect(selected.reasons.some((reason) => reason.includes(`opaque consumer ${loader}`))).toBe(
        true,
      );
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  },
);
