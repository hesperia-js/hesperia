import assert from "node:assert/strict";

/** @typedef {import("playwright").BrowserType} BrowserType */
/** @typedef {import("playwright").Route} Route */

const [playwrightModuleUrl, applicationUrl] = process.argv.slice(2);

const { chromium, firefox, webkit } = /** @type {typeof import("playwright")} */ (
  await import(playwrightModuleUrl)
);

for (const engine of [chromium, firefox, webkit]) {
  const browser = await engine.launch();

  try {
    const page = await browser.newPage();

    /** @type {string[]} */
    const errors = [];

    page.on("pageerror", (error) => errors.push(error.message));

    /** @type {Map<string, Route[]>} */
    const queuedRequests = new Map();

    /** @type {Map<string, ((route: Route) => void)[]>} */
    const requestWaiters = new Map();

    /** @param {string} name */
    const waitForRequest = (name) =>
      new Promise((/** @type {(route: Route) => void} */ resolve) => {
        const queued = queuedRequests.get(name) ?? [];

        if (queued.length) resolve(/** @type {Route} */ (queued.shift()));
        else {
          const waiters = requestWaiters.get(name) ?? [];

          waiters.push(resolve);

          requestWaiters.set(name, waiters);
        }
      });

    await page.route("**/api/message/**", (route) => {
      const name = new URL(route.request().url()).pathname.split("/").pop();

      if (name !== "one" && name !== "broken") return route.continue();

      const waiters = requestWaiters.get(name) ?? [];

      const waiter = waiters.shift();

      if (waiter) waiter(route);
      else {
        const queued = queuedRequests.get(name) ?? [];

        queued.push(route);

        queuedRequests.set(name, queued);
      }

      return;
    });

    await page.goto(applicationUrl);

    const shell = await page.locator("#shell-draft").elementHandle();

    const layout = await page.locator("#root-layout").elementHandle();

    if (!shell || !layout) throw new Error("Initial shell is missing");

    await page.locator("#draft").fill("Keep this draft");

    await page.evaluate(() => {
      globalThis.savedDraft = document.querySelector("#draft");
    });

    const firstSlowRequest = waitForRequest("one");

    await page.getByRole("link", { name: "Slow page" }).click();

    const request = await firstSlowRequest;

    await page.locator("#loading").waitFor();

    assert.equal(new URL(page.url()).pathname, "/");

    assert.equal(await page.locator("#draft").count(), 0);

    assert.equal(await page.locator("#ready").count(), 0);

    assert.equal(
      await page.evaluate((node) => node === document.querySelector("#shell-draft"), shell),
      true,
    );

    assert.equal(
      await page.evaluate((node) => node === document.querySelector("#root-layout"), layout),
      true,
    );

    await request.fulfill({ json: { message: "Query finished" } });

    await page.locator("#ready").waitFor();

    await page.waitForURL("**/slow");

    assert.equal(await page.locator("#ready h1").textContent(), "Query finished");

    assert.equal(await page.locator("#loading").count(), 0);

    await page.evaluate(() => history.back());

    await page.locator("#draft").waitFor();

    await page.waitForURL(applicationUrl);

    assert.equal(await page.locator("#draft").inputValue(), "Keep this draft");

    assert.equal(
      await page.evaluate(() => document.querySelector("#draft") === globalThis.savedDraft),
      true,
    );

    assert.equal(
      await page.evaluate((node) => node === document.querySelector("#shell-draft"), shell),
      true,
    );

    assert.equal(
      await page.evaluate((node) => node === document.querySelector("#root-layout"), layout),
      true,
    );

    assert.equal(await page.locator("#home-effects").getAttribute("data-cleanup"), "true");

    assert.equal(Number(await page.locator("#home-effects").getAttribute("data-runs")) >= 2, true);

    const forwardToSlow = page.waitForURL("**/slow");

    await page.evaluate(() => history.forward());

    await page.locator("#ready").waitFor();

    await forwardToSlow;

    assert.equal(await page.locator("#ready").getAttribute("data-body"), "1");

    const oldSlowEffects = await page.locator("#slow-effects").elementHandle();

    if (!oldSlowEffects) throw new Error("Cached async route effects are missing");

    await page.evaluate((node) => {
      globalThis.savedSlowEffects = /** @type {HTMLElement | SVGElement} */ (node);
    }, oldSlowEffects);

    await page.getByRole("link", { name: "Home" }).click();

    await page.waitForURL(applicationUrl);

    await page.locator("#draft").fill("Home survives reset");

    const parkedHomeDraft = await page.locator("#draft").elementHandle();

    if (!parkedHomeDraft) throw new Error("Cached home draft is missing before reset");

    const parkedHomeValue = await page.locator("#draft").inputValue();

    const parkedRequestCount = await page.evaluate(() => globalThis.getRoutingMessageRequests());

    const parkedSlowDisposals = await page.evaluate(
      (node) => Number(node.dataset.disposals),
      oldSlowEffects,
    );

    const parkedSlowEffectCleanups = await page.evaluate(
      (node) => Number(node.dataset.effectCleanups),
      oldSlowEffects,
    );

    await page.evaluate(() => globalThis.resetRoutingApi());

    assert.equal(
      await page.evaluate(() => globalThis.getRoutingMessageRequests()),
      parkedRequestCount,
    );

    assert.equal(await page.locator("#draft").inputValue(), parkedHomeValue);

    assert.equal(
      await page.evaluate((node) => node === document.querySelector("#draft"), parkedHomeDraft),
      true,
    );

    assert.equal(
      await page.evaluate((node) => node === document.querySelector("#shell-draft"), shell),
      true,
    );

    assert.equal(
      await page.evaluate((node) => node === document.querySelector("#root-layout"), layout),
      true,
    );

    const restoredSlowRequest = waitForRequest("one");

    const backToSlow = page.waitForURL("**/slow");

    await page.evaluate(() => history.back());

    await page.locator("#loading").waitFor();

    assert.equal(await page.locator("#ready").count(), 0);

    const freshRouteRequest = await restoredSlowRequest;

    assert.equal(
      await page.evaluate(() => globalThis.getRoutingMessageRequests()),
      parkedRequestCount + 1,
    );

    const disposedSlowState = await page.evaluate(() => ({
      disposals: globalThis.savedSlowEffects?.dataset.disposals,
      effectCleanups: globalThis.savedSlowEffects?.dataset.effectCleanups,
      bodyCount: globalThis.slowBodies,
    }));

    assert.equal(disposedSlowState.disposals, String(parkedSlowDisposals + 1));

    assert.equal(disposedSlowState.effectCleanups, String(parkedSlowEffectCleanups));

    assert.equal(disposedSlowState.bodyCount, 1);

    await freshRouteRequest.fulfill({ json: { message: "Reset restored" } });

    await page.locator("#ready").waitFor();

    await backToSlow;

    await page.waitForFunction(
      () => document.querySelector("#slow-effects")?.getAttribute("data-runs") === "1",
    );

    assert.equal(await page.locator("#ready h1").textContent(), "Reset restored");

    assert.equal(await page.locator("#ready").getAttribute("data-body"), "2");

    assert.equal(await page.locator("#slow-effects").getAttribute("data-runs"), "1");

    assert.equal(
      await page.evaluate(
        (node) => node !== document.querySelector("#slow-effects"),
        oldSlowEffects,
      ),
      true,
    );

    const forwardToParkedHome = page.waitForURL(applicationUrl);

    await page.evaluate(() => history.forward());

    await page.locator("#draft").waitFor();

    await forwardToParkedHome;

    assert.equal(await page.locator("#draft").inputValue(), parkedHomeValue);

    assert.equal(
      await page.evaluate((node) => node === document.querySelector("#draft"), parkedHomeDraft),
      true,
    );

    assert.equal(
      await page.evaluate((node) => node === document.querySelector("#shell-draft"), shell),
      true,
    );

    assert.equal(
      await page.evaluate((node) => node === document.querySelector("#root-layout"), layout),
      true,
    );

    await page.getByRole("link", { name: "Broken page" }).click();

    const broken = await waitForRequest("broken");

    await page.locator("#loading").waitFor();

    await broken.fulfill({ status: 500, contentType: "text/plain", body: "broken backend failed" });

    await page.locator("#root-error").waitFor();

    assert.equal(
      /** @type {string} */ (await page.locator("#root-error").textContent()).includes(
        "nested fallback failed",
      ),
      true,
    );

    assert.equal(
      await page.evaluate((node) => node === document.querySelector("#shell-draft"), shell),
      true,
    );

    await page.getByRole("link", { name: "Home" }).click();

    await page.locator("#draft").waitFor();

    assert.equal(
      await page.evaluate((node) => node === document.querySelector("#shell-draft"), shell),
      true,
    );

    assert.deepEqual(errors, []);

    console.log(engine.name() + " async routing verified");
  } catch (error) {
    throw new Error(engine.name() + " generated routing failed", { cause: error });
  } finally {
    await browser.close();
  }
}
