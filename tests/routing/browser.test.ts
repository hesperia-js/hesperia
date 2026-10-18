import { afterAll, beforeAll, expect, test } from "bun:test";
import { chromium, firefox, webkit } from "playwright";
import { appendFileSync, mkdirSync, mkdtempSync } from "node:fs";
import { resolve } from "node:path";
import type { Router } from "../../packages/hesperia/src/routing/index.ts";
import { startBrowserDiagnostics } from "../tooling/fixtures/drivers/browser-diagnostics.mjs";
import { startProcessDiagnostics } from "../tooling/fixtures/drivers/process-diagnostics.mjs";
import { observeFetch } from "../tooling/server-diagnostics.ts";

let server: ReturnType<typeof Bun.serve>;
let serverDiagnostics: ReturnType<typeof startProcessDiagnostics> | undefined;

beforeAll(async () => {
  const build = await Bun.build({
    entrypoints: [resolve(import.meta.dir, "browser.fixture.ts")],
    target: "browser",
    format: "esm",
  });

  if (!build.success)
    throw new AggregateError(build.logs, "Routing browser fixture did not bundle");

  const script = await build.outputs[0]!.text();
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,

    fetch: observeFetch(
      (request: Request) => {
        if (new URL(request.url).pathname === "/entry.js")
          return new Response(script, { headers: { "content-type": "text/javascript" } });

        return new Response(
          '<!doctype html><title>routing</title><a id="next" href="/next"><span>Next</span></a><a id="probe" href="/probe">Probe</a><div id="route"></div><div id="scroll-space" style="height:2400px"></div><script type="module" src="/entry.js"></script>',
          { headers: { "content-type": "text/html" } },
        );
      },
      (kind, detail) => serverDiagnostics?.mark(kind, detail),
    ),
  });
});

afterAll(() => {
  server?.stop(true);
});

for (const engine of [chromium, firefox, webkit]) {
  for (const legacy of [false, true]) {
    test(`${engine.name()} ${legacy ? "legacy" : "native"}: fragment navigation preserves the page and restores presentation on Back`, async () => {
      const browser = await engine.launch();

      try {
        const page = await browser.newPage();

        if (legacy)
          await page.addInitScript(() => {
            Object.defineProperty(window, "navigation", { configurable: true, value: undefined });
          });

        await page.goto(`http://127.0.0.1:${server.port}/`);

        await page.waitForFunction(
          () => (window as unknown as { routingFixture: { ready: boolean } }).routingFixture.ready,
        );

        const moved = await page.evaluate(async () => {
          const fixture = (
            window as unknown as { routingFixture: { router: Router; events: string[] } }
          ).routingFixture;
          const main = document.querySelector("main")!;
          const heading = document.createElement("h2");
          heading.id = "detail";
          heading.textContent = "Details";
          heading.style.marginTop = "1000px";

          main.append(heading);

          main.dataset.retained = "true";

          document.getElementById("route-focus")!.focus({ preventScroll: true });

          window.scrollTo(0, 120);

          const length = history.length;

          await fixture.router.navigate("/#detail", { history: "push" });

          return {
            sameNode: document.querySelector("main") === main,
            focused: document.activeElement === heading,
            scrolled: window.scrollY > 500,
            extraEntries: history.length - length,
            installs: fixture.events.filter((item) => item.startsWith("install:")),
          };
        });

        expect(moved).toStrictEqual({
          sameNode: true,
          focused: true,
          scrolled: true,
          extraEntries: 1,
          installs: ["install:/"],
        });

        await page.evaluate(async () => {
          const fixture = (window as unknown as { routingFixture: { router: Router } })
            .routingFixture;
          const heading = document.createElement("h2");
          heading.id = "other";
          heading.textContent = "Other details";
          heading.style.marginTop = "700px";

          document.querySelector("main")!.append(heading);

          document.getElementById("route-focus")!.focus({ preventScroll: true });

          window.scrollTo(0, 240);

          await fixture.router.navigate("/#other", { history: "push" });
        });

        await page.evaluate(() => {
          const fixture = (
            window as unknown as {
              routingFixture: {
                guardPending: boolean;
                guardStarted: boolean;
                hashSettled?: boolean;
              };
            }
          ).routingFixture;
          fixture.guardPending = true;
          fixture.guardStarted = false;
          fixture.hashSettled = false;

          window.addEventListener(
            "hashchange",
            () => {
              fixture.hashSettled = true;
            },
            { once: true },
          );

          history.back();
        });

        await page.waitForFunction(
          () =>
            (
              window as unknown as {
                routingFixture: { guardStarted: boolean };
              }
            ).routingFixture.guardStarted,
        );

        if (legacy)
          await page.waitForFunction(
            () =>
              (
                window as unknown as {
                  routingFixture: { hashSettled: boolean };
                }
              ).routingFixture.hashSettled,
          );

        await page.evaluate(() => {
          const fixture = (
            window as unknown as {
              routingFixture: { guardPending: boolean; releaseGuard: (allow: boolean) => void };
            }
          ).routingFixture;
          fixture.guardPending = false;

          fixture.releaseGuard(true);
        });

        await page
          .waitForFunction(
            () =>
              location.hash === "#detail" &&
              document.activeElement?.id === "route-focus" &&
              window.scrollY === 240,
            undefined,
            { timeout: 10_000 },
          )
          .catch(async (cause) => {
            const state = await page.evaluate(() => ({
              url: location.href,
              focus: document.activeElement?.id,
              scroll: window.scrollY,
              events: (window as unknown as { routingFixture: { events: string[] } }).routingFixture
                .events,
            }));
            throw new Error(`Fragment history restoration failed: ${JSON.stringify(state)}`, {
              cause,
            });
          });

        await page.evaluate(() => history.back());

        await page.waitForFunction(
          () =>
            location.hash === "" &&
            document.activeElement?.id === "route-focus" &&
            window.scrollY === 120,
          undefined,
          { timeout: 10_000 },
        );

        expect(await page.locator("main").getAttribute("data-retained")).toBe("true");
      } finally {
        await browser.close();
      }
    }, 30_000);
  }

  test(`${engine.name()}: history tracking preserves native calls and distinct entries during nested writes`, async () => {
    const browser = await engine.launch();

    try {
      const page = await browser.newPage();

      await page.goto(`http://127.0.0.1:${server.port}/`);

      await page.waitForFunction(
        () => (window as unknown as { routingFixture: { ready: boolean } }).routingFixture.ready,
      );

      const result = await page.evaluate(() => {
        const before = { length: history.length, url: location.href };
        let conversions = 0;
        const url = {
          toString() {
            conversions++;
            return "/converted";
          },
        };
        let receiverError: string | undefined;

        try {
          Reflect.apply(history.pushState, {}, [null, "", url]);
        } catch (error) {
          receiverError = (error as Error).name;
        }

        const invalidReceiverConversions = conversions;
        let argumentError: string | undefined;

        try {
          Reflect.apply(history.pushState, history, [null]);
        } catch (error) {
          argumentError = (error as Error).name;
        }

        const preserved = history.length === before.length && location.href === before.url;

        Reflect.apply(history.pushState, history, [{ value: 1 }, "", url]);

        return {
          receiverError,
          argumentError,
          invalidReceiverConversions,
          preserved,
          conversions,
          path: location.pathname,
          extraEntries: history.length - before.length,
        };
      });

      expect(result).toStrictEqual({
        receiverError: "TypeError",
        argumentError: "TypeError",
        invalidReceiverConversions: 0,
        preserved: true,
        conversions: 1,
        path: "/converted",
        extraEntries: 1,
      });

      const nested = await page.evaluate(() => {
        type Entry = { trackerId: string; id: number; position: number };

        const nativeHistoryState = () => {
          let prototype = Object.getPrototypeOf(history) as object | null;

          while (prototype) {
            const getter = Object.getOwnPropertyDescriptor(prototype, "state")?.get;

            if (getter) return Reflect.apply(getter, history, []);

            prototype = Object.getPrototypeOf(prototype);
          }

          throw new Error("History has no native state getter");
        };

        let inner!: Entry;
        const length = history.length;

        history.pushState(
          {
            get value() {
              history.pushState({ inner: true }, "", "/inner");

              inner = (nativeHistoryState() as { __hesperiaHistory: Entry }).__hesperiaHistory;
              return "outer";
            },
          },
          "",
          "/outer",
        );

        const outer = (nativeHistoryState() as { __hesperiaHistory: Entry }).__hesperiaHistory;
        return {
          distinct: outer.trackerId !== inner.trackerId || outer.id !== inner.id,
          consecutive: outer.position === inner.position + 1,
          entries: history.length - length,
          path: location.pathname,
        };
      });

      expect(nested).toStrictEqual({
        distinct: true,
        consecutive: true,
        entries: 2,
        path: "/outer",
      });
    } finally {
      await browser.close();
    }
  }, 20_000);

  test(`${engine.name()}: direct history writes retain author state across router adoption and native traversal`, async () => {
    const browser = await engine.launch();

    try {
      const page = await browser.newPage();
      const errors: string[] = [];

      page.on("pageerror", (error) => errors.push(error.message));

      await page.goto(`http://127.0.0.1:${server.port}/`);

      await page.waitForFunction(
        () => (window as unknown as { routingFixture: { ready: boolean } }).routingFixture.ready,
      );

      const writes = await page.evaluate(async () => {
        const fixture = (
          window as unknown as { routingFixture: { router: Router; events: string[] } }
        ).routingFixture;
        const length = history.length;
        const author = { selection: { tab: "details" } };

        history.pushState(author, "", "/direct");

        author.selection.tab = "changed after push";
        const unchanged = document.querySelector("main")?.textContent;

        await fixture.router.navigate(location.href, { history: "none" });

        const pushed = fixture.router.state;

        history.replaceState(undefined, "", "/replaced");

        await fixture.router.navigate(location.href, { history: "none" });

        const replacedUndefined = fixture.router.state === undefined;

        history.pushState(null, "", "/null");

        await fixture.router.navigate(location.href, { history: "none" });

        const pushedNull = fixture.router.state === null;
        const beforeFailure = location.href;
        let cloneError: string | undefined;

        try {
          history.pushState(() => undefined, "", "/must-not-exist");
        } catch (error) {
          cloneError = (error as DOMException).name;
        }

        let originError: string | undefined;

        try {
          history.replaceState({ invalid: true }, "", "https://example.com/foreign");
        } catch (error) {
          originError = (error as DOMException).name;
        }

        return {
          unchanged,
          pushed,
          replacedUndefined,
          pushedNull,
          extraEntries: history.length - length,
          cloneError,
          originError,
          addressPreserved: location.href === beforeFailure,
          statePreserved: fixture.router.state === null,
          events: fixture.events,
        };
      });

      expect(writes).toStrictEqual({
        unchanged: "/",
        pushed: { selection: { tab: "details" } },
        replacedUndefined: true,
        pushedNull: true,
        extraEntries: 2,
        cloneError: "DataCloneError",
        originError: "SecurityError",
        addressPreserved: true,
        statePreserved: true,
        events: ["install:/", "install:/direct", "install:/replaced", "install:/null"],
      });

      const traversal = await page.evaluate(async () => {
        const { router } = (window as unknown as { routingFixture: { router: Router } })
          .routingFixture;

        const traverse = (delta: number) =>
          new Promise<void>((resolve) => {
            window.addEventListener("popstate", () => resolve(), { once: true });

            history.go(delta);
          });

        await traverse(-1);

        await router.navigate(location.href, { history: "none" });

        const replaced = { path: location.pathname, undefinedState: router.state === undefined };

        history.pushState({ branch: "new" }, "", "/branch");

        await router.navigate(location.href, { history: "none" });

        await traverse(-1);

        await router.navigate(location.href, { history: "none" });

        await traverse(1);

        await router.navigate(location.href, { history: "none" });

        return { replaced, path: location.pathname, state: router.state };
      });

      expect(traversal).toStrictEqual({
        replaced: { path: "/replaced", undefinedState: true },
        path: "/branch",
        state: { branch: "new" },
      });

      expect(errors).toStrictEqual([]);
    } finally {
      await browser.close();
    }
  }, 20_000);

  test(`${engine.name()}: native links navigate once and preserve modified/download/target/platform behavior`, async () => {
    const browser = await engine.launch();

    try {
      const page = await browser.newPage();

      await page.goto(`http://127.0.0.1:${server.port}/`);

      await page.waitForFunction(
        () => (window as unknown as { routingFixture: { ready: boolean } }).routingFixture.ready,
      );

      const length = await page.evaluate(() => history.length);

      await page.locator("#next span").click();

      await page.waitForFunction(() => document.querySelector("main")?.textContent === "/next");

      expect(await page.evaluate(() => history.length)).toBe(length + 1);

      expect(await page.title()).toBe("/next");

      const outcomes = await page.evaluate(() => {
        const anchor = document.getElementById("probe")!;
        const prevented: boolean[] = [];

        const preserveNative = (event: MouseEvent) => {
          prevented.push(event.defaultPrevented);

          event.preventDefault();
        };

        document.addEventListener("click", preserveNative);

        const dispatch = (options: MouseEventInit = {}) =>
          anchor.dispatchEvent(
            new MouseEvent("click", {
              bubbles: true,
              cancelable: true,
              composed: true,
              button: 0,
              ...options,
            }),
          );

        dispatch({ ctrlKey: true });

        dispatch({ metaKey: true });

        dispatch({ shiftKey: true });

        dispatch({ altKey: true });

        dispatch({ button: 1 });

        anchor.setAttribute("download", "file");

        dispatch();

        anchor.removeAttribute("download");

        anchor.setAttribute("target", "_blank");

        dispatch();

        anchor.removeAttribute("target");

        anchor.setAttribute("href", "https://example.com/");

        dispatch();

        anchor.setAttribute("href", "mailto:test@example.com");

        dispatch();

        anchor.setAttribute("href", "/probe");

        document.removeEventListener("click", preserveNative);

        return prevented;
      });

      expect(outcomes).toStrictEqual(Array(9).fill(false));

      expect(await page.locator("main").textContent()).toBe("/next");

      expect(
        await page.evaluate(() =>
          (
            window as unknown as { routingFixture: { events: string[] } }
          ).routingFixture.events.filter((event) => event.startsWith("install")),
        ),
      ).toStrictEqual(["install:/", "install:/next"]);
    } finally {
      await browser.close();
    }
  }, 20_000);

  test(`${engine.name()}: browser Back restores a route through the history adapter`, async () => {
    const browser = await engine.launch();

    try {
      const page = await browser.newPage();

      await page.goto(`http://127.0.0.1:${server.port}/`);

      await page.waitForFunction(
        () => (window as unknown as { routingFixture: { ready: boolean } }).routingFixture.ready,
      );

      await page.evaluate(() => {
        const fixture = (
          window as unknown as {
            routingFixture: { beforeBackNode?: HTMLElement };
          }
        ).routingFixture;
        fixture.beforeBackNode = document.querySelector("main")!;

        document.querySelector<HTMLButtonElement>("#route-focus")!.focus();

        window.scrollTo(0, 640);
      });

      await page.waitForFunction(
        () => document.activeElement?.id === "route-focus" && window.scrollY >= 640,
      );

      await page.evaluate(async () => {
        const router = (window as unknown as { routingFixture: { router: Router } }).routingFixture
          .router;

        await router.navigate("/next", { history: "push" });
      });

      await page.waitForFunction(() => document.querySelector("main")?.textContent === "/next");

      await page.evaluate(() => history.back());

      await page.waitForFunction(() => document.querySelector("main")?.textContent === "/");

      expect(await page.evaluate(() => location.pathname)).toBe("/");

      expect(
        await page.evaluate(() => {
          const fixture = (
            window as unknown as {
              routingFixture: { beforeBackNode?: HTMLElement };
            }
          ).routingFixture;
          return {
            recreated: fixture.beforeBackNode !== document.querySelector("main"),
            focus: document.activeElement?.id,
            scrollY: window.scrollY,
          };
        }),
      ).toStrictEqual({ recreated: true, focus: "route-focus", scrollY: 640 });

      expect(
        await page.evaluate(
          () =>
            (window as unknown as { routingFixture: { router: Router } }).routingFixture.router
              .state,
        ),
      ).toStrictEqual({ entry: "root" });
    } finally {
      await browser.close();
    }
  }, 20_000);

  test(`${engine.name()}: native Back redirects without leaving the physical history entry behind`, async () => {
    const browser = await engine.launch();

    try {
      const page = await browser.newPage();

      await page.goto(`http://127.0.0.1:${server.port}/`);

      await page.waitForFunction(
        () => (window as unknown as { routingFixture: { ready: boolean } }).routingFixture.ready,
      );

      await page.locator("#next").click();

      await page.waitForFunction(() => document.querySelector("main")?.textContent === "/next");

      const length = await page.evaluate(() => history.length);

      await page.evaluate(
        () =>
          ((
            window as unknown as { routingFixture: { redirectBack: boolean } }
          ).routingFixture.redirectBack = true),
      );

      await page.evaluate(() => history.back());

      await page.waitForFunction(
        () => document.querySelector("main")?.textContent === "/redirected",
      );

      await page.waitForURL("**/redirected");

      expect(await page.evaluate(() => location.pathname)).toBe("/redirected");

      expect(await page.evaluate(() => history.length)).toBe(length);

      expect(
        await page.evaluate(
          () =>
            (window as unknown as { routingFixture: { router: Router } }).routingFixture.router
              .state,
        ),
      ).toStrictEqual({ entry: "root" });
    } finally {
      await browser.close();
    }
  }, 20_000);

  test(`${engine.name()}: a Back veto restores the exact committed browser entry`, async () => {
    const browser = await engine.launch();

    try {
      const page = await browser.newPage();

      await page.goto(`http://127.0.0.1:${server.port}/`);

      await page.waitForFunction(
        () => (window as unknown as { routingFixture: { ready: boolean } }).routingFixture.ready,
      );

      await page.locator("#next").click();

      await page.waitForFunction(() => document.querySelector("main")?.textContent === "/next");

      const guardVetoes = await page.evaluate(
        () =>
          (window as unknown as { routingFixture: { guardVetoes: number } }).routingFixture
            .guardVetoes,
      );

      await page.evaluate(
        () =>
          ((
            window as unknown as { routingFixture: { denyBack: boolean } }
          ).routingFixture.denyBack = true),
      );

      await page.evaluate(() => history.back());

      await page.waitForFunction(
        (before) =>
          (window as unknown as { routingFixture: { guardVetoes: number } }).routingFixture
            .guardVetoes > before,
        guardVetoes,
      );

      await page.waitForFunction(() => location.pathname === "/next");

      expect(await page.locator("main").textContent()).toBe("/next");
    } finally {
      await browser.close();
    }
  }, 20_000);

  test(`${engine.name()}: fallback Back keeps the outgoing native page during an async veto`, async () => {
    const browser = await engine.launch();

    try {
      const page = await browser.newPage();

      await page.addInitScript(() => {
        Object.defineProperty(window, "navigation", {
          configurable: true,
          value: undefined,
        });
      });

      await page.goto(`http://127.0.0.1:${server.port}/`);

      await page.waitForFunction(
        () => (window as unknown as { routingFixture: { ready: boolean } }).routingFixture.ready,
      );

      await page.locator("#next").click();

      await page.waitForFunction(() => document.querySelector("main")?.textContent === "/next");

      const historyLength = await page.evaluate(() => history.length);

      await page.evaluate(() => {
        const fixture = (window as unknown as { routingFixture: { guardPending: boolean } })
          .routingFixture;
        fixture.guardPending = true;

        history.back();
      });

      await page.waitForFunction(
        () =>
          (window as unknown as { routingFixture: { guardStarted: boolean } }).routingFixture
            .guardStarted,
      );

      expect(
        await page.evaluate(() => {
          const fixture = window as unknown as {
            routingFixture: { lastNode?: Node };
          };
          return {
            sameNode: fixture.routingFixture.lastNode === document.querySelector("main"),
            text: document.querySelector("main")?.textContent,
          };
        }),
      ).toStrictEqual({ sameNode: true, text: "/next" });

      await page.evaluate(() => {
        const fixture = window as unknown as {
          routingFixture: { releaseGuard?: (decision: boolean) => void };
        };

        fixture.routingFixture.releaseGuard?.(false);
      });

      await page.waitForFunction(() => location.pathname === "/next");

      expect(await page.evaluate(() => history.length)).toBe(historyLength);

      expect(await page.locator("main").textContent()).toBe("/next");

      await page.evaluate(() => {
        const fixture = (window as unknown as { routingFixture: { guardPending: boolean } })
          .routingFixture;
        fixture.guardPending = false;

        history.back();
      });

      await page.waitForFunction(() => document.querySelector("main")?.textContent === "/");

      expect(
        await page.evaluate(
          () =>
            (window as unknown as { routingFixture: { router: Router } }).routingFixture.router
              .state,
        ),
      ).toStrictEqual({ entry: "root" });

      expect(await page.evaluate(() => history.length)).toBe(historyLength);
    } finally {
      await browser.close();
    }
  }, 20_000);

  const modes =
    engine.name() === "webkit" ? (["legacy"] as const) : (["native", "legacy"] as const);

  for (const mode of modes) {
    test(`${engine.name()} ${mode}: a newer programmatic route wins over a pending traversal`, async () => {
      const diagnosticsRoot = resolve(import.meta.dir, "../../.hesperia/browser-diagnostics");

      mkdirSync(diagnosticsRoot, { recursive: true });

      const directory = mkdtempSync(resolve(diagnosticsRoot, "pending-traversal-"));
      const label = `${engine.name()}-${mode}`;
      const driver = startProcessDiagnostics({ directory, label: "bun-driver" });
      serverDiagnostics = driver;
      const started = Date.now();
      let browser: Awaited<ReturnType<typeof engine.launch>> | undefined;
      let diagnostics: Awaited<ReturnType<typeof startBrowserDiagnostics>> | undefined;
      let failed = false;

      function mark(step: string, detail?: unknown) {
        driver.mark(step, detail);

        try {
          // Bun's outer deadline can bypass capture and dispose the browser.
          appendFileSync(
            resolve(directory, "checkpoints.jsonl"),
            JSON.stringify({ label, elapsedMs: Date.now() - started, step, detail }) + "\n",
          );
        } catch (error) {
          console.error(`[browser diagnostics] ${label} checkpoint: ${String(error)}`);
        }

        diagnostics?.mark(step, detail);
      }

      try {
        mark("browser-launch");

        browser = await engine.launch();

        browser.on("disconnected", () => mark("browser-disconnected"));

        mark("browser-launched");

        mark("page-create");

        const page = await browser.newPage();

        mark("page-created");

        diagnostics = await startBrowserDiagnostics(page, { directory, label });

        mark("diagnostics-started");

        if (mode === "legacy")
          await page.addInitScript(() => {
            Object.defineProperty(window, "navigation", {
              configurable: true,
              value: undefined,
            });
          });

        mark("document-navigation");

        await page.goto(`http://127.0.0.1:${server.port}/`);

        mark("document-loaded");

        await page.waitForFunction(
          () => (window as unknown as { routingFixture: { ready: boolean } }).routingFixture.ready,
        );

        mark("fixture-ready");

        const selectedNativePath = await page.evaluate(() => {
          const candidate = window as unknown as {
            navigation?: {
              currentEntry?: unknown;
              addEventListener?: unknown;
              back?: unknown;
            };
            NavigateEvent?: { prototype?: { intercept?: unknown } };
            NavigationPrecommitController?: unknown;
          };
          return (
            candidate.navigation !== undefined &&
            typeof candidate.NavigateEvent?.prototype?.intercept === "function" &&
            typeof candidate.NavigationPrecommitController === "function" &&
            candidate.navigation.currentEntry !== undefined &&
            typeof candidate.navigation.addEventListener === "function" &&
            typeof candidate.navigation.back === "function"
          );
        });

        mark("native-path-selected", selectedNativePath);

        expect(selectedNativePath).toBe(mode === "native");

        mark("next-click");

        await page.locator("#next").click();

        mark("next-click-completed");

        await page.waitForFunction(() => document.querySelector("main")?.textContent === "/next");

        mark("next-visible");

        mark("traversal-start");

        const traversal = page.evaluate(async (native) => {
          const candidate = window as unknown as {
            navigation?: { back: () => { finished: Promise<unknown> } };
            routingFixture: {
              guardPending: boolean;
              guardStarted: boolean;
            };
          };
          const fixture = candidate.routingFixture;
          fixture.guardPending = true;
          fixture.guardStarted = false;

          if (native) {
            const navigation = candidate.navigation;

            if (!navigation) throw new Error("Native navigation disappeared before Back");

            try {
              await navigation.back().finished;
              return { status: "fulfilled" };
            } catch (error: unknown) {
              return {
                status: "rejected",
                name:
                  typeof error === "object" && error !== null && "name" in error
                    ? String(error.name)
                    : String(error),
              };
            }
          } else {
            history.back();

            return null;
          }
        }, mode === "native");

        mark("guard-wait");

        await page.waitForFunction(
          () =>
            (window as unknown as { routingFixture: { guardStarted: boolean } }).routingFixture
              .guardStarted,
        );

        mark("guard-started");

        mark("programmatic-navigation");

        const result = await page.evaluate(async () => {
          const router = (window as unknown as { routingFixture: { router: Router } })
            .routingFixture.router;
          return router.navigate("/programmatic", {
            history: "push",
            state: { entry: "programmatic" },
          });
        });

        mark("programmatic-navigation-finished", result);

        expect(result.status).toBe("committed");

        await page.waitForFunction(
          () => document.querySelector("main")?.textContent === "/programmatic",
        );

        mark("programmatic-visible");

        mark("guard-release");

        const released = await page.evaluate(() => {
          const fixture = (
            window as unknown as {
              routingFixture: { releaseGuard?: (decision: boolean) => void };
            }
          ).routingFixture;

          if (!fixture.releaseGuard) return false;

          fixture.releaseGuard(true);

          return true;
        });

        mark("guard-released", released);

        expect(released).toBe(true);

        mark("traversal-outcome-wait");

        const traversalOutcome = await traversal;

        mark("traversal-outcome", traversalOutcome);

        if (mode === "native") {
          expect(traversalOutcome).toStrictEqual({ status: "rejected", name: "AbortError" });
        }

        mark("final-route-read");

        const finalRoute = await page.evaluate(() => {
          const router = (window as unknown as { routingFixture: { router: Router } })
            .routingFixture.router;
          return {
            pathname: location.pathname,
            content: document.querySelector("main")?.textContent,
            state: router.state,
          };
        });

        mark("final-route", finalRoute);

        expect(finalRoute).toStrictEqual({
          pathname: "/programmatic",
          content: "/programmatic",
          state: { entry: "programmatic" },
        });

        mark("assertions-completed");
      } catch (error) {
        failed = true;

        mark("failure", String(error));

        await diagnostics?.capture(error);

        console.error(`[browser diagnostics] ${label}: ${directory}`);

        throw error;
      } finally {
        try {
          mark("diagnostics-dispose");

          await diagnostics?.dispose().catch((error) => {
            if (!failed) throw error;
          });
        } finally {
          diagnostics = undefined;

          mark("browser-close");

          try {
            await browser?.close().then(
              () => mark("browser-closed"),
              (error) => {
                mark("browser-close-failed", String(error));

                if (!failed) throw error;
              },
            );
          } finally {
            if (serverDiagnostics === driver) serverDiagnostics = undefined;

            driver.dispose();
          }
        }
      }
    }, 20_000);
  }
}
