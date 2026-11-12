import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** @typedef {import("playwright").BrowserType} BrowserType */
const [playwrightUrl, applicationUrl] = process.argv.slice(2);

if (!playwrightUrl || !applicationUrl)
  throw new Error("Expected Playwright module URL and application URL");

const schedulingNodeProof = JSON.parse(
  execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      'import { debounce } from "hesperia/scheduling"; const run = debounce((value) => value * 2, 0); console.log(JSON.stringify({ resolved: import.meta.resolve("hesperia/scheduling"), node: process.versions.node, result: await run(21) }));',
    ],
    { cwd: process.cwd(), encoding: "utf8", timeout: 10_000 },
  ),
);

assert.equal(schedulingNodeProof.node, "22.23.2");
assert.equal(schedulingNodeProof.result, 42);
assert.equal(
  realpathSync(fileURLToPath(schedulingNodeProof.resolved)),
  realpathSync(join(process.cwd(), "node_modules/hesperia/dist/scheduling/node.js")),
);

console.error(JSON.stringify({ kind: "installed-scheduling-node", ...schedulingNodeProof }));

/** @type {typeof import("playwright")} */
const playwright = await import(playwrightUrl);

const { chromium, firefox, webkit } = playwright;

/** @type {Record<string, BrowserType>} */
const engines = { chromium, firefox, webkit };

/** @type {string[]} */
const results = [];

/** @param {import("playwright").Page} page @param {string} selector */
async function clickWithoutNavigationWait(page, selector) {
  const box = await page.evaluate((value) => {
    const element = document.querySelector(value);

    if (!(element instanceof HTMLElement)) return null;

    element.scrollIntoView({ block: "center", inline: "center" });

    const rect = element.getBoundingClientRect();

    if (rect.width <= 0 || rect.height <= 0) return null;

    return { x: rect.left, y: rect.top, width: rect.width, height: rect.height };
  }, selector);

  assert.ok(box, "Missing visible pointer target for " + selector);

  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}

for (const [name, engine] of Object.entries(engines)) {
  const browser = await engine.launch();

  try {
    const page = await browser.newPage();

    /** @type {string[]} */
    const errors = [];

    page.on("pageerror", (error) => errors.push(error.message));

    for (const pathname of ["", "deep/link"]) {
      await page.goto(applicationUrl + pathname);

      const count = pathname ? page.locator("#count") : page.getByRole("button");

      await count.waitFor();

      let greetingHandle = null;

      if (pathname) {
        await page.getByText("Hello Hesperia", { exact: true }).waitFor();

        await page.getByText("packed plugin data", { exact: true }).waitFor();

        await page.locator("#captured-guards").waitFor();

        await page.locator("#disposable-guard").waitFor();

        greetingHandle = await page.locator("#greeting").elementHandle();

        await page.waitForFunction(() => globalThis.installedNavigationProof.reassignedCalls === 1);

        if (name === "webkit") await clickWithoutNavigationWait(page, "#try-leave");
        else await page.locator("#try-leave").click();

        await page.waitForFunction(() => globalThis.installedNavigationProof.outcomes.length === 1);

        assert.deepEqual(await page.evaluate(() => globalThis.installedNavigationProof.outcomes), [
          "denied",
        ]);

        assert.equal(
          new URL(page.url()).pathname,
          "/deep/link",
          "The installed beforeLeave import vetoed navigation",
        );

        assert.deepEqual(
          await page.evaluate(() => ({
            directChecks: globalThis.installedNavigationProof.directChecks,
            namespaceChecks: globalThis.installedNavigationProof.namespaceChecks,
            capturedChecks: globalThis.installedNavigationProof.capturedChecks,
            disposableChecks: globalThis.installedNavigationProof.disposableChecks,
            reassignedCalls: globalThis.installedNavigationProof.reassignedCalls,
            reassignedChecks: globalThis.installedNavigationProof.reassignedChecks,
          })),
          {
            directChecks: 1,
            namespaceChecks: 1,
            capturedChecks: 1,
            disposableChecks: 1,
            reassignedCalls: 1,
            reassignedChecks: 0,
          },
          "Captured direct, namespace, and mutable marker values all registered their owner-bound checks",
        );

        if (name === "webkit") await clickWithoutNavigationWait(page, "#remove-disposable");
        else await page.locator("#remove-disposable").click();

        if (name === "webkit")
          await page.waitForFunction(() => !!document.querySelector("#disposable-removed"));
        else await page.locator("#disposable-removed").waitFor();

        assert.equal(
          await page.evaluate(() => globalThis.installedNavigationProof.disposableChecks),
          1,
          "Removing the guard owner does not run its check",
        );
      }

      assert.deepEqual(errors, [], await page.content());

      const countText =
        name === "webkit"
          ? await page.evaluate(
              () =>
                document.querySelector("#count")?.textContent ??
                document.querySelector("button")?.textContent,
            )
          : await count.textContent();

      assert.equal(countText, "Count: 0", await page.content());

      if (!pathname) {
        const result = await count.evaluate((button) => {
          const countButton = /** @type {HTMLButtonElement} */ (button);

          countButton.click();

          const first = countButton.textContent;

          countButton.click();

          const renderedButton = document.querySelector("button");

          return {
            first,
            second: countButton.textContent,
            same: renderedButton === countButton,
          };
        });

        assert.deepEqual(result, { first: "Count: 1", second: "Count: 2", same: true });
      }

      if (pathname) {
        if (name === "webkit") await clickWithoutNavigationWait(page, "#rename");
        else await page.locator("#rename").click();

        if (name === "webkit")
          await page.waitForFunction(
            () => document.querySelector("#greeting")?.textContent === "Hello Aeolia",
          );
        else await page.getByText("Hello Aeolia", { exact: true }).waitFor();

        assert.equal(
          await greetingHandle?.evaluate(
            (node) => node.isConnected && document.querySelector("#greeting") === node,
          ),
          true,
        );

        await greetingHandle?.dispose();

        await page.evaluate(() => {
          globalThis.installedNavigationProof.allow = true;
        });

        if (name === "webkit") await clickWithoutNavigationWait(page, "#try-leave");
        else await page.locator("#try-leave").click();

        await page.waitForFunction(() => globalThis.installedNavigationProof.outcomes.length === 2);

        assert.deepEqual(await page.evaluate(() => globalThis.installedNavigationProof.outcomes), [
          "denied",
          "committed",
        ]);

        assert.equal(
          new URL(page.url()).pathname,
          "/",
          "The installed captured guards allow navigation after owner cleanup",
        );

        assert.deepEqual(
          await page.evaluate(() => ({
            directChecks: globalThis.installedNavigationProof.directChecks,
            namespaceChecks: globalThis.installedNavigationProof.namespaceChecks,
            capturedChecks: globalThis.installedNavigationProof.capturedChecks,
            disposableChecks: globalThis.installedNavigationProof.disposableChecks,
            reassignedCalls: globalThis.installedNavigationProof.reassignedCalls,
            reassignedChecks: globalThis.installedNavigationProof.reassignedChecks,
          })),
          {
            directChecks: 2,
            namespaceChecks: 2,
            capturedChecks: 2,
            disposableChecks: 1,
            reassignedCalls: 1,
            reassignedChecks: 0,
          },
          "The live captured checks run on allow, the disposed owner's check stays removed, and reassignment stays an ordinary call",
        );
      }

      assert.deepEqual(errors, []);
    }

    await page.goto(applicationUrl + "users/Hesperia");

    if (name === "webkit") {
      await page.waitForFunction(
        () => document.querySelector("h1")?.textContent === "User Hesperia",
      );

      await page.waitForFunction(
        () => document.querySelector("main p")?.textContent === "HELLO HESPERIA",
      );
    } else {
      await page.getByRole("heading", { name: "User Hesperia" }).waitFor();

      await page.getByText("HELLO HESPERIA", { exact: true }).waitFor();
    }

    assert.deepEqual(errors, []);

    const schedulingTarget = new URL("deep/link", new URL("scheduling", applicationUrl));

    await page.goto(applicationUrl + "scheduling");
    await page.locator("#installed-schedule").click();
    await page.waitForFunction(
      () =>
        document.querySelector("#installed-scheduling-result")?.textContent === "packed scheduling",
    );

    const schedulingDocument = await page.evaluateHandle(() => document);
    assert.equal(
      await page.evaluate(() => document.documentElement.dataset.installedSchedulingCleanup),
      undefined,
    );
    await page.locator("#remove-installed-scheduling").click();
    await page.locator("#installed-scheduling-removed").waitFor();
    assert.equal(await page.locator("#installed-scheduling-control").count(), 0);
    await page.waitForFunction(
      () => document.documentElement.dataset.installedSchedulingCleanup === "true",
    );
    assert.equal(
      await page.evaluate((original) => original === document, schedulingDocument),
      true,
    );
    await schedulingDocument.dispose();

    const leaveScheduling =
      name === "webkit"
        ? clickWithoutNavigationWait(page, "#leave-installed-scheduling")
        : page.locator("#leave-installed-scheduling").click();

    await Promise.all([page.waitForURL(schedulingTarget.href), leaveScheduling]);
    await page.locator("#count").waitFor();
    assert.deepEqual(errors, []);

    await page.goto(applicationUrl + "form");

    const nameInput = page.locator("#form-name");

    await nameInput.fill(" aDa ");
    await page.locator("#validate-form").click();
    await page.waitForFunction(
      () => document.querySelector("#form-status")?.textContent === "success",
    );

    assert.equal(await page.locator("#form-result").textContent(), "Hello, ADA");

    await page.locator("#reset-form-validation").click();
    await page.waitForFunction(
      () =>
        document.querySelector("#form-status")?.textContent === "idle" &&
        document.querySelector("#form-result")?.textContent === "",
    );

    assert.equal(await nameInput.inputValue(), " aDa ");
    assert.deepEqual(errors, []);

    results.push(name);
  } catch (error) {
    throw new Error(name + " installed application failed", { cause: error });
  } finally {
    await browser.close();
  }
}

console.log(JSON.stringify(results));
