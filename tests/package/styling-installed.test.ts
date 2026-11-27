import { browserLaunchOptions } from "../support/browser-launch.mjs";
import { expect, test } from "bun:test";
import { readPinnedAeoliaVersion, writePackageManifest } from "./package-manifest.ts";
import { suppliedReleaseArchive } from "./release-candidate.ts";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
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

async function runTar(operation: string, archive: string, ...args: string[]): Promise<string> {
  const archivePath = resolve(packageRoot, archive);
  const process_ = Bun.spawn(["tar", operation, `./${basename(archivePath)}`, ...args], {
    cwd: dirname(archivePath),
    stdout: "pipe",
    stderr: "pipe",
  });

  const [status, stdout, stderr] = await Promise.all([
    process_.exited,
    new Response(process_.stdout).text(),
    new Response(process_.stderr).text(),
  ]);

  if (status !== 0)
    throw new Error(`tar ${[operation, archive, ...args].join(" ")} failed (${status})\n${stderr}`);

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

function captureStderr(stream: ReadableStream<Uint8Array>) {
  const limit = 16_384;
  let tail = new Uint8Array(0);
  let truncated = false;
  let finished = false;
  let readFailure: string | undefined;

  const done = (async () => {
    try {
      const reader = stream.getReader();

      try {
        while (true) {
          const chunk = await reader.read();

          if (chunk.done) break;

          const current = chunk.value.subarray(Math.max(0, chunk.value.byteLength - limit));
          const retained = Math.min(tail.byteLength, limit - current.byteLength);
          const next = new Uint8Array(retained + current.byteLength);

          next.set(tail.subarray(tail.byteLength - retained));
          next.set(current, retained);
          truncated ||= retained < tail.byteLength || current.byteLength < chunk.value.byteLength;
          tail = next;
        }
      } finally {
        reader.releaseLock();
      }
    } catch (error) {
      try {
        const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);

        readFailure = detail.slice(0, 1_024);
      } catch {
        readFailure = "Unprintable stderr stream error";
      }
    } finally {
      finished = true;
    }
  })();

  return {
    done,
    snapshot(): string {
      let state = finished ? "complete" : "still draining";

      if (readFailure !== undefined) state = `read failed: ${readFailure}`;

      const prefix = truncated ? "earlier bytes discarded; " : "";

      return `[stderr ${prefix}${state}]\n${new TextDecoder().decode(tail)}`;
    },
  };
}

async function waitForServer(
  process_: ReturnType<typeof Bun.spawn>,
  stderr: ReturnType<typeof captureStderr>,
): Promise<string> {
  const reader = (process_.stdout as ReadableStream<Uint8Array>).getReader();

  let output = "";

  try {
    while (true) {
      const chunk = await reader.read();

      if (chunk.done) {
        const [status] = await Promise.all([process_.exited, stderr.done]);

        throw new Error(
          `Hesperia server exited before listening (${status})\n${output}\n${stderr.snapshot()}`,
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

async function waitForServerExit(child: ReturnType<typeof Bun.spawn>): Promise<number | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    return await Promise.race([
      child.exited,
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), 1_500);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function retireServer(
  child: ReturnType<typeof Bun.spawn>,
  name: string,
  afterFailure: boolean,
  stage: (message: string) => void,
): Promise<void> {
  stage("signal " + name + " server " + child.pid);

  if (child.exitCode === null) child.kill();

  stage("await " + name + " server exit " + child.pid);
  const status = afterFailure ? await waitForServerExit(child) : await child.exited;

  if (status !== undefined) {
    stage(name + " server exited with status " + status);
    return;
  }

  stage("force " + name + " server exit " + child.pid);

  if (child.exitCode === null) child.kill("SIGKILL");

  const forcedStatus = await waitForServerExit(child);

  if (forcedStatus === undefined) throw new Error(name + " server exit was not observed");

  throw new Error(name + " server exceeded its graceful exit bound (status " + forcedStatus + ")");
}

function isInside(parent: string, child: string): boolean {
  const path = relative(resolve(parent), resolve(child));

  return path !== "" && path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

test("packed PostCSS, Tailwind, and StyleX work in an installed development and production app", async () => {
  const stage = (name: string) => console.error(`[Q10-STYLING] ${name}`);
  stage("create temporary workspace");
  const tempRoot = resolve(tmpdir());

  const workspace = await mkdtemp(join(tempRoot, "hesperia-styling-installed-"));

  const application = join(workspace, "application with spaces");

  let devServer: ReturnType<typeof Bun.spawn> | undefined;
  let devStderr: ReturnType<typeof captureStderr> | undefined;

  let previewServer: ReturnType<typeof Bun.spawn> | undefined;
  let previewStderr: ReturnType<typeof captureStderr> | undefined;

  let passed = false;
  let primaryFailure: { error: unknown } | undefined;

  try {
    stage("prepare package archives");
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

    stage("create application");
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

    stage("install application dependencies");
    await run(application, "install", "--ignore-scripts");

    stage("check application");
    expect(await run(application, "run", "check")).toContain("Hesperia checking passed");

    const errors: string[] = [];

    stage("launch browser");
    const browser = await chromium.launch(browserLaunchOptions("chromium"));
    let browserFailure: { error: unknown } | undefined;

    try {
      stage("start development server");
      devServer = Bun.spawn(
        [process.execPath, "node_modules/@hesperia/tooling/dist/cli.js", "dev", "--port", "0"],
        {
          cwd: application,
          stdout: "pipe",
          stderr: "pipe",
        },
      );

      devStderr = captureStderr(devServer.stderr as ReadableStream<Uint8Array>);
      const devUrl = await waitForServer(devServer, devStderr);

      stage("exercise development app");
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
      stage("CSS revision input written");

      await devPage.waitForFunction(
        () =>
          getComputedStyle(document.querySelector("#css-update-proof")!).backgroundColor ===
          "rgb(20, 180, 60)",
        undefined,
        { timeout: 15_000 },
      );
      stage("CSS revision visible");

      expect(await counter.textContent()).toBe("Count: 2");

      expect(await counter.evaluate((node, original) => node === original, counterNode)).toBe(true);

      expect(await stylex.getAttribute("style")).toContain("--x-color:steelblue");

      await counterNode.dispose();

      expect(errors).toStrictEqual([]);

      await devPage.close();

      stage("stop development server");
      devServer.kill();

      await devServer.exited;

      devServer = undefined;

      stage("build application");
      expect(await run(application, "run", "build")).toContain("Built browser application");

      stage("start preview server");
      previewServer = Bun.spawn(
        [process.execPath, "node_modules/@hesperia/tooling/dist/cli.js", "preview", "--port", "0"],
        {
          cwd: application,
          stdout: "pipe",
          stderr: "pipe",
        },
      );

      previewStderr = captureStderr(previewServer.stderr as ReadableStream<Uint8Array>);
      const previewUrl = await waitForServer(previewServer, previewStderr);

      stage("exercise preview app");
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
    } catch (error) {
      browserFailure = { error };
      console.error("[Q10-STYLING] browser exercise failed", error);

      try {
        if (devServer && devStderr)
          console.error("[Q10-STYLING] development server stderr tail", devStderr.snapshot());

        if (previewServer && previewStderr)
          console.error("[Q10-STYLING] preview server stderr tail", previewStderr.snapshot());
      } catch {
        // The stderr diagnostic must not replace the browser failure.
      }
    } finally {
      stage("close browser");

      try {
        await browser.close();
      } catch (error) {
        browserFailure = {
          error: browserFailure
            ? new AggregateError(
                [browserFailure.error, error],
                "Browser exercise and close failed",
                { cause: browserFailure.error },
              )
            : error,
        };
      }
    }

    if (browserFailure) throw browserFailure.error;

    passed = true;
  } catch (error) {
    primaryFailure = { error };
  } finally {
    stage("clean up application");

    try {
      if (devServer) await retireServer(devServer, "development", !passed, stage);

      if (previewServer) await retireServer(previewServer, "preview", !passed, stage);

      if (!passed && process.env.HESPERIA_PACKAGE_TEST_KEEP_TEMP_ON_FAILURE === "1") {
        console.error(`Retained failed optional-styling consumer at ${workspace}`);
      } else if (!isInside(tempRoot, workspace)) {
        console.error(`Skipped cleanup outside the temp root: ${workspace}`);
      } else {
        stage("remove temporary workspace");
        await rm(workspace, { recursive: true, force: true });
        stage("temporary workspace removed");
      }
    } catch (error) {
      console.error(`Retained optional-styling consumer after cleanup failure at ${workspace}`);

      primaryFailure = {
        error: primaryFailure
          ? new AggregateError([primaryFailure.error, error], "Styling test and cleanup failed", {
              cause: primaryFailure.error,
            })
          : error,
      };
    }
  }

  if (primaryFailure) throw primaryFailure.error;
}, 300_000);
