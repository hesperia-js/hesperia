import { expect, test } from "bun:test";
import { readPinnedAeoliaVersion, writePackageManifest } from "./package-manifest.ts";
import { suppliedReleaseArchive } from "./release-candidate.ts";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const packageRoot = resolve(import.meta.dir, "../..");

test("packed packages serve a custom backend data flow in all three browser engines", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "hesperia-installed-"));

  const application = join(workspace, "application with spaces");

  async function run(cwd: string, ...args: string[]): Promise<string> {
    const process_ = Bun.spawn([process.execPath, ...args], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
    });

    const [status, stdout, stderr] = await Promise.all([
      process_.exited,
      new Response(process_.stdout).text(),
      new Response(process_.stderr).text(),
    ]);

    if (status !== 0) throw new Error(`${args.join(" ")} failed (${status})\n${stdout}\n${stderr}`);

    return stdout;
  }

  let preview: ReturnType<typeof Bun.spawn> | undefined;

  try {
    async function pack(root: string): Promise<string> {
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

    const tarballs = {
      hesperia: await pack(resolve(packageRoot, "packages/hesperia")),
      "@hesperia/compiler": await pack(resolve(packageRoot, "packages/compiler")),
      "@hesperia/hosting": await pack(resolve(packageRoot, "packages/hosting")),
      "@hesperia/tooling": await pack(resolve(packageRoot, "packages/tooling")),
      "@hesperia/language-server": await pack(resolve(packageRoot, "packages/language-server")),
    };

    await run(
      packageRoot,
      resolve(packageRoot, "packages/create-hesperia/dist/cli.js"),
      application,
      "--no-install",
      "--host",
      "none",
    );

    const nestedRoute = join(application, "src/routes/deep/link");

    await mkdir(nestedRoute, { recursive: true });

    await writeFile(
      join(nestedRoute, "+page.tsx"),
      await readFile(
        new URL("./fixtures/installed-app/src/routes/deep/link/+page.tsx", import.meta.url),
        "utf8",
      ),
    );

    await writeFile(
      join(application, "palette.dat"),
      await readFile(new URL("./fixtures/installed-app/palette.dat", import.meta.url), "utf8"),
    );

    await writeFile(
      join(application, "hesperia.config.ts"),
      await readFile(
        new URL("./fixtures/installed-app/hesperia.config.ts", import.meta.url),
        "utf8",
      ),
    );

    await writeFile(
      join(application, "api.ts"),
      await readFile(new URL("./fixtures/installed-app/api.ts", import.meta.url), "utf8"),
    );

    const asyncRoute = join(application, "src/routes/users/[id]");

    await mkdir(asyncRoute, { recursive: true });

    await writeFile(
      join(asyncRoute, "+page.tsx"),
      await readFile(
        new URL("./fixtures/installed-app/src/routes/users/[id]/+page.tsx", import.meta.url),
        "utf8",
      ),
    );

    const manifestPath = join(application, "package.json");

    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));

    manifest.dependencies = {
      hesperia: tarballs.hesperia,
      aeolia: await readPinnedAeoliaVersion(packageRoot),
    };

    manifest.devDependencies["@hesperia/tooling"] = tarballs["@hesperia/tooling"];

    manifest.devDependencies["@hesperia/language-server"] = tarballs["@hesperia/language-server"];

    manifest.overrides = tarballs;

    await writePackageManifest(manifestPath, manifest);

    await run(application, "install", "--ignore-scripts");

    expect(await run(application, "run", "check")).toContain("Hesperia checking passed");

    const require = createRequire(manifestPath);

    expect(require.resolve("@hesperia/compiler")).toContain(
      join("node_modules", "@hesperia", "compiler"),
    );

    expect(() => require.resolve("hesperia/compiler")).toThrow();

    expect(() => require.resolve("@hesperia/compiler/ir")).toThrow();

    for (const name of ["hesperia", "@hesperia/compiler", "@hesperia/tooling"]) {
      const root = join(application, "node_modules", name);

      const published = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as {
        dependencies?: Record<string, string>;
        exports: Record<string, { types?: string; import?: string } | string>;
      };

      for (const target of Object.values(published.exports)) {
        if (typeof target === "string") {
          await stat(join(root, target));

          continue;
        }

        for (const path of [target.types, target.import]) if (path) await stat(join(root, path));
      }

      if (name === "hesperia") expect(published.dependencies ?? {}).toEqual({});
    }

    await writeFile(
      join(application, "consumer.ts"),
      await readFile(new URL("./fixtures/installed-app/consumer.ts", import.meta.url), "utf8"),
    );

    await writeFile(
      join(application, "tsconfig.consumer.json"),
      JSON.stringify({
        compilerOptions: {
          lib: ["ESNext", "DOM"],
          module: "ESNext",
          moduleResolution: "Bundler",
          noEmit: true,
          skipLibCheck: true,
          strict: true,
          types: [],
        },
        files: ["hesperia.d.ts", "consumer.ts"],
      }),
    );

    const tsc = join(application, "node_modules/typescript/bin/tsc");

    async function runTypeScript(...args: string[]): Promise<string> {
      const process_ = Bun.spawn([process.execPath, tsc, ...args], {
        cwd: application,
        stdout: "pipe",
        stderr: "pipe",
      });

      const [code, stdout, stderr] = await Promise.all([
        process_.exited,
        new Response(process_.stdout).text(),
        new Response(process_.stderr).text(),
      ]);

      if (code !== 0) throw new Error(`Installed TypeScript consumer failed\n${stdout}\n${stderr}`);

      return stdout;
    }

    await runTypeScript("--noEmit", "--project", "tsconfig.consumer.json");

    const files = await runTypeScript(
      "--noEmit",
      "--listFilesOnly",
      "--project",
      "tsconfig.consumer.json",
    );

    expect(files.replaceAll("\\", "/")).toContain("/node_modules/hesperia/dist/client.d.ts");

    expect(files.replaceAll("\\", "/")).toContain("/node_modules/hesperia/dist/navigation.d.ts");

    expect(files.replaceAll("\\", "/")).toContain("/node_modules/hesperia/dist/env.d.ts");

    expect(files.replaceAll("\\", "/")).toContain(
      "/node_modules/@hesperia/compiler/dist/index.d.ts",
    );

    expect(await run(application, "run", "build")).toContain("Built browser application");

    preview = Bun.spawn(
      [
        process.execPath,
        join(application, "node_modules/@hesperia/tooling/dist/cli.js"),
        "preview",
        "--port",
        "0",
      ],
      { cwd: application, stdout: "pipe", stderr: "pipe" },
    );

    const reader = (preview.stdout as ReadableStream<Uint8Array>).getReader();

    let output = "";

    let url: string | undefined;

    try {
      while (!url) {
        const chunk = await reader.read();

        if (chunk.done) throw new Error(`Preview exited before listening: ${output}`);

        output += new TextDecoder().decode(chunk.value);

        url = output.match(/http:\/\/127\.0\.0\.1:\d+\//)?.[0];
      }
    } finally {
      reader.releaseLock();
    }

    const browserRunner = join(packageRoot, "tests/package/fixtures/installed-browser.mjs");

    const playwrightUrl = pathToFileURL(
      join(packageRoot, "node_modules/playwright/index.mjs"),
    ).href;

    const browserProcess = Bun.spawn(["node", browserRunner, playwrightUrl, url], {
      cwd: application,
      stdout: "pipe",
      stderr: "pipe",
    });

    const [browserStatus, browserOutput, browserErrors] = await Promise.all([
      browserProcess.exited,
      new Response(browserProcess.stdout).text(),
      new Response(browserProcess.stderr).text(),
    ]);

    if (browserStatus !== 0)
      throw new Error(`Installed browser application failed\n${browserOutput}\n${browserErrors}`);

    expect(JSON.parse(browserOutput.trim())).toStrictEqual(["chromium", "firefox", "webkit"]);
  } finally {
    if (preview) {
      preview.kill();

      await preview.exited;
    }

    await rm(workspace, { recursive: true, force: true });
  }
}, 120_000);
