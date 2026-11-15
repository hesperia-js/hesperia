import { browserLaunchOptions } from "../../../support/browser-launch.mjs";
import assert from "node:assert/strict";
import { writeSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { writeFile } from "node:fs/promises";

/** @typedef {import("playwright").Browser} Browser */
/** @typedef {import("playwright").Page} Page */
/** @typedef {import("playwright").Request} Request */

/**
 * @typedef {object} BrowserEntry
 * @property {Browser} browser
 * @property {string} name
 * @property {string[]} errors
 * @property {Page} [page]
 * @property {boolean} [hasNativeRouteInterception]
 * @property {number} [initialTimeOrigin]
 * @property {Promise<Request>} [documentReload]
 */

const [playwrightModuleUrl, applicationUrl, routePath, secondPageSource] = process.argv.slice(2);

const { chromium, firefox, webkit } = /** @type {typeof import("playwright")} */ (
  await import(playwrightModuleUrl)
);

/** @type {BrowserEntry[]} */
const opened = [];
let diagnosticSequence = 0;
let diagnosticTruncated = false;
let requestSequence = 0;
/** @type {WeakMap<import("playwright").Request, number>} */
const diagnosticRequests = new WeakMap();
let activeBrowser = "setup";

/** @param {string} kind @param {Record<string, unknown>} [detail] @param {boolean} [force] */
function diagnostic(kind, detail = {}, force = false) {
  try {
    if (diagnosticSequence >= 600 && !force) {
      if (!diagnosticTruncated) {
        diagnosticTruncated = true;
        diagnostic("events-truncated", {}, true);
      }
      return;
    }
    const record = {
      kind,
      sequence: ++diagnosticSequence,
      pid: process.pid,
      wallTime: new Date().toISOString(),
      monotonicMs: performance.now(),
      ...detail,
    };
    writeSync(2, `[development-browser-diagnostic] ${JSON.stringify(record)}\n`);
  } catch {
    // Diagnostics must not replace the original failure.
  }
}

try {
  for (const engine of [chromium, firefox, webkit]) {
    const browser = await engine.launch(browserLaunchOptions(engine.name()));

    /** @type {BrowserEntry} */
    const entry = { browser, name: engine.name(), errors: [] };
    activeBrowser = entry.name;

    opened.push(entry);

    const page = await browser.newPage();
    entry.page = page;

    page.on("pageerror", (error) => entry.errors.push(error.message));

    try {
      page.on("request", (request) => {
        try {
          const path = new URL(request.url()).pathname;
          const type = request.resourceType();
          if (
            !(request.isNavigationRequest() && path === "/nested") &&
            type !== "eventsource" &&
            path !== "/_hesperia/events" &&
            path !== "/_hesperia/warnings"
          )
            return;
          const id = ++requestSequence;
          diagnosticRequests.set(request, id);
          diagnostic("request", {
            browser: entry.name,
            id,
            path,
            type,
            method: request.method(),
            navigation: request.isNavigationRequest(),
            mainFrame: request.frame() === page.mainFrame(),
          });
        } catch {
          diagnostic("request-metadata-unavailable", { browser: entry.name });
        }
      });
      page.on("response", (response) => {
        try {
          const id = diagnosticRequests.get(response.request());
          if (id !== undefined)
            diagnostic("response", { browser: entry.name, id, status: response.status() });
        } catch {
          diagnostic("response-metadata-unavailable", { browser: entry.name });
        }
      });
      page.on("requestfinished", (request) => {
        try {
          const id = diagnosticRequests.get(request);
          if (id !== undefined) diagnostic("request-finished", { browser: entry.name, id });
        } catch {
          diagnostic("request-finished-metadata-unavailable", { browser: entry.name });
        }
      });
      page.on("requestfailed", (request) => {
        try {
          const id = diagnosticRequests.get(request);
          if (id !== undefined)
            diagnostic("request-failed", {
              browser: entry.name,
              id,
              failure: request.failure()?.errorText,
            });
        } catch {
          diagnostic("request-failure-metadata-unavailable", { browser: entry.name });
        }
      });
      page.on("framenavigated", (frame) => {
        try {
          if (frame === page.mainFrame())
            diagnostic("main-frame-navigated", {
              browser: entry.name,
              path: new URL(frame.url()).pathname,
            });
        } catch {
          diagnostic("frame-metadata-unavailable", { browser: entry.name });
        }
      });
      page.on("domcontentloaded", () => diagnostic("domcontentloaded", { browser: entry.name }));
      page.on("load", () => diagnostic("load", { browser: entry.name }));
      page.on("console", (message) => {
        try {
          if (message.type() === "error" || message.type() === "warning")
            diagnostic("console", {
              browser: entry.name,
              type: message.type(),
              text: message.text().slice(0, 1000),
            });
        } catch {
          diagnostic("console-metadata-unavailable", { browser: entry.name });
        }
      });
      page.on("pageerror", (error) => {
        try {
          diagnostic("page-error", { browser: entry.name, message: error.message.slice(0, 1000) });
        } catch {
          diagnostic("page-error-metadata-unavailable", { browser: entry.name });
        }
      });
    } catch {
      diagnostic("listener-setup-unavailable", { browser: entry.name }, true);
    }

    const warning = page.waitForEvent("console", {
      predicate: (message) => message.type() === "warning" && message.text().includes("unsafeBind"),
    });
    const forwarded = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/_hesperia/warnings" &&
        response.request().method() === "POST" &&
        Boolean(response.request().postData()?.includes("unsafeBind")),
    );

    diagnostic("initial-navigation-start", { browser: entry.name });
    await page.goto(applicationUrl);
    diagnostic("initial-version-wait-start", { browser: entry.name });
    await page.waitForFunction(() => document.querySelector("#version")?.textContent === "first");
    diagnostic("initial-version-wait-complete", { browser: entry.name });

    assert.match((await warning).text(), /unsafeBind/);

    const response = await forwarded;

    assert.equal(response.status(), 204, "Development server accepted the browser warning");

    assert.match(response.request().postData() ?? "", /unsafeBind/);

    await page.locator("#count").click();

    assert.equal(await page.locator("#count").textContent(), "1");

    await page.evaluate(() => {
      globalThis.beforeReloadMarker = true;
    });

    const hasNativeRouteInterception = await page.evaluate(
      () =>
        typeof window.navigation?.reload === "function" &&
        typeof window.NavigateEvent?.prototype?.intercept === "function" &&
        typeof window.NavigationPrecommitController === "function",
    );

    await page.evaluate(() => {
      window.sessionStorage.removeItem("hesperia-dev-reload-ack");

      window.addEventListener(
        "hesperia:dev-hard-reload",
        (event) => {
          window.sessionStorage.setItem("hesperia-dev-reload-ack", String(event.defaultPrevented));
        },
        { once: true },
      );
    });

    entry.hasNativeRouteInterception = hasNativeRouteInterception;
    entry.initialTimeOrigin = await page.evaluate(() => performance.timeOrigin);
    diagnostic("navigation-listener-setup-start", { browser: entry.name });
    entry.documentReload = page.waitForRequest(
      (request) =>
        request.isNavigationRequest() &&
        request.resourceType() === "document" &&
        new URL(request.url()).pathname === "/nested",
      { timeout: 30000 },
    );
    diagnostic("navigation-listener-armed", { browser: entry.name });
  }

  activeBrowser = "shared-route-edit";
  diagnostic("route-write-start");
  await writeFile(routePath, secondPageSource);
  diagnostic("route-write-complete");

  for (const entry of /** @type {Required<BrowserEntry>[]} */ (opened)) {
    activeBrowser = entry.name;
    diagnostic("navigation-wait-start", { browser: entry.name });
    const documentRequest = await entry.documentReload;
    diagnostic("navigation-wait-complete", {
      browser: entry.name,
      id: diagnosticRequests.get(documentRequest),
    });

    diagnostic("second-version-wait-start", { browser: entry.name });
    await entry.page.waitForFunction(
      () => document.querySelector("#version")?.textContent === "second",
      null,
      { timeout: 30000 },
    );
    diagnostic("second-version-wait-complete", { browser: entry.name });

    assert.equal(documentRequest.isNavigationRequest(), true, "Reload issued a navigation request");

    assert.equal(documentRequest.resourceType(), "document", "Reload requested a document");

    assert.equal(
      new URL(documentRequest.url()).pathname,
      "/nested",
      "Document request retained the deep URL",
    );

    assert.notEqual(
      await entry.page.evaluate(() => performance.timeOrigin),
      entry.initialTimeOrigin,
      "Reload created a new document performance context",
    );

    assert.equal(
      await entry.page.locator("#count").textContent(),
      "0",
      "Reload created fresh component state",
    );

    assert.equal(
      await entry.page.evaluate(() => globalThis.beforeReloadMarker),
      undefined,
      "Reload created a new document environment",
    );

    assert.equal(new URL(entry.page.url()).pathname, "/nested", "Reload retained the deep URL");

    assert.equal(
      await entry.page.evaluate(() => sessionStorage.getItem("hesperia-dev-reload-ack")),
      String(entry.hasNativeRouteInterception),
      "The dev runtime acknowledged hard reload only when its native route bridge was available",
    );

    if (entry.name === "chromium")
      assert.equal(entry.hasNativeRouteInterception, true, "Chromium exercises the runtime bridge");

    assert.deepEqual(entry.errors, []);

    diagnostic("browser-assertions-complete", { browser: entry.name });
    console.log(entry.name + " development warning and reload verified");
  }
} catch (error) {
  try {
    diagnostic(
      "original-failure",
      {
        browser: activeBrowser,
        name: error instanceof Error ? error.name : "non-error",
        message:
          error instanceof Error ? error.message.slice(0, 2000) : String(error).slice(0, 2000),
        stack: error instanceof Error ? error.stack?.slice(0, 4000) : undefined,
      },
      true,
    );
  } catch {
    // Preserve the original failure even if its diagnostic metadata is unavailable.
  }
  throw error;
} finally {
  diagnostic("cleanup-start", {}, true);
  await Promise.all(opened.map((entry) => entry.browser.close()));
}
