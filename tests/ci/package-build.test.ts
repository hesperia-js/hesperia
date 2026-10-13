import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import {
  discoverPackageBuildPlan,
  validatePackageBuildOutputs,
} from "../../scripts/build-packages.ts";

function isInside(parent: string, child: string): boolean {
  const path = relative(resolve(parent), resolve(child));
  return path !== "" && path !== ".." && !path.startsWith(`..${sep}`);
}

async function withWorkspace<T>(action: (root: string) => Promise<T>): Promise<T> {
  const tempRoot = resolve(tmpdir());
  const workspaceRoot = await mkdtemp(join(tempRoot, "hesperia-package-build-"));

  try {
    await mkdir(join(workspaceRoot, "packages"));

    return await action(workspaceRoot);
  } finally {
    if (isInside(tempRoot, workspaceRoot)) {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  }
}

async function writePackage(
  workspaceRoot: string,
  directory: string,
  manifest: Record<string, unknown>,
): Promise<void> {
  const packageRoot = join(workspaceRoot, "packages", directory);

  await mkdir(packageRoot, { recursive: true });

  await writeFile(join(packageRoot, "package.json"), JSON.stringify(manifest));
}

function packageManifest(
  name: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    name,
    files: ["dist"],
    exports: {
      ".": { types: "./dist/index.d.ts", import: "./dist/index.js" },
    },
    scripts: { build: "bunx tsc -p tsconfig.build.json" },
    ...overrides,
  };
}

test("root build inventory includes every immediate publishable package and emitted output", async () => {
  const workspaceRoot = resolve(import.meta.dir, "../..");
  const rootManifest = JSON.parse(await readFile(join(workspaceRoot, "package.json"), "utf8")) as {
    scripts?: Record<string, string>;
  };

  expect(rootManifest.scripts?.build).toBe("bun run scripts/build-packages.ts");

  const packageDirectories = await readdir(join(workspaceRoot, "packages"), {
    withFileTypes: true,
  });
  const declaredPublicNames: string[] = [];

  for (const directory of packageDirectories) {
    if (!directory.isDirectory()) continue;

    const manifestPath = join(workspaceRoot, "packages", directory.name, "package.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
      name: string;
      private?: boolean;
    };

    if (manifest.private !== true) declaredPublicNames.push(manifest.name);
  }

  const plan = await discoverPackageBuildPlan(workspaceRoot);

  expect(plan.map((target) => target.name).sort()).toStrictEqual(declaredPublicNames.sort());

  const languageServer = plan.find((target) => target.name === "@hesperia/language-server");

  expect(languageServer?.exportTargets).toContain("./dist/index.d.ts");

  expect(languageServer?.binTargets).toStrictEqual(["./dist/cli.js"]);

  for (let index = 0; index < plan.length; index += 1) {
    const target = plan[index];

    if (!target) throw new Error(`Missing package build target at ${index}`);

    for (const dependency of target.workspaceDependencies) {
      expect(plan.findIndex((candidate) => candidate.name === dependency)).toBeLessThan(index);
    }

    await validatePackageBuildOutputs(target);
  }
});

test("build order follows workspace dependencies and development dependencies", async () => {
  await withWorkspace(async (workspaceRoot) => {
    await writePackage(workspaceRoot, "application", {
      ...packageManifest("@fixture/application"),
      dependencies: { "@fixture/adapter": "workspace:*" },
    });

    await writePackage(workspaceRoot, "adapter", {
      ...packageManifest("@fixture/adapter"),
      devDependencies: { "@fixture/base": "workspace:*" },
    });

    await writePackage(workspaceRoot, "base", packageManifest("@fixture/base"));

    const plan = await discoverPackageBuildPlan(workspaceRoot);

    expect(plan.map((target) => target.name)).toStrictEqual([
      "@fixture/base",
      "@fixture/adapter",
      "@fixture/application",
    ]);
  });
});

test("a publishable package without a build script fails inventory discovery", async () => {
  await withWorkspace(async (workspaceRoot) => {
    await writePackage(workspaceRoot, "missing-build", {
      ...packageManifest("@fixture/missing-build"),
      scripts: {},
    });

    await expect(discoverPackageBuildPlan(workspaceRoot)).rejects.toThrow(
      "Publishable package @fixture/missing-build is missing a build script",
    );
  });
});

test("a publishable package without exports or a bin command fails inventory discovery", async () => {
  await withWorkspace(async (workspaceRoot) => {
    await writePackage(workspaceRoot, "missing-exports", {
      ...packageManifest("@fixture/missing-exports"),
      exports: undefined,
    });

    await expect(discoverPackageBuildPlan(workspaceRoot)).rejects.toThrow(
      "Publishable package @fixture/missing-exports must declare exports or a bin command",
    );
  });
});

test("a command-only package can declare a string bin target without exports", async () => {
  await withWorkspace(async (workspaceRoot) => {
    await writePackage(workspaceRoot, "command", {
      name: "@fixture/command",
      private: false,
      files: ["dist"],
      bin: "./dist/cli.js",
      scripts: { build: "bun build" },
    });

    const [target] = await discoverPackageBuildPlan(workspaceRoot);

    if (!target) throw new Error("Expected one package build target");

    expect(target.exportTargets).toStrictEqual([]);

    expect(target.binTargets).toStrictEqual(["./dist/cli.js"]);

    await expect(validatePackageBuildOutputs(target)).rejects.toThrow(
      "Build for @fixture/command did not emit bin target ./dist/cli.js",
    );

    await mkdir(join(target.packageRoot, "dist"), { recursive: true });

    await writeFile(join(target.packageRoot, "dist/cli.js"), "#!/usr/bin/env node\n");

    await expect(validatePackageBuildOutputs(target)).resolves.toBeUndefined();
  });
});

test("a command-only package accepts npm bin maps and rejects targets outside dist", async () => {
  await withWorkspace(async (workspaceRoot) => {
    await writePackage(workspaceRoot, "commands", {
      name: "@fixture/commands",
      files: ["dist"],
      bin: { "fixture-command": "./dist/cli.js" },
      scripts: { build: "bun build" },
    });

    const [target] = await discoverPackageBuildPlan(workspaceRoot);

    expect(target?.binTargets).toStrictEqual(["./dist/cli.js"]);
  });
});

test("bin targets must be explicit dist files contained by dist", async () => {
  await withWorkspace(async (workspaceRoot) => {
    await writePackage(workspaceRoot, "commands", {
      name: "@fixture/commands",
      files: ["dist"],
      bin: { "fixture-command": "./dist/../outside/cli.js" },
      scripts: { build: "bun build" },
    });

    await expect(discoverPackageBuildPlan(workspaceRoot)).rejects.toThrow(
      "Bin target ./dist/../outside/cli.js for @fixture/commands escapes its dist directory",
    );
  });
});

test("a publishable package must include dist in its packed files", async () => {
  await withWorkspace(async (workspaceRoot) => {
    await writePackage(workspaceRoot, "missing-dist", {
      ...packageManifest("@fixture/missing-dist"),
      files: ["README.md"],
    });

    await expect(discoverPackageBuildPlan(workspaceRoot)).rejects.toThrow(
      "Publishable package @fixture/missing-dist must include dist in files",
    );
  });
});

test("a publishable package must declare root export types", async () => {
  await withWorkspace(async (workspaceRoot) => {
    await writePackage(workspaceRoot, "missing-types", {
      ...packageManifest("@fixture/missing-types"),
      exports: { ".": { import: "./dist/index.js" } },
    });

    await expect(discoverPackageBuildPlan(workspaceRoot)).rejects.toThrow(
      'Publishable package @fixture/missing-types must declare exports["."].types',
    );
  });
});

test("cyclic workspace build dependencies fail inventory discovery", async () => {
  await withWorkspace(async (workspaceRoot) => {
    await writePackage(workspaceRoot, "left", {
      ...packageManifest("@fixture/left"),
      dependencies: { "@fixture/right": "workspace:*" },
    });

    await writePackage(workspaceRoot, "right", {
      ...packageManifest("@fixture/right"),
      devDependencies: { "@fixture/left": "workspace:*" },
    });

    await expect(discoverPackageBuildPlan(workspaceRoot)).rejects.toThrow(
      "Cyclic workspace build dependencies: @fixture/left, @fixture/right",
    );
  });
});

test("post-build validation requires every declared export file under dist", async () => {
  await withWorkspace(async (workspaceRoot) => {
    await writePackage(workspaceRoot, "missing-output", packageManifest("@fixture/missing-output"));

    const [target] = await discoverPackageBuildPlan(workspaceRoot);

    if (!target) throw new Error("Expected one package build target");

    await expect(validatePackageBuildOutputs(target)).rejects.toThrow(
      "Build for @fixture/missing-output did not emit ./dist/index.d.ts",
    );

    await mkdir(join(target.packageRoot, "dist"), { recursive: true });

    await writeFile(join(target.packageRoot, "dist/index.d.ts"), "export {};");

    await writeFile(join(target.packageRoot, "dist/index.js"), "export {};");

    await expect(validatePackageBuildOutputs(target)).resolves.toBeUndefined();
  });
});

test("packages with exports and a bin validate both emitted interfaces", async () => {
  await withWorkspace(async (workspaceRoot) => {
    await writePackage(workspaceRoot, "both", {
      ...packageManifest("@fixture/both"),
      bin: { "fixture-both": "./dist/cli.js" },
    });

    const [target] = await discoverPackageBuildPlan(workspaceRoot);

    if (!target) throw new Error("Expected one package build target");

    await mkdir(join(target.packageRoot, "dist"), { recursive: true });

    await writeFile(join(target.packageRoot, "dist/index.d.ts"), "export {};");

    await writeFile(join(target.packageRoot, "dist/index.js"), "export {};");

    await expect(validatePackageBuildOutputs(target)).rejects.toThrow(
      "Build for @fixture/both did not emit bin target ./dist/cli.js",
    );

    await writeFile(join(target.packageRoot, "dist/cli.js"), "#!/usr/bin/env node\n");

    await expect(validatePackageBuildOutputs(target)).resolves.toBeUndefined();
  });
});
