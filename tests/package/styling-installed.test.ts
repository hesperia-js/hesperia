import { expect, test } from "bun:test";
import { readPinnedAeoliaVersion, writePackageManifest } from "./package-manifest.ts";
import { suppliedReleaseArchive } from "./release-candidate.ts";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { chromium } from "playwright";

const packageRoot = resolve(
  process.env.HESPERIA_PACKAGE_TEST_ROOT ?? resolve(import.meta.dir, "../.."),
);

const stylingFixtureRoot = join(import.meta.dir, "fixtures/applications/styling");

interface PackedManifest {
  readonly name: string;
  readonly version: string;
  readonly files?: readonly string[];
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly exports?: Readonly<Record<string, unknown>>;
}

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

async function runTar(...args: string[]): Promise<string> {
  const process_ = Bun.spawn(["tar", ...args], {
    cwd: packageRoot,
    stdout: "pipe",
    stderr: "pipe",
  });

  const [status, stdout, stderr] = await Promise.all([
    process_.exited,
    new Response(process_.stdout).text(),
    new Response(process_.stderr).text(),
  ]);

  if (status !== 0) throw new Error(`tar ${args.join(" ")} failed (${status})\n${stderr}`);

  return stdout;
}

async function readPackedManifest(tarball: string): Promise<PackedManifest> {
  return JSON.parse(await runTar("-xOf", tarball, "package/package.json")) as PackedManifest;
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

async function waitForServer(process_: ReturnType<typeof Bun.spawn>): Promise<string> {
  const reader = (process_.stdout as ReadableStream<Uint8Array>).getReader();

  const stderr = new Response(process_.stderr as ReadableStream<Uint8Array>).text();

  let output = "";

  try {
    while (true) {
      const chunk = await reader.read();

      if (chunk.done) {
        const [status, errors] = await Promise.all([process_.exited, stderr]);

        throw new Error(
          `Hesperia server exited before listening (${status})\n${output}\n${errors}`,
        );
      }

      output += new TextDecoder().decode(chunk.value);

      const url = output.match(/Hesperia (?:dev|preview): (http:\/\/\S+)/)?.[1];

      if (url) return url;
    }
  } finally {
    reader.releaseLock();
  }
}

function isInside(parent: string, child: string): boolean {
  const path = relative(resolve(parent), resolve(child));

  return path !== "" && path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

test("packed PostCSS, Tailwind, and StyleX work in an installed development and production app", async () => {
  const tempRoot = resolve(tmpdir());

  const workspace = await mkdtemp(join(tempRoot, "hesperia-styling-installed-"));

  const application = join(workspace, "application with spaces");

  let devServer: ReturnType<typeof Bun.spawn> | undefined;

  let previewServer: ReturnType<typeof Bun.spawn> | undefined;

  let passed = false;

  try {
    if (!isInside(tempRoot, workspace)) throw new Error(`Unsafe temp workspace path: ${workspace}`);

    const tarballs = {
      hesperia: await pack(workspace, resolve(packageRoot, "packages/hesperia")),
      "@hesperia/compiler": await pack(workspace, resolve(packageRoot, "packages/compiler")),
      "@hesperia/hosting": await pack(workspace, resolve(packageRoot, "packages/hosting")),
      "@hesperia/tooling": await pack(workspace, resolve(packageRoot, "packages/tooling")),
      "@hesperia/language-server": await pack(
        workspace,
        resolve(packageRoot, "packages/language-server"),
      ),
      "@hesperia/postcss": await pack(workspace, resolve(packageRoot, "packages/postcss")),
      "@hesperia/tailwind": await pack(workspace, resolve(packageRoot, "packages/tailwind")),
      "@hesperia/stylex": await pack(workspace, resolve(packageRoot, "packages/stylex")),
    };

    const manifests = {
      postcss: await readPackedManifest(tarballs["@hesperia/postcss"]),
      tailwind: await readPackedManifest(tarballs["@hesperia/tailwind"]),
      stylex: await readPackedManifest(tarballs["@hesperia/stylex"]),
    };

    const tailwindPostcssVersion = manifests.tailwind.dependencies?.["@hesperia/postcss"];

    expect(manifests.postcss.name).toBe("@hesperia/postcss");

    expect(manifests.tailwind.name).toBe("@hesperia/tailwind");

    expect(manifests.stylex.name).toBe("@hesperia/stylex");

    expect(tailwindPostcssVersion).toBe(manifests.postcss.version);

    expect(tailwindPostcssVersion).not.toMatch(/^workspace:/);

    for (const [manifest, tarball] of [
      [manifests.postcss, tarballs["@hesperia/postcss"]],
      [manifests.tailwind, tarballs["@hesperia/tailwind"]],
      [manifests.stylex, tarballs["@hesperia/stylex"]],
    ] as const) {
      expect(manifest.files).toContain("dist");

      const rootExport = manifest.exports?.["."] as
        | { readonly import?: string; readonly types?: string }
        | undefined;

      expect(rootExport?.import).toBe("./dist/index.js");

      expect(rootExport?.types).toBe("./dist/index.d.ts");

      const entries = (await runTar("-tzf", tarball)).split(/\r?\n/u);

      expect(entries).toContain("package/dist/index.js");

      expect(entries).toContain("package/dist/index.d.ts");
    }

    await run(
      packageRoot,
      resolve(packageRoot, "packages/create-hesperia/dist/cli.js"),
      application,
      "--no-install",
      "--host",
      "none",
    );

    await writeFile(
      join(application, "installed.css"),
      await readFile(join(stylingFixtureRoot, "installed.css"), "utf8"),
    );

    await writeFile(
      join(application, "src/routes/+page.tsx"),
      await readFile(join(stylingFixtureRoot, "src/routes/+page.tsx"), "utf8"),
    );

    await writeFile(
      join(application, "hesperia.config.ts"),
      await readFile(join(stylingFixtureRoot, "hesperia.config.ts"), "utf8"),
    );

    const manifestPath = join(application, "package.json");

    const applicationManifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
      overrides?: Record<string, string>;
    };

    applicationManifest.dependencies = {
      ...applicationManifest.dependencies,
      hesperia: tarballs.hesperia,
      aeolia: await readPinnedAeoliaVersion(packageRoot),
      "@stylexjs/stylex": "0.19.1",
    };

    applicationManifest.devDependencies = {
      ...applicationManifest.devDependencies,
      "@hesperia/tooling": tarballs["@hesperia/tooling"],
      "@hesperia/language-server": tarballs["@hesperia/language-server"],
      "@hesperia/postcss": tarballs["@hesperia/postcss"],
      "@hesperia/tailwind": tarballs["@hesperia/tailwind"],
      "@hesperia/stylex": tarballs["@hesperia/stylex"],
      postcss: "8.5.28",
    };

    applicationManifest.overrides = {
      ...applicationManifest.overrides,
      ...tarballs,
    };

    await writePackageManifest(manifestPath, applicationManifest);

    await run(application, "install", "--ignore-scripts");

    expect(await run(application, "run", "check")).toContain("Hesperia checking passed");

    const errors: string[] = [];

    const browser = await chromium.launch();

    try {
      devServer = Bun.spawn(
        [process.execPath, "node_modules/@hesperia/tooling/dist/cli.js", "dev", "--port", "0"],
        {
          cwd: application,
          stdout: "pipe",
          stderr: "pipe",
        },
      );

      const devUrl = await waitForServer(devServer);

      const devPage = await browser.newPage();

      devPage.on("pageerror", (error) => errors.push(error.message));

      await devPage.goto(devUrl);

      await devPage.locator("#counter").waitFor();

      expect(
        await devPage.locator("#postcss-proof").evaluate((node) => getComputedStyle(node).color),
      ).toBe("rgb(12, 34, 56)");

      expect(
        await devPage.locator("#tailwind-proof").evaluate((node) => {
          const style = getComputedStyle(node);

          return { paddingLeft: style.paddingLeft, backgroundColor: style.backgroundColor };
        }),
      ).toMatchObject({ paddingLeft: "28px" });

      expect(
        await devPage
          .locator("#tailwind-proof")
          .evaluate((node) => getComputedStyle(node).backgroundColor),
      ).not.toBe("rgba(0, 0, 0, 0)");

      const stylex = devPage.locator("#stylex-proof");

      expect(await stylex.getAttribute("style")).toContain("--x-color:rebeccapurple");

      expect(await stylex.evaluate((node) => getComputedStyle(node).color)).toBe(
        "rgb(102, 51, 153)",
      );

      await stylex.click();

      expect(await stylex.getAttribute("style")).toContain("--x-color:steelblue");

      expect(await stylex.evaluate((node) => getComputedStyle(node).color)).toBe(
        "rgb(70, 130, 180)",
      );

      const counter = devPage.locator("#counter");

      await counter.click();

      await counter.click();

      expect(await counter.textContent()).toBe("Count: 2");

      const counterNode = await counter.elementHandle();

      if (!counterNode) throw new Error("Counter disappeared before the CSS revision");

      const cssPath = join(application, "installed.css");

      const originalCss = await readFile(cssPath, "utf8");

      const revisedCss = await readFile(join(stylingFixtureRoot, "installed.revised.css"), "utf8");

      if (revisedCss === originalCss)
        throw new Error("CSS fixture update did not change its input");

      await writeFile(cssPath, revisedCss);

      await devPage.waitForFunction(
        () =>
          getComputedStyle(document.querySelector("#css-update-proof")!).backgroundColor ===
          "rgb(20, 180, 60)",
        undefined,
        { timeout: 15_000 },
      );

      expect(await counter.textContent()).toBe("Count: 2");

      expect(await counter.evaluate((node, original) => node === original, counterNode)).toBe(true);

      expect(await stylex.getAttribute("style")).toContain("--x-color:steelblue");

      await counterNode.dispose();

      expect(errors).toStrictEqual([]);

      await devPage.close();

      devServer.kill();

      await devServer.exited;

      devServer = undefined;

      expect(await run(application, "run", "build")).toContain("Built browser application");

      previewServer = Bun.spawn(
        [process.execPath, "node_modules/@hesperia/tooling/dist/cli.js", "preview", "--port", "0"],
        {
          cwd: application,
          stdout: "pipe",
          stderr: "pipe",
        },
      );

      const previewUrl = await waitForServer(previewServer);

      const previewPage = await browser.newPage();

      previewPage.on("pageerror", (error) => errors.push(error.message));

      await previewPage.goto(previewUrl);

      await previewPage.locator("#counter").waitFor();

      expect(
        await previewPage
          .locator("#postcss-proof")
          .evaluate((node) => getComputedStyle(node).color),
      ).toBe("rgb(12, 34, 56)");

      expect(
        await previewPage
          .locator("#tailwind-proof")
          .evaluate((node) => getComputedStyle(node).paddingLeft),
      ).toBe("28px");

      expect(
        await previewPage
          .locator("#css-update-proof")
          .evaluate((node) => getComputedStyle(node).backgroundColor),
      ).toBe("rgb(20, 180, 60)");

      const previewStylex = previewPage.locator("#stylex-proof");

      expect(await previewStylex.getAttribute("style")).toContain("--x-color:rebeccapurple");

      await previewStylex.click();

      expect(await previewStylex.getAttribute("style")).toContain("--x-color:steelblue");

      expect(await previewStylex.evaluate((node) => getComputedStyle(node).color)).toBe(
        "rgb(70, 130, 180)",
      );

      expect(errors).toStrictEqual([]);

      await previewPage.close();
    } finally {
      await browser.close();
    }

    passed = true;
  } finally {
    if (devServer) {
      devServer.kill();

      await devServer.exited;
    }

    if (previewServer) {
      previewServer.kill();

      await previewServer.exited;
    }

    if (!passed && process.env.HESPERIA_PACKAGE_TEST_KEEP_TEMP_ON_FAILURE === "1") {
      console.error(`Retained failed optional-styling consumer at ${workspace}`);
    } else if (!isInside(tempRoot, workspace)) {
      console.error(`Skipped cleanup outside the temp root: ${workspace}`);
    } else {
      await rm(workspace, { recursive: true, force: true });
    }
  }
}, 300_000);
