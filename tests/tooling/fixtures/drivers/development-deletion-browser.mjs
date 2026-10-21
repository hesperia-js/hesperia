import assert from "node:assert/strict";
import { writeFile, rm } from "node:fs/promises";
import { startBrowserDiagnostics } from "./browser-diagnostics.mjs";
import { startProcessDiagnostics } from "./process-diagnostics.mjs";

/** @typedef {"chromium" | "firefox" | "webkit"} BrowserName */

/** @typedef {import("playwright").Browser} Browser */
/** @typedef {import("playwright").Page} Page */

const [
  playwrightModuleUrl,
  engineName,
  applicationUrl,
  cssPath,
  removedPath,
  navigationMode,
  diagnosticsDirectory,
] = process.argv.slice(2);

/** @param {Page} page */
async function installRecorder(page) {
  await page.addInitScript(
    ({ prefix, origin }) => {
      if (window !== window.top || location.origin !== origin) return;

      /** @type {(() => void)[]} */
      const setupCleanups = [];
      /** @type {string | undefined} */
      let documentToken;

      try {
        const token = crypto.randomUUID();
        documentToken = token;
        /** @type {WeakMap<Node, number>} */
        const identities = new WeakMap();
        let nextNode = 0;
        let sequence = 0;
        let stopped = false;
        let capSent = false;
        let errorSent = false;
        /** @type {Element | null} */
        let previousCount = null;
        /** @type {Map<number, Element>} */
        const pending = new Map();
        let nextTask = 0;
        const channel = new MessageChannel();
        setupCleanups.push(() => {
          pending.clear();
          channel.port1.close();
          channel.port2.close();
        });
        /** @type {{target: EventTarget, name: string, listener: EventListener, capture: boolean}[]} */
        const listeners = [];
        setupCleanups.push(() => {
          for (const item of listeners)
            item.target.removeEventListener(item.name, item.listener, item.capture);
        });

        /** @param {Node | null} node */
        function identify(node) {
          if (!node) return null;

          if (!identities.has(node)) identities.set(node, ++nextNode);

          return identities.get(node);
        }

        /** @param {Node | null} node */
        function describe(node) {
          return node instanceof Element
            ? {
                node: identify(node),
                id: node.id.slice(0, 80),
                tag: node.tagName,
                text: node.textContent?.slice(0, 160),
                connected: node.isConnected,
                disabled: node instanceof HTMLButtonElement ? node.disabled : undefined,
              }
            : {
                node: identify(node),
                text: node?.textContent?.slice(0, 160),
                connected: node?.isConnected,
              };
        }

        /** @param {string} kind @param {Record<string, unknown>} [detail] */
        function emit(kind, detail = {}) {
          const value = {
            kind,
            document: token,
            sequence: ++sequence,
            timeOrigin: performance.timeOrigin,
            now: performance.now(),
            url: location.href.slice(0, 1000),
            ...detail,
          };
          const payload = JSON.stringify(value);

          if (new TextEncoder().encode(payload).length > 6000)
            throw new Error("Browser diagnostic payload exceeds 6000 bytes");

          console.debug(prefix + payload);
        }

        /** @param {unknown} error */
        function captureError(error) {
          if (errorSent) return;

          errorSent = true;

          try {
            emit("capture-error", { error: String(error).slice(0, 300) });
          } catch {
            // An unavailable transport leaves missing evidence.
          }
        }

        /** @param {string} kind @param {Record<string, unknown>} [detail] */
        function record(kind, detail = {}) {
          if (stopped || capSent) return;

          try {
            if (sequence >= 498) {
              capSent = true;
              emit("capture-cap", { limit: 500, pendingTasks: pending.size });
              return;
            }

            const matches = document.querySelectorAll("#count");
            const count = matches[0] ?? null;
            previousCount = count ?? previousCount;
            const navigation = window.navigation;

            emit(kind, {
              state: {
                readyState: document.readyState,
                fixtureIdentity: globalThis.documentIdentity,
                removals: globalThis.removals,
                styleRevisions: globalThis.styleRevisions,
                countMatches: matches.length,
                counts: [...matches].slice(0, 3).map(describe),
                countListTruncated: matches.length > 3,
                routeA: !!document.querySelector("#a"),
                routeB: !!document.querySelector("#b"),
                navigationAvailable: !!navigation,
                transition: !!navigation?.transition,
                entryURL: navigation?.currentEntry?.url?.slice(0, 1000),
              },
              ...detail,
            });
          } catch (error) {
            captureError(error);
          }
        }

        /** @param {EventTarget} target @param {string} name @param {(event: any) => void} run @param {boolean} [capture] */
        function listen(target, name, run, capture = false) {
          /** @type {EventListener} */
          const listener = (event) => {
            try {
              run(event);
            } catch (error) {
              captureError(error);
            }
          };
          target.addEventListener(name, listener, capture);
          listeners.push({ target, name, listener, capture });
        }

        channel.port1.onmessage = (event) => {
          try {
            const target = pending.get(event.data);
            pending.delete(event.data);

            if (target && !stopped) record("click-task", { clicked: describe(target) });
          } catch (error) {
            captureError(error);
          }
        };

        /** @param {Event} event @param {string} kind */
        function pointer(event, kind) {
          if (stopped || capSent) return;

          const target = event.target instanceof Element ? event.target : null;
          const path = event.composedPath();
          const mouse = event instanceof MouseEvent ? event : null;

          record(kind, {
            trusted: event.isTrusted,
            defaultPrevented: event.defaultPrevented,
            target: describe(target),
            button: mouse?.button,
            x: mouse?.clientX,
            y: mouse?.clientY,
            anchor: target?.closest("a")?.getAttribute("href")?.slice(0, 300),
            path: path
              .slice(0, 6)
              .filter((item) => item instanceof Node)
              .map((item) => identify(/** @type {Node} */ (item))),
            pathTruncated: path.length > 6,
          });

          if (kind === "click-capture" && target?.closest("#count")) {
            if (pending.size >= 8) {
              record("click-task-cap", { limit: 8 });
              return;
            }

            const task = ++nextTask;
            pending.set(task, /** @type {Element} */ (target.closest("#count")));
            channel.port2.postMessage(task);
          }
        }

        for (const name of ["pointerdown", "pointerup", "click"]) {
          listen(document, name, (event) => pointer(event, `${name}-capture`), true);
          listen(document, name, (event) =>
            pointer(event, name === "click" ? "click-bubble" : `${name}-bubble`),
          );
        }

        const mutationObserver = new MutationObserver((changes) => {
          if (stopped || capSent) return;

          try {
            const relevant = changes.filter((change) => {
              if (previousCount?.contains(change.target)) return true;

              return [...change.addedNodes, ...change.removedNodes].some(
                (node) =>
                  node instanceof Element &&
                  (node.matches("#count") || node.querySelector("#count")),
              );
            });

            if (relevant.length)
              record("counter-mutation", {
                mutations: relevant.slice(0, 2).map((change) => ({
                  type: change.type,
                  targetNode: identify(change.target),
                  targetText: change.target.textContent?.slice(0, 160),
                  oldText: change.oldValue?.slice(0, 160),
                  added: [...change.addedNodes].slice(0, 2).map(identify),
                  removed: [...change.removedNodes].slice(0, 2).map(identify),
                  nodesTruncated: change.addedNodes.length > 2 || change.removedNodes.length > 2,
                })),
                mutationsTruncated: relevant.length > 2,
              });
          } catch (error) {
            captureError(error);
          }
        });
        setupCleanups.push(() => mutationObserver.disconnect());
        mutationObserver.observe(document, {
          subtree: true,
          childList: true,
          characterData: true,
          characterDataOldValue: true,
        });

        for (const name of [
          "hesperia:style-revision",
          "hesperia:dev-source-removal",
          "fixture-departure",
          "fixture-api-result",
          "pageshow",
          "popstate",
          "hashchange",
        ])
          listen(window, name, (event) =>
            record(name, {
              persisted: event.persisted,
              detail: typeof event.detail === "string" ? event.detail.slice(0, 200) : undefined,
            }),
          );

        listen(window, "error", (event) =>
          record("window-error", { error: String(event.message).slice(0, 500) }),
        );
        listen(window, "unhandledrejection", (event) =>
          record("window-rejection", { error: String(event.reason).slice(0, 500) }),
        );

        if (window.navigation) {
          for (const name of ["navigate", "currententrychange", "navigatesuccess", "navigateerror"])
            listen(window.navigation, name, (event) =>
              record(`navigation-${name}`, {
                destination: event.destination?.url?.slice(0, 1000),
                error: String(event.error ?? "").slice(0, 300),
              }),
            );
        }

        listen(window, "pagehide", (event) => {
          record("pagehide", { persisted: event.persisted, pendingTasks: pending.size });
          stopped = true;
          mutationObserver.disconnect();
          pending.clear();
          channel.port1.close();
          channel.port2.close();

          for (const item of listeners)
            item.target.removeEventListener(item.name, item.listener, item.capture);
        });

        record("capture-ready", { recordLimit: 500, taskLimit: 8 });
      } catch (error) {
        for (const cleanup of setupCleanups.reverse()) {
          try {
            cleanup();
          } catch {
            /* Partial setup must not affect the fixture. */
          }
        }

        try {
          console.debug(
            prefix +
              JSON.stringify({
                kind: "capture-error",
                stage: "setup",
                document: documentToken ?? null,
                sequence: 1,
                error: String(error).slice(0, 500),
              }),
          );
        } catch {
          // An unavailable transport leaves missing evidence.
        }
      }
    },
    { prefix, origin: new URL(applicationUrl).origin },
  );
}

const playwright = /** @type {typeof import("playwright")} */ (await import(playwrightModuleUrl));

const browserName = /** @type {BrowserName} */ (engineName);

const observer = diagnosticsDirectory
  ? startProcessDiagnostics({ directory: diagnosticsDirectory, label: "node-driver" })
  : { mark() {}, dispose() {} };
let phase = "browser-launch";
let failed = false;
/** @type {unknown} */
let closeFailure;
/** @type {Awaited<ReturnType<typeof startBrowserDiagnostics>> | undefined} */
let diagnostics;
/** @type {Page | undefined} */
let observedPage;
const prefix = "hesperia-deletion-diagnostic:";
let admitted = 0;
let bytes = 0;
let capped = false;
let transportError = false;

/** @param {import("playwright").ConsoleMessage} message */
function receive(message) {
  try {
    const text = message.text();

    if (!text.startsWith(prefix) || capped) return;

    const payload = text.slice(prefix.length);
    const size = Buffer.byteLength(payload);

    if (admitted >= 1200 || bytes + size > 512_000) {
      capped = true;
      observer.mark("browser-case-cap", { recordLimit: 1200, byteLimit: 512_000, admitted, bytes });
      return;
    }

    if (size > 6000) throw new Error("Oversized browser diagnostic payload");

    const value = JSON.parse(payload);

    if (!value || typeof value !== "object" || typeof value.kind !== "string")
      throw new Error("Malformed browser diagnostic payload");

    admitted++;
    bytes += size;
    observer.mark("browser-event", value);
  } catch (error) {
    if (!transportError) {
      transportError = true;
      observer.mark("browser-transport-error", { error: String(error) });
    }
  }
}

/** @param {string} next */
function beginPhase(next) {
  phase = next;
  observer.mark("phase-begin", { phase });
}

function completePhase() {
  observer.mark("phase-complete", { phase });
}

observer.mark("phase-begin", { phase });
/** @type {Browser} */
let browser;

try {
  browser = await playwright[browserName].launch();
} catch (error) {
  observer.mark("phase-failure", { phase, error });
  observer.dispose();
  throw error;
}
observer.mark("phase-complete", { phase });

try {
  /** @type {Page} */
  const page = await browser.newPage();
  observedPage = page;

  if (diagnosticsDirectory)
    try {
      diagnostics = await startBrowserDiagnostics(page, {
        directory: diagnosticsDirectory,
        label: "browser",
      });
      page.on("console", receive);
      observer.mark("receiver-installed", { engineName, navigationMode });

      await installRecorder(page);
      observer.mark("init-script-registered");
    } catch (error) {
      observer.mark("diagnostic-setup-error", { error: String(error) });
      console.error(`[deletion diagnostics unavailable] ${String(error)}`);
    }

  /** @type {(string | undefined)[]} */
  const errors = [];

  page.on("pageerror", (error) => errors.push(error.stack));

  if (navigationMode === "fallback")
    await page.addInitScript(() =>
      Object.defineProperty(window, "navigation", { configurable: true, value: undefined }),
    );

  await page.addInitScript(() => {
    globalThis.documentIdentity = Math.random();

    globalThis.apiOutcome = "";

    window.addEventListener("fixture-api-result", (event) => {
      globalThis.apiOutcome = /** @type {CustomEvent<string>} */ (event).detail;
    });

    globalThis.departures = 0;

    window.addEventListener("fixture-departure", () => {
      globalThis.departures++;
    });

    globalThis.removals = 0;

    globalThis.styleRevisions = 0;

    window.addEventListener("hesperia:style-revision", () => {
      globalThis.styleRevisions++;
    });

    window.addEventListener("hesperia:dev-source-removal", () => {
      globalThis.removals++;
    });
  });

  beginPhase("01:route-step");

  await page.goto(applicationUrl);

  completePhase();

  beginPhase("02:click");

  await page.locator("#count").click();

  completePhase();

  beginPhase("03:route-step");

  const oldStylesheet = await page.locator('link[rel="stylesheet"]').evaluateAll(
    /** @param {HTMLLinkElement[]} links */
    (links) => links.find((link) => link.href.includes("/_hesperia/assets/"))?.href,
  );

  completePhase();

  beginPhase("04:route-step");

  assert.ok(oldStylesheet);

  completePhase();

  beginPhase("05:click");

  await page.locator("#to-other").click();

  completePhase();

  beginPhase("06:route-step");

  await page.waitForSelector("#b");

  completePhase();

  beginPhase("07:click");

  await page.locator("#count").click();

  completePhase();

  beginPhase("08:document-identity");

  const identity = await page.evaluate(() => globalThis.documentIdentity);

  completePhase();

  beginPhase("09:style-revision");

  const revision = await page.evaluate(() => globalThis.styleRevisions);

  completePhase();

  beginPhase("10:style-write");

  await writeFile(cssPath, ".a { color: rgb(50, 60, 70); }");

  completePhase();

  beginPhase("11:style-revision");

  await page.waitForFunction((previous) => globalThis.styleRevisions > previous, revision);

  completePhase();

  beginPhase("12:source-removal");

  await rm(removedPath);

  completePhase();

  beginPhase("13:removal-event");

  await page.waitForFunction(() => globalThis.removals > 0, null, { timeout: 15000 });

  completePhase();

  beginPhase("14:document-identity");

  assert.equal(await page.evaluate(() => globalThis.documentIdentity), identity);

  completePhase();

  beginPhase("15:counter-check");

  assert.equal(await page.locator("#count").textContent(), "1");

  completePhase();

  beginPhase("16:route-step");

  assert.equal((await page.request.get(oldStylesheet)).status(), 404);

  completePhase();

  beginPhase("17:click");

  await page.locator("#veto").click();

  completePhase();

  beginPhase("18:route-step");

  await page.evaluate(() => window.dispatchEvent(new Event("fixture-api-navigate")));

  completePhase();

  beginPhase("19:route-step");

  await page.waitForFunction(() => globalThis.apiOutcome !== "");

  completePhase();

  beginPhase("20:route-step");

  assert.equal(await page.evaluate(() => globalThis.apiOutcome), "AbortError");

  completePhase();

  beginPhase("21:document-identity");

  assert.equal(await page.evaluate(() => globalThis.documentIdentity), identity);

  completePhase();

  beginPhase("22:route-step");

  assert.equal(new URL(page.url()).pathname, "/b");

  completePhase();

  beginPhase("23:counter-check");

  assert.equal(await page.locator("#count").textContent(), "1");

  completePhase();

  beginPhase("24:click");

  await page.locator("#veto").click();

  completePhase();

  beginPhase("25:route-step");

  await page.goBack();

  completePhase();

  beginPhase("26:route-step");

  await page.waitForSelector("#a");

  completePhase();

  beginPhase("27:document-identity");

  await page.waitForFunction((previous) => globalThis.documentIdentity !== previous, identity);

  completePhase();

  beginPhase("28:counter-check");

  assert.equal(await page.locator("#count").textContent(), "0");

  completePhase();

  beginPhase("29:route-step");

  assert.equal(new URL(page.url()).pathname, "/a");

  completePhase();

  beginPhase("30:success-marker");

  console.log("route ready", navigationMode);

  completePhase();

  beginPhase("31:style-write");

  await writeFile(removedPath, ".a { color: rgb(80, 90, 100); }");

  completePhase();

  beginPhase("32:style-write");

  await writeFile(cssPath, '@import "./removed.css";');

  completePhase();

  beginPhase("33:route-step");

  await page.waitForFunction(
    () =>
      document.querySelector("#a") &&
      getComputedStyle(/** @type {HTMLElement} */ (document.querySelector("#a"))).color ===
        "rgb(80, 90, 100)",
  );

  completePhase();

  beginPhase("34:document-identity");

  const activeIdentity = await page.evaluate(() => globalThis.documentIdentity);

  completePhase();

  beginPhase("35:click");

  await page.locator("#count").click();

  completePhase();

  beginPhase("36:click");

  await page.locator("#veto").click();

  completePhase();

  beginPhase("37:route-step");

  const activeDepartures = await page.evaluate(() => globalThis.departures);

  completePhase();

  beginPhase("38:style-write");

  await writeFile(cssPath, ".a { color: rgb(110, 120, 130); }");

  completePhase();

  beginPhase("39:source-removal");

  await rm(removedPath);

  completePhase();

  beginPhase("40:route-step");

  await page.waitForFunction((previous) => globalThis.departures > previous, activeDepartures);

  completePhase();

  beginPhase("41:document-identity");

  assert.equal(await page.evaluate(() => globalThis.documentIdentity), activeIdentity);

  completePhase();

  beginPhase("42:counter-check");

  assert.equal(await page.locator("#count").textContent(), "1");

  completePhase();

  beginPhase("43:click");

  await page.locator("#veto").click();

  completePhase();

  beginPhase("44:click");

  await page.locator("#reload").click();

  completePhase();

  beginPhase("45:document-identity");

  await page.waitForFunction(
    (previous) => globalThis.documentIdentity !== previous,
    activeIdentity,
  );

  completePhase();

  beginPhase("46:route-step");

  await page.waitForSelector("#a");

  completePhase();

  beginPhase("47:counter-check");

  assert.equal(await page.locator("#count").textContent(), "0");

  completePhase();

  beginPhase("48:route-step");

  assert.equal(new URL(page.url()).pathname, "/a");

  completePhase();

  beginPhase("49:success-marker");

  console.log("route ready", navigationMode);

  completePhase();

  beginPhase("50:route-step");

  assert.deepEqual(errors, []);

  completePhase();

  beginPhase("51:success-marker");

  console.log("veto and reload verified", navigationMode);

  completePhase();

  beginPhase("52:style-write");

  await writeFile(removedPath, ".a { color: rgb(20, 30, 40); }");

  completePhase();

  beginPhase("53:style-write");

  await writeFile(cssPath, '@import "./removed.css";');

  completePhase();

  beginPhase("54:route-step");

  await page.waitForFunction(
    () =>
      document.querySelector("#a") &&
      getComputedStyle(/** @type {HTMLElement} */ (document.querySelector("#a"))).color ===
        "rgb(20, 30, 40)",
  );

  completePhase();

  beginPhase("55:success-marker");

  console.log("Active and cached deletion behavior verified");

  completePhase();
} catch (error) {
  failed = true;
  observer.mark("phase-failure", { phase, error });

  try {
    await diagnostics?.capture(error);
  } catch (captureError) {
    observer.mark("diagnostic-capture-error", { error: String(captureError) });
  }

  throw error;
} finally {
  try {
    await browser.close();
  } catch (error) {
    observer.mark("browser-close-error", { error });

    if (!failed) closeFailure = error;
  } finally {
    observedPage?.off("console", receive);

    try {
      await diagnostics?.dispose();
    } catch (error) {
      observer.mark("diagnostic-dispose-error", { error });
    }

    observer.mark("diagnostics-complete", { admitted, bytes, capped });
    observer.dispose();
  }
}

if (closeFailure) throw closeFailure;
