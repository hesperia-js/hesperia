import assert from "node:assert/strict";
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

try {
  for (const engine of [chromium, firefox, webkit]) {
    const browser = await engine.launch();

    /** @type {BrowserEntry} */
    const entry = { browser, name: engine.name(), errors: [] };

    opened.push(entry);

    const page = await browser.newPage();
    entry.page = page;

    page.on("pageerror", (error) => entry.errors.push(error.message));

    const warning = page.waitForEvent("console", {
      predicate: (message) => message.type() === "warning" && message.text().includes("unsafeBind"),
    });
    const forwarded = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/_hesperia/warnings" &&
        response.request().method() === "POST" &&
        Boolean(response.request().postData()?.includes("unsafeBind")),
    );

    await page.goto(applicationUrl);

    await page.waitForFunction(() => document.querySelector("#version")?.textContent === "first");

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
    entry.documentReload = page.waitForRequest(
      (request) =>
        request.isNavigationRequest() &&
        request.resourceType() === "document" &&
        new URL(request.url()).pathname === "/nested",
      { timeout: 30000 },
    );
  }

  await writeFile(routePath, secondPageSource);

  for (const entry of /** @type {Required<BrowserEntry>[]} */ (opened)) {
    const documentRequest = await entry.documentReload;

    await entry.page.waitForFunction(
      () => document.querySelector("#version")?.textContent === "second",
      null,
      { timeout: 30000 },
    );

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

    console.log(entry.name + " development warning and reload verified");
  }
} finally {
  await Promise.all(opened.map((entry) => entry.browser.close()));
}
