import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { prepareBuild, ProjectError, writeBuild } from "../../src/tooling/project.ts";
import { previewProject } from "../../src/tooling/server.ts";

test("a browser build publishes both finite dynamic import targets and loads them lazily", async () => {
  const parent = resolve(import.meta.dir, "../../.hesperia");
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, "dynamic-import-app-"));
  let server: Awaited<ReturnType<typeof previewProject>> | undefined;
  try {
    await mkdir(join(root, "src/routes"), { recursive: true });
    await writeFile(
      join(root, "app.tsx"),
      `import { load } from "./src/loader.ts";
      import type { Component, Rendered } from "hesperia";
      Object.assign(globalThis, { loadFixture: load });
      export default function App(props: Component.Props<{ children: Rendered }>) { return <html><head/><body>{props.children()}</body></html>; }`,
    );
    await writeFile(
      join(root, "src/routes/+page.tsx"),
      "export default function Page() { return <main>Lazy imports</main>; }",
    );
    await writeFile(
      join(root, "src/loader.ts"),
      `export function load(first: boolean) {
      const name = first ? "first" : "second";
      return import("./" + name + ".ts");
    }`,
    );
    for (const name of ["first", "second"])
      await writeFile(
        join(root, `src/${name}.ts`),
        `Object.assign(globalThis, { dynamicLoaded_${name}: true }); export const value = "${name}";`,
      );
    try {
      await writeBuild(root, await prepareBuild(root));
    } catch (error) {
      if (error instanceof ProjectError)
        throw new Error(JSON.stringify(error.diagnostics), { cause: error });
      throw error;
    }
    server = await previewProject(root, 0);
    const script = `import assert from "node:assert/strict";
      import { chromium, firefox, webkit } from ${JSON.stringify(pathToFileURL(resolve(import.meta.dir, "../../node_modules/playwright/index.mjs")).href)};
      for (const engine of [chromium, firefox, webkit]) {
        const browser = await engine.launch();
        try {
          const page = await browser.newPage();
          await page.goto(${JSON.stringify(server.url.href)});
          await page.locator("main").waitFor();
          assert.deepEqual(await page.evaluate(() => [globalThis.dynamicLoaded_first ?? false, globalThis.dynamicLoaded_second ?? false]), [false, false]);
          const values = await page.evaluate(async () => {
            const first = await globalThis.loadFixture(true);
            const second = await globalThis.loadFixture(false);
            return [first.value, second.value, first === await globalThis.loadFixture(true)];
          });
          assert.deepEqual(values, ["first", "second", true]);
          assert.deepEqual(await page.evaluate(() => [globalThis.dynamicLoaded_first, globalThis.dynamicLoaded_second]), [true, true]);
          console.log(engine.name());
        } finally { await browser.close(); }
      }`;
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
      throw new Error(`Finite import browser execution failed\n${output}\n${errors}`);
    expect(output.trim().split(/\r?\n/)).toStrictEqual(["chromium", "firefox", "webkit"]);
  } finally {
    await server?.close();
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);
