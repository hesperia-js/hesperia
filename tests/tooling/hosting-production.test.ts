import { afterEach, expect, test } from "bun:test";
import { chromium } from "playwright";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareBuild, writeBuild } from "../../packages/tooling/src/project.ts";
import { previewProject, type ProjectServer } from "../../packages/tooling/src/server.ts";
import { linkFrameworkPackages, unlinkFrameworkPackages } from "./fixture-dependencies.ts";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await unlinkFrameworkPackages(root);

    await rm(root, { recursive: true, force: true });
  }
});

function sha256(bytes: Uint8Array): string {
  return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}

test("one production build serves root and nested hosts without changing its assets", async () => {
  const root = await mkdtemp(join(tmpdir(), "hesperia-hosting-production-"));

  roots.push(root);

  await linkFrameworkPackages(root);

  await mkdir(join(root, "src", "routes", "early"), { recursive: true });

  await writeFile(join(root, "hesperia.config.json"), JSON.stringify({ mountURL: "/dashboard" }));

  await writeFile(
    join(root, "app.tsx"),
    await readFile(join(import.meta.dir, "fixtures/applications/production-host/app.tsx"), "utf8"),
  );

  await writeFile(
    join(root, "app.css"),
    await readFile(join(import.meta.dir, "fixtures/applications/production-host/app.css"), "utf8"),
  );

  await writeFile(
    join(root, "src/routes/+route.ts"),
    await readFile(
      join(import.meta.dir, "fixtures/applications/production-host/src/routes/+route.ts"),
      "utf8",
    ),
  );

  await writeFile(
    join(root, "src/routes/+page.tsx"),
    await readFile(
      join(import.meta.dir, "fixtures/applications/production-host/src/routes/+page.tsx"),
      "utf8",
    ),
  );

  await writeFile(
    join(root, "src/routes/home.css"),
    await readFile(
      join(import.meta.dir, "fixtures/applications/production-host/src/routes/home.css"),
      "utf8",
    ),
  );

  await writeFile(
    join(root, "src/routes/early/+page.tsx"),
    await readFile(
      join(import.meta.dir, "fixtures/applications/production-host/src/routes/early/+page.tsx"),
      "utf8",
    ),
  );

  await writeFile(
    join(root, "src/routes/early/early.css"),
    await readFile(
      join(import.meta.dir, "fixtures/applications/production-host/src/routes/early/early.css"),
      "utf8",
    ),
  );

  const build = await prepareBuild(root).catch((error: unknown) => {
    if (typeof error === "object" && error !== null && "diagnostics" in error)
      throw new Error(
        `Mounted production fixture diagnostics: ${JSON.stringify(error.diagnostics)}`,
        { cause: error },
      );

    throw error;
  });

  expect(build.diagnostics).toStrictEqual([]);

  expect(build.hosting.standaloneMountURL).toBe("/dashboard");

  await writeBuild(root, build);

  const record = JSON.parse(
    await readFile(join(root, ".hesperia", "build", "hesperia-build.json"), "utf8"),
  ) as {
    readonly routeGuards: Readonly<Record<string, string>>;
    readonly routeTable: string;
    readonly hosting: typeof build.hosting;
  };

  expect(record.hosting).toStrictEqual(build.hosting);

  const stylesheetAssets = build.hosting.assets.filter((asset) =>
    asset.contentType.startsWith("text/css"),
  );

  expect(stylesheetAssets.length).toBeGreaterThanOrEqual(2);

  const guardPath = record.routeGuards["src/routes/+route.ts"];

  expect(guardPath).toMatch(/^\/assets\/routes\/guard-.*\.js$/u);

  const routeTable = await build.files.get(record.routeTable)!.text();

  expect(routeTable).toContain('import("./routes/guard-');

  expect(routeTable).not.toContain('import("/assets/routes/guard-');

  const emittedJavaScript = (
    await Promise.all(
      [...build.files].filter(([path]) => path.endsWith(".js")).map(([, file]) => file.text()),
    )
  ).join("\n");

  expect(emittedJavaScript).not.toContain("SERVER_ROUTE_MARKER");

  let rootServer: ProjectServer | undefined;

  let dashboardServer: ProjectServer | undefined;

  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;

  try {
    rootServer = await previewProject(root, 0, { mountURL: "/" });

    dashboardServer = await previewProject(root, 0, { mountURL: "/dashboard" });

    const mounts = [
      { name: "root", server: rootServer, mount: "", path: "/early" },
      {
        name: "dashboard",
        server: dashboardServer,
        mount: "/dashboard",
        path: "/dashboard/early",
      },
    ];

    for (const fixture of mounts) {
      const assetBase = fixture.mount + "/_hesperia";

      const document = await fetch(new URL(fixture.path, fixture.server.url), {
        headers: { accept: "text/html" },
      });

      expect(document.status).toBe(200);

      expect(await document.text()).toContain(
        '<script type="module" src="' + assetBase + '/startup.js">',
      );

      const wrapper = await fetch(new URL(assetBase + "/startup.js", fixture.server.url));

      expect(await wrapper.text()).toContain('await start("' + (fixture.mount || "/") + '")');

      for (const asset of build.hosting.assets) {
        const response = await fetch(new URL(assetBase + asset.path, fixture.server.url));

        expect(response.status).toBe(200);

        expect(response.headers.get("content-type")).toBe(asset.contentType);

        expect(sha256(new Uint8Array(await response.arrayBuffer()))).toBe(asset.sha256);
      }

      for (const asset of build.hosting.assets.filter((item) =>
        item.contentType.startsWith("text/javascript"),
      )) {
        const source = await build.files.get(asset.path)!.text();

        const moduleUrl = new URL(assetBase + asset.path, fixture.server.url);

        const specifiers = [
          ...source.matchAll(/(?:\bfrom\s*|\bimport\s*(?:\(\s*)?)["'](\.{1,2}\/[^"']+)["']/gu),
        ].map((match) => match[1]!);

        for (const specifier of specifiers) {
          const importedUrl = new URL(specifier, moduleUrl);

          expect(importedUrl.pathname.startsWith(assetBase + "/assets/")).toBe(true);

          expect(importedUrl.pathname).not.toContain("/assets/assets/");

          expect((await fetch(importedUrl)).status).toBe(200);
        }
      }

      expect(
        (await fetch(new URL(assetBase + "/assets/missing.js", fixture.server.url))).status,
      ).toBe(404);

      for (const path of ["/hesperia-build.json", "/src/routes/+route.ts", "/package.json"]) {
        const response = await fetch(new URL(path, fixture.server.url), {
          headers: { accept: "application/json" },
        });

        expect(response.status).toBe(404);
      }

      if (fixture.mount) {
        for (const path of [
          "/hesperia-build.json",
          "/src/routes/+route.ts",
          "/package.json",
          "/.hesperia/build/hesperia-build.json",
        ]) {
          const response = await fetch(new URL(fixture.mount + path, fixture.server.url), {
            headers: { accept: "application/json" },
          });

          expect(response.status).toBe(404);
        }
      }
    }

    const guardPath = record.routeGuards["src/routes/+route.ts"]!;

    const guardAsset = build.hosting.assets.find((asset) => asset.path === guardPath)!;

    expect(guardAsset).toBeDefined();

    for (const fixture of mounts) {
      const response = await fetch(
        new URL(fixture.mount + "/_hesperia" + guardPath, fixture.server.url),
      );

      expect(response.status).toBe(200);

      expect(await response.text()).not.toContain("SERVER_ROUTE_MARKER");
    }

    const earlyStyle = stylesheetAssets.find((asset) => asset.path.includes("early"));

    expect(earlyStyle).toBeDefined();

    browser = await chromium.launch();

    for (const fixture of mounts) {
      const page = await browser.newPage();

      const errors: string[] = [];

      const requests: string[] = [];

      const responses: { path: string; status: number }[] = [];

      const failedRequests: { path: string; failure: string | undefined }[] = [];

      page.on("pageerror", (error) => errors.push(error.message));

      page.on("console", (message) => {
        if (message.type() === "error") errors.push(`console: ${message.text()}`);
      });

      page.on("request", (request) => requests.push(new URL(request.url()).pathname));

      page.on("requestfailed", (request) =>
        failedRequests.push({
          path: new URL(request.url()).pathname,
          failure: request.failure()?.errorText,
        }),
      );

      page.on("response", (response) =>
        responses.push({ path: new URL(response.url()).pathname, status: response.status() }),
      );

      await page.addInitScript(() => {
        const observed = window as unknown as {
          __r13FirstRender?: { color: string; sheets: { href: string; ready: boolean }[] };
        };

        const observer = new MutationObserver(() => {
          if (observed.__r13FirstRender || !document.querySelector(".early-proof")) return;

          const sheets = [...document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')];

          observed.__r13FirstRender = {
            color: getComputedStyle(document.querySelector(".early-proof")!).color,
            sheets: sheets.map((link) => ({ href: link.href, ready: Boolean(link.sheet) })),
          };
        });

        observer.observe(document, { childList: true, subtree: true });
      });

      await page
        .goto(new URL(fixture.path, fixture.server.url).href, {
          waitUntil: "domcontentloaded",
          timeout: 5_000,
        })
        .catch(async (error: unknown) => {
          throw new Error(
            `Document did not load at ${fixture.path}; page URL: ${page.url()}; page errors: ${JSON.stringify(errors)}; failed requests: ${JSON.stringify(failedRequests)}; responses: ${JSON.stringify(responses)}; body: ${await page.locator("body").innerText().catch(String)}`,
            { cause: error },
          );
        });

      await page
        .waitForFunction(
          () => document.querySelector(".early-proof")?.textContent === "R13 early route",
          null,
          { timeout: 10_000 },
        )
        .catch(async (error: unknown) => {
          throw new Error(
            `Mounted route did not render at ${fixture.path}; page URL: ${page.url()}; page errors: ${JSON.stringify(errors)}; failed requests: ${JSON.stringify(failedRequests)}; responses: ${JSON.stringify(responses)}; body: ${await page.locator("body").innerText().catch(String)}`,
            { cause: error },
          );
        });

      expect(new URL(page.url()).pathname).toBe(fixture.path);

      expect(
        await page.locator(".early-proof").evaluate((node) => getComputedStyle(node).color),
      ).toBe("rgb(17, 34, 51)");

      const firstRender = await page.evaluate(
        () =>
          (
            window as unknown as {
              __r13FirstRender?: { color: string; sheets: { href: string; ready: boolean }[] };
            }
          ).__r13FirstRender,
      );

      expect(firstRender?.color).toBe("rgb(17, 34, 51)");

      expect(
        firstRender?.sheets.some(
          (sheet) => sheet.href.includes(earlyStyle!.path.slice(1)) && sheet.ready,
        ),
      ).toBe(true);

      expect(
        requests.some(
          (path) => path.includes("/_hesperia/assets/routes/guard-") && path.endsWith(".js"),
        ),
      ).toBe(true);

      expect(
        requests.some((path) => path.includes("/_hesperia/assets/") && path.endsWith(".css")),
      ).toBe(true);

      expect(errors).toStrictEqual([]);

      await page.close();
    }
  } finally {
    await browser?.close();

    await dashboardServer?.close();

    await rootServer?.close();
  }
}, 45_000);
