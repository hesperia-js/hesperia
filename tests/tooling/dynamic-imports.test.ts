import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { prepareBuild, ProjectError, writeBuild } from "../../packages/tooling/src/project.ts";
import { previewProject } from "../../packages/tooling/src/server.ts";

test("browser builds preserve finite imports and component-owned dynamic import awaits", async () => {
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
      `import { AsyncBoundary } from "hesperia";
      import * as client from "hesperia/client";
      import { moduleEvaluations, releaseModuleGate } from "../module-gate.ts";

      const photoPromise = import("../photo.png", { with: { type: "image" } });
      const delayedPromise = import("../delayed.ts");
      const state = {
        directModule: undefined as Awaited<typeof photoPromise> | undefined,
        storedModule: undefined as Awaited<typeof photoPromise> | undefined,
        repeatedModule: undefined as Awaited<typeof photoPromise> | undefined,
        delayedModules: [] as Awaited<typeof delayedPromise>[],
        delayedDirectModule: undefined as Awaited<typeof delayedPromise> | undefined,
        firstContinuations: 0,
        firstEffects: 0,
        secondEffects: 0,
        laterEffects: 0,
      };
      Object.assign(globalThis, {
        asyncImportControl: {
          state,
          releaseModuleGate,
          evaluationCount: () => moduleEvaluations,
        },
      });

      async function DirectImage() {
        const loaded = await import("../photo.png", { with: { type: "image" } });
        state.directModule = loaded;
        return <img id="direct-image" alt="Direct dynamic import" src={loaded.default} />;
      }

      async function StoredImage() {
        const loaded = await photoPromise;
        state.storedModule = loaded;
        return <img id="stored-image" alt="Stored dynamic import" src={loaded.default} />;
      }

      async function RepeatedStoredImage() {
        const loaded = await photoPromise;
        state.repeatedModule = loaded;
        return <img id="repeated-image" alt="Repeated stored dynamic import" src={loaded.default} />;
      }

      async function FirstDelayed() {
        await delayedPromise;
        state.firstContinuations++;
        client.effect(() => { state.firstEffects++; });
        return <span id="first-delayed-ready">first ready</span>;
      }

      async function SecondDelayed() {
        const loaded = await delayedPromise;
        state.delayedModules.push(loaded);
        client.effect(() => { state.secondEffects++; });
        return <span id="second-delayed-ready">second:{loaded.value}</span>;
      }

      async function LaterDelayed() {
        const direct = await import("../delayed.ts");
        const loaded = await delayedPromise;
        state.delayedDirectModule = direct;
        state.delayedModules.push(loaded);
        client.effect(() => { state.laterEffects++; });
        return <span id="later-delayed-ready">later:{loaded.value}</span>;
      }

      function FirstBoundary() {
        return <AsyncBoundary fallback={<span id="first-loading">first loading</span>}><FirstDelayed /></AsyncBoundary>;
      }

      function LaterBoundary() {
        return <AsyncBoundary fallback={<span id="later-loading">later loading</span>}><LaterDelayed /></AsyncBoundary>;
      }

      export default function Page() {
        const showFirst = client.state(true);
        const showLater = client.state(false);
        return <main>
          <h1>Lazy imports</h1>
          <button id="dispose-first" on:click={() => showFirst.set(false)}>Dispose first</button>
          <button id="show-later" on:click={() => showLater.set(true)}>Show later</button>
          <AsyncBoundary fallback={<span id="direct-loading">direct loading</span>}><DirectImage /></AsyncBoundary>
          <AsyncBoundary fallback={<span id="stored-loading">stored loading</span>}><StoredImage /></AsyncBoundary>
          <AsyncBoundary fallback={<span id="repeated-loading">repeated loading</span>}><RepeatedStoredImage /></AsyncBoundary>
          {showFirst() ? <FirstBoundary /> : null}
          <AsyncBoundary fallback={<span id="second-loading">second loading</span>}><SecondDelayed /></AsyncBoundary>
          {showLater() ? <LaterBoundary /> : null}
        </main>;
      }`,
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

    await writeFile(
      join(root, "src/module-gate.ts"),
      `let release!: () => void;
      export const moduleGate = new Promise<void>((resolve) => { release = resolve; });
      export let moduleEvaluations = 0;
      export function releaseModuleGate() { release(); }
      export function recordModuleEvaluation() { moduleEvaluations++; }`,
    );

    await writeFile(
      join(root, "src/delayed.ts"),
      `import { moduleGate, recordModuleEvaluation } from "./module-gate.ts";
      await moduleGate;
      recordModuleEvaluation();
      export const value = "loaded";`,
    );

    await writeFile(
      join(root, "src/photo.png"),
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGNgAAAAAgABSK+kcQAAAABJRU5ErkJggg==",
        "base64",
      ),
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
          await page.locator("#direct-image").waitFor();
          await page.locator("#stored-image").waitFor();
          await page.locator("#repeated-image").waitFor();
          await page.locator("#first-loading").waitFor();
          await page.locator("#second-loading").waitFor();
          const imageState = await page.evaluate(async () => {
            const direct = document.querySelector("#direct-image");
            const stored = document.querySelector("#stored-image");
            const repeated = document.querySelector("#repeated-image");
            await Promise.all([direct.decode(), stored.decode(), repeated.decode()]);
            const fixture = globalThis.asyncImportControl;
            return {
              directBlobType: fixture.state.directModule.default.type,
              storedBlobType: fixture.state.storedModule.default.type,
              repeatedBlobType: fixture.state.repeatedModule.default.type,
              sharedNamespace: fixture.state.storedModule === fixture.state.repeatedModule,
              sharedBlob: fixture.state.storedModule.default === fixture.state.repeatedModule.default,
              directUsesBlobUrl: direct.src.startsWith("blob:"),
              storedUsesBlobUrl: stored.src.startsWith("blob:"),
              repeatedUsesBlobUrl: repeated.src.startsWith("blob:"),
              dimensions: [direct.naturalWidth, direct.naturalHeight, stored.naturalWidth, stored.naturalHeight, repeated.naturalWidth, repeated.naturalHeight],
              evaluations: fixture.evaluationCount(),
              firstEffects: fixture.state.firstEffects,
              secondEffects: fixture.state.secondEffects,
            };
          });
          assert.deepEqual(imageState, {
            directBlobType: "image/png",
            storedBlobType: "image/png",
            repeatedBlobType: "image/png",
            sharedNamespace: true,
            sharedBlob: true,
            directUsesBlobUrl: true,
            storedUsesBlobUrl: true,
            repeatedUsesBlobUrl: true,
            dimensions: [1, 1, 1, 1, 1, 1],
            evaluations: 0,
            firstEffects: 0,
            secondEffects: 0,
          });
          await page.locator("#dispose-first").click();
          await page.locator("#first-loading").waitFor({ state: "detached" });
          await page.evaluate(() => globalThis.asyncImportControl.releaseModuleGate());
          await page.locator("#second-delayed-ready").waitFor();
          await page.waitForFunction(() => {
            const fixture = globalThis.asyncImportControl;
            return fixture.state.secondEffects === 1 && fixture.evaluationCount() === 1;
          });
          let delayedState = await page.evaluate(() => ({
            first: document.querySelector("#first-delayed-ready") !== null,
            firstContinuations: globalThis.asyncImportControl.state.firstContinuations,
            firstEffects: globalThis.asyncImportControl.state.firstEffects,
            secondEffects: globalThis.asyncImportControl.state.secondEffects,
            evaluations: globalThis.asyncImportControl.evaluationCount(),
            namespaceCount: globalThis.asyncImportControl.state.delayedModules.length,
          }));
          assert.deepEqual(delayedState, {
            first: false,
            firstContinuations: 0,
            firstEffects: 0,
            secondEffects: 1,
            evaluations: 1,
            namespaceCount: 1,
          });
          await page.locator("#show-later").click();
          await page.locator("#later-delayed-ready").waitFor();
          await page.waitForFunction(() => globalThis.asyncImportControl.state.laterEffects === 1);
          delayedState = await page.evaluate(() => ({
            sameNamespace:
              globalThis.asyncImportControl.state.delayedModules[0] ===
                globalThis.asyncImportControl.state.delayedModules[1] &&
              globalThis.asyncImportControl.state.delayedDirectModule ===
                globalThis.asyncImportControl.state.delayedModules[0],
            firstContinuations: globalThis.asyncImportControl.state.firstContinuations,
            firstEffects: globalThis.asyncImportControl.state.firstEffects,
            secondEffects: globalThis.asyncImportControl.state.secondEffects,
            laterEffects: globalThis.asyncImportControl.state.laterEffects,
            evaluations: globalThis.asyncImportControl.evaluationCount(),
          }));
          assert.deepEqual(delayedState, {
            sameNamespace: true,
            firstContinuations: 0,
            firstEffects: 0,
            secondEffects: 1,
            laterEffects: 1,
            evaluations: 1,
          });
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
}, 120_000);
