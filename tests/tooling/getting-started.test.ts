import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { prepareBuild, ProjectError, writeBuild } from "../../packages/tooling/src/project.ts";
import { previewProject } from "../../packages/tooling/src/server.ts";

test("getting-started files build and restore page head content with cached navigation", async () => {
  const guide = await Bun.file(resolve(import.meta.dir, "../../docs/getting-started.md")).text();
  const parent = resolve(import.meta.dir, "../../.hesperia");

  await mkdir(parent, { recursive: true });

  const root = await mkdtemp(join(parent, "getting-started-"));
  let server: Awaited<ReturnType<typeof previewProject>> | undefined;

  try {
    const examples = [...guide.matchAll(/```tsx?\r?\n\/\/ ([^\r\n]+)\r?\n([\s\S]*?)```/gu)];

    expect(examples.map((match) => match[1])).toContain("app.tsx");

    expect(examples.map((match) => match[1])).toContain("app.config.ts");

    for (const match of examples) {
      const filename = join(root, match[1]!);

      await mkdir(dirname(filename), { recursive: true });

      await writeFile(filename, match[2]!);
    }

    const json = [...guide.matchAll(/```json\r?\n([\s\S]*?)```/gu)].map(
      (match) => JSON.parse(match[1]!) as Record<string, unknown>,
    );

    await writeFile(
      join(root, "tsconfig.json"),
      JSON.stringify(json.find((value) => "compilerOptions" in value)),
    );

    await writeFile(
      join(root, "hesperia.config.json"),
      JSON.stringify(json.find((value) => "allowUnsafeHTML" in value)),
    );

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
          await page.goto(${JSON.stringify(server.url.href)});
          await page.getByRole("heading", { name: "Home", exact: true }).waitFor();
          assert.equal(await page.title(), "My app");
          assert.equal(await page.locator("html").getAttribute("lang"), "en");
          assert.equal(await page.locator('meta[name="description"]').getAttribute("content"), "My Hesperia application");

          await page.getByRole("link", { name: "Todos", exact: true }).click();
          await page.waitForFunction(() => document.title === "Todos | My app");
          assert.equal(await page.locator('meta[name="description"]').getAttribute("content"), "Manage your tasks");
          const input = await page.getByRole("textbox", { name: "New task" }).elementHandle();
          await input.fill("Retained draft");
          const layout = await page.getByRole("region", { name: "Todo workspace" }).elementHandle();
          await page.getByRole("link", { name: "Open task 123" }).click();
          await page.getByRole("heading", { name: "Task 123" }).waitFor();
          await page.waitForFunction(() => document.title === "My app");
          assert.equal(await page.locator('meta[name="description"]').getAttribute("content"), "My Hesperia application");
          assert.equal(await layout.evaluate(node => node === document.querySelector('[aria-label="Todo workspace"]')), true);
          assert.equal(await page.getByText("Tab: notes", { exact: true }).count(), 1);

          await page.goBack();
          await page.waitForFunction(() => document.title === "Todos | My app");
          assert.equal(await input.evaluate(node => node === document.querySelector('[aria-label="New task"]')), true);
          assert.equal(await input.inputValue(), "Retained draft");
          assert.equal(await page.locator('meta[name="description"]').getAttribute("content"), "Manage your tasks");
          await page.getByRole("link", { name: "Home", exact: true }).click();
          await page.waitForFunction(() => document.title === "My app");
          assert.equal(await page.locator('meta[name="description"]').getAttribute("content"), "My Hesperia application");

          await page.goto(${JSON.stringify(new URL("/old-todos", server.url).href)});
          await page.waitForFunction(() => location.pathname === "/todos" && document.title === "Todos | My app");
          await page.goto(${JSON.stringify(new URL("/missing", server.url).href)});
          await page.getByRole("heading", { name: "Page not found" }).waitFor();
          assert.deepEqual(errors, []);
          console.log(engine.name() + " getting started verified");
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

    if (status !== 0)
      throw new Error(`Getting-started browser checks failed\n${output}\n${errors}`);

    expect(output.trim().split(/\r?\n/u)).toStrictEqual([
      "chromium getting started verified",
      "firefox getting started verified",
      "webkit getting started verified",
    ]);
  } finally {
    await server?.close();

    await rm(root, { recursive: true, force: true });
  }
}, 60_000);
