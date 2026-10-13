import { afterAll, beforeAll, expect, test } from "bun:test";
import { chromium, firefox, webkit } from "playwright";
import { resolve } from "node:path";
import { loadBrowserPageCoverage, type BrowserPageCoverageSuite } from "./browser-page-coverage.ts";

let server: ReturnType<typeof Bun.serve>;
let browserCoverage: BrowserPageCoverageSuite | undefined;

beforeAll(async () => {
  browserCoverage = await loadBrowserPageCoverage(
    "tests/routing/navigation-facade.browser.test.ts",
  );
  const entrypoint = resolve(import.meta.dir, "navigation-facade.browser.fixture.ts");
  const buildOptions: Parameters<typeof Bun.build>[0] = {
    entrypoints: [entrypoint],
    target: "browser",
    format: "esm",
  };
  const build = browserCoverage
    ? await browserCoverage.buildFixtures({
        expectedEntrypoints: [[entrypoint]],
        build: () => Bun.build(buildOptions),
      })
    : await Bun.build(buildOptions);

  if (!build.success)
    throw new AggregateError(build.logs, "Navigation facade browser fixture did not bundle");

  const script = await build.outputs[0]!.text();
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,

    fetch(request) {
      const pathname = new URL(request.url).pathname;

      if (pathname.startsWith("/window/"))
        return new Response("<!doctype html><title>routed window</title><body></body>", {
          headers: { "content-type": "text/html" },
        });

      if (pathname === "/fixture.js")
        return new Response(script, { headers: { "content-type": "text/javascript" } });

      return new Response(
        '<!doctype html><title>navigation facade</title><script type="module" src="/fixture.js"></script>',
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
  test(`${engine.name()} routes two iframe Windows independently through one runtime`, async () => {
    const browser = await engine.launch();
    const page = await browser.newPage();

    try {
      const capturePage = await browserCoverage?.preparePage(page, browser.version(), {
        engine: engine.name(),
        caseId: "iframe-window-isolation",
        mode: "default",
        documents: 1,
      });

      await page.goto(`http://127.0.0.1:${server.port}/window-driver`);

      await page.waitForFunction(
        () =>
          (
            window as Window & {
              navigationFacadeFixture?: { ready: boolean };
            }
          ).navigationFacadeFixture?.ready === true,
      );

      await page.evaluate(async () => {
        const fixture = (
          window as unknown as Window & {
            navigationFacadeFixture: {
              startIframeApplications(first: Window, second: Window): Promise<void>;
            };
          }
        ).navigationFacadeFixture;

        const createFrame = async (id: string, path: string): Promise<HTMLIFrameElement> => {
          const frame = document.createElement("iframe");
          frame.id = id;
          const loaded = new Promise<void>((resolve) => {
            frame.addEventListener("load", () => resolve(), { once: true });
          });
          frame.src = path;

          document.body.append(frame);

          await loaded;
          return frame;
        };

        const [first, second] = await Promise.all([
          createFrame("first-window", "/window/first/"),
          createFrame("second-window", "/window/second/"),
        ]);

        await fixture.startIframeApplications(first.contentWindow!, second.contentWindow!);
      });

      const firstFrame = page.frameLocator("#first-window");
      const secondFrame = page.frameLocator("#second-window");

      await firstFrame.locator('main[data-page="home"]').waitFor();

      await secondFrame.locator('main[data-page="home"]').waitFor();

      const readWindows = () =>
        page.evaluate(() => {
          const read = (id: string) => {
            const frame = document.querySelector(`#${id}`) as HTMLIFrameElement;
            return {
              pathname: frame.contentWindow!.location.pathname,
              page: frame.contentDocument!.querySelector("main")?.getAttribute("data-page"),
            };
          };

          return { first: read("first-window"), second: read("second-window") };
        });

      expect(await readWindows()).toStrictEqual({
        first: { pathname: "/window/first/", page: "home" },
        second: { pathname: "/window/second/", page: "home" },
      });

      await firstFrame.getByRole("link", { name: "detail" }).click();

      await firstFrame.locator('main[data-page="detail"]').waitFor();

      expect(await readWindows()).toStrictEqual({
        first: { pathname: "/window/first/detail", page: "detail" },
        second: { pathname: "/window/second/", page: "home" },
      });

      await secondFrame.getByRole("link", { name: "detail" }).click();

      await secondFrame.locator('main[data-page="detail"]').waitFor();

      expect(await readWindows()).toStrictEqual({
        first: { pathname: "/window/first/detail", page: "detail" },
        second: { pathname: "/window/second/detail", page: "detail" },
      });

      await capturePage?.();
    } finally {
      try {
        await page.evaluate(() => {
          const fixture = (
            window as Window & {
              navigationFacadeFixture?: { disposeIframeApplications(): void };
            }
          ).navigationFacadeFixture;

          try {
            fixture?.disposeIframeApplications();
          } finally {
            document
              .querySelectorAll("#first-window, #second-window")
              .forEach((frame) => frame.remove());
          }
        });
      } finally {
        await browser.close();
      }
    }
  }, 30_000);

  test(`${engine.name()} default: same-origin query navigation is routed`, async () => {
    const browser = await engine.launch();

    try {
      const page = await browser.newPage();
      const capturePage = await browserCoverage?.preparePage(page, browser.version(), {
        engine: engine.name(),
        caseId: "query-navigation",
        mode: "default",
        documents: 1,
      });

      await page.goto(`http://127.0.0.1:${server.port}/one`);

      await page.waitForFunction(
        () =>
          (window as Window & { navigationFacadeFixture?: { ready: boolean } })
            .navigationFacadeFixture?.ready === true,
      );

      const result = await page.evaluate(async () => {
        const fixture = (
          window as unknown as Window & {
            navigationFacadeFixture: {
              navigation: Navigation;
              router: { readonly url: string };
              readonly guardCalls: number;
              native: boolean;
              navigationEvents: Array<{
                type: string;
                sameDocument: boolean;
                hashChange: boolean;
                url: string | null;
              }>;
            };
          }
        ).navigationFacadeFixture;
        const beforeGuards = fixture.guardCalls;
        const eventIndex = fixture.navigationEvents.length;
        const navigation = fixture.navigation.navigate("/one?source=query", {
          history: "push",
        });
        const committed = await navigation.committed;
        const finished = await navigation.finished;
        return {
          beforeGuards,
          afterGuards: fixture.guardCalls,
          routerUrl: fixture.router.url,
          locationUrl: location.href,
          committedUrl: committed?.url,
          finishedUrl: finished?.url,
          event: fixture.navigationEvents[eventIndex],
        };
      });

      expect(result.afterGuards).toBeGreaterThan(result.beforeGuards);

      expect(result).toMatchObject({
        routerUrl: `http://127.0.0.1:${server.port}/one?source=query`,
        locationUrl: `http://127.0.0.1:${server.port}/one?source=query`,
        committedUrl: `http://127.0.0.1:${server.port}/one?source=query`,
        finishedUrl: `http://127.0.0.1:${server.port}/one?source=query`,
        event: {
          type: "push",
          sameDocument: false,
          hashChange: false,
          url: `http://127.0.0.1:${server.port}/one?source=query`,
        },
      });

      await capturePage?.();
    } finally {
      await browser.close();
    }
  }, 30_000);

  const modes =
    engine.name() === "webkit" ? (["legacy"] as const) : (["native", "legacy"] as const);

  for (const mode of modes) {
    test(`${engine.name()} ${mode}: authored navigation uses the routed facade`, async () => {
      const browser = await engine.launch();

      try {
        const page = await browser.newPage();
        const capturePage = await browserCoverage?.preparePage(page, browser.version(), {
          engine: engine.name(),
          caseId: "authored-navigation",
          mode,
          documents: 1,
        });

        if (mode === "legacy")
          await page.addInitScript(() => {
            Object.defineProperty(window, "navigation", { configurable: true, value: undefined });
          });

        await page.goto(`http://127.0.0.1:${server.port}/one`);

        await page.waitForFunction(
          () =>
            (window as Window & { navigationFacadeFixture?: { ready: boolean } })
              .navigationFacadeFixture?.ready === true,
        );

        const result = await page.evaluate(async () => {
          const fixture = (
            window as unknown as Window & {
              navigationFacadeFixture: {
                navigation: Navigation;
                exportedNavigation: Navigation;
                router: { readonly url: string };
                events: string[];
                native: boolean;
              };
            }
          ).navigationFacadeFixture;
          const exportedNavigation = fixture.exportedNavigation;
          const originalCalls: string[] = [];
          const replacementCalls: string[] = [];
          const listenerCalls: string[] = [];

          const originalHandler = (event: Event) => {
            originalCalls.push((event as NavigateEvent).destination.url);
          };

          const replacementHandler = (event: Event) => {
            replacementCalls.push((event as NavigateEvent).destination.url);
          };

          const listener = (event: Event) => {
            listenerCalls.push((event as NavigateEvent).destination.url);
          };

          const currentEntryUrl = exportedNavigation.currentEntry?.url ?? null;
          const hasNavigate = "navigate" in exportedNavigation;
          const hasBeforeLeave = "beforeLeave" in exportedNavigation;

          exportedNavigation.addEventListener("navigate", listener);

          exportedNavigation.onnavigate = originalHandler;
          const originalHandlerReadback = exportedNavigation.onnavigate === originalHandler;
          exportedNavigation.onnavigate = replacementHandler;
          const replacementHandlerReadback = exportedNavigation.onnavigate === replacementHandler;
          const documentBefore = document;
          const initial = document.querySelector("main");
          const navigation = exportedNavigation.navigate("/two", {
            state: { destination: true },
          });
          const committed = await navigation.committed;
          const finished = await navigation.finished;
          const sameDocument = document === documentBefore;
          const replacedMain = document.querySelector("main") !== initial;
          const mainText = document.querySelector("main")?.textContent;
          const routerUrl = fixture.router.url;
          exportedNavigation.onnavigate = null;
          const handlerCleared = exportedNavigation.onnavigate === null;

          exportedNavigation.removeEventListener("navigate", listener);

          const laterNavigation = exportedNavigation.navigate("/one", { history: "push" });
          const laterFinished = await laterNavigation.finished;
          const events = [...fixture.events];
          return {
            originalHandlerReadback,
            replacementHandlerReadback,
            originalCalls,
            replacementCalls,
            listenerCalls,
            handlerCleared,
            currentEntryUrl,
            hasNavigate,
            hasBeforeLeave,
            usesNativeNavigationAPI: fixture.native,
            sameDocument,
            replacedMain,
            mainText,
            committedUrl: committed!.url,
            finishedUrl: finished!.url,
            laterFinishedUrl: laterFinished!.url,
            routerUrl,
            events,
          };
        });

        expect(result.usesNativeNavigationAPI).toBe(mode === "native");

        expect(result.originalHandlerReadback).toBe(true);

        expect(result.replacementHandlerReadback).toBe(true);

        expect(result.originalCalls).toStrictEqual([]);

        expect(result.replacementCalls).toStrictEqual([`http://127.0.0.1:${server.port}/two`]);

        expect(result.listenerCalls).toStrictEqual([`http://127.0.0.1:${server.port}/two`]);

        expect(result.handlerCleared).toBe(true);

        expect(result.currentEntryUrl).toBe(`http://127.0.0.1:${server.port}/one`);

        expect(result.hasNavigate).toBe(true);

        expect(result.hasBeforeLeave).toBe(false);

        expect(result.laterFinishedUrl).toBe(`http://127.0.0.1:${server.port}/one`);

        expect(result).toMatchObject({
          sameDocument: true,
          replacedMain: true,
          mainText: "/two",
          committedUrl: `http://127.0.0.1:${server.port}/two`,
          finishedUrl: `http://127.0.0.1:${server.port}/two`,
          routerUrl: `http://127.0.0.1:${server.port}/two`,
        });

        expect(result.events.filter((item) => item === "install:/two")).toHaveLength(1);

        expect(result.events).toContain("navigate:push:false:true");

        await capturePage?.();
      } finally {
        await browser.close();
      }
    }, 30_000);

    test(`${engine.name()} ${mode}: exact explicit-fragment navigation skips route work`, async () => {
      const browser = await engine.launch();

      try {
        const page = await browser.newPage();
        const capturePage = await browserCoverage?.preparePage(page, browser.version(), {
          engine: engine.name(),
          caseId: "exact-fragment",
          mode,
          documents: 1,
        });

        if (mode === "legacy")
          await page.addInitScript(() => {
            Object.defineProperty(window, "navigation", { configurable: true, value: undefined });
          });

        await page.goto(`http://127.0.0.1:${server.port}/one`);

        await page.waitForFunction(
          () =>
            (window as Window & { navigationFacadeFixture?: { ready: boolean } })
              .navigationFacadeFixture?.ready === true,
        );

        const result = await page.evaluate(async () => {
          const fixture = (
            window as unknown as Window & {
              navigationFacadeFixture: {
                navigation: Navigation;
                router: { readonly url: string };
                readonly guardCalls: number;
                native: boolean;
                navigationEvents: Array<{
                  type: string;
                  sameDocument: boolean;
                  hashChange: boolean;
                  url: string | null;
                }>;
              };
            }
          ).navigationFacadeFixture;
          const documentBefore = document;
          const initialMain = document.querySelector("main");
          const beforeGuards = fixture.guardCalls;
          const target = `${location.pathname}#details`;
          const firstEvent = fixture.navigationEvents.length;
          const changedFragment = fixture.navigation.navigate(target, {
            history: "push",
            state: { route: "changed-fragment" },
          });
          const changedCommitted = await changedFragment.committed;
          const changedFinished = await changedFragment.finished;
          const afterChangedGuards = fixture.guardCalls;
          const pageAfterChanged = document.querySelector("main");
          const exactEvent = fixture.navigationEvents.length;
          const exactFragment = fixture.navigation.navigate(target, {
            history: "push",
            state: { route: "exact-fragment" },
          });
          const exactCommitted = await exactFragment.committed;
          const exactFinished = await exactFragment.finished;
          return {
            sameDocument: document === documentBefore,
            changedFragmentRetainedMain: pageAfterChanged === initialMain,
            exactFragmentRetainedMain: document.querySelector("main") === pageAfterChanged,
            routerUrl: fixture.router.url,
            native: fixture.native,
            locationUrl: location.href,
            beforeGuards,
            afterChangedGuards,
            afterExactGuards: fixture.guardCalls,
            changed: {
              committedUrl: changedCommitted?.url,
              finishedUrl: changedFinished?.url,
              event: fixture.navigationEvents[firstEvent],
            },
            exact: {
              committedUrl: exactCommitted?.url,
              finishedUrl: exactFinished?.url,
              event: fixture.navigationEvents[exactEvent],
            },
          };
        });

        expect(result.sameDocument).toBe(true);

        expect(result.changedFragmentRetainedMain).toBe(true);

        expect(result.exactFragmentRetainedMain).toBe(true);

        expect(result.beforeGuards).toBeLessThan(result.afterChangedGuards);

        expect(result.afterExactGuards).toBe(result.afterChangedGuards);

        expect(result).toMatchObject({
          routerUrl: `http://127.0.0.1:${server.port}/one#details`,
          locationUrl: `http://127.0.0.1:${server.port}/one#details`,
          changed: {
            event: {
              type: "push",
              sameDocument: true,
              hashChange: true,
              url: `http://127.0.0.1:${server.port}/one#details`,
            },
          },
          exact: {
            event: {
              type: "push",
              sameDocument: true,
              hashChange: false,
              url: `http://127.0.0.1:${server.port}/one#details`,
            },
          },
        });

        await capturePage?.();
      } finally {
        await browser.close();
      }
    }, 30_000);

    test(`${engine.name()} ${mode}: direct History writes stay native`, async () => {
      const browser = await engine.launch();

      try {
        const page = await browser.newPage();
        const capturePage = await browserCoverage?.preparePage(page, browser.version(), {
          engine: engine.name(),
          caseId: "direct-history",
          mode,
          documents: 1,
        });

        if (mode === "legacy")
          await page.addInitScript(() => {
            Object.defineProperty(window, "navigation", { configurable: true, value: undefined });
          });

        await page.goto(`http://127.0.0.1:${server.port}/one`);

        await page.waitForFunction(
          () =>
            (window as Window & { navigationFacadeFixture?: { ready: boolean } })
              .navigationFacadeFixture?.ready === true,
        );

        const baseline = await page.evaluate(async () => {
          const fixture = (
            window as unknown as Window & {
              navigationFacadeFixture: {
                navigation: Navigation;
                router: { readonly url: string };
                readonly guardCalls: number;
                native: boolean;
              };
            }
          ).navigationFacadeFixture;
          const fragment = fixture.navigation.navigate("/one#start", { history: "push" });
          await fragment.finished;

          Object.assign(window, { nativeHistoryFixtureMain: document.querySelector("main") });

          return {
            native: fixture.native,
            routerUrl: fixture.router.url,
            guardCalls: fixture.guardCalls,
          };
        });
        const writes = await page.evaluate(() => {
          const fixture = (
            window as unknown as Window & {
              navigationFacadeFixture: {
                native: boolean;
                navigationEvents: Array<{
                  url: string | null;
                }>;
              };
            }
          ).navigationFacadeFixture;
          const firstEvent = fixture.navigationEvents.length;

          history.pushState({ direct: "fragment" }, "", "/one#other");

          history.pushState({ direct: "query" }, "", "/one?direct=true");

          return {
            native: fixture.native,
            firstEvent,
          };
        });

        if (writes.native) {
          await page.waitForFunction(
            (expectedCount) =>
              (
                window as Window & {
                  navigationFacadeFixture?: { navigationEvents: unknown[] };
                }
              ).navigationFacadeFixture?.navigationEvents.length === expectedCount,
            writes.firstEvent + 2,
            { timeout: 2_000 },
          );
        }

        const result = await page.evaluate((firstEvent) => {
          const fixture = (
            window as unknown as Window & {
              navigationFacadeFixture: {
                router: { readonly url: string };
                readonly guardCalls: number;
                navigationEvents: Array<{
                  type: string;
                  sameDocument: boolean;
                  hashChange: boolean;
                  url: string | null;
                }>;
              };
            }
          ).navigationFacadeFixture;
          return {
            routerUrl: fixture.router.url,
            locationUrl: location.href,
            guardCalls: fixture.guardCalls,
            retainedMain:
              document.querySelector("main") ===
              (window as Window & { nativeHistoryFixtureMain?: Element | null })
                .nativeHistoryFixtureMain,
            events: fixture.navigationEvents.slice(firstEvent),
          };
        }, writes.firstEvent);

        expect(result.routerUrl).toBe(result.locationUrl);

        expect(result.locationUrl).toBe(`http://127.0.0.1:${server.port}/one?direct=true`);

        expect(result.guardCalls).toBe(baseline.guardCalls);

        expect(result.retainedMain).toBe(true);

        if (writes.native) {
          expect(result.events).toHaveLength(2);

          expect(result.events).toMatchObject([
            {
              type: "push",
              sameDocument: true,
              hashChange: false,
              url: `http://127.0.0.1:${server.port}/one#other`,
            },
            {
              type: "push",
              sameDocument: true,
              hashChange: false,
              url: `http://127.0.0.1:${server.port}/one?direct=true`,
            },
          ]);
        } else expect(result.events).toHaveLength(0);

        await capturePage?.();
      } finally {
        await browser.close();
      }
    }, 30_000);
  }
}
