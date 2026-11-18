import { expect, test } from "bun:test";
import { mkdirSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  executeCreator,
  resolveCreator,
} from "../../packages/create-hesperia/src/creator.ts";

const creator = resolve(import.meta.dir, "../../packages/create-hesperia/src/cli.ts");

interface CommandResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

async function runCreator(
  cwd: string,
  args: readonly string[],
  preload?: string,
  env: Record<string, string | undefined> = process.env,
): Promise<CommandResult> {
  const adapterPath = process.env.HESPERIA_CREATOR_CLI_CAPTURE_ADAPTER;

  if (adapterPath) {
    const adapter = (await import(pathToFileURL(resolve(adapterPath)).href)) as {
      runCreatorCli(input: {
        readonly cwd: string;
        readonly execPath: string;
        readonly entryPath: string;
        readonly args: readonly string[];
        readonly preload?: string;
        readonly env: Record<string, string | undefined>;
      }): Promise<CommandResult>;
    };
    return adapter.runCreatorCli({
      cwd,
      execPath: process.execPath,
      entryPath: creator,
      args,
      ...(preload === undefined ? {} : { preload }),
      env,
    });
  }

  const command = [process.execPath];

  if (preload) command.push("--preload", preload);

  command.push(creator, ...args);

  const child = Bun.spawn(command, { cwd, env, stdout: "pipe", stderr: "pipe" });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

test("requires an explicit destination and creates nothing when it is missing", async () => {
  const root = await mkdtemp(join(tmpdir(), "hesperia-create-no-destination-"));

  try {
    const result = await runCreator(root, []);

    expect(result.exitCode).not.toBe(0);

    expect(result.stderr).toContain("Usage: bun create hesperia <destination> [--no-install]");

    expect(await readdir(root)).toStrictEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("resolves a creator plan without creating its destination", async () => {
  const root = await mkdtemp(join(tmpdir(), "hesperia-create-resolve-"));
  const destination = join(root, "deferred-app");

  try {
    const plan = resolveCreator({
      destination,
      hostIntegration: "none",
      install: false,
    });

    expect(plan.projectRoot).toBe(destination);
    expect(plan.packageName).toBe("deferred-app");
    expect(await readdir(root)).toStrictEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("creates the default Elysia frontend without installing when requested", async () => {
  const root = await mkdtemp(join(tmpdir(), "hesperia-create-no-install-"));
  const destination = join(root, "My App");

  try {
    const result = await runCreator(root, [destination, "--no-install"]);

    expect(result.exitCode).toBe(0);

    expect(result.stdout).toContain("Dependencies were not installed");

    expect(await readdir(destination)).not.toContain("node_modules");

    const manifest = JSON.parse(await readFile(join(destination, "package.json"), "utf8")) as {
      name: string;
      scripts: Record<string, string>;
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    };

    expect(manifest.name).toBe("my-app");

    expect(manifest.scripts).toStrictEqual({
      dev: "hesperia dev",
      build: "hesperia build",
      preview: "bun run build && bun src/server-entry.ts",
      start: "bun src/server-entry.ts",
      check: "hesperia check",
    });

    expect(manifest.dependencies).toStrictEqual({
      "@elysia/eden": "1.4.10",
      "@hesperia/elysia": "1.0.0-alpha.3",
      "@hesperia/hosting": "1.0.0-alpha.3",
      aeolia: "1.0.0-alpha.1",
      elysia: "1.4.30",
      hesperia: "1.0.0-alpha.3",
    });

    const languageServerManifest = JSON.parse(
      await readFile(
        resolve(import.meta.dir, "../../packages/language-server/package.json"),
        "utf8",
      ),
    ) as { version: string };

    expect(manifest.devDependencies).toStrictEqual({
      "@hesperia/language-server": languageServerManifest.version,
      "@hesperia/tooling": "1.0.0-alpha.3",
      "@types/bun": "1.4.2",
      typescript: "7.0.2",
    });

    expect(await readdir(join(destination, "src"))).toContain("server.ts");

    expect(await readdir(join(destination, "src"))).toContain("server-entry.ts");

    expect(await readdir(join(destination, "src"))).toContain("server-internals.ts");

    expect(await readdir(join(destination, "src"))).toContain("client.ts");

    const shell = await readFile(join(destination, "app.tsx"), "utf8");

    expect(shell).toContain('import "./src/styles.css"');

    expect(shell).toContain('<html lang="en">');

    expect(shell).toContain("{props.children()}");

    expect(shell).toContain("<title>my-app</title>");

    expect(await readFile(join(destination, "src/styles.css"), "utf8")).toContain("body {");

    expect(await readFile(join(destination, "src/styles.d.ts"), "utf8")).toContain(
      'declare module "*.css"',
    );

    const page = await readFile(join(destination, "src/routes/+page.tsx"), "utf8");

    expect(page).toContain('import * as client from "hesperia/client"');

    expect(page).toContain("client.state(0)");

    expect(page).toContain("count.update((value) => value + 1)");

    expect(await readFile(join(destination, "src/routes/+loading.tsx"), "utf8")).toContain(
      "Loading…",
    );

    expect(await readFile(join(destination, "app.config.ts"), "utf8")).toContain(
      "pageCacheSize: 5",
    );

    expect(await readFile(join(destination, "hesperia.config.ts"), "utf8")).toContain(
      'mountURL: "/"',
    );

    expect(await readFile(join(destination, "hesperia.d.ts"), "utf8")).toContain(
      "HESPERIA GENERATED PAGE ROUTES",
    );

    expect(
      JSON.parse(await readFile(join(destination, ".vscode/extensions.json"), "utf8")),
    ).toStrictEqual({ recommendations: ["hesperia.hesperia-vscode"] });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("--host elysia creates the Elysia starter without installing", async () => {
  const root = await mkdtemp(join(tmpdir(), "hesperia-create-host-elysia-"));
  const destination = join(root, "elysia-app");

  try {
    const result = await runCreator(root, [destination, "--host", "elysia", "--no-install"]);

    expect(result.exitCode).toBe(0);

    expect(result.stdout).toContain("Dependencies were not installed");

    expect(await readdir(destination)).not.toContain("node_modules");

    const manifest = JSON.parse(await readFile(join(destination, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
      dependencies: Record<string, string>;
    };

    expect(manifest.dependencies["@hesperia/elysia"]).toBe("1.0.0-alpha.3");

    expect(manifest.dependencies["@elysia/eden"]).toBe("1.4.10");

    expect(manifest.scripts.preview).toBe("bun run build && bun src/server-entry.ts");

    expect(manifest.scripts.start).toBe("bun src/server-entry.ts");

    expect(await readdir(join(destination, "src"))).toContain("server.ts");

    expect(await readdir(join(destination, "src"))).toContain("client.ts");

    expect(await readdir(join(destination, "src"))).toContain("server-internals.ts");

    expect(await readFile(join(destination, "hesperia.config.ts"), "utf8")).toContain(
      'elysia({ serverModule: "./src/server.ts", appExport: "app" })',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("--host none creates the frontend-only starter without installing", async () => {
  const root = await mkdtemp(join(tmpdir(), "hesperia-create-host-none-"));
  const destination = join(root, "frontend-app");

  try {
    const result = await runCreator(root, [destination, "--host", "none", "--no-install"]);

    expect(result.exitCode).toBe(0);

    expect(result.stdout).toContain("Dependencies were not installed");

    expect(await readdir(destination)).not.toContain("node_modules");

    const manifest = JSON.parse(await readFile(join(destination, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
      dependencies: Record<string, string>;
    };

    expect(manifest.dependencies).toStrictEqual({
      aeolia: "1.0.0-alpha.1",
      hesperia: "1.0.0-alpha.3",
    });

    expect(manifest.scripts).toStrictEqual({
      dev: "hesperia dev",
      build: "hesperia build",
      preview: "hesperia preview",
      check: "hesperia check",
    });

    expect(await readdir(join(destination, "src"))).not.toContain("server.ts");

    expect(await readdir(join(destination, "src"))).not.toContain("client.ts");

    expect(await readdir(join(destination, "src"))).not.toContain("server-internals.ts");

    expect(await readFile(join(destination, "hesperia.config.ts"), "utf8")).not.toContain(
      "plugins",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("preserves creator flag ordering and last host selection", async () => {
  const root = await mkdtemp(join(tmpdir(), "hesperia-create-flag-order-"));
  const destination = join(root, "ordered-app");

  try {
    const result = await runCreator(root, [
      "--host",
      "none",
      "--no-install",
      destination,
      "--host",
      "elysia",
      "--no-install",
    ]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Dependencies were not installed");
    expect(await readdir(join(destination, "src"))).toContain("server.ts");
    expect(await readdir(destination)).not.toContain("node_modules");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects an unknown host before creating the destination", async () => {
  const root = await mkdtemp(join(tmpdir(), "hesperia-create-host-invalid-"));
  const destination = join(root, "invalid-app");

  try {
    const result = await runCreator(root, [destination, "--host", "express", "--no-install"]);

    expect(result.exitCode).not.toBe(0);

    expect(result.stderr).toContain('Unknown host integration "express"');

    expect(await readdir(root)).toStrictEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects a missing host value before creating the destination", async () => {
  const root = await mkdtemp(join(tmpdir(), "hesperia-create-host-missing-"));
  const destination = join(root, "missing-app");

  try {
    const result = await runCreator(root, [destination, "--host"]);

    expect(result.exitCode).not.toBe(0);

    expect(result.stderr).toContain("Option --host requires a value");

    expect(await readdir(root)).toStrictEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects Citty-only creator spellings and extra destinations", async () => {
  const cases = [
    { args: ["--host=none", "--no-install"], error: "Unknown option: --host=none" },
    { args: ["--install", "--no-install"], error: "Unknown option: --install" },
    { args: ["--no-install=false"], error: "Unknown option: --no-install=false" },
    { args: ["second-app", "--no-install"], error: "Expected one destination." },
  ] as const;

  for (const [index, testCase] of cases.entries()) {
    const root = await mkdtemp(join(tmpdir(), `hesperia-create-citty-compat-${index}-`));
    const destination = join(root, "first-app");

    try {
      const result = await runCreator(root, [destination, ...testCase.args]);

      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain(testCase.error);
      expect(await readdir(root)).toStrictEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("runs dependency installation by default", async () => {
  const root = await mkdtemp(join(tmpdir(), "hesperia-create-install-"));
  const destination = join(root, "installed-app");
  const marker = join(root, "install.json");
  const preload = join(root, "intercept-install.mjs");

  try {
    await writeFile(
      preload,
      `import { writeFileSync } from "node:fs";
const spawn = Bun.spawn;
Bun.spawn = (command, options = {}) => {
  if (Array.isArray(command) && command[0] === process.execPath && command[1] === "install") {
    writeFileSync(process.env.HESPERIA_CREATOR_INSTALL_MARKER, JSON.stringify({ command, cwd: options.cwd }));
    return { exited: Promise.resolve(0) };
  }
  return spawn(command, options);
};
`,
    );

    const result = await runCreator(root, [destination], preload, {
      ...process.env,
      HESPERIA_CREATOR_INSTALL_MARKER: marker,
    });

    expect(result.exitCode).toBe(0);

    expect(result.stdout).toContain("Dependencies installed");

    expect(JSON.parse(await readFile(marker, "utf8"))).toStrictEqual({
      command: [process.execPath, "install"],
      cwd: destination,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("refuses to overwrite existing files before execution or after resolution", async () => {
  const root = await mkdtemp(join(tmpdir(), "hesperia-create-existing-"));
  const destination = join(root, "existing");
  const resolvedDestination = join(root, "resolved-existing");

  try {
    await mkdir(destination);

    await writeFile(join(destination, "keep.txt"), "keep this file");

    const result = await runCreator(root, [destination, "--no-install"]);

    expect(result.exitCode).not.toBe(0);

    expect(result.stderr).toContain("Destination must be empty");

    expect(await readFile(join(destination, "keep.txt"), "utf8")).toBe("keep this file");

    const plan = resolveCreator({
      destination: resolvedDestination,
      hostIntegration: "none",
      install: false,
    });

    await mkdir(resolvedDestination);
    await writeFile(join(resolvedDestination, "keep.txt"), "author-owned contents");

    const execution = await executeCreator(plan, { signal: new AbortController().signal });

    expect(execution.status).toBe("failed");

    if (execution.status !== "failed") throw new Error("Expected destination validation to fail");

    expect(execution.message).toContain("Destination must be empty");

    expect(await readFile(join(resolvedDestination, "keep.txt"), "utf8")).toBe(
      "author-owned contents",
    );

    expect(await readdir(resolvedDestination)).toStrictEqual(["keep.txt"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("cancels a partial scaffold and preserves replaced and concurrent files", async () => {
  const root = await mkdtemp(join(tmpdir(), "hesperia-create-cancel-"));
  const destination = join(root, "cancelled-app");
  const plan = resolveCreator({
    destination,
    hostIntegration: "none",
    install: false,
  });
  const controller = new AbortController();
  let observedFirstWrite = false;
  let replacedPath: string | undefined;

  try {
    const result = await executeCreator(plan, {
      signal: controller.signal,
      onProgress(progress) {
        if (progress.kind !== "scaffold" || progress.completedFiles !== 1) return;

        observedFirstWrite = true;
        replacedPath = join(destination, progress.relativePath);

        unlinkSync(replacedPath);
        writeFileSync(replacedPath, "keep this replacement");
        writeFileSync(join(destination, "user-note.txt"), "keep this concurrent file");
        controller.abort();
      },
    });

    expect(observedFirstWrite).toBe(true);
    expect(result.status).toBe("cancelled");

    if (result.status !== "cancelled") throw new Error("Expected creator execution to cancel");

    if (replacedPath === undefined) throw new Error("Expected a scaffold path to be replaced");

    expect(result.cleanup.status).toBe("retained");
    expect(result.cleanup.retainedPaths).toContain(replacedPath);
    expect(result.cleanup.retainedPaths).toContain(destination);
    expect(await readFile(replacedPath, "utf8")).toBe("keep this replacement");
    expect(await readFile(join(destination, "user-note.txt"), "utf8")).toBe(
      "keep this concurrent file",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("cleans a partial scaffold when its progress consumer fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "hesperia-create-progress-failure-"));
  const destination = join(root, "failed-app");
  const plan = resolveCreator({
    destination,
    hostIntegration: "none",
    install: false,
  });

  try {
    const result = await executeCreator(plan, {
      signal: new AbortController().signal,
      onProgress(progress) {
        if (progress.kind === "scaffold" && progress.completedFiles === 1) {
          throw new Error("Progress consumer failed.");
        }
      },
    });

    expect(result.status).toBe("failed");

    if (result.status !== "failed") throw new Error("Expected progress failure to fail execution");

    expect(result.message).toBe("Progress consumer failed.");
    expect(result.cleanup.status).toBe("complete");
    expect(await readdir(root)).toStrictEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("does not remove a destination directory replaced during cancellation", async () => {
  const root = await mkdtemp(join(tmpdir(), "hesperia-create-replaced-directory-"));
  const destination = join(root, "replaced-app");
  const plan = resolveCreator({
    destination,
    hostIntegration: "none",
    install: false,
  });
  const controller = new AbortController();
  let observedFirstWrite = false;

  try {
    const result = await executeCreator(plan, {
      signal: controller.signal,
      onProgress(progress) {
        if (progress.kind !== "scaffold" || progress.completedFiles !== 1) return;

        observedFirstWrite = true;
        const createdPath = join(destination, progress.relativePath);

        unlinkSync(createdPath);

        let parentDirectory = dirname(createdPath);

        while (parentDirectory !== destination) {
          rmdirSync(parentDirectory);
          parentDirectory = dirname(parentDirectory);
        }

        rmdirSync(destination);
        mkdirSync(destination);
        writeFileSync(join(destination, "user-note.txt"), "keep this replacement directory");
        controller.abort();
      },
    });

    expect(observedFirstWrite).toBe(true);
    expect(result.status).toBe("cancelled");

    if (result.status !== "cancelled") throw new Error("Expected creator execution to cancel");

    expect(result.cleanup.status).toBe("retained");
    expect(result.cleanup.retainedPaths).toContain(destination);
    expect(await readdir(destination)).toStrictEqual(["user-note.txt"]);
    expect(await readFile(join(destination, "user-note.txt"), "utf8")).toBe(
      "keep this replacement directory",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
