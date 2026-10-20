import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { selectVerification } from "../../scripts/ci/select-verification.ts";

function git(repo: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", "-C", repo, ...args], { stdout: "pipe", stderr: "pipe" });

  if (!result.success) throw new Error(new TextDecoder().decode(result.stderr));
  return new TextDecoder().decode(result.stdout).trim();
}

async function put(repo: string, path: string, content: string): Promise<void> {
  await mkdir(dirname(join(repo, path)), { recursive: true });
  await writeFile(join(repo, path), content);
}

function commit(repo: string): string {
  git(repo, "add", "--all");
  git(
    repo,
    "-c",
    "user.name=CI fixture",
    "-c",
    "user.email=ci@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "--quiet",
    "-m",
    "fixture revision",
  );
  return git(repo, "rev-parse", "HEAD");
}

async function withRepo(run: (repo: string) => Promise<void>, initialize = true): Promise<void> {
  const repo = await mkdtemp(join(tmpdir(), "hesperia-verification-selection-"));

  try {
    if (initialize) git(repo, "init", "--quiet");
    await run(repo);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
}

test("product impact selects owner and static dependent roots without unrelated roots", async () => {
  await withRepo(async (repo) => {
    const path = "packages/hesperia/src/data/feed.ts";
    await put(repo, path, "export const value = 1;");
    await put(
      repo,
      "tests/data/feed.test.ts",
      'import { value } from "../../packages/hesperia/src/data/feed.ts"; export { value };',
    );
    await put(
      repo,
      "tests/tooling/feed.test.ts",
      'export { value } from "../../packages/hesperia/src/data/feed.ts";',
    );
    await put(repo, "tests/hosting/unrelated.test.ts", "export const unrelated = true;");
    const base = commit(repo);
    await put(repo, path, "export const value = 2;");
    const result = selectVerification({ repoPath: repo, base, head: commit(repo) });

    expect(result.full).toBe(false);
    expect(result.roots).toStrictEqual(["data", "tooling"]);
    expect([result.browser, result.package, result.vscode, result.golden]).toStrictEqual([
      true,
      true,
      true,
      true,
    ]);
    expect(result.reasons.some((reason) => reason.includes("tests/tooling/feed.test.ts"))).toBe(
      true,
    );
  });
});

test("owned application fixtures include cross-root opaque readers and local configuration", async () => {
  await withRepo(async (repo) => {
    const path = "tests/tooling/fixtures/applications/example/tsconfig.json";
    await put(repo, path, '{"compilerOptions":{}}');
    await put(
      repo,
      "tests/tooling/fixture-reader.ts",
      'import { readFile } from "node:fs/promises"; export const read = (path: string) => readFile(path);',
    );
    await put(
      repo,
      "tests/routing/fixture.test.ts",
      'import { read } from "../tooling/fixture-reader.ts"; export { read };',
    );
    const base = commit(repo);
    await put(repo, path, '{"compilerOptions":{"strict":true}}');
    const result = selectVerification({ repoPath: repo, base, head: commit(repo) });

    expect(result.full).toBe(false);
    expect(result.roots).toStrictEqual(["tooling", "routing"]);
    expect(
      result.reasons.some((reason) =>
        reason.includes("opaque consumer tests/tooling/fixture-reader.ts"),
      ),
    ).toBe(true);
  });
});

test("distributed documentation selects package consumers without coverage", async () => {
  await withRepo(async (repo) => {
    const path = "packages/tooling/docs/project-configuration.md";
    await put(repo, path, "Before");
    const base = commit(repo);
    await put(repo, path, "After");
    const result = selectVerification({ repoPath: repo, base, head: commit(repo) });

    expect(result.full).toBe(false);
    expect(result.roots).toStrictEqual([]);
    expect(result.package).toBe(true);
    expect([result.browser, result.vscode, result.golden]).toStrictEqual([false, false, false]);
  });
});

test("an unchanged unconstrained loader remains selected without a reverse edge", async () => {
  await withRepo(async (repo) => {
    const path = "packages/hesperia/src/data/feed.ts";
    await put(repo, path, "export const value = 1;");
    await put(
      repo,
      "tests/tooling/loader.test.ts",
      "export const load = (name: string) => import(name);",
    );
    const base = commit(repo);
    await put(repo, path, "export const value = 2;");
    const result = selectVerification({ repoPath: repo, base, head: commit(repo) });

    expect(result.full).toBe(false);
    expect(result.roots).toContain("tooling");
    expect(result.roots).toContain("data");
    expect(result.roots).not.toContain("hosting");
  });
});

test("unchanged staged fixture inputs retain their compiler consumers on production edits", async () => {
  await withRepo(async (repo) => {
    const path = "packages/hesperia/src/data/feed.ts";
    await put(repo, path, "export const value = 1;");
    await put(
      repo,
      "tests/tooling/fixtures/applications/staged/app.tsx",
      'export { generated } from "./created-by-test.ts";',
    );
    const base = commit(repo);
    await put(repo, path, "export const value = 2;");
    const result = selectVerification({ repoPath: repo, base, head: commit(repo) });

    expect(result.full).toBe(false);
    expect(result.roots).toStrictEqual(["data", "tooling"]);
  });
});

test("removed imports and deleted sources retain their base-side test consumers", async () => {
  await withRepo(async (repo) => {
    const path = "packages/hesperia/src/runtime/removed.ts";
    await put(repo, path, "export const value = 1;");
    await put(
      repo,
      "tests/tooling/removed.test.ts",
      'export { value } from "../../packages/hesperia/src/runtime/removed.ts";',
    );
    const base = commit(repo);
    await rm(join(repo, path));
    await put(repo, "tests/tooling/removed.test.ts", "export const value = 2;");
    const result = selectVerification({ repoPath: repo, base, head: commit(repo) });

    expect(result.full).toBe(false);
    expect(result.roots).toStrictEqual(["runtime", "tooling"]);
    expect(
      result.reasons.some((reason) =>
        reason.includes("removed.ts -> tests/tooling/removed.test.ts"),
      ),
    ).toBe(true);
  });
});

test("new unimported source files retain their subsystem owner", async () => {
  await withRepo(async (repo) => {
    await put(repo, "README.md", "Fixture");
    const base = commit(repo);
    await put(repo, "packages/hesperia/src/runtime/new.ts", "export const value = 1;");
    const result = selectVerification({ repoPath: repo, base, head: commit(repo) });

    expect(result.full).toBe(false);
    expect(result.roots).toStrictEqual(["runtime"]);
    expect(result.browser && result.package && result.vscode).toBe(true);
  });
});

test.each([
  "tests/tooling/fixtures/drivers/globals.d.mts",
  "tests/tooling/fixtures/drivers/tsconfig.json",
  "tests/tooling/shared-helper.ts",
  "package.json",
  "bun.lock",
  "tsconfig.json",
  "docs/ci.md",
  "tests/README.md",
  "unknown/input.bin",
  "packages/not-a-workspace-package/docs/guide.md",
])("shared support, policy and unknown changes stay full: %s", async (path) => {
  await withRepo(async (repo) => {
    await put(repo, path, path.endsWith(".json") ? "{}" : "before");
    const base = commit(repo);
    await put(repo, path, path.endsWith(".json") ? '{"changed":true}' : "after");
    const result = selectVerification({ repoPath: repo, base, head: commit(repo) });

    expect(result.full).toBe(true);
    expect(result.roots).toHaveLength(8);
    expect(result.fallbackReasons.length).toBeGreaterThan(0);
  });
});

test("unowned opaque consumers fail closed rather than dropping possible dependencies", async () => {
  await withRepo(async (repo) => {
    const path = "packages/hesperia/src/data/feed.ts";
    await put(repo, path, "export const value = 1;");
    await put(repo, "unmapped/loader.ts", "export const load = (name: string) => import(name);");
    const base = commit(repo);
    await put(repo, path, "export const value = 2;");
    const result = selectVerification({ repoPath: repo, base, head: commit(repo) });

    expect(result.full).toBe(true);
    expect(result.fallbackReasons).toContain(
      "opaque consumer has no verified test owner: unmapped/loader.ts",
    );
  });
});

test.each(['export { value } from "./missing.ts";', "export const = ;"])(
  "invalid dependency graphs stay full: %s",
  async (source) => {
    await withRepo(async (repo) => {
      const path = "packages/hesperia/src/data/feed.ts";
      await put(repo, path, "export const value = 1;");
      await put(repo, "tests/tooling/invalid.test.ts", source);
      const base = commit(repo);
      await put(repo, path, "export const value = 2;");
      const result = selectVerification({ repoPath: repo, base, head: commit(repo) });

      expect(result.full).toBe(true);
      expect(
        result.fallbackReasons.some((reason) =>
          reason.startsWith("invalid source dependency graph"),
        ),
      ).toBe(true);
    });
  },
);

test.each([
  "tests/tooling/fixtures/unowned/broken.ts",
  "tests/browser/fixtures/broken.fixture.mts",
])("unowned or executable fixture errors stay full: %s", async (fixture) => {
  await withRepo(async (repo) => {
    const path = "packages/hesperia/src/data/feed.ts";
    await put(repo, path, "export const value = 1;");
    await put(repo, fixture, 'export { value } from "./missing.ts";');
    const base = commit(repo);
    await put(repo, path, "export const value = 2;");
    const result = selectVerification({ repoPath: repo, base, head: commit(repo) });

    expect(result.full).toBe(true);
    expect(
      result.fallbackReasons.some((reason) => reason.startsWith("invalid source dependency graph")),
    ).toBe(true);
  });
});

test("explicit full, empty comparisons, dirty workspaces and invalid revisions stay full", async () => {
  await withRepo(async (repo) => {
    await put(repo, "README.md", "Fixture");
    const base = commit(repo);
    await put(repo, "README.md", "Changed");
    const head = commit(repo);

    expect(selectVerification({ repoPath: repo, base, head, full: true }).full).toBe(true);
    expect(selectVerification({ repoPath: repo, base: head, head }).full).toBe(true);
    expect(selectVerification({ repoPath: repo, base: "missing-revision", head }).full).toBe(true);
    await put(repo, "untracked.ts", "export const value = 1;");
    expect(selectVerification({ repoPath: repo, base, head }).full).toBe(true);
  });
});

test("the CLI publishes the same selected scope consumed by the workflow", async () => {
  await withRepo(async (repo) => {
    const path = "packages/tooling/docs/project-configuration.md";
    await put(repo, path, "Before");
    const base = commit(repo);
    await put(repo, path, "After");
    const head = commit(repo);
    const output = join(tmpdir(), `hesperia-verification-output-${crypto.randomUUID()}`);
    const cli = resolve(import.meta.dir, "../../scripts/ci/select-verification.ts");

    try {
      const result = Bun.spawnSync([process.execPath, cli, "--base", base, "--head", head], {
        cwd: repo,
        env: { ...process.env, GITHUB_OUTPUT: output },
        stdout: "pipe",
        stderr: "pipe",
      });

      expect(result.exitCode).toBe(0);
      const selection = JSON.parse(new TextDecoder().decode(result.stdout));
      expect(selection.full).toBe(false);
      expect(selection.package).toBe(true);
      const outputs = Object.fromEntries(
        (await readFile(output, "utf8"))
          .trim()
          .split("\n")
          .map((line) => line.split("=")),
      );
      expect(outputs.full).toBe("false");
      expect(outputs.all_count).toBe("1");
      expect(outputs.package).toBe("true");
      expect(outputs.scope_complete).toBe("true");
      for (const root of [
        "compiler",
        "runtime",
        "data",
        "tooling",
        "routing",
        "editor",
        "hosting",
        "ci",
      ])
        expect(outputs[root]).toBe("false");

      const workflow = Bun.YAML.parse(
        await readFile(resolve(import.meta.dir, "../../.github/workflows/verify.yml"), "utf8"),
      ) as { jobs: { checks: { steps: { name?: string; env?: Record<string, string> }[] } } };
      const scope = workflow.jobs.checks.steps.find(
        (step) => step.name === "Resolve verification scope",
      )!.env!;
      const evaluate = (expression: string) =>
        new Function(
          "inputs",
          "steps",
          `return (${expression.slice(4, -3).replaceAll(" != ", " !== ").replaceAll(" == ", " === ")});`,
        )({ full: false }, { paths: { outcome: "success", outputs } });

      expect(evaluate(scope.FULL!)).toBe(false);
      expect(evaluate(scope.PACKAGE!)).toBe(true);
      expect(evaluate(scope.TOOLING!)).toBe(false);
    } finally {
      await rm(output, { force: true });
    }
  });
});

test.each([
  { path: "packages/tooling/src/style-topology.ts", root: "tooling", package: true },
  {
    path: "tests/tooling/fixtures/applications/type-only-css/app.tsx",
    root: "tooling",
    package: false,
  },
  { path: "packages/tooling/docs/project-configuration.md", root: undefined, package: true },
])("the complete repository selects a partial scope for $path", async (entry) => {
  await withRepo(async (repo) => {
    const workspace = resolve(import.meta.dir, "../..");
    git(repo, "clone", "--quiet", "--shared", "--no-checkout", workspace, ".");
    git(repo, "checkout", "--quiet", "--detach", git(workspace, "rev-parse", "HEAD"));
    const base = git(repo, "rev-parse", "HEAD");
    const source = await readFile(join(repo, entry.path), "utf8");
    await put(
      repo,
      entry.path,
      `${source}\n${entry.path.endsWith(".md") ? "Selection fixture." : "// selection fixture"}\n`,
    );
    const result = selectVerification({ repoPath: repo, base, head: commit(repo) });

    console.info(
      JSON.stringify({
        canary: entry.path,
        full: result.full,
        roots: result.roots,
        browser: result.browser,
        package: result.package,
        vscode: result.vscode,
        golden: result.golden,
        fallbackReasons: result.fallbackReasons,
      }),
    );

    expect(result.full, JSON.stringify(result.fallbackReasons, null, 2)).toBe(false);
    expect(result.roots.length, JSON.stringify(result.roots)).toBeLessThan(8);
    if (entry.root) expect(result.roots).toContain(entry.root);
    if (entry.package) expect(result.package).toBe(true);
  }, false);
});
