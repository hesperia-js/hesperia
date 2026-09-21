import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { matchRoute, type RouteManifest, type RouteNode } from "../../src/routing/manifest.ts";
import { createRouteTable, type RouteTable } from "../../src/tooling/route-table.ts";
import { prepareBuild, writeBuild } from "../../src/tooling/project.ts";
import { previewProject } from "../../src/tooling/server.ts";

const temporaryRoots: string[] = [];
afterEach(async () => {
  for (const root of temporaryRoots.splice(0)) await rm(root, { recursive: true, force: true });
});

test("the generated route table preserves scanner ancestry and lazy role defaults", async () => {
  const root = "/project/src";
  const page = `${root}/routes/+page.tsx`;
  const childPage = `${root}/routes/[id]/+page.tsx`;
  const route = `${root}/routes/+route.ts`;
  const child: RouteNode = {
    id: "/[id]",
    pattern: "/[id]",
    segments: [{ kind: "param", value: "id" }],
    files: { page: childPage },
    children: [],
  };
  const rootNode: RouteNode = {
    id: "/",
    pattern: "/",
    segments: [],
    files: {
      page,
      layout: `${root}/routes/+layout.tsx`,
      loading: `${root}/routes/+loading.tsx`,
      error: `${root}/routes/+error.tsx`,
      notFound: `${root}/routes/+not-found.tsx`,
      route,
    },
    children: [child],
  };
  const manifest: RouteManifest = { root: rootNode, routes: [rootNode, child] };
  const source = createRouteTable({
    manifest,
    root,
    guardUrls: new Map([[route, "/assets/routes/guard-root.js"]]),
  });
  const moduleUrls = new Map(
    [...source.modules].map(([specifier, filename]) => [
      specifier,
      `data:text/javascript;base64,${Buffer.from(`export default ${JSON.stringify(filename)};`).toString("base64")}`,
    ]),
  );
  const guardModuleUrl = `data:text/javascript;base64,${Buffer.from("export default () => true;").toString("base64")}`;
  const executable = source.code
    .replaceAll(/"hesperia-route-module:\d+"/gu, (specifier) =>
      JSON.stringify(moduleUrls.get(JSON.parse(specifier))),
    )
    .replace('import("/assets/routes/guard-root.js")', `import(${JSON.stringify(guardModuleUrl)})`);
  const tableModule = await import(
    `data:text/javascript;base64,${Buffer.from(executable).toString("base64")}`
  );
  const table = tableModule.default as RouteTable;

  expect(table.root).toBe(table.routes[0]!);
  expect(
    matchRoute(table as unknown as RouteManifest, new URL("https://example.test/42"))!.chain.map(
      (node) => node.id,
    ),
  ).toStrictEqual([table.root.id, table.root.children[0]!.id]);
  expect(table.root.files).toMatchObject({
    page: { filename: "routes/+page.tsx" },
    layout: { filename: "routes/+layout.tsx" },
    loading: { filename: "routes/+loading.tsx" },
    error: { filename: "routes/+error.tsx" },
    notFound: { filename: "routes/+not-found.tsx" },
    guard: { filename: "/assets/routes/guard-root.js" },
  });
  expect(await table.root.files.page!.load()).toBe(resolve(page));
  expect(await table.root.files.layout!.load()).toBe(resolve(`${root}/routes/+layout.tsx`));
  const guard = (await table.root.files.guard!.load()) as { default: () => boolean };
  expect(guard.default()).toBe(true);
  expect(await table.root.files.guard!.load()).toBe(guard);
  expect(source.code).not.toContain("+route.ts");
});

test("a real split build leaves the route page cold and mounts it through the built entry runtime", async () => {
  const marker = globalThis as { routePageLoaded?: boolean };
  const startupMarker = globalThis as { startupHistoryReady?: boolean };
  const previousMarker = marker.routePageLoaded;
  const previousStartupMarker = startupMarker.startupHistoryReady;
  try {
    const parent = resolve(import.meta.dir, "../../.hesperia");
    await mkdir(parent, { recursive: true });
    const root = await mkdtemp(join(parent, "route-table-runtime-"));
    temporaryRoots.push(root);
    await mkdir(join(root, "src/routes"), { recursive: true });
    await writeFile(
      join(root, "app.tsx"),
      "const historyState = window.history.state as { __hesperiaHistory?: unknown }; Object.assign(globalThis, { startupHistoryReady: historyState.__hesperiaHistory !== undefined }); export default function App(props: { children: () => unknown }) { return <html><head><title>Startup fixture</title></head><body>{props.children()}</body></html>; }",
    );
    await writeFile(
      join(root, "src/route-marker.ts"),
      "export function mark() { (globalThis as { routePageLoaded?: boolean }).routePageLoaded = true; return true; }",
    );
    await writeFile(
      join(root, "src/routes/+page.tsx"),
      'import { mark } from "../route-marker.ts"; import * as client from "hesperia/client"; export const loaded = mark(); export default function Page() { const count = client.state(0); return <button on:click={() => count.update(value => value + 1)}>{count()}</button>; }',
    );
    await writeFile(
      join(root, "src/routes/+route.ts"),
      'import { route } from "hesperia/routing"; const guard = () => true; export default route({ guard, load: () => "route-server-marker" });',
    );

    const build = await prepareBuild(root);
    await writeBuild(root, build);
    const metadata = JSON.parse(
      await readFile(join(root, ".hesperia/build/hesperia-build.json"), "utf8"),
    ) as { routeTable: string };
    const html = await readFile(join(root, ".hesperia/build/index.html"), "utf8");
    const mainUrl = html.match(/src="(\/assets\/main-[^"]+\.js)"/u)?.[1];
    expect(mainUrl).toBeDefined();
    const importAsset = (url: string) =>
      import(pathToFileURL(join(root, ".hesperia/build", url.slice(1))).href);
    const tableModule = await importAsset(metadata.routeTable);
    expect(tableModule.default).toBeDefined();
    expect(marker.routePageLoaded).toBeUndefined();
    expect(startupMarker.startupHistoryReady).toBeUndefined();
    const server = await previewProject(root, 0);
    try {
      const script = `
        import assert from "node:assert/strict";
        import { chromium, firefox, webkit } from ${JSON.stringify(pathToFileURL(resolve(import.meta.dir, "../../node_modules/playwright/index.mjs")).href)};
        for (const engine of [chromium, firefox, webkit]) {
          const browser = await engine.launch();
          try {
          const page = await browser.newPage();
          const errors = [];
          page.on("pageerror", error => errors.push(String(error)));
          await page.goto(${JSON.stringify(server.url.href)});
          await page.waitForFunction(() => document.querySelector("button")?.textContent === "0", null, { timeout: 10000 });
          await page.waitForFunction(() => document.querySelector('[role="status"]')?.textContent === "Startup fixture", null, { timeout: 10000 });
          assert.equal(await page.locator('[role="status"]').getAttribute("aria-live"), "polite");
          assert.equal(await page.evaluate(() => globalThis.startupHistoryReady), true);
          assert.equal(await page.evaluate(() => globalThis.routePageLoaded), true);
          assert.equal(await page.evaluate(() => {
            const button = document.querySelector("button");
            button.click();
            return button.textContent === "1" && document.querySelector("button") === button;
          }), true);
          assert.deepEqual(errors, []);
          console.log(engine.name() + " startup verified");
          } catch (error) {
            throw new Error(engine.name() + " generated startup failed", { cause: error });
          } finally { await browser.close(); }
        }
      `;
      const child = Bun.spawn(["node", "--input-type=module", "--eval", script], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const [status, output, errors] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      if (status !== 0) throw new Error(`Generated startup failed\n${errors}`);
      expect(output.trim().split(/\r?\n/u)).toStrictEqual([
        "chromium startup verified",
        "firefox startup verified",
        "webkit startup verified",
      ]);
    } finally {
      await server.close();
    }

    const guardPath = [...build.files.keys()].find(
      (path) => path.endsWith(".js") && path.includes("/assets/routes/guard-"),
    );
    expect(guardPath).toBeDefined();
    const javascript = await Promise.all(
      [...build.files.entries()]
        .filter(([path]) => path.endsWith(".js"))
        .map(([, file]) => file.text()),
    );
    expect(javascript.join("\n")).not.toContain("route-server-marker");
    const guardMap = await build.files.get(`${guardPath}.map`)!.text();
    expect(guardMap).not.toContain("route-server-marker");
    expect(guardMap).not.toContain("sourcesContent");
  } finally {
    if (previousMarker === undefined) delete marker.routePageLoaded;
    else marker.routePageLoaded = previousMarker;
    if (previousStartupMarker === undefined) delete startupMarker.startupHistoryReady;
    else startupMarker.startupHistoryReady = previousStartupMarker;
  }
}, 30000);
