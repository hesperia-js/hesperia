import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve, relative, isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import { devProject, type ProjectServer } from "../../src/tooling/server.ts";

test("development browsers forward authored unsafe warnings and reload fresh state after an edit", async () => {
  const parent = resolve(import.meta.dir, "../../.hesperia");
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, "development-browser-"));
  const cleanupRelative = relative(parent, resolve(root));
  if (
    isAbsolute(cleanupRelative) ||
    !cleanupRelative.startsWith("development-browser-") ||
    cleanupRelative.includes("/") ||
    cleanupRelative.includes("\\")
  )
    throw new Error("Invalid development fixture cleanup path");
  const reports: string[] = [];
  let server: ProjectServer | undefined;
  const pageSource = (version: string) => `import * as client from "hesperia/client";
export default function Page() {
  const count = client.state(0);
  const input = client.unsafeBind<HTMLInputElement>();
  return <main><span id="version">${version}</span><input bind={input} /><button id="count" on:click={() => count.update(value => value + 1)}>{count()}</button></main>;
}`;
  try {
    const route = join(root, "src/routes/nested/+page.tsx");
    await mkdir(resolve(route, ".."), { recursive: true });
    await writeFile(
      join(root, "app.tsx"),
      `import type { Component, Rendered } from "hesperia";
export default function App(props: Component.Props<{ children: Rendered }>) {
  return <html><head><title>Development browser</title></head><body>{props.children()}</body></html>;
}`,
    );
    await writeFile(route, pageSource("first"));
    await writeFile(
      join(root, "src/routes/+loading.tsx"),
      "export default function Loading() { return <span>Loading</span>; }",
    );
    server = await devProject(root, { port: 0, report: (message) => reports.push(message) });
    const script = `
      import assert from "node:assert/strict";
      import { writeFile } from "node:fs/promises";
      import { chromium, firefox, webkit } from ${JSON.stringify(pathToFileURL(resolve(import.meta.dir, "../../node_modules/playwright/index.mjs")).href)};
      const opened = [];
      try {
        for (const engine of [chromium, firefox, webkit]) {
          const browser = await engine.launch();
          const entry = { browser, name: engine.name(), errors: [] };
          opened.push(entry);
          const page = await browser.newPage();
          entry.page = page;
          page.on("pageerror", error => entry.errors.push(error.message));
          const warning = page.waitForEvent("console", { predicate: message => message.type() === "warning" && message.text().includes("unsafeBind") });
          const forwarded = page.waitForResponse(response => new URL(response.url()).pathname === "/__hesperia/warnings" && response.request().method() === "POST" && response.request().postData()?.includes("unsafeBind"));
          await page.goto(${JSON.stringify(new URL("/nested", server.url).href)});
          await page.waitForFunction(() => document.querySelector("#version")?.textContent === "first");
          assert.match((await warning).text(), /unsafeBind/);
          const response = await forwarded;
          assert.equal(response.status(), 204, "Development server accepted the browser warning");
          assert.match(response.request().postData() ?? "", /unsafeBind/);
          await page.locator("#count").click();
          assert.equal(await page.locator("#count").textContent(), "1");
          await page.evaluate(() => { globalThis.beforeReloadMarker = true; });
        }
        await writeFile(${JSON.stringify(route)}, ${JSON.stringify(pageSource("second"))});
        for (const entry of opened) {
          await entry.page.waitForFunction(() => document.querySelector("#version")?.textContent === "second", null, { timeout: 30000 });
          assert.equal(await entry.page.locator("#count").textContent(), "0", "Reload created fresh component state");
          assert.equal(await entry.page.evaluate(() => globalThis.beforeReloadMarker), undefined, "Reload created a new document environment");
          assert.equal(new URL(entry.page.url()).pathname, "/nested", "Reload retained the deep URL");
          assert.deepEqual(entry.errors, []);
          console.log(entry.name + " development warning and reload verified");
        }
      } finally {
        await Promise.all(opened.map(entry => entry.browser.close()));
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
    if (status !== 0)
      throw new Error(
        `Development browser flow failed\n${output}\n${errors}\nServer reports: ${JSON.stringify(reports)}`,
      );
    expect(output.trim().split(/\r?\n/u)).toStrictEqual([
      "chromium development warning and reload verified",
      "firefox development warning and reload verified",
      "webkit development warning and reload verified",
    ]);
    expect(
      reports.filter((message) => message.includes("unsafeBind")).length,
    ).toBeGreaterThanOrEqual(3);
    expect(reports.filter((message) => !message.includes("unsafeBind"))).toStrictEqual([]);
  } finally {
    await server?.close();
    await rm(root, { recursive: true, force: true });
  }
}, 90_000);
