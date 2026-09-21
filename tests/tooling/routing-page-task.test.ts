import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { prepareBuild, writeBuild } from "../../src/tooling/project.ts";
import { previewProject } from "../../src/tooling/server.ts";

test("a parked page task updates active shared data and eviction cancels it", async () => {
  const parent = resolve(import.meta.dir, "../../.hesperia");
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, "routing-page-task-"));
  let server: Awaited<ReturnType<typeof previewProject>> | undefined;
  try {
    const sources: Record<string, string> = {
      "app.config.ts": `import type { AppConfiguration } from "hesperia";
export default { pageCacheSize: 1 } satisfies AppConfiguration;`,
      "app.tsx": `import type { Component, Rendered } from "hesperia";
import { api } from "./api";

Object.assign(globalThis, { pageTaskFixture: { started: 0, releases: 0, aborts: 0, release: undefined } });

export default function App(props: Component.Props<{ children: Rendered }>) {
  const shared = api.shared();
  return <html><head><title>Page task</title></head><body>
    <output id="shell-shared">{shared()}</output>
    {props.children()}
  </body></html>;
}`,
      "api.ts": `import { createGraph, createStore, defineContract } from "aeolia";
import { withAeolia } from "hesperia/aeolia";

const shared = createStore({ name: "page-task.shared", initial: "initial" });
const contract = defineContract({ namespace: "page-task", operations: { shared } });
const graph = createGraph({ contract });
export const api = withAeolia(graph, contract);`,
      "src/routes/+page.tsx": `import { api } from "../../api";
import { client } from "hesperia";

type TaskFixture = {
  started: number;
  releases: number;
  aborts: number;
  release?: (() => void) | undefined;
};

export default function TaskPage() {
  const shared = api.shared();
  const fixture = globalThis as unknown as { pageTaskFixture: TaskFixture };
  const task = client.task<void, string>(({ signal }) => () => new Promise<string>((resolve) => {
    fixture.pageTaskFixture.started += 1;
    const release = () => {
      fixture.pageTaskFixture.releases += 1;
      fixture.pageTaskFixture.release = undefined;
      shared.set("settled");
      resolve("done");
    };
    fixture.pageTaskFixture.release = release;
    signal.addEventListener("abort", () => {
      fixture.pageTaskFixture.aborts += 1;
      fixture.pageTaskFixture.release = undefined;
    }, { once: true });
  }));
  const marker = <span id="task-effect" data-runs="0" data-value="" />;
  client.effect(() => {
    marker.dataset.value = shared();
    marker.dataset.runs = String(Number(marker.dataset.runs) + 1);
  });
  return <main id="task">
    <button id="start" on:click={() => { void task.run(); }}>Start</button>
    <a id="task-other" href="/other">Other</a>
    <output id="task-status">{task.status()}</output>
    {marker}
  </main>;
}`,
      "src/routes/other/+page.tsx": `export default function Other() {
  return <main id="other"><button id="back" on:click={() => history.back()}>Back</button><a id="other-evict" href="/evict">Evict</a></main>;
}`,
      "src/routes/evict/+page.tsx": `export default function Evicted() { return <main id="evict">Evicted</main>; }`,
    };
    for (const [filename, source] of Object.entries(sources)) {
      const target = join(root, filename);
      await mkdir(resolve(target, ".."), { recursive: true });
      await writeFile(target, source);
    }

    await writeBuild(root, await prepareBuild(root));
    server = await previewProject(root, 0);
    const script = `
      import assert from "node:assert/strict";
      import { chromium, firefox, webkit } from ${JSON.stringify(pathToFileURL(resolve(import.meta.dir, "../../node_modules/playwright/index.mjs")).href)};
      for (const engine of [chromium, firefox, webkit]) {
        const browser = await engine.launch();
        try {
          const page = await browser.newPage();
          await page.goto(${JSON.stringify(server.url.href)});
          await page.locator("#task").waitFor();
          await page.locator("#task-effect").waitFor({ state: "attached" });
          assert.equal(await page.locator("#shell-shared").textContent(), "initial");
          assert.equal(await page.locator("#task-effect").getAttribute("data-runs"), "1");
          assert.equal(await page.locator("#task-effect").getAttribute("data-value"), "initial");

          const parkedTask = await page.locator("#task").elementHandle();
          const parkedEffect = await page.locator("#task-effect").elementHandle();
          if (!parkedTask || !parkedEffect) throw new Error("Task page handles are missing");
          await page.locator("#start").click();
          await page.waitForFunction(() => {
            const fixture = globalThis.pageTaskFixture;
            return fixture.started === 1 && document.querySelector("#task-status")?.textContent === "pending";
          });
          await page.locator("#task-other").click();
          await page.locator("#other").waitFor();
          assert.equal(await parkedTask.evaluate((node) => node.isConnected), false);

          await page.evaluate(() => {
            const fixture = globalThis.pageTaskFixture;
            if (!fixture.release) throw new Error("Page task release is missing while parked");
            fixture.release();
          });
          await page.waitForFunction(() => document.querySelector("#shell-shared")?.textContent === "settled");
          assert.equal(await parkedEffect.getAttribute("data-runs"), "1");
          assert.equal(await parkedEffect.getAttribute("data-value"), "initial");
          assert.deepEqual(
            await page.evaluate(() => ({
              releases: globalThis.pageTaskFixture.releases,
              aborts: globalThis.pageTaskFixture.aborts,
            })),
            { releases: 1, aborts: 0 },
          );

          await page.evaluate(() => history.back());
          await page.locator("#task").waitFor();
          assert.equal(await page.evaluate((node) => node === document.querySelector("#task"), parkedTask), true);
          assert.equal(await page.locator("#task-status").textContent(), "success");
          assert.equal(await page.locator("#task-effect").getAttribute("data-runs"), "2");
          assert.equal(await page.locator("#task-effect").getAttribute("data-value"), "settled");

          await page.locator("#start").click();
          await page.waitForFunction(() => {
            const fixture = globalThis.pageTaskFixture;
            return fixture.started === 2 && document.querySelector("#task-status")?.textContent === "pending";
          });
          const evictedTask = await page.locator("#task").elementHandle();
          if (!evictedTask) throw new Error("Second task page handle is missing");
          await page.locator("#task-other").click();
          await page.locator("#other").waitFor();
          await page.locator("#other-evict").click();
          await page.locator("#evict").waitFor();
          await page.waitForFunction(() => {
            const fixture = globalThis.pageTaskFixture;
            return fixture.started === 2 && fixture.releases === 1 && fixture.aborts === 1 && !fixture.release;
          });
          assert.equal(await evictedTask.evaluate((node) => node.isConnected), false);
          console.log(engine.name() + " parked task and eviction verified");
        } finally {
          await browser.close();
        }
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
    if (status !== 0) throw new Error(`Parked page task failed\n${output}\n${errors}`);
    expect(output.trim().split(/\r?\n/u)).toStrictEqual([
      "chromium parked task and eviction verified",
      "firefox parked task and eviction verified",
      "webkit parked task and eviction verified",
    ]);
  } finally {
    await server?.close();
    await rm(root, { recursive: true, force: true });
  }
}, 90_000);
