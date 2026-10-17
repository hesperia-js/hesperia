import assert from "node:assert/strict";
import { writeFile, rm } from "node:fs/promises";

/** @typedef {"chromium" | "firefox" | "webkit"} BrowserName */

/** @typedef {import("playwright").Browser} Browser */
/** @typedef {import("playwright").Page} Page */

const [playwrightModuleUrl, engineName, applicationUrl, cssPath, removedPath, navigationMode] =
  process.argv.slice(2);

const playwright = /** @type {typeof import("playwright")} */ (await import(playwrightModuleUrl));

const browserName = /** @type {BrowserName} */ (engineName);

/** @type {Browser} */
const browser = await playwright[browserName].launch();

try {
  /** @type {Page} */
  const page = await browser.newPage();

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

  await page.goto(applicationUrl);

  await page.locator("#count").click();

  const oldStylesheet = await page.locator('link[rel="stylesheet"]').evaluateAll(
    /** @param {HTMLLinkElement[]} links */
    (links) => links.find((link) => link.href.includes("/_hesperia/assets/"))?.href,
  );

  assert.ok(oldStylesheet);

  await page.locator("#to-other").click();

  await page.waitForSelector("#b");

  await page.locator("#count").click();

  const identity = await page.evaluate(() => globalThis.documentIdentity);

  const revision = await page.evaluate(() => globalThis.styleRevisions);

  await writeFile(cssPath, ".a { color: rgb(50, 60, 70); }");

  await page.waitForFunction((previous) => globalThis.styleRevisions > previous, revision);

  await rm(removedPath);

  await page.waitForFunction(() => globalThis.removals > 0, null, { timeout: 15000 });

  assert.equal(await page.evaluate(() => globalThis.documentIdentity), identity);

  assert.equal(await page.locator("#count").textContent(), "1");

  assert.equal((await page.request.get(oldStylesheet)).status(), 404);

  await page.locator("#veto").click();

  await page.evaluate(() => window.dispatchEvent(new Event("fixture-api-navigate")));

  await page.waitForFunction(() => globalThis.apiOutcome !== "");

  assert.equal(await page.evaluate(() => globalThis.apiOutcome), "AbortError");

  assert.equal(await page.evaluate(() => globalThis.documentIdentity), identity);

  assert.equal(new URL(page.url()).pathname, "/b");

  assert.equal(await page.locator("#count").textContent(), "1");

  await page.locator("#veto").click();

  await page.goBack();

  await page.waitForSelector("#a");

  await page.waitForFunction((previous) => globalThis.documentIdentity !== previous, identity);

  assert.equal(await page.locator("#count").textContent(), "0");

  assert.equal(new URL(page.url()).pathname, "/a");

  console.log("route ready", navigationMode);

  await writeFile(removedPath, ".a { color: rgb(80, 90, 100); }");

  await writeFile(cssPath, '@import "./removed.css";');

  await page.waitForFunction(
    () =>
      document.querySelector("#a") &&
      getComputedStyle(/** @type {HTMLElement} */ (document.querySelector("#a"))).color ===
        "rgb(80, 90, 100)",
  );

  const activeIdentity = await page.evaluate(() => globalThis.documentIdentity);

  await page.locator("#count").click();

  await page.locator("#veto").click();

  const activeDepartures = await page.evaluate(() => globalThis.departures);

  await writeFile(cssPath, ".a { color: rgb(110, 120, 130); }");

  await rm(removedPath);

  await page.waitForFunction((previous) => globalThis.departures > previous, activeDepartures);

  assert.equal(await page.evaluate(() => globalThis.documentIdentity), activeIdentity);

  assert.equal(await page.locator("#count").textContent(), "1");

  await page.locator("#veto").click();

  await page.locator("#reload").click();

  await page.waitForFunction(
    (previous) => globalThis.documentIdentity !== previous,
    activeIdentity,
  );

  await page.waitForSelector("#a");

  assert.equal(await page.locator("#count").textContent(), "0");

  assert.equal(new URL(page.url()).pathname, "/a");

  console.log("route ready", navigationMode);

  assert.deepEqual(errors, []);

  console.log("veto and reload verified", navigationMode);

  await writeFile(removedPath, ".a { color: rgb(20, 30, 40); }");

  await writeFile(cssPath, '@import "./removed.css";');

  await page.waitForFunction(
    () =>
      document.querySelector("#a") &&
      getComputedStyle(/** @type {HTMLElement} */ (document.querySelector("#a"))).color ===
        "rgb(20, 30, 40)",
  );

  console.log("Active and cached deletion behavior verified");
} finally {
  await browser.close();
}
