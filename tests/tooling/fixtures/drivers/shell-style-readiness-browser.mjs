import assert from "node:assert/strict";

const [playwrightModuleURL, serverURL] = process.argv.slice(2);
const { chromium, firefox, webkit } = /** @type {typeof import("playwright")} */ (
  await import(playwrightModuleURL)
);

for (const engine of [chromium, firefox, webkit]) {
  const browser = await engine.launch();

  try {
    const modes = engine === chromium ? ["delay", "reject", "ready"] : ["ready"];

    for (const mode of modes) {
      const page = await browser.newPage();
      page.setDefaultTimeout(5000);
      /** @type {string[]} */
      const errors = [];

      page.on("pageerror", (error) => errors.push(String(error)));

      await page.addInitScript(() => {
        window.fixtureEffects = [];
        window.fixturePushState = history.pushState;
        window.addEventListener("fixture-effect", (event) => {
          window.fixtureEffects.push({
            name: /** @type {CustomEvent<string>} */ (event).detail,
            color: getComputedStyle(/** @type {HTMLElement} */ (document.querySelector("#shell")))
              .color,
            display: getComputedStyle(document.body).display,
          });
        });
      });

      await page.route("**/_hesperia/startup.js", async (route) => {
        const response = await route.fetch();
        const html = await response.text();

        await route.fulfill({
          response,
          body: html.replace(
            'await start("/");',
            'window.fixtureStartup = "pending"; start("/").then(() => window.fixtureStartup = "ready", error => { window.fixtureStartup = "failed"; window.fixtureError = String(error); });',
          ),
        });
      });

      let release = () => {};
      const gate = new Promise(
        /** @param {(value?: void) => void} resolve */ (resolve) => {
          release = resolve;
        },
      );
      await page.route("**/*.css", async (route) => {
        if (mode !== "ready" && (await page.evaluate(() => document.title === "Styled shell"))) {
          await page.evaluate(() => {
            window.fixtureCssHeld = true;
          });

          await gate;

          if (mode === "reject") return route.abort();
        }

        await route.continue();
      });

      try {
        await page.goto(serverURL, { waitUntil: "commit", timeout: 5000 });

        if (mode !== "ready") {
          await page.waitForFunction(
            () => window.fixtureCssHeld || window.fixtureStartup === "failed",
            null,
            { timeout: 5000 },
          );

          assert.equal(
            await page.evaluate(() => window.fixtureError),
            undefined,
            `${engine.name()}: shell reaches its installed-head request`,
          );

          const pending = await page.evaluate(() => ({
            startup: window.fixtureStartup,
            effects: window.fixtureEffects,
            display: getComputedStyle(document.body).display,
            loaded: [...document.head.querySelectorAll('link[rel="stylesheet"]')].some((link) =>
              Boolean(/** @type {HTMLLinkElement} */ (link).sheet),
            ),
          }));

          assert.equal(pending.loaded, false, `${engine.name()}: replacement-head CSS is held`);
          assert.deepEqual(
            pending.effects,
            [],
            `${engine.name()}: effects wait for replacement-head CSS`,
          );
          assert.equal(pending.display, "none", `${engine.name()}: pending shell stays hidden`);
          assert.equal(pending.startup, "pending");
        }

        release();

        await page.waitForFunction(
          () => window.fixtureStartup === "ready" || window.fixtureStartup === "failed",
          null,
          { timeout: 5000 },
        );

        const completed = await page.evaluate(() => ({
          startup: window.fixtureStartup,
          error: window.fixtureError,
          effects: window.fixtureEffects,
          display: document.body ? getComputedStyle(document.body).display : null,
          route: document.querySelector("#initial-route")?.textContent,
          historyReleased: history.pushState === window.fixturePushState,
          links: document.querySelectorAll('link[rel="stylesheet"]').length,
        }));

        if (mode !== "reject") {
          assert.equal(completed.startup, "ready");
          assert.equal(completed.route, "Initial route");
          assert.equal(completed.display, "block");
          assert.deepEqual(
            completed.effects,
            ["child", "shell", "page"].map((name) => ({
              name,
              color: "rgb(1, 2, 3)",
              display: "block",
            })),
          );
          assert.deepEqual(errors, []);
        } else {
          assert.equal(completed.startup, "failed");
          assert.match(completed.error, /style|CSS/i);
          assert.deepEqual(completed.effects, []);
          assert.ok(completed.display === null || completed.display === "none");
          assert.equal(completed.historyReleased, true);
          assert.equal(completed.links, 0);
        }
      } catch (error) {
        throw new Error(
          `${engine.name()} ${mode}: ${JSON.stringify(await page.evaluate(() => ({ title: document.title, startup: window.fixtureStartup, error: window.fixtureError, effects: window.fixtureEffects, html: document.documentElement.outerHTML })))}, page errors: ${errors.join("; ")}`,
          { cause: error },
        );
      } finally {
        release();

        await page.close();
      }
    }

    console.log(`${engine.name()} shell CSS verified (${modes.join(", ")})`);
  } finally {
    await browser.close();
  }
}
