import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { devProject } from "../../packages/tooling/src/server.ts";
import { linkFrameworkPackages, unlinkFrameworkPackages } from "./fixture-dependencies.ts";

test("CSS-only edits preserve a live direct mount and failed edits retain the old sheet", async () => {
  const root = await mkdtemp(join(tmpdir(), "hesperia-css-development-"));
  const reports: string[] = [];
  let server: Awaited<ReturnType<typeof devProject>> | undefined;

  try {
    await linkFrameworkPackages(root);

    await mkdir(join(root, "src", "routes"), { recursive: true });

    const css = join(root, "src", "card.css");

    await writeFile(css, "#card { color: rgb(210, 30, 40); }");

    await writeFile(
      join(root, "src", "Card.tsx"),
      `import * as client from "hesperia/client";
import "./card.css";

type CssTaskFixture = {
  started: number;
  aborted: number;
  releases: number;
  release: (() => void) | undefined;
};

export function Card() {
  const result = client.state("pending");
  const task = client.task<void, string>(({ signal }) => () => new Promise<string>((resolve) => {
    const fixture = (globalThis as unknown as { cssTaskFixture: CssTaskFixture }).cssTaskFixture;
    fixture.started += 1;
    fixture.release = () => {
      fixture.releases += 1;
      fixture.release = undefined;
      resolve("CSS task completed");
    };
    signal.addEventListener("abort", () => {
      fixture.aborted += 1;
      fixture.release = undefined;
    }, { once: true });
  }));
  return <section><strong id="card">Card</strong><button id="start-task" on:click={() => {
    void task.run().then(
      (value) => result.update(() => value),
      () => result.update(() => "cancelled"),
    );
  }}>Start task</button><output id="task-result">{result()}</output></section>;
}`,
    );

    await writeFile(join(root, "src", "Deferred.ts"), 'export const label = "Lazy loaded";');

    await writeFile(
      join(root, "app.tsx"),
      'import type { Component, Rendered } from "hesperia"; export default function App(props: Component.Props<{children: Rendered}>) { return <html><head></head><body>{props.children()}</body></html>; }',
    );

    await writeFile(
      join(root, "src", "routes", "+loading.tsx"),
      "export default function Loading() { return <span>Loading</span>; }",
    );

    await writeFile(
      join(root, "src", "routes", "+page.tsx"),
      `import { mount } from "hesperia";
import * as client from "hesperia/client";
import { Card } from "../Card";
export default function Page() {
  const count = client.state(0);
  const lazy = client.state("Pending");
  let mounted: ReturnType<typeof mount> | undefined;
  client.cleanup(() => mounted?.dispose());
  return <main><button id="count" on:click={() => count.update(value => value + 1)}>{count()}</button><button id="show" on:click={() => { mounted = mount(document.querySelector("#target")!, Card, {}); }}>Show</button><button id="lazy" on:click={async () => { const loaded = await import("../Deferred"); lazy.update(() => loaded.label); }}>Load</button><span id="lazy-result">{lazy()}</span><div id="target"></div></main>;
}`,
    );

    const failureMarker = join(root, "css-failure.txt");
    server = await devProject(root, {
      port: 0,
      report: (message) => {
        reports.push(message);

        void writeFile(failureMarker, message);
      },
    });
    const script = `
      import assert from "node:assert/strict";
      import { watch, writeFile } from "node:fs/promises";
      import { chromium } from ${JSON.stringify(pathToFileURL(resolve(import.meta.dir, "../../node_modules/playwright/index.mjs")).href)};
      const browser = await chromium.launch();
      try {
        const page = await browser.newPage();
        await page.addInitScript(() => {
          Object.assign(globalThis, { cssTaskFixture: { started: 0, aborted: 0, releases: 0, release: undefined } });
        });
        const errors = [];
        page.on("pageerror", error => errors.push(error.message));
        await page.goto(${JSON.stringify(server.url.href)});
        await page.locator("#show").click();
        await page.locator("#count").click();
        await page.waitForFunction(() => getComputedStyle(document.querySelector("#card")).color === "rgb(210, 30, 40)");
        await page.evaluate(() => { globalThis.cssRevisionMarker = true; document.querySelector("#card").dataset.identity = "same-node"; });
        await page.locator("#start-task").click();
        await page.waitForFunction(() => globalThis.cssTaskFixture.started === 1);
        const failureEvents = watch(${JSON.stringify(dirname(failureMarker))});
        let nextFailureEvent = failureEvents.next();
        await writeFile(${JSON.stringify(css)}, '@import "./missing.css";');
        try {
          for (;;) {
            const event = await nextFailureEvent;
            if (event.done) throw new Error("CSS failure watcher ended before the import diagnostic");
            if (String(event.value.filename) === ${JSON.stringify(basename(failureMarker))}) break;
            nextFailureEvent = failureEvents.next();
          }
        } finally {
          await failureEvents.return();
        }
        assert.equal(await page.locator("#card").evaluate(node => getComputedStyle(node).color), "rgb(210, 30, 40)");
        await writeFile(${JSON.stringify(css)}, "#card { color: rgb(20, 40, 210); }");
        await page.waitForFunction(() => getComputedStyle(document.querySelector("#card")).color === "rgb(20, 40, 210)", null, { timeout: 30000 });
        assert.equal(await page.locator("#count").textContent(), "1");
        assert.equal(await page.evaluate(() => globalThis.cssRevisionMarker), true);
        assert.equal(await page.locator("#card").getAttribute("data-identity"), "same-node");
        assert.equal(await page.locator("#task-result").textContent(), "pending");
        assert.deepEqual(await page.evaluate(() => ({ started: globalThis.cssTaskFixture.started, aborted: globalThis.cssTaskFixture.aborted, releases: globalThis.cssTaskFixture.releases })), { started: 1, aborted: 0, releases: 0 });
        await page.evaluate(() => {
          const fixture = globalThis.cssTaskFixture;
          if (!fixture.release) throw new Error("CSS task was cancelled before controlled completion");
          fixture.release();
        });
        await page.waitForFunction(() => document.querySelector("#task-result")?.textContent === "CSS task completed");
        assert.deepEqual(await page.evaluate(() => ({ started: globalThis.cssTaskFixture.started, aborted: globalThis.cssTaskFixture.aborted, releases: globalThis.cssTaskFixture.releases })), { started: 1, aborted: 0, releases: 1 });
        await page.locator("#lazy").click();
        await page.waitForFunction(() => document.querySelector("#lazy-result")?.textContent === "Lazy loaded");
        assert.deepEqual(errors, []);
        console.log("CSS revision preserved live browser state");
      } finally { await browser.close(); }
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
        `CSS browser revision failed\n${output}\n${errors}\nReports: ${JSON.stringify(reports)}`,
      );

    expect(output.trim()).toBe("CSS revision preserved live browser state");

    expect(reports.length).toBeGreaterThan(0);
  } finally {
    await server?.close();

    await unlinkFrameworkPackages(root);

    await rm(root, { recursive: true, force: true });
  }
}, 90_000);
