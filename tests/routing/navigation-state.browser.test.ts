import { afterAll, beforeAll, expect, test } from "bun:test";
import { chromium, firefox, webkit } from "playwright";
import { resolve } from "node:path";
import { loadBrowserPageCoverage, type BrowserPageCoverageSuite } from "./browser-page-coverage.ts";

let server: ReturnType<typeof Bun.serve>;
let historyScript: string;
let browserCoverage: BrowserPageCoverageSuite | undefined;

beforeAll(async () => {
  browserCoverage = await loadBrowserPageCoverage("tests/routing/navigation-state.browser.test.ts");
  const stateEntrypoint = resolve(import.meta.dir, "navigation-state.browser.fixture.ts");
  const historyEntrypoint = resolve(import.meta.dir, "history-state.browser.fixture.ts");

  const buildFixtures = async () => {
    const stateBuild = await Bun.build({
      entrypoints: [stateEntrypoint],
      target: "browser",
      format: "esm",
    });
    const historyBuild = await Bun.build({
      entrypoints: [historyEntrypoint],
      target: "browser",
      format: "esm",
    });
    return [stateBuild, historyBuild] as const;
  };

  const [build, historyBuild] = browserCoverage
    ? await browserCoverage.buildFixtures({
        expectedEntrypoints: [[stateEntrypoint], [historyEntrypoint]],
        build: buildFixtures,
      })
    : await buildFixtures();

  if (!build.success)
    throw new AggregateError(build.logs, "Navigation state browser fixture did not bundle");

  const script = await build.outputs[0]!.text();

  if (!historyBuild.success)
    throw new AggregateError(historyBuild.logs, "History state browser fixture did not bundle");

  historyScript = await historyBuild.outputs[0]!.text();
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,

    fetch(request) {
      const pathname = new URL(request.url).pathname;

      if (pathname === "/fixture.js")
        return new Response(script, { headers: { "content-type": "text/javascript" } });

      if (pathname === "/history-fixture.js")
        return new Response(historyScript, { headers: { "content-type": "text/javascript" } });

      if (pathname.startsWith("/history/"))
        return new Response(
          '<!doctype html><head><base href="/base/nested/"></head><script type="module" src="/history-fixture.js"></script>',
          { headers: { "content-type": "text/html" } },
        );

      return new Response(
        '<!doctype html><title>navigation state</title><script type="module" src="/fixture.js"></script>',
        { headers: { "content-type": "text/html" } },
      );
    },
  });
});

afterAll(async () => {
  try {
    await browserCoverage?.finish();
  } finally {
    server?.stop(true);
  }
});

for (const engine of [chromium, firefox, webkit]) {
  test(
    engine.name() +
      " changed-URL direct History writes project author state across reload and released Forward",
    async () => {
      const browser = await engine.launch();

      try {
        const page = await browser.newPage();
        const capturePage = await browserCoverage?.preparePage(page, browser.version(), {
          engine: engine.name(),
          caseId: "direct-history-navigation-state",
          mode: "default",
          documents: 2,
        });
        const origin = "http://127.0.0.1:" + server.port;

        await page.goto(origin + "/one");

        await page.waitForFunction(
          () =>
            (
              window as Window & {
                navigationStateFixture?: { ready: boolean };
              }
            ).navigationStateFixture?.ready === true,
        );

        const write = await page.evaluate(async () => {
          const fixture = (
            window as unknown as Window & {
              navigationStateFixture: {
                navigation: Navigation;
                router: { readonly url: string };
              };
            }
          ).navigationStateFixture;

          const waitForEntryChange = () =>
            new Promise<boolean>((resolve) => {
              const timer = window.setTimeout(() => resolve(false), 2_000);

              fixture.navigation.addEventListener(
                "currententrychange",
                () => {
                  window.clearTimeout(timer);

                  resolve(true);
                },
                { once: true },
              );
            });

          window.history.replaceState({ classic: "one" }, "", "/one");

          fixture.navigation.updateCurrentEntry({ state: { api: "one" } });

          await fixture.navigation.navigate("/two", { state: { api: "two" } }).finished;

          const replaced = waitForEntryChange();

          window.history.replaceState({ classic: "two" }, "", "/two?x=1");

          const replaceEventObserved = await replaced;

          const updated = waitForEntryChange();

          fixture.navigation.updateCurrentEntry({ state: { api: "two-updated" } });

          const updateEventObserved = await updated;

          return {
            href: window.location.href,
            routerUrl: fixture.router.url,
            classic: window.history.state,
            api: fixture.navigation.currentEntry?.getState(),
            replaceEventObserved,
            updateEventObserved,
          };
        });

        expect(write).toStrictEqual({
          href: origin + "/two?x=1",
          routerUrl: origin + "/two?x=1",
          classic: { classic: "two" },
          api: { api: "two-updated" },
          replaceEventObserved: true,
          updateEventObserved: true,
        });

        await page.reload();

        await page.waitForFunction(
          () =>
            (
              window as Window & {
                navigationStateFixture?: { ready: boolean };
              }
            ).navigationStateFixture?.ready === true,
        );

        const afterReload = await page.evaluate(() => {
          const fixture = (
            window as unknown as Window & {
              navigationStateFixture: {
                navigation: Navigation;
                restoredAtStartup: { classic: unknown; navigation: unknown };
              };
            }
          ).navigationStateFixture;
          return {
            classic: window.history.state,
            restoredAtStartup: fixture.restoredAtStartup,
          };
        });

        expect(afterReload).toStrictEqual({
          classic: { classic: "two" },
          restoredAtStartup: {
            classic: { classic: "two" },
            navigation: { api: "two-updated" },
          },
        });

        const popstatesBeforeBack = await page.evaluate(
          () =>
            (
              window as unknown as Window & {
                navigationStateFixture: { popstateStates: unknown[] };
              }
            ).navigationStateFixture.popstateStates.length,
        );

        await page.evaluate(() => window.history.back());

        await page.waitForFunction(
          (count) =>
            window.location.pathname === "/one" &&
            (
              window as unknown as Window & {
                navigationStateFixture: { popstateStates: unknown[] };
              }
            ).navigationStateFixture.popstateStates.length > count,
          popstatesBeforeBack,
        );

        await page.evaluate(() => {
          const fixture = (
            window as unknown as Window & {
              navigationStateFixture: { dispose(): void };
            }
          ).navigationStateFixture;

          fixture.dispose();
        });

        const popstatesBeforeForward = await page.evaluate(
          () =>
            (
              window as unknown as Window & {
                navigationStateFixture: { popstateStates: unknown[] };
              }
            ).navigationStateFixture.popstateStates.length,
        );

        await page.evaluate(() => window.history.forward());

        await page.waitForFunction(
          (count) =>
            window.location.pathname === "/two" &&
            window.location.search === "?x=1" &&
            (
              window as unknown as Window & {
                navigationStateFixture: { popstateStates: unknown[] };
              }
            ).navigationStateFixture.popstateStates.length > count,
          popstatesBeforeForward,
        );

        const afterForward = await page.evaluate(() => {
          const fixture = (
            window as unknown as Window & {
              navigationStateFixture: { popstateStates: unknown[] };
            }
          ).navigationStateFixture;
          return {
            classic: window.history.state,
            popstate: fixture.popstateStates.at(-1),
          };
        });

        expect(afterForward).toStrictEqual({
          classic: { classic: "two" },
          popstate: { classic: "two" },
        });

        await capturePage?.();
      } finally {
        await browser.close();
      }
    },
    45_000,
  );

  test(`${engine.name()} direct History URL arguments match nullable and base-relative native behavior`, async () => {
    const browser = await engine.launch();

    try {
      const page = await browser.newPage();
      const capturePage = await browserCoverage?.preparePage(page, browser.version(), {
        engine: engine.name(),
        caseId: "direct-history-url-arguments",
        mode: "history-api",
        documents: 1,
      });
      const origin = "http://127.0.0.1:" + server.port;

      await page.goto(origin + "/history/origin/start?keep=1");

      await page.waitForFunction(
        () =>
          (
            window as Window & {
              historyStateFixture?: { ready: boolean };
            }
          ).historyStateFixture?.ready === true,
      );

      const result = await page.evaluate(async (origin) => {
        const fixture = (
          window as unknown as Window & {
            historyStateFixture: {
              popstateStates: unknown[];

              dispose(): void;
            };
          }
        ).historyStateFixture;

        type Scenario = {
          readonly name: string;
          readonly method: "pushState" | "replaceState";
          readonly urlKind:
            | "null"
            | "omitted"
            | "undefined"
            | "relative"
            | "empty"
            | "object-empty";
          readonly url?: string;
          readonly expectedUrl: string;
        };

        const relativePushUrl = origin + "/base/nested/child/push?q=1";
        const relativeReplaceUrl = origin + "/base/nested/child/replace?q=2";
        const scenarios: readonly Scenario[] = [
          {
            name: "push-relative",
            method: "pushState",
            urlKind: "relative",
            url: "child/push?q=1",
            expectedUrl: relativePushUrl,
          },
          {
            name: "push-empty",
            method: "pushState",
            urlKind: "empty",
            expectedUrl: relativePushUrl,
          },
          {
            name: "push-object-empty",
            method: "pushState",
            urlKind: "object-empty",
            expectedUrl: relativePushUrl,
          },
          {
            name: "push-null",
            method: "pushState",
            urlKind: "null",
            expectedUrl: relativePushUrl,
          },
          {
            name: "push-omitted",
            method: "pushState",
            urlKind: "omitted",
            expectedUrl: relativePushUrl,
          },
          {
            name: "push-undefined",
            method: "pushState",
            urlKind: "undefined",
            expectedUrl: relativePushUrl,
          },
          {
            name: "replace-null",
            method: "replaceState",
            urlKind: "null",
            expectedUrl: relativePushUrl,
          },
          {
            name: "replace-omitted",
            method: "replaceState",
            urlKind: "omitted",
            expectedUrl: relativePushUrl,
          },
          {
            name: "replace-undefined",
            method: "replaceState",
            urlKind: "undefined",
            expectedUrl: relativePushUrl,
          },
          {
            name: "replace-relative",
            method: "replaceState",
            urlKind: "relative",
            url: "child/replace?q=2",
            expectedUrl: relativeReplaceUrl,
          },
          {
            name: "replace-empty",
            method: "replaceState",
            urlKind: "empty",
            expectedUrl: relativeReplaceUrl,
          },
          {
            name: "replace-object-empty",
            method: "replaceState",
            urlKind: "object-empty",
            expectedUrl: relativeReplaceUrl,
          },
        ];
        const writes = [];

        for (const scenario of scenarios) {
          const state = { classic: scenario.name };
          const method = window.history[scenario.method];
          let conversions = 0;
          const conversionHints: string[] = [];

          if (scenario.urlKind === "omitted") method.call(window.history, state, "");
          else if (scenario.urlKind === "null") method.call(window.history, state, "", null);
          else if (scenario.urlKind === "undefined")
            method.call(window.history, state, "", undefined);
          else if (scenario.urlKind === "empty") method.call(window.history, state, "", "");
          else if (scenario.urlKind === "object-empty")
            Reflect.apply(method, window.history, [
              state,
              "",
              {
                [Symbol.toPrimitive](hint: string) {
                  conversions++;

                  conversionHints.push(hint);

                  return "";
                },
              },
            ]);
          else method.call(window.history, state, "", scenario.url);

          if (window.location.href !== scenario.expectedUrl)
            throw new Error(`${scenario.name} resolved to ${window.location.href}`);

          writes.push({
            name: scenario.name,
            href: window.location.href,
            documentURL: document.URL,
            classic: window.history.state,
            conversions,
            conversionHints,
          });
        }

        fixture.dispose();

        const backStates = [];

        for (let index = 0; index < 5; index++) {
          const returned = new Promise<void>((resolve, reject) => {
            const timer = window.setTimeout(
              () => reject(new Error("Back traversal timed out")),
              5_000,
            );

            window.addEventListener(
              "popstate",
              () => {
                window.clearTimeout(timer);

                resolve();
              },
              { once: true },
            );
          });

          window.history.back();

          await returned;

          backStates.push({
            href: window.location.href,
            classic: window.history.state,
            popstate: fixture.popstateStates.at(-1),
          });
        }

        return { baseUri: document.baseURI, writes, afterReleasedBack: backStates.at(-1) };
      }, origin);

      const relativePushUrl = origin + "/base/nested/child/push?q=1";
      const relativeReplaceUrl = origin + "/base/nested/child/replace?q=2";
      const expectedWrites = [
        ["push-relative", relativePushUrl, 0, []],
        ["push-empty", relativePushUrl, 0, []],
        ["push-object-empty", relativePushUrl, 1, ["string"]],
        ["push-null", relativePushUrl, 0, []],
        ["push-omitted", relativePushUrl, 0, []],
        ["push-undefined", relativePushUrl, 0, []],
        ["replace-null", relativePushUrl, 0, []],
        ["replace-omitted", relativePushUrl, 0, []],
        ["replace-undefined", relativePushUrl, 0, []],
        ["replace-relative", relativeReplaceUrl, 0, []],
        ["replace-empty", relativeReplaceUrl, 0, []],
        ["replace-object-empty", relativeReplaceUrl, 1, ["string"]],
      ] as const;

      expect(result).toStrictEqual({
        baseUri: origin + "/base/nested/",
        writes: expectedWrites.map(([name, href, conversions, conversionHints]) => ({
          name,
          href,
          documentURL: href,
          classic: { classic: name },
          conversions,
          conversionHints: [...conversionHints],
        })),
        afterReleasedBack: {
          href: relativePushUrl,
          classic: { classic: "push-relative" },
          popstate: { classic: "push-relative" },
        },
      });

      await capturePage?.();
    } finally {
      await browser.close();
    }
  }, 45_000);

  test(`${engine.name()} fallback keeps classic and Navigation state separate across reload and traversal`, async () => {
    const browser = await engine.launch();

    try {
      const page = await browser.newPage();
      const capturePage = await browserCoverage?.preparePage(page, browser.version(), {
        engine: engine.name(),
        caseId: "fallback-state-reload-traversal",
        mode: "legacy",
        documents: 2,
      });

      await page.addInitScript(() => {
        Object.defineProperty(window, "navigation", { configurable: true, value: undefined });
      });

      await page.goto(`http://127.0.0.1:${server.port}/one`);

      await page.waitForFunction(
        () =>
          (
            window as Window & {
              navigationStateFixture?: { ready: boolean };
            }
          ).navigationStateFixture?.ready === true,
      );

      const beforeReload = await page.evaluate(async () => {
        const fixture = (
          window as unknown as Window & {
            navigationStateFixture: {
              navigation: Navigation;
              router: { readonly url: string };
            };
          }
        ).navigationStateFixture;

        window.history.replaceState({ classic: "author" }, "", "/one");

        fixture.navigation.updateCurrentEntry({ state: { api: "coexisting" } });

        await fixture.navigation.navigate("/two", { state: { api: "pushed" } }).finished;
        await fixture.navigation.navigate("/replaced", {
          history: "replace",
          state: { api: "replaced" },
        }).finished;
        return {
          href: window.location.href,
          classic: window.history.state,
          navigation: fixture.navigation.currentEntry?.getState(),
          rendered: document.querySelector("main")?.textContent,
        };
      });

      expect(beforeReload).toMatchObject({
        href: `http://127.0.0.1:${server.port}/replaced`,
        classic: null,
        navigation: { api: "replaced" },
        rendered: "/replaced",
      });

      await page.reload();

      await page.waitForFunction(
        () =>
          (
            window as Window & {
              navigationStateFixture?: { ready: boolean };
            }
          ).navigationStateFixture?.ready === true,
      );

      const afterReload = await page.evaluate(() => {
        const fixture = (
          window as unknown as Window & {
            navigationStateFixture: {
              navigation: Navigation;
              router: { readonly url: string };
              restoredAtStartup: { classic: unknown; navigation: unknown };
            };
          }
        ).navigationStateFixture;
        return {
          classic: window.history.state,
          navigation: fixture.navigation.currentEntry?.getState(),
          restoredAtStartup: fixture.restoredAtStartup,
          rendered: document.querySelector("main")?.textContent,
        };
      });

      expect(afterReload).toMatchObject({
        classic: null,
        navigation: { api: "replaced" },
        restoredAtStartup: { classic: null, navigation: { api: "replaced" } },
        rendered: "/replaced",
      });

      await page.evaluate(() => window.history.back());

      await page.waitForFunction(
        () =>
          window.location.pathname === "/one" &&
          document.querySelector("main")?.textContent === "/one",
      );

      const back = await page.evaluate(() => {
        const fixture = (
          window as unknown as Window & {
            navigationStateFixture: {
              navigation: Navigation;
              popstateStates: unknown[];
            };
          }
        ).navigationStateFixture;
        return {
          classic: window.history.state,
          navigation: fixture.navigation.currentEntry?.getState(),
          popstate: fixture.popstateStates.at(-1),
        };
      });

      expect(back).toStrictEqual({
        classic: { classic: "author" },
        navigation: { api: "coexisting" },
        popstate: { classic: "author" },
      });

      await page.evaluate(() => window.history.forward());

      await page.waitForFunction(
        () =>
          window.location.pathname === "/replaced" &&
          document.querySelector("main")?.textContent === "/replaced",
      );

      const forward = await page.evaluate(() => {
        const fixture = (
          window as unknown as Window & {
            navigationStateFixture: { navigation: Navigation; popstateStates: unknown[] };
          }
        ).navigationStateFixture;
        return {
          classic: window.history.state,
          navigation: fixture.navigation.currentEntry?.getState(),
          popstate: fixture.popstateStates.at(-1),
        };
      });

      expect(forward).toStrictEqual({
        classic: null,
        navigation: { api: "replaced" },
        popstate: null,
      });

      await capturePage?.();
    } finally {
      await browser.close();
    }
  }, 45_000);

  test(`${engine.name()} fallback keeps state projection on Back and Forward after Router disposal`, async () => {
    const browser = await engine.launch();

    try {
      const page = await browser.newPage();
      const capturePage = await browserCoverage?.preparePage(page, browser.version(), {
        engine: engine.name(),
        caseId: "fallback-after-dispose",
        mode: "legacy",
        documents: 2,
      });

      await page.addInitScript(() => {
        Object.defineProperty(window, "navigation", { configurable: true, value: undefined });
      });

      await page.goto(`http://127.0.0.1:${server.port}/one`);

      await page.waitForFunction(
        () =>
          (
            window as Window & {
              navigationStateFixture?: { ready: boolean };
            }
          ).navigationStateFixture?.ready === true,
      );

      await page.evaluate(async () => {
        const fixture = (
          window as unknown as Window & {
            navigationStateFixture: {
              navigation: Navigation;

              dispose(): void;
            };
          }
        ).navigationStateFixture;

        window.history.replaceState({ classic: "one" }, "", "/one");

        fixture.navigation.updateCurrentEntry({ state: { api: "one" } });

        await fixture.navigation.navigate("/two", { state: { api: "two" } }).finished;

        fixture.dispose();
      });

      const methodsRestored = await page.evaluate(
        () =>
          (
            window as unknown as Window & {
              navigationStateFixture: { historyMethodsRestored: boolean };
            }
          ).navigationStateFixture.historyMethodsRestored,
      );

      expect(methodsRestored).toBe(true);

      const popstatesBeforeBack = await page.evaluate(
        () =>
          (
            window as unknown as Window & {
              navigationStateFixture: { popstateStates: unknown[] };
            }
          ).navigationStateFixture.popstateStates.length,
      );

      await page.evaluate(() => window.history.back());

      await page.waitForFunction(
        (count) =>
          window.location.pathname === "/one" &&
          (
            window as unknown as Window & {
              navigationStateFixture: { popstateStates: unknown[] };
            }
          ).navigationStateFixture.popstateStates.length > count,
        popstatesBeforeBack,
      );

      const afterBack = await page.evaluate(() => {
        const fixture = (
          window as unknown as Window & {
            navigationStateFixture: { popstateStates: unknown[] };
          }
        ).navigationStateFixture;
        return {
          classic: window.history.state,
          popstate: fixture.popstateStates.at(-1),
          path: window.location.pathname,
        };
      });

      expect(afterBack).toStrictEqual({
        classic: { classic: "one" },
        popstate: { classic: "one" },
        path: "/one",
      });

      const popstatesBeforeForward = await page.evaluate(
        () =>
          (
            window as unknown as Window & {
              navigationStateFixture: { popstateStates: unknown[] };
            }
          ).navigationStateFixture.popstateStates.length,
      );

      await page.evaluate(() => window.history.forward());

      await page.waitForFunction(
        (count) =>
          window.location.pathname === "/two" &&
          (
            window as unknown as Window & {
              navigationStateFixture: { popstateStates: unknown[] };
            }
          ).navigationStateFixture.popstateStates.length > count,
        popstatesBeforeForward,
      );

      const afterForward = await page.evaluate(() => {
        const fixture = (
          window as unknown as Window & {
            navigationStateFixture: { popstateStates: unknown[] };
          }
        ).navigationStateFixture;
        return {
          classic: window.history.state,
          popstate: fixture.popstateStates.at(-1),
          path: window.location.pathname,
        };
      });

      expect(afterForward).toStrictEqual({ classic: null, popstate: null, path: "/two" });

      const popstatesBeforeReloadBack = await page.evaluate(
        () =>
          (
            window as unknown as Window & {
              navigationStateFixture: { popstateStates: unknown[] };
            }
          ).navigationStateFixture.popstateStates.length,
      );

      await page.evaluate(() => window.history.back());

      await page.waitForFunction(
        (count) =>
          window.location.pathname === "/one" &&
          (
            window as unknown as Window & {
              navigationStateFixture: { popstateStates: unknown[] };
            }
          ).navigationStateFixture.popstateStates.length > count,
        popstatesBeforeReloadBack,
      );

      await page.reload();

      await page.waitForFunction(
        () =>
          (
            window as Window & {
              navigationStateFixture?: { ready: boolean };
            }
          ).navigationStateFixture?.ready === true,
      );

      const restored = await page.evaluate(() => {
        const fixture = (
          window as unknown as Window & {
            navigationStateFixture: {
              restoredAtStartup: { classic: unknown; navigation: unknown };
            };
          }
        ).navigationStateFixture;
        return fixture.restoredAtStartup;
      });

      expect(restored).toStrictEqual({ classic: { classic: "one" }, navigation: { api: "one" } });

      await capturePage?.();
    } finally {
      await browser.close();
    }
  }, 45_000);
}
