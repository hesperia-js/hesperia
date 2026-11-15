import { browserLaunchOptions } from "../../../support/browser-launch.mjs";
import assert from "node:assert/strict";
import { writeSync } from "node:fs";
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
 * @property {string} [developmentClientUrl]
 * @property {string} [eventStreamUrl]
 */

const [playwrightModuleUrl, applicationUrl, routePath, secondPageSource] = process.argv.slice(2);

const { chromium, firefox, webkit } = /** @type {typeof import("playwright")} */ (
  await import(playwrightModuleUrl)
);

/** @type {BrowserEntry[]} */
const opened = [];
/** @type {Array<() => void>} */
const releaseEventStreams = [];
let eventStreamsReleased = false;

/** @param {string} name */
function markMilestone(name) {
  try {
    writeSync(2, `${name}\n`);
  } catch {
    return;
  }
}

try {
  for (const engine of [chromium, firefox, webkit]) {
    const browser = await engine.launch(browserLaunchOptions(engine.name()));

    /** @type {BrowserEntry} */
    const entry = { browser, name: engine.name(), errors: [] };

    opened.push(entry);

    const page = await browser.newPage();
    entry.page = page;

    let releaseEventStream = () => {};
    const eventStreamGate = new Promise(
      /** @param {(value?: void) => void} resolve */ (resolve) => {
        releaseEventStream = resolve;
      },
    );
    releaseEventStreams.push(releaseEventStream);

    let observeEventStreamHold = () => {};
    const eventStreamHeld = new Promise(
      /** @param {(value?: void) => void} resolve */ (resolve) => {
        observeEventStreamHold = resolve;
      },
    );
    const clientScriptRequest = page.waitForRequest((request) =>
      new URL(request.url()).pathname.endsWith("/client.js"),
    );
    const eventStreamRequest = page.waitForRequest((request) =>
      new URL(request.url()).pathname.endsWith("/events"),
    );

    await page.route("**/events", async (route) => {
      observeEventStreamHold();

      await eventStreamGate;

      await route.continue();
    });

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

    const [clientRequest, heldEventRequest] = await Promise.all([
      clientScriptRequest,
      eventStreamRequest,
    ]);

    await eventStreamHeld;

    const developmentClientUrl = clientRequest.url();
    const eventStreamUrl = heldEventRequest.url();

    entry.developmentClientUrl = developmentClientUrl;
    entry.eventStreamUrl = eventStreamUrl;

    assert.equal(
      eventStreamUrl,
      new URL("./events", developmentClientUrl).href,
      "Development client used its mounted event URL",
    );

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
  }

  const publicationEntry = opened[0];

  if (!publicationEntry) throw new Error("No browser is available for publication observation");

  const publicationPage = await publicationEntry.browser.newPage();

  publicationPage.on("pageerror", (error) => publicationEntry.errors.push(error.message));

  const publicationClientRequest = publicationPage.waitForRequest((request) =>
    new URL(request.url()).pathname.endsWith("/client.js"),
  );
  const publicationEventRequest = publicationPage.waitForRequest((request) =>
    new URL(request.url()).pathname.endsWith("/events"),
  );
  const publicationEventResponse = publicationPage.waitForResponse(
    (response) => new URL(response.url()).pathname.endsWith("/events") && response.status() === 200,
  );

  await publicationPage.goto(applicationUrl);

  await publicationPage.waitForFunction(
    () => document.querySelector("#version")?.textContent === "first",
  );

  const [publicationClient, publicationRequest, publicationResponse] = await Promise.all([
    publicationClientRequest,
    publicationEventRequest,
    publicationEventResponse,
  ]);

  assert.equal(
    publicationRequest.url(),
    new URL("./events", publicationClient.url()).href,
    "Publication observer used its mounted event URL",
  );
  const heldEventStreamUrl = publicationEntry.eventStreamUrl;

  if (!heldEventStreamUrl) throw new Error("Browser event stream URL was not captured");

  assert.equal(publicationRequest.url(), heldEventStreamUrl);
  assert.equal(publicationResponse.url(), publicationRequest.url());

  const publicationDocumentReload = publicationPage.waitForRequest(
    (request) =>
      request.isNavigationRequest() &&
      request.resourceType() === "document" &&
      new URL(request.url()).pathname === "/nested",
    { timeout: 30000 },
  );

  await writeFile(routePath, secondPageSource);

  const publishedDocumentRequest = await publicationDocumentReload;

  assert.equal(publishedDocumentRequest.isNavigationRequest(), true);

  await publicationPage.waitForFunction(
    () => document.querySelector("#version")?.textContent === "second",
  );

  markMilestone("observer-second");

  for (const entry of /** @type {Required<BrowserEntry>[]} */ (opened)) {
    entry.documentReload = entry.page.waitForRequest(
      (request) =>
        request.isNavigationRequest() &&
        request.resourceType() === "document" &&
        new URL(request.url()).pathname === "/nested",
      { timeout: 30000 },
    );
    void entry.documentReload.catch(() => {});
  }

  markMilestone("waits-armed");

  for (const releaseEventStream of releaseEventStreams) releaseEventStream();
  eventStreamsReleased = true;

  markMilestone("gate-release");

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
  if (!eventStreamsReleased) {
    for (const releaseEventStream of releaseEventStreams) releaseEventStream();

    markMilestone("cleanup-gate-release");
  }

  await Promise.all(opened.map((entry) => entry.browser.close()));
}
