import assert from "node:assert/strict";
import { startBrowserDiagnostics } from "./browser-diagnostics.mjs";

const [playwrightModuleURL, serverURL, diagnosticsDirectory] = process.argv.slice(2);

const { chromium, firefox, webkit } = /** @type {typeof import("playwright")} */ (
  await import(playwrightModuleURL)
);

for (const engine of [chromium, firefox, webkit]) {
  const browser = await engine.launch();

  /** @type {Awaited<ReturnType<typeof startBrowserDiagnostics>> | undefined} */
  let diagnostics;
  let failed = false;

  try {
    const page = await browser.newPage();
    diagnostics = await startBrowserDiagnostics(page, {
      directory: diagnosticsDirectory,
      label: engine.name(),
    });

    if (engine.name() === "webkit") {
      await page.addInitScript(() => {
        Object.defineProperty(window, "NavigationPrecommitController", {
          configurable: true,
          value: undefined,
        });
      });
    }

    /** @type {string[]} */
    const errors = [];

    page.on("pageerror", (error) => errors.push(String(error)));

    diagnostics.mark("document navigation", { url: new URL("/dashboard/", serverURL).href });

    await page
      .goto(new URL("/dashboard/", serverURL).href, {
        waitUntil: "domcontentloaded",
        timeout: 5000,
      })
      .catch((error) => {
        throw new Error("Document did not load", { cause: error });
      });

    diagnostics.mark("startup button mount");

    await page
      .waitForFunction(() => document.querySelector("button")?.textContent === "0", null, {
        timeout: 5000,
      })
      .catch((error) => {
        throw new Error("Startup did not mount the button", { cause: error });
      });

    diagnostics.mark("startup live region");

    await page.waitForFunction(
      () => document.querySelector('[role="status"]')?.textContent === "Startup fixture",
      null,
      { timeout: 10000 },
    );

    assert.equal(await page.locator('[role="status"]').getAttribute("aria-live"), "polite");

    if (engine.name() === "webkit") {
      diagnostics.mark("fallback history back");

      assert.equal(
        await page.evaluate(
          () =>
            typeof (
              /** @type {Window & { NavigationPrecommitController?: unknown }} */ (window)
                .NavigationPrecommitController
            ),
        ),
        "undefined",
      );

      await page.evaluate(() => window.history.back());

      await page.waitForFunction(
        () =>
          window.location.pathname === "/dashboard/early" &&
          document.querySelector('[data-startup-entry="early"]')?.textContent ===
            "Early history entry",
        null,
        { timeout: 10000 },
      );

      assert.deepEqual(
        await page.evaluate(() => ({
          pathname: window.location.pathname,
          state: window.history.state,
        })),
        {
          pathname: "/dashboard/early",
          state: { startupEntry: "early" },
        },
      );

      diagnostics.mark("fallback history forward");

      await page.evaluate(() => window.history.forward());

      await page.waitForFunction(
        () =>
          window.location.pathname === "/dashboard/" &&
          document.querySelector("button")?.textContent === "0",
        null,
        { timeout: 10000 },
      );

      assert.equal(await page.evaluate(() => window.history.state), null);
    }

    assert.equal(
      await page.evaluate(
        () =>
          /** @type {typeof globalThis & { routePageLoaded?: boolean }} */ (globalThis)
            .routePageLoaded,
      ),
      true,
    );

    diagnostics.mark("startup button click");

    assert.equal(
      await page.evaluate(() => {
        const button = /** @type {HTMLButtonElement} */ (document.querySelector("button"));

        button.click();

        return button.textContent === "1" && document.querySelector("button") === button;
      }),
      true,
    );

    assert.deepEqual(errors, []);

    console.log(engine.name() + " startup verified");
  } catch (error) {
    failed = true;

    await diagnostics?.capture(error);

    throw new Error(engine.name() + " generated startup failed: " + String(error), {
      cause: error,
    });
  } finally {
    try {
      await diagnostics?.dispose().catch((error) => {
        if (!failed) throw error;
      });
    } finally {
      await browser.close().catch((error) => {
        if (!failed) throw error;
      });
    }
  }
}
