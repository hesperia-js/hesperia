import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const packageRoot = resolve(import.meta.dir, "../..");

test("packed packages serve a custom backend data flow in all three browser engines", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "hesperia-installed-"));
  const application = join(workspace, "application with spaces");
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
  let preview: ReturnType<typeof Bun.spawn> | undefined;
  try {
    await run(resolve(packageRoot, "../aeolia"), "run", "build");
    await run(
      resolve(packageRoot, "../aeolia"),
      "pm",
      "pack",
      "--destination",
      workspace,
      "--ignore-scripts",
      "--quiet",
    );
    await run(packageRoot, "pm", "pack", "--destination", workspace, "--ignore-scripts", "--quiet");
    await run(packageRoot, resolve(packageRoot, "dist/tooling/cli.js"), "init", application);
    const nestedRoute = join(application, "src/routes/deep/link");
    await mkdir(nestedRoute, { recursive: true });
    await writeFile(
      join(nestedRoute, "+page.tsx"),
      `import * as client from "hesperia/client";
import { api } from "../../../../api";
function Counter() {
  const count = client.state(0);
  return <button id="count" on:click={() => count.update(value => value + 1)}>Count: {count()}</button>;
}
export default function NestedPage() {
  const greeting = api.greeting("Hesperia");
  const rename = api.rename();
  return <main><span id="greeting">{greeting.value() ?? "Waiting"}</span><button id="rename" on:click={() => void rename.run({ name: "Hesperia", text: "Hello Aeolia" })}>Rename</button><Counter /></main>;
}`,
    );
    await writeFile(
      join(application, "api.ts"),
      `import { affects, createGraph, createMutation, createQuery, defineContract } from "aeolia";
import { withAeolia } from "hesperia/aeolia";
const greetings = new Map([["Hesperia", "Hello Hesperia"]]);
const greeting = createQuery({ name: "greeting", key: (name: string) => name, fetch: async (name) => greetings.get(name) ?? "Unknown greeting" });
const rename = createMutation({
  name: "greeting.rename",
  run: async ({ name, text }: { name: string; text: string }) => {
    greetings.set(name, text);
    return text;
  },
  affects: [affects(greeting, { select: ({ name }: { name: string; text: string }) => name, on: "revalidate" })],
});
const contract = defineContract({ namespace: "installed", operations: { greeting, rename } });
const graph = createGraph({ contract });
export const api = withAeolia(graph, contract);`,
    );
    const asyncRoute = join(application, "src/routes/users/[id]");
    await mkdir(asyncRoute, { recursive: true });
    await writeFile(
      join(asyncRoute, "+page.tsx"),
      `import type { Page } from "hesperia";
import { api } from "../../../../api";
export default async function Page(props: Page.Props) {
  const id: string = props.params.id;
  const greeting = await api.greeting(id);
  return <main><h1>User {id}</h1><p>{greeting().toUpperCase()}</p></main>;
}`,
    );
    const manifestPath = join(application, "package.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.dependencies = {
      hesperia: join(workspace, "hesperia-0.0.0.tgz").replaceAll("\\", "/"),
      aeolia: join(workspace, "aeolia-0.0.0.tgz").replaceAll("\\", "/"),
    };
    manifest.overrides = { aeolia: manifest.dependencies.aeolia };
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
    await run(application, "install", "--ignore-scripts");
    expect(await run(application, "run", "check")).toContain("Hesperia checking passed");
    expect(await run(application, "run", "build")).toContain("Built browser application");
    preview = Bun.spawn(
      [
        process.execPath,
        join(application, "node_modules/hesperia/dist/tooling/cli.js"),
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

    const browserTest = `
      import assert from "node:assert/strict";
      import { chromium, firefox, webkit } from ${JSON.stringify(pathToFileURL(join(packageRoot, "node_modules/playwright/index.mjs")).href)};
      const results = [];
      for (const [name, engine] of Object.entries({ chromium, firefox, webkit })) {
        const browser = await engine.launch();
        try {
          const page = await browser.newPage();
          const errors = [];
          page.on("pageerror", error => errors.push(error.message));
          for (const pathname of ["", "deep/link"]) {
          await page.goto(${JSON.stringify(url)} + pathname);
          const count = pathname ? page.locator("#count") : page.getByRole("button");
          await count.waitFor();
          let greetingHandle = null;
          if (pathname) {
            await page.getByText("Hello Hesperia", { exact: true }).waitFor();
            greetingHandle = await page.locator("#greeting").elementHandle();
          }
          assert.deepEqual(errors, [], await page.content());
          assert.equal(await count.textContent(), "Count: 0", await page.content());
          if (!pathname) {
            const result = await count.evaluate(button => {
              button.click();
              const first = button.textContent;
              button.click();
              return { first, second: button.textContent, same: document.querySelector("button") === button };
            });
            assert.deepEqual(result, { first: "Count: 1", second: "Count: 2", same: true });
          }
          if (pathname) {
            await page.locator("#rename").click();
            await page.getByText("Hello Aeolia", { exact: true }).waitFor();
            assert.equal(
              await greetingHandle?.evaluate(
                (node) => node.isConnected && document.querySelector("#greeting") === node,
              ),
              true,
            );
            await greetingHandle?.dispose();
          }
          assert.deepEqual(errors, []);
          }
          await page.goto(${JSON.stringify(url)} + "users/Hesperia");
          await page.getByRole("heading", { name: "User Hesperia" }).waitFor();
          await page.getByText("HELLO HESPERIA", { exact: true }).waitFor();
          assert.deepEqual(errors, []);
          results.push(name);
        } catch (error) {
          throw new Error(name + " installed application failed", { cause: error });
        } finally { await browser.close(); }
      }
      console.log(JSON.stringify(results));
    `;
    const browserProcess = Bun.spawn(["node", "--input-type=module", "--eval", browserTest], {
      cwd: application,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [browserStatus, browserOutput, browserErrors] = await Promise.all([
      browserProcess.exited,
      new Response(browserProcess.stdout).text(),
      new Response(browserProcess.stderr).text(),
    ]);
    if (browserStatus !== 0)
      throw new Error(`Installed browser application failed\n${browserOutput}\n${browserErrors}`);
    expect(JSON.parse(browserOutput.trim())).toStrictEqual(["chromium", "firefox", "webkit"]);
  } finally {
    if (preview) {
      preview.kill();
      await preview.exited;
    }
    await rm(workspace, { recursive: true, force: true });
  }
}, 120_000);
