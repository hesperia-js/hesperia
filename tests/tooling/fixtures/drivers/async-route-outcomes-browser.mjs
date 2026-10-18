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

    page.on("pageerror", (error) => errors.push(error.stack ?? error.message));

    /** @type {Record<string, (route: Route) => void>} */
    const requests = {};

    /** @type {Record<string, Promise<Route>>} */
    const waiting = {};

    for (const name of ["reject", "broken", "slow"]) {
      waiting[name] = new Promise((resolve) => (requests[name] = resolve));
    }

    await page.route("**/api/message/**", (route) => {
      const name = /** @type {string} */ (new URL(route.request().url()).pathname.split("/").pop());

      if (name in requests) return requests[name](route);

      return route.continue();
    });

    await page.goto(applicationUrl);

    await page.getByRole("link", { name: "Reject" }).click();

    const reject = await waiting.reject;

    await page.locator("#loading").waitFor();

    await reject.fulfill({ status: 500, contentType: "text/plain", body: "reject backend failed" });

    await page.waitForFunction(() =>
      document.querySelector("#root-error")?.textContent?.includes("reject backend failed"),
    );

    assert.equal(await page.locator("#reject").count(), 0);

    await page.getByRole("link", { name: "Broken" }).click();

    const broken = await waiting.broken;

    await page.locator("#loading").waitFor();

    await broken.fulfill({ status: 500, contentType: "text/plain", body: "broken backend failed" });

    await page.waitForFunction(() =>
      document.querySelector("#root-error")?.textContent?.includes("nested error fallback failed"),
    );

    assert.equal(
      /** @type {string} */ (await page.locator("#root-error").textContent()).includes(
        "nested error fallback failed",
      ),
      true,
    );

    assert.equal(await page.locator("#broken").count(), 0);

    await page.getByRole("link", { name: "Home" }).click();

    await page.locator("#home").waitFor();

    await page.getByRole("link", { name: "Slow" }).click();

    const slow = await waiting.slow;

    await page.locator("#loading").waitFor();

    await page.getByRole("link", { name: "Fast" }).click();

    await page.locator("#fast").waitFor();

    assert.equal(new URL(page.url()).pathname, "/fast");

    const committed = page.evaluate(() => {
      const pending = window.routeOutcomeFixture.waitForSlowCommit();

      window.routeOutcomeFixture.waitingForSlow = true;

      return pending;
    });

    await page.waitForFunction(() => window.routeOutcomeFixture.waitingForSlow);

    await slow.fulfill({ json: { message: "late slow result" } });

    assert.deepEqual(await committed, { message: "late slow result" });

    assert.equal(await page.locator("#slow").count(), 0);

    assert.equal(await page.title(), "Async route outcomes");

    assert.deepEqual(errors, []);

    console.log(engine.name() + " async outcomes verified");
  } catch (error) {
    throw new Error(engine.name() + " async outcome failed", { cause: error });
  } finally {
    await browser.close();
  }
}
