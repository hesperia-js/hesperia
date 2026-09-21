import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { prepareBuild, ProjectError, writeBuild } from "../../src/tooling/project.ts";
import { previewProject } from "../../src/tooling/server.ts";

test("generated async routes wait for public query data and restore the cached native page", async () => {
  const parent = resolve(import.meta.dir, "../../.hesperia");
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, "application-routing-"));
  let server: Awaited<ReturnType<typeof previewProject>> | undefined;
  try {
    const sources = {
      "app.tsx": `import type { Component, Rendered } from "hesperia";
import { effect, cleanup } from "hesperia/client";
export default function App(props: Component.Props<{ children: Rendered }>) {
  const marker = <span id="shell-effects" data-runs="0"/>;
  effect(() => {
    marker.dataset.runs = String(Number(marker.dataset.runs) + 1);
  });
  cleanup(() => { marker.dataset.cleanup = "true"; });
  return <html><head><title>Routing fixture</title></head><body><input id="shell-draft"/>{marker}{props.children()}</body></html>;
}`,
      "api.ts": `import { createQuery, createGraph, defineContract } from "aeolia";
import { withAeolia } from "hesperia/aeolia";
const message = createQuery({
  name: "message",
  key: (id: string) => id,
  fetch: async (id, { abortSignal }) => {
    const response = await fetch("/api/message/" + id, { signal: abortSignal });
    if (!response.ok) throw new Error(await response.text());
    return await response.json() as { message: string };
  },
});
const contract = defineContract({ namespace: "routing", operations: { message } });
const graph = createGraph({ contract });
export const api = withAeolia(graph, contract);`,
      "src/routes/+layout.tsx": `import type { Component, Rendered } from "hesperia";
export default function Layout(props: Component.Props<{ children: Rendered }>) {
  return <section id="root-layout">{props.children()}</section>;
}`,
      "src/routes/+error.tsx": `import type { Component } from "hesperia";
export default function RootError(props: Component.Props<{ error: unknown }>) {
  return <main id="root-error">{String(props.error())}<a href="/">Home</a></main>;
}`,
      "src/routes/+page.tsx": `import { effect } from "hesperia/client";
export default function Home() {
  const marker = <span id="home-effects" data-runs="0"/>;
  effect(() => {
    marker.dataset.runs = String(Number(marker.dataset.runs) + 1);
    return () => { marker.dataset.cleanup = "true"; };
  });
  return <main><h1>Home</h1><input id="draft"/><a href="/slow">Slow page</a><a href="/broken">Broken page</a>{marker}</main>;
}`,
      "src/routes/+loading.tsx": `export default function Loading() {
  return <span id="loading">Loading destination</span>;
}`,
      "src/routes/slow/+page.tsx": `import { api } from "../../../api";
export default async function Slow() {
  const message = await api.message("one");
  return <main id="ready"><h1>{message().message}</h1><a href="/">Home</a></main>;
}`,
      "src/routes/broken/+layout.tsx": `import type { Component, Rendered } from "hesperia";
export default function BrokenLayout(props: Component.Props<{ children: Rendered }>) {
  return <section id="broken-layout">{props.children()}</section>;
}`,
      "src/routes/broken/+error.tsx": `import type { Component } from "hesperia";
export default function BrokenError(_props: Component.Props<{ error: unknown }>) {
  throw new Error("nested fallback failed");
}`,
      "src/routes/broken/+page.tsx": `import { api } from "../../../api";
export default async function Broken() {
  const message = await api.message("broken");
  return <main id="broken">{message().message}</main>;
}`,
    };
    for (const [filename, source] of Object.entries(sources)) {
      const target = join(root, filename);
      await mkdir(resolve(target, ".."), { recursive: true });
      await writeFile(target, source);
    }
    try {
      await writeBuild(root, await prepareBuild(root));
    } catch (error) {
      if (error instanceof ProjectError)
        throw new Error(JSON.stringify(error.diagnostics, null, 2), { cause: error });
      throw error;
    }
    server = await previewProject(root, 0);
    const script = `
      import assert from "node:assert/strict";
      import { chromium, firefox, webkit } from ${JSON.stringify(pathToFileURL(resolve(import.meta.dir, "../../node_modules/playwright/index.mjs")).href)};
      for (const engine of [chromium, firefox, webkit]) {
        const browser = await engine.launch();
        try {
          const page = await browser.newPage();
          const errors = [];
          page.on("pageerror", error => errors.push(error.message));
          const requests = {};
          const waiting = {};
          for (const name of ["one", "broken"]) {
            waiting[name] = new Promise(resolve => requests[name] = resolve);
          }
          await page.route("**/api/message/**", route => {
            const name = new URL(route.request().url()).pathname.split("/").pop();
            if (name in requests) return requests[name](route);
            return route.continue();
          });
          await page.goto(${JSON.stringify(server.url.href)});
          const shell = await page.locator("#shell-draft").elementHandle();
          const layout = await page.locator("#root-layout").elementHandle();
          if (!shell || !layout) throw new Error("Initial shell is missing");
          await page.locator("#draft").fill("Keep this draft");
          await page.evaluate(() => { globalThis.savedDraft = document.querySelector("#draft"); });
          await page.getByRole("link", { name: "Slow page" }).click();
          const request = await waiting.one;
          await page.locator("#loading").waitFor();
          assert.equal(new URL(page.url()).pathname, "/");
          assert.equal(await page.locator("#draft").count(), 0);
          assert.equal(await page.locator("#ready").count(), 0);
          assert.equal(await page.evaluate((node) => node === document.querySelector("#shell-draft"), shell), true);
          assert.equal(await page.evaluate((node) => node === document.querySelector("#root-layout"), layout), true);
          await request.fulfill({ json: { message: "Query finished" } });
          await page.locator("#ready").waitFor();
          await page.waitForURL("**/slow");
          assert.equal(await page.locator("#ready h1").textContent(), "Query finished");
          assert.equal(await page.locator("#loading").count(), 0);
          await page.evaluate(() => history.back());
          await page.locator("#draft").waitFor();
          await page.waitForURL(${JSON.stringify(server.url.href)});
          assert.equal(await page.locator("#draft").inputValue(), "Keep this draft");
          assert.equal(await page.evaluate(() => document.querySelector("#draft") === globalThis.savedDraft), true);
          assert.equal(await page.evaluate((node) => node === document.querySelector("#shell-draft"), shell), true);
          assert.equal(await page.evaluate((node) => node === document.querySelector("#root-layout"), layout), true);
          assert.equal(await page.locator("#home-effects").getAttribute("data-cleanup"), "true");
          assert.equal(Number(await page.locator("#home-effects").getAttribute("data-runs")) >= 2, true);
          await page.getByRole("link", { name: "Broken page" }).click();
          const broken = await waiting.broken;
          await page.locator("#loading").waitFor();
          await broken.fulfill({ status: 500, contentType: "text/plain", body: "broken backend failed" });
          await page.locator("#root-error").waitFor();
          assert.equal((await page.locator("#root-error").textContent()).includes("nested fallback failed"), true);
          assert.equal(await page.evaluate((node) => node === document.querySelector("#shell-draft"), shell), true);
          await page.getByRole("link", { name: "Home" }).click();
          await page.locator("#draft").waitFor();
          assert.equal(await page.evaluate((node) => node === document.querySelector("#shell-draft"), shell), true);
          assert.deepEqual(errors, []);
          console.log(engine.name() + " async routing verified");
        } catch (error) {
          throw new Error(engine.name() + " generated routing failed", { cause: error });
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
    if (status !== 0) throw new Error(`Generated route application failed\n${output}\n${errors}`);
    expect(output.trim().split(/\r?\n/u)).toStrictEqual([
      "chromium async routing verified",
      "firefox async routing verified",
      "webkit async routing verified",
    ]);
  } finally {
    await server?.close();
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);
