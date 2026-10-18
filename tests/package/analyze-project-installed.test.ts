import { expect, test } from "bun:test";
import { readPinnedAeoliaVersion, writePackageManifest } from "./package-manifest.ts";
import { suppliedReleaseArchive } from "./release-candidate.ts";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { chromium } from "playwright";

const packageRoot = resolve(
  process.env.HESPERIA_PACKAGE_TEST_ROOT ?? resolve(import.meta.dir, "../.."),
);

const applicationFixture = join(import.meta.dir, "fixtures/applications/analyze-project");

const pluginFixture = join(applicationFixture, "plugins/analyze-project-plugin.mjs");

test("packed packages run an installed analyzeProject plugin against one pinned revision", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "hesperia-installed-analyze-project-"));

  const application = join(workspace, "application with spaces");

  let preview: ReturnType<typeof Bun.spawn> | undefined;

  let passed = false;

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

  async function copyFixture(relativePath: string): Promise<void> {
    const destination = join(application, relativePath);

    await mkdir(dirname(destination), { recursive: true });

    await copyFile(join(applicationFixture, relativePath), destination);
  }

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

  async function emittedFiles(directory: string): Promise<Array<{ path: string; text: string }>> {
    const files: Array<{ path: string; text: string }> = [];

    async function visit(current: string): Promise<void> {
      for (const entry of await readdir(current, { withFileTypes: true })) {
        const path = join(current, entry.name);

        if (entry.isDirectory()) await visit(path);
        else if (entry.isFile()) files.push({ path, text: await readFile(path, "utf8") });
      }
    }

    await visit(directory);

    return files;
  }

  try {
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

    await copyFixture("src/shared-value.ts");

    await copyFixture("src/server-only.ts");

    await copyFixture("src/routes/+page.tsx");

    await copyFile(
      join(applicationFixture, "analysis.config.ts"),
      join(application, "hesperia.config.ts"),
    );

    const pluginDestination = join(application, "plugins/analyze-project-plugin.mjs");

    await mkdir(dirname(pluginDestination), { recursive: true });

    await copyFile(pluginFixture, pluginDestination);

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

    expect(await run(application, "run", "build")).toContain("Built browser application");

    const observation = JSON.parse(
      await readFile(join(application, ".analyze-project-proof.json"), "utf8"),
    );

    expect(observation).toMatchObject({
      capturedSharedBefore: 'export const capturedValue = "CAPTURED_VALUE_FROM_FIRST_READ";\n',
      checkingSharedBefore: 'export const capturedValue = "CAPTURED_VALUE_FROM_FIRST_READ";\n',
      capturedSharedAfter: 'export const capturedValue = "CAPTURED_VALUE_FROM_FIRST_READ";\n',
      checkingSharedAfter: 'export const capturedValue = "CAPTURED_VALUE_FROM_FIRST_READ";\n',
      capturedServerBefore: 'export const serverSecret = "SERVER_ONLY_TEXT_MUST_NOT_SHIP_64A7";\n',
      checkingServerAfter: 'export const serverSecret = "SERVER_ONLY_TEXT_MUST_NOT_SHIP_64A7";\n',
      serverAstAfter: 'export const serverSecret = "SERVER_ONLY_TEXT_MUST_NOT_SHIP_64A7";\n',
      diskSharedAfter: 'export const capturedValue = "MUTATED_DURING_ANALYZE_PROJECT";\n',
      diskServerAfter: 'export const serverSecret = "MUTATED_DURING_ANALYZE_PROJECT";\n',
    });

    const buildFiles = await emittedFiles(join(application, ".hesperia/build"));

    expect(buildFiles.length).toBeGreaterThan(0);

    const buildText = buildFiles.map(({ text }) => text).join("\n");

    expect(buildText).toContain("CAPTURED_VALUE_FROM_FIRST_READ");

    expect(buildText).toContain("INSTALLED_THIRD_PARTY_BODY_EXECUTED");

    expect(buildText).not.toContain("SERVER_ONLY_TEXT_MUST_NOT_SHIP_64A7");

    expect(buildText).not.toContain("MUTATED_DURING_ANALYZE_PROJECT");

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

    const browser = await chromium.launch();

    try {
      const page = await browser.newPage();

      const errors: string[] = [];

      page.on("pageerror", (error) => errors.push(error.message));

      const response = await page.goto(url);

      try {
        await page.locator("#captured").waitFor({ timeout: 5_000 });
      } catch (error) {
        const body = await page.locator("body").innerHTML();

        throw new Error(
          `Built app did not render its route (HTTP ${response?.status() ?? "no response"})\n` +
            `Body: ${body}\nPage errors: ${JSON.stringify(errors)}`,
          { cause: error },
        );
      }

      expect(await page.locator("#captured").textContent()).toBe("CAPTURED_VALUE_FROM_FIRST_READ");

      expect(await page.locator("#generated").textContent()).toBe(
        "INSTALLED_THIRD_PARTY_BODY_EXECUTED",
      );

      expect(errors).toStrictEqual([]);
    } finally {
      await browser.close();
    }

    passed = true;
  } finally {
    if (preview) {
      preview.kill();

      await preview.exited;
    }

    if (!passed && process.env.HESPERIA_PACKAGE_TEST_KEEP_TEMP_ON_FAILURE === "1") {
      console.error(`Retained failed installed app at ${workspace}`);
    } else {
      await rm(workspace, { recursive: true, force: true });
    }
  }
}, 180_000);
