import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { prepareBuild, ProjectError, writeBuild } from "../../src/tooling/project.ts";
import { previewProject } from "../../src/tooling/server.ts";

test("compiled async routes surface rejection, bubble fallback faults, and cancel stale work", async () => {
  const parent = resolve(import.meta.dir, "../../.hesperia");
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, "async-route-outcomes-"));
  let server: Awaited<ReturnType<typeof previewProject>> | undefined;
  try {
    const sources = {
      "app.tsx": `import type { Component, Rendered } from "hesperia";
import { waitForSlowCommit } from "./api";
Object.assign(globalThis, { routeOutcomeFixture: { waitForSlowCommit, waitingForSlow: false } });
export default function App(props: Component.Props<{ children: Rendered }>) {
  return <html><head><title>Async route outcomes</title></head><body><nav><a href="/">Home</a><a href="/reject">Reject</a><a href="/broken">Broken</a><a href="/slow">Slow</a><a href="/fast">Fast</a></nav>{props.children()}</body></html>;
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
const contract = defineContract({ namespace: "outcomes", operations: { message } });
const graph = createGraph({ contract });
export const api = withAeolia(graph, contract);
export function waitForSlowCommit() { return graph.api.message("slow").ready; }`,
      "src/routes/+layout.tsx": `import type { Component, Rendered } from "hesperia";
export default function Layout(props: Component.Props<{ children: Rendered }>) {
  return <section id="outcome-layout">{props.children()}</section>;
}`,
      "src/routes/+loading.tsx": `export default function Loading() { return <span id="loading">Loading</span>; }`,
      "src/routes/+error.tsx": `import type { Component } from "hesperia";
export default function RootError(props: Component.Props<{ error: unknown }>) {
  return <main id="root-error">{String(props.error())}</main>;
}`,
      "src/routes/+page.tsx": `export default function Home() { return <main id="home">Home</main>; }`,
      "src/routes/reject/+page.tsx": `import { api } from "../../../api";
export default async function Reject() {
  const message = await api.message("reject");
  return <main id="reject">{message().message}</main>;
}`,
      "src/routes/broken/+error.tsx": `import type { Component } from "hesperia";
export default function BrokenError(_props: Component.Props<{ error: unknown }>) {
  throw new Error("nested error fallback failed");
}`,
      "src/routes/broken/+page.tsx": `import { api } from "../../../api";
export default async function Broken() {
  const message = await api.message("broken");
  return <main id="broken">{message().message}</main>;
}`,
      "src/routes/slow/+page.tsx": `import { api } from "../../../api";
export default async function Slow() {
  const message = await api.message("slow");
  return <main id="slow">{message().message}</main>;
}`,
      "src/routes/fast/+page.tsx": `export default function Fast() { return <main id="fast">Fast</main>; }`,
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
          page.on("pageerror", error => errors.push(error.stack ?? error.message));
          const requests = {};
          const waiting = {};
          for (const name of ["reject", "broken", "slow"]) {
            waiting[name] = new Promise(resolve => requests[name] = resolve);
          }
          await page.route("**/api/message/**", route => {
            const name = new URL(route.request().url()).pathname.split("/").pop();
            if (name in requests) return requests[name](route);
            return route.continue();
          });
          await page.goto(${JSON.stringify(server.url.href)});

          await page.getByRole("link", { name: "Reject" }).click();
          const reject = await waiting.reject;
          await page.locator("#loading").waitFor();
          await reject.fulfill({ status: 500, contentType: "text/plain", body: "reject backend failed" });
          await page.waitForFunction(() =>
            document.querySelector("#root-error")?.textContent?.includes("reject backend failed"),
          );
          assert.equal(await page.locator("#reject").count(), 0);

          await page.getByRole("link", { name: "Broken" }).click();
          const broken = await waiting.broken;
          await page.locator("#loading").waitFor();
          await broken.fulfill({ status: 500, contentType: "text/plain", body: "broken backend failed" });
          await page.waitForFunction(() =>
            document.querySelector("#root-error")?.textContent?.includes("nested error fallback failed"),
          );
          assert.equal((await page.locator("#root-error").textContent()).includes("nested error fallback failed"), true);
          assert.equal(await page.locator("#broken").count(), 0);

          await page.getByRole("link", { name: "Home" }).click();
          await page.locator("#home").waitFor();
          await page.getByRole("link", { name: "Slow" }).click();
          const slow = await waiting.slow;
          await page.locator("#loading").waitFor();
          await page.getByRole("link", { name: "Fast" }).click();
          await page.locator("#fast").waitFor();
          assert.equal(new URL(page.url()).pathname, "/fast");
          const committed = page.evaluate(() => {
            const pending = window.routeOutcomeFixture.waitForSlowCommit();
            window.routeOutcomeFixture.waitingForSlow = true;
            return pending;
          });
          await page.waitForFunction(() => window.routeOutcomeFixture.waitingForSlow);
          await slow.fulfill({ json: { message: "late slow result" } });
          assert.deepEqual(await committed, { message: "late slow result" });
          assert.equal(await page.locator("#slow").count(), 0);
          assert.equal(await page.title(), "Async route outcomes");

          assert.deepEqual(errors, []);
          console.log(engine.name() + " async outcomes verified");
        } catch (error) {
          throw new Error(engine.name() + " async outcome failed", { cause: error });
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
    if (status !== 0) throw new Error(`Generated async outcomes failed\n${output}\n${errors}`);
    expect(output.trim().split(/\r?\n/u)).toStrictEqual([
      "chromium async outcomes verified",
      "firefox async outcomes verified",
      "webkit async outcomes verified",
    ]);
  } finally {
    await server?.close();
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);
