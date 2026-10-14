import { expect, test } from "bun:test";
import { readPinnedAeoliaVersion, writePackageManifest } from "./package-manifest.ts";
import { suppliedReleaseArchive } from "./release-candidate.ts";
import { copyFile, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, firefox, webkit, type Frame, type Page, type Request } from "playwright";

const packageRoot = resolve(import.meta.dir, "../..");

const applicationFixture = join(import.meta.dir, "fixtures/applications/embed");

async function navigate(page: Page, url: string): Promise<void> {
  const started = Date.now();
  const timeline: string[] = [];
  const pending = new Set<Request>();
  const origin = new URL(url).origin;
  const localURL = (value: string): string => {
    if (!value) return "uncommitted";

    const parsed = new URL(value);

    return parsed.origin === origin
      ? `${origin}${parsed.pathname}`
      : parsed.protocol === "about:"
        ? `about:${parsed.pathname}`
        : parsed.protocol;
  };
  const record = (event: string): void => {
    timeline.push(`${Date.now() - started}ms ${event}`);

    if (timeline.length > 32) timeline.shift();
  };
  const requested = (request: Request): void => {
    pending.add(request);

    record(`request ${localURL(request.url())}`);
  };
  const settled = (request: Request): void => {
    pending.delete(request);

    record(`${request.failure() ? "failed" : "finished"} ${localURL(request.url())}`);
  };
  const navigated = (frame: Frame): void => record(`frame ${localURL(frame.url())}`);
  const loaded = (): void => record(`load ${localURL(page.url())}`);

  page.on("request", requested);

  page.on("requestfinished", settled);

  page.on("requestfailed", settled);

  page.on("framenavigated", navigated);

  page.on("load", loaded);

  try {
    await page.goto(url);
  } catch (error) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const documentState = await Promise.race([
      page
        .evaluate(() => ({
          readyState: document.readyState,
          loads: document.getElementById("loads")?.textContent ?? null,
        }))
        .catch(() => "unavailable"),
      new Promise<string>((resolve_) => {
        timer = setTimeout(() => resolve_("observation timed out"), 1_000);
      }),
    ]);

    clearTimeout(timer);

    console.error("Installed Embed navigation failed", {
      timeline,
      pending: [...pending].map((request) => localURL(request.url())),
      browserConnected: page.context().browser()?.isConnected(),
      pageClosed: page.isClosed(),
      frames: page.frames().map((frame) => localURL(frame.url())),
      document: documentState,
    });

    throw error;
  } finally {
    page.off("request", requested);

    page.off("requestfinished", settled);

    page.off("requestfailed", settled);

    page.off("framenavigated", navigated);

    page.off("load", loaded);
  }
}

test("packed public Embed preserves root policy, events, and wrapper binding in compiled applications", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "hesperia-installed-embed-"));

  const applications = [
    { name: "strict", allowUnsafeEmbed: false },
    { name: "permissive", allowUnsafeEmbed: true },
  ] as const;

  const previews: ReturnType<typeof Bun.spawn>[] = [];

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

    for (const application of applications) {
      const directory = join(workspace, `${application.name} application`);

      await run(
        packageRoot,
        resolve(packageRoot, "packages/create-hesperia/dist/cli.js"),
        directory,
        "--no-install",
        "--host",
        "none",
      );

      await rm(join(directory, "hesperia.config.ts"));

      await writeFile(
        join(directory, "hesperia.config.json"),
        `{ "allowUnsafeEmbed": ${application.allowUnsafeEmbed} }\n`,
      );

      await copyFile(
        join(applicationFixture, "src/routes/+page.tsx"),
        join(directory, "src/routes/+page.tsx"),
      );

      const manifestPath = join(directory, "package.json");

      const manifest = JSON.parse(await readFile(manifestPath, "utf8"));

      manifest.dependencies = {
        hesperia: tarballs.hesperia,
        aeolia: await readPinnedAeoliaVersion(packageRoot),
      };

      manifest.devDependencies["@hesperia/tooling"] = tarballs["@hesperia/tooling"];

      manifest.devDependencies["@hesperia/language-server"] = tarballs["@hesperia/language-server"];

      manifest.overrides = tarballs;

      await writePackageManifest(manifestPath, manifest);

      await run(directory, "install", "--ignore-scripts");

      const invalid = join(directory, "src", "invalid-embed.tsx");

      await writeFile(
        invalid,
        `import { Embed } from "hesperia/embed";
export function Invalid() {
  return <Embed sandbox={42} />;
}
`,
      );

      const invalidCheck = await run(directory, "run", "check").then(
        () => "",
        (error: unknown) => String(error),
      );

      expect(invalidCheck).toContain("Type 'number' is not assignable to type 'string'");

      await rm(invalid);

      const invalidEvent = join(directory, "src", "invalid-embed-event.tsx");

      await writeFile(
        invalidEvent,
        `import { Embed } from "hesperia/embed";
export function Invalid() {
  return <Embed on:load={[(event: Event) => event.type, { signal: true }]} />;
}
`,
      );

      const invalidEventCheck = await run(directory, "run", "check").then(
        () => "",
        (error: unknown) => String(error),
      );

      expect(invalidEventCheck).toContain("Native event options must be a static object");

      await rm(invalidEvent);

      expect(await run(directory, "run", "check")).toContain("Hesperia checking passed");

      expect(await run(directory, "run", "build")).toContain("Built browser application");

      const preview = Bun.spawn(
        [
          process.execPath,
          join(directory, "node_modules/@hesperia/tooling/dist/cli.js"),
          "preview",
          "--port",
          "0",
        ],
        { cwd: directory, stdout: "pipe", stderr: "pipe" },
      );

      previews.push(preview);

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

      for (const [name, engine] of Object.entries({ chromium, firefox, webkit })) {
        const browser = await engine.launch();

        try {
          const page = await browser.newPage();

          const errors: string[] = [];

          page.on("pageerror", (error) => errors.push(error.message));

          await navigate(page, url);

          await page.locator('iframe[name="primary"]').waitFor();

          expect(await page.locator('iframe[name="primary"]').count()).toBe(1);

          expect(await page.locator('iframe[name="primary"]').getAttribute("sandbox")).toBe(
            "allow-scripts",
          );

          expect(await page.locator('iframe[name="primary"]').getAttribute("title")).toBe(
            "Primary frame",
          );

          const initialFrame = page.frame({ name: "primary" });

          if (!initialFrame) throw new Error("The primary Embed browsing context was not found");

          await initialFrame.waitForLoadState("load");

          expect(Number(await page.locator("#loads").textContent())).toBe(1);

          const passivePrevented = await page
            .locator('iframe[name="primary"]')
            .evaluate((frame) => {
              const event = new Event("error", { cancelable: true });

              frame.dispatchEvent(event);

              return event.defaultPrevented;
            });

          expect(passivePrevented).toBe(false);

          expect(await page.locator("#status").textContent()).toBe("passive");

          await page
            .locator('iframe[name="primary"]')
            .evaluate((frame) => frame.dispatchEvent(new Event("load")));

          expect(Number(await page.locator("#loads").textContent())).toBe(1);

          await page.locator("#binding").click();

          expect(await page.locator("#status").textContent()).toBe("bound");

          await page.waitForFunction(
            () => Number(document.querySelector("#loads")?.textContent) > 0,
          );

          const before = await page.locator('iframe[name="primary"]').elementHandle();

          const wrapper = await page
            .locator('iframe[name="primary"]')
            .locator("..")
            .elementHandle();

          if (application.allowUnsafeEmbed) {
            await page.locator("#change").click();

            await page.waitForFunction(
              () =>
                document.querySelector('iframe[name="primary"]')?.getAttribute("sandbox") ===
                "allow-scripts allow-same-origin",
            );

            const after = await page.locator('iframe[name="primary"]').elementHandle();

            const currentWrapper = await page
              .locator('iframe[name="primary"]')
              .locator("..")
              .elementHandle();

            expect(await page.evaluate(([left, right]) => left === right, [before, after])).toBe(
              false,
            );

            expect(
              await page.evaluate(([left, right]) => left === right, [wrapper, currentWrapper]),
            ).toBe(true);

            const replacementFrame = page.frame({ name: "primary" });

            if (!replacementFrame)
              throw new Error("The replacement primary Embed browsing context was not found");

            await replacementFrame.waitForLoadState("load");

            expect(Number(await page.locator("#loads").textContent())).toBe(2);

            await page
              .locator('iframe[name="primary"]')
              .evaluate((frame) => frame.dispatchEvent(new Event("load")));

            expect(Number(await page.locator("#loads").textContent())).toBe(2);

            await page.locator("#binding").click();

            expect(await page.locator("#status").textContent()).toBe("bound");

            await page.locator("#unsafe").click();

            await page.locator('iframe[name="unsafe"]').waitFor();

            expect(await page.locator("#status").textContent()).toBe("mounted");
          } else {
            expect(await page.locator('iframe[name="primary"]').getAttribute("sandbox")).toBe(
              "allow-scripts",
            );

            await page.locator("#unsafe").click();

            await page.waitForFunction(() =>
              (document.querySelector("#status")?.textContent ?? "").includes("allowUnsafeEmbed"),
            );

            expect(await page.locator('iframe[name="unsafe"]').count()).toBe(0);

            await page.locator("#nested").click();

            await page.waitForFunction(() =>
              (document.querySelector("#status")?.textContent ?? "").includes("allowUnsafeEmbed"),
            );

            expect(await page.locator('iframe[name="nested"]').count()).toBe(0);
          }

          expect(errors).toStrictEqual([]);
        } catch (error) {
          throw new Error(`${application.name} ${name} installed Embed failed`, { cause: error });
        } finally {
          await browser.close();
        }
      }
    }
  } finally {
    for (const preview of previews) {
      preview.kill();

      await preview.exited;
    }

    await rm(workspace, { recursive: true, force: true });
  }
}, 180_000);
