import { expect, test } from "bun:test";
import { readPinnedAeoliaVersion } from "./package-manifest.ts";
import { suppliedReleaseArchive } from "./release-candidate.ts";
import { createRequire } from "node:module";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const packageRoot = resolve(
  process.env.HESPERIA_PACKAGE_TEST_ROOT ?? resolve(import.meta.dir, "../.."),
);

const isolatedToolingFixture = join(import.meta.dir, "fixtures/applications/isolated-tooling");

interface CommandResult {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

async function runResult(cwd: string, ...args: string[]): Promise<CommandResult> {
  const child = Bun.spawn([process.execPath, ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });

  const [status, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);

  return { status, stdout, stderr };
}

async function runInstalledCliResult(
  cwd: string,
  cli: string,
  ...args: string[]
): Promise<CommandResult> {
  const adapterPath = process.env.HESPERIA_CLI_CAPTURE_ADAPTER;

  if (!adapterPath) return runResult(cwd, cli, ...args);

  const adapter = (await import(pathToFileURL(resolve(adapterPath)).href)) as {
    runInstalledCli(input: {
      readonly cwd: string;
      readonly execPath: string;
      readonly args: readonly string[];
    }): Promise<CommandResult>;
  };

  return adapter.runInstalledCli({ cwd, execPath: process.execPath, args: [cli, ...args] });
}

async function run(cwd: string, ...args: string[]): Promise<string> {
  const result = await runResult(cwd, ...args);

  if (result.status !== 0)
    throw new Error(
      `${args.join(" ")} failed (${result.status})\n${result.stdout}\n${result.stderr}`,
    );

  return result.stdout;
}

async function pack(workspace: string, root: string): Promise<string> {
  const supplied = await suppliedReleaseArchive(root);

  if (supplied) return supplied;

  const before = new Set(await readdir(workspace));

  await run(root, "pm", "pack", "--destination", workspace, "--ignore-scripts", "--quiet");

  const [name] = (await readdir(workspace)).filter(
    (item) => item.endsWith(".tgz") && !before.has(item),
  );

  if (!name) throw new Error(`Packing ${root} produced no new tarball`);

  return join(workspace, name).replaceAll("\\", "/");
}

function digest(source: string): string {
  return new Bun.CryptoHasher("sha256").update(source).digest("hex");
}

test("installed hesperia check preserves sources, fixes configured Oxc issues, and keeps compiler errors", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "hesperia-check-installed-"));

  const application = join(workspace, "external app");

  try {
    const tarballs = {
      hesperia: await pack(workspace, resolve(packageRoot, "packages/hesperia")),
      compiler: await pack(workspace, resolve(packageRoot, "packages/compiler")),
      hosting: await pack(workspace, resolve(packageRoot, "packages/hosting")),
      languageServer: await pack(workspace, resolve(packageRoot, "packages/language-server")),
      postcss: await pack(workspace, resolve(packageRoot, "packages/postcss")),
      stylex: await pack(workspace, resolve(packageRoot, "packages/stylex")),
      tailwind: await pack(workspace, resolve(packageRoot, "packages/tailwind")),
      tooling: await pack(workspace, resolve(packageRoot, "packages/tooling")),
      creator: await pack(workspace, resolve(packageRoot, "packages/create-hesperia")),
    };

    await mkdir(join(application, "src", "routes"), { recursive: true });

    const dependencies = {
      aeolia: await readPinnedAeoliaVersion(packageRoot),
      hesperia: tarballs.hesperia,
      "@hesperia/compiler": tarballs.compiler,
      "@hesperia/hosting": tarballs.hosting,
      "@hesperia/language-server": tarballs.languageServer,
      "@hesperia/postcss": tarballs.postcss,
      "@hesperia/stylex": tarballs.stylex,
      "@hesperia/tailwind": tarballs.tailwind,
      "@hesperia/tooling": tarballs.tooling,
      "create-hesperia": tarballs.creator,
      postcss: "8.5.28",
      "@stylexjs/stylex": "0.19.1",
    };

    await writeFile(
      join(application, "package.json"),
      `${JSON.stringify(
        {
          name: "installed-check-consumer",
          private: true,
          type: "module",
          dependencies,
          overrides: dependencies,
        },
        null,
        2,
      )}\n`,
    );

    await run(application, "install", "--ignore-scripts");

    const cli = join(application, "node_modules", "@hesperia", "tooling", "dist", "cli.js");

    const require = createRequire(join(application, "package.json"));

    expect(require.resolve("@hesperia/tooling")).toContain(
      join("node_modules", "@hesperia", "tooling"),
    );

    expect(require.resolve("oxlint")).toContain(join("node_modules", "oxlint"));

    expect(require.resolve("oxfmt")).toContain(join("node_modules", "oxfmt"));

    await writeFile(
      join(application, "app.tsx"),
      'import "./app.css";\nexport default function App(props: { children: () => unknown }) { return <html><head><title>Installed app</title></head><body>{props.children()}</body></html>; }\n',
    );

    await writeFile(join(application, "app.css"), "body { margin: 0; }\n");

    await writeFile(
      join(application, "src", "routes", "+page.tsx"),
      'import { copiedValue } from "../../api.ts";\nexport default function Page() { return <main>{copiedValue}</main>; }\n',
    );

    await writeFile(
      join(application, "api.ts"),
      "export const apiValue = 'packed API';\nlet copied = apiValue;\nexport const copiedValue = copied;\n",
    );

    await writeFile(
      join(application, ".oxlintrc.json"),
      `${JSON.stringify({ rules: { "prefer-const": "error" } }, null, 2)}\n`,
    );

    await writeFile(
      join(application, ".oxfmtrc.json"),
      `${JSON.stringify({ singleQuote: false }, null, 2)}\n`,
    );

    await writeFile(join(application, ".eslintignore"), "src/ignored.ts\n");

    await writeFile(join(application, ".prettierignore"), "src/ignored-format.ts\n");

    await writeFile(join(application, "src", "ignored.ts"), "let ignored = true;\n");

    await writeFile(
      join(application, "src", "ignored-format.ts"),
      "export const ignored='format';\n",
    );

    const authoredFiles = [
      "app.tsx",
      "api.ts",
      "src/routes/+page.tsx",
      ".oxlintrc.json",
      ".oxfmtrc.json",
      "src/ignored.ts",
      "src/ignored-format.ts",
    ];

    const before = new Map(
      await Promise.all(
        authoredFiles.map(async (path) => {
          const filename = join(application, path);

          return [filename, digest(await readFile(filename, "utf8"))] as const;
        }),
      ),
    );

    const check = await runInstalledCliResult(application, cli, "check");

    const checkText = `${check.stdout}\n${check.stderr}`;

    expect(check.status).toBe(1);

    expect(checkText).toContain("eslint(prefer-const)");

    expect(checkText).toContain("OXFMT");

    for (const [filename, sourceDigest] of before)
      expect(digest(await readFile(filename, "utf8"))).toBe(sourceDigest);

    await writeFile(
      join(application, "api.ts"),
      `${await readFile(join(application, "api.ts"), "utf8")}export const invalid: string = 1;\n`,
    );

    const fixedWithCompilerError = await runInstalledCliResult(application, cli, "check", "--fix");

    const fixedText = `${fixedWithCompilerError.stdout}\n${fixedWithCompilerError.stderr}`;

    expect(fixedWithCompilerError.status).toBe(1);

    expect(fixedText).toContain("TS2322");

    expect(fixedText).not.toContain("OXFMT");

    expect(fixedText).not.toContain("eslint(prefer-const)");

    const fixedApi = await readFile(join(application, "api.ts"), "utf8");

    expect(fixedApi).toContain('"packed API"');

    expect(fixedApi).toContain("const copied = apiValue;");

    expect(await readFile(join(application, "src", "ignored.ts"), "utf8")).toBe(
      "let ignored = true;\n",
    );

    expect(await readFile(join(application, "src", "ignored-format.ts"), "utf8")).toBe(
      "export const ignored='format';\n",
    );

    await writeFile(
      join(application, "api.ts"),
      fixedApi.replace(
        "export const invalid: string = 1;",
        'export const invalid: string = "fixed";',
      ),
    );

    const passing = await runInstalledCliResult(application, cli, "check");

    if (passing.status !== 0)
      throw new Error(
        `Final installed check failed (${passing.status})\n${passing.stdout}\n${passing.stderr}`,
      );

    expect(passing.stdout).toContain("Hesperia checking passed");

    await writeFile(
      join(application, "api.ts"),
      `${await readFile(join(application, "api.ts"), "utf8")}export const invalidAgain: string = 1;\n`,
    );

    await writeFile(join(application, ".oxfmtrc.json"), "{ invalid configuration\n");

    const toolFailure = await runInstalledCliResult(application, cli, "check", "--fix");

    const toolFailureText = `${toolFailure.stdout}\n${toolFailure.stderr}`;

    expect(toolFailure.status).toBe(1);

    expect(toolFailureText).toContain("TS2322");

    expect(toolFailureText).toContain("OXFMT");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("isolated tooling consumer resolves runtime imports and public project types", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "hesperia-tooling-isolated-consumer-"));

  const application = join(workspace, "consumer app");

  try {
    const tarballs = {
      hesperia: await pack(workspace, resolve(packageRoot, "packages/hesperia")),
      compiler: await pack(workspace, resolve(packageRoot, "packages/compiler")),
      hosting: await pack(workspace, resolve(packageRoot, "packages/hosting")),
      tooling: await pack(workspace, resolve(packageRoot, "packages/tooling")),
    };

    await mkdir(join(application, "src", "routes"), { recursive: true });

    const dependencies = {
      aeolia: await readPinnedAeoliaVersion(packageRoot),
      hesperia: tarballs.hesperia,
      "@hesperia/tooling": tarballs.tooling,
    };

    const devDependencies = { "@types/bun": "1.4.2" };

    const overrides = {
      aeolia: await readPinnedAeoliaVersion(packageRoot),
      hesperia: tarballs.hesperia,
      "@hesperia/compiler": tarballs.compiler,
      "@hesperia/hosting": tarballs.hosting,
    };

    await writeFile(
      join(application, "package.json"),
      `${JSON.stringify(
        {
          name: "tooling-isolated-consumer",
          private: true,
          type: "module",
          dependencies,
          devDependencies,
          overrides,
        },
        null,
        2,
      )}\n`,
    );

    const bunfig = join(application, "bunfig.toml");

    await writeFile(
      bunfig,
      [
        "[install]",
        'auto = "disable"',
        'linker = "isolated"',
        "hoist = false",
        "publicHoistPattern = []",
        "peer = true",
        "",
      ].join("\n"),
    );

    await copyFile(join(isolatedToolingFixture, "app.tsx"), join(application, "app.tsx"));

    await copyFile(join(isolatedToolingFixture, "app.css"), join(application, "app.css"));

    await copyFile(
      join(isolatedToolingFixture, "src/routes/+page.tsx"),
      join(application, "src", "routes", "+page.tsx"),
    );

    await copyFile(join(isolatedToolingFixture, "api.ts"), join(application, "api.ts"));

    await copyFile(join(isolatedToolingFixture, "consumer.ts"), join(application, "consumer.ts"));

    await writeFile(
      join(application, "tsconfig.consumer.json"),
      JSON.stringify({
        compilerOptions: {
          target: "ESNext",
          lib: ["ESNext", "DOM"],
          module: "ESNext",
          moduleResolution: "Bundler",
          noEmit: true,
          skipLibCheck: false,
          strict: true,
        },
        files: ["consumer.ts"],
      }),
    );

    await run(
      application,
      "install",
      "--ignore-scripts",
      "--linker",
      "isolated",
      `--config=${bunfig}`,
    );

    const cli = join(application, "node_modules", "@hesperia", "tooling", "dist", "cli.js");

    await run(
      packageRoot,
      "run",
      "fmt",
      "--",
      join(application, "package.json"),
      join(application, "app.tsx"),
      join(application, "app.css"),
      join(application, "src", "routes", "+page.tsx"),
      join(application, "api.ts"),
      join(application, "consumer.ts"),
      join(application, "tsconfig.consumer.json"),
    );

    const runtime = await runResult(application, cli, "check");

    const tsc = join(packageRoot, "node_modules", "typescript", "bin", "tsc");

    const typecheck = await runResult(
      application,
      tsc,
      "--noEmit",
      "--project",
      "tsconfig.consumer.json",
    );

    const failures: string[] = [];

    if (runtime.status !== 0)
      failures.push(
        `Installed tooling check failed (${runtime.status})\n${runtime.stdout}\n${runtime.stderr}`,
      );
    else if (!runtime.stdout.includes("Hesperia checking passed"))
      failures.push(`Installed tooling check did not pass\n${runtime.stdout}\n${runtime.stderr}`);

    if (typecheck.status !== 0)
      failures.push(
        `Installed tooling declaration consumer failed (${typecheck.status})\n${typecheck.stdout}\n${typecheck.stderr}`,
      );

    expect(failures).toStrictEqual([]);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
