import { expect, test } from "bun:test";
import { readPinnedAeoliaVersion, writePackageManifest } from "./package-manifest.ts";
import { suppliedReleaseArchive } from "./release-candidate.ts";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { chromium, firefox, webkit } from "playwright";

const packageRoot = resolve(import.meta.dir, "../..");

const applicationFixture = join(import.meta.dir, "fixtures/applications/assets");

test("packed packages render built-in asset views in all three browser engines", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "hesperia-installed-assets-"));

  const application = join(workspace, "application with spaces");

  let preview: ReturnType<typeof Bun.spawn> | undefined;

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

    await copyFixture("message.txt");

    await copyFixture("data.json");

    await copyFixture("logo.svg");

    await writeFile(join(application, "pixel.png"), new Uint8Array([0, 1, 2, 255]));

    const markupImageBytes = await readFile(
      resolve(packageRoot, "tests/browser/fixtures/imported-markup/src/assets/density-1.png"),
    );

    await writeFile(join(application, "src/markup-image.png"), markupImageBytes);

    await copyFixture("src/panel.html");

    await copyFixture("src/icon.svg");

    await copyFixture("hesperia.config.ts");

    await copyFixture("src/card.css");

    await copyFixture("src/Card.tsx");

    await copyFixture("src/routes/+page.tsx");

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

    for (const [name, engine] of Object.entries({ chromium, firefox, webkit })) {
      const browser = await engine.launch();

      try {
        const page = await browser.newPage();

        const errors: string[] = [];

        const imageResponses = new Map<
          string,
          { readonly status: number; readonly body: () => Promise<Buffer> }
        >();

        page.on("pageerror", (error) => errors.push(error.message));

        page.on("response", (response) => {
          if (response.request().resourceType() === "image")
            imageResponses.set(response.url(), {
              status: response.status(),
              body: () => response.body(),
            });
        });

        await page.goto(url);

        await page.locator("#load").waitFor();

        expect(await page.locator("#text").textContent()).toBe("asset text from packed app");

        expect(await page.locator("#json").textContent()).toBe("4:true");

        expect(await page.locator("#svg-text").textContent()).toBe('<svg viewBox="0 0 1 1"></svg>');

        expect(await page.locator("#svg-blob").textContent()).toBe("image/svg+xml:29");

        expect(await page.locator("#image").textContent()).toBe("image/png:4");

        expect(await page.locator("#packed-html-text").textContent()).toBe("HTML from packed app");

        expect(await page.locator("#packed-svg-text").textContent()).toBe("SVG from packed app");

        expect(await page.locator("#packed-svg-root").evaluate((node) => node.namespaceURI)).toBe(
          "http://www.w3.org/2000/svg",
        );

        const markupImage = page.locator("#packed-markup-image");

        await page.waitForFunction(() => {
          const image = document.querySelector("#packed-markup-image");

          return image instanceof HTMLImageElement && image.complete;
        });

        expect(
          await markupImage.evaluate((node) => (node as HTMLImageElement).naturalWidth),
        ).toBeGreaterThan(0);

        const markupImageURL = await markupImage.evaluate(
          (node) => (node as HTMLImageElement).currentSrc,
        );

        expect(new URL(markupImageURL).pathname).toMatch(/\/assets\/[^/]+\.png$/u);

        const markupImageResponse = imageResponses.get(markupImageURL);

        if (!markupImageResponse)
          throw new Error("The packed markup image request was not observed");

        expect(markupImageResponse.status).toBe(200);

        expect([...(await markupImageResponse.body())]).toStrictEqual([...markupImageBytes]);

        expect(await page.locator("#card").count()).toBe(0);

        const unloadedStyle = await page.evaluate(() => {
          const link = [
            ...document.head.querySelectorAll<HTMLLinkElement>("link[data-hesperia-style-id]"),
          ].find((candidate) => candidate.dataset.hesperiaStyleId === "css:src/card.css");

          return link && { media: link.sheet?.media.mediaText, url: new URL(link.href).pathname };
        });

        expect(unloadedStyle).toEqual({
          media: "not all",
          url: expect.stringContaining("/assets/"),
        });

        await page.locator("#toggle-card").click();

        await page.getByText("Styled Card", { exact: true }).waitFor();

        expect(await page.locator("#card").evaluate((node) => getComputedStyle(node).color)).toBe(
          "rgb(210, 30, 40)",
        );

        expect(
          await page.evaluate(
            () =>
              [
                ...document.head.querySelectorAll<HTMLLinkElement>("link[data-hesperia-style-id]"),
              ].find((candidate) => candidate.dataset.hesperiaStyleId === "css:src/card.css")?.sheet
                ?.media.mediaText,
          ),
        ).toBe("all");

        await page.locator("#toggle-card").click();

        expect(await page.locator("#card").count()).toBe(0);

        expect(
          await page.evaluate(
            () =>
              [
                ...document.head.querySelectorAll<HTMLLinkElement>("link[data-hesperia-style-id]"),
              ].find((candidate) => candidate.dataset.hesperiaStyleId === "css:src/card.css")?.sheet
                ?.media.mediaText,
          ),
        ).toBe("not all");

        await page.locator("#load").click();

        await page.getByText("4:image/png:0,1,2,255", { exact: true }).waitFor();

        expect(errors).toStrictEqual([]);
      } catch (error) {
        throw new Error(`${name} installed assets failed`, { cause: error });
      } finally {
        await browser.close();
      }
    }
  } finally {
    if (preview) {
      preview.kill();

      await preview.exited;
    }

    await rm(workspace, { recursive: true, force: true });
  }
}, 120_000);
