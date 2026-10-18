import assert from "node:assert/strict";

const [playwrightModuleUrl, applicationUrl] = process.argv.slice(2);

const { chromium, firefox, webkit } = /** @type {typeof import("playwright")} */ (
  await import(playwrightModuleUrl)
);

for (const engine of [chromium, firefox, webkit]) {
  const browser = await engine.launch();

  try {
    const page = await browser.newPage();

    await page.goto(applicationUrl);

    await page.locator("#task").waitFor();

    await page.locator("#task-effect").waitFor({ state: "attached" });

    assert.equal(await page.locator("#shell-shared").textContent(), "initial");

    assert.equal(await page.locator("#task-effect").getAttribute("data-runs"), "1");

    assert.equal(await page.locator("#task-effect").getAttribute("data-value"), "initial");

    const parkedTask = await page.locator("#task").elementHandle();

    const parkedEffect = await page.locator("#task-effect").elementHandle();

    if (!parkedTask || !parkedEffect) throw new Error("Task page handles are missing");

    await page.locator("#start").click();

    await page.waitForFunction(() => {
      const fixture = globalThis.pageTaskFixture;

      return (
        fixture.started === 1 && document.querySelector("#task-status")?.textContent === "pending"
      );
    });

    await page.locator("#task-other").click();

    await page.locator("#other").waitFor();

    assert.equal(await parkedTask.evaluate((node) => node.isConnected), false);

    await page.evaluate(() => {
      const fixture = globalThis.pageTaskFixture;

      if (!fixture.release) throw new Error("Page task release is missing while parked");

      fixture.release();
    });

    await page.waitForFunction(
      () => document.querySelector("#shell-shared")?.textContent === "settled",
    );

    assert.equal(await parkedEffect.getAttribute("data-runs"), "1");

    assert.equal(await parkedEffect.getAttribute("data-value"), "initial");

    assert.deepEqual(
      await page.evaluate(() => ({
        releases: globalThis.pageTaskFixture.releases,
        aborts: globalThis.pageTaskFixture.aborts,
      })),
      { releases: 1, aborts: 0 },
    );

    await page.evaluate(() => history.back());

    await page.locator("#task").waitFor();

    assert.equal(
      await page.evaluate((node) => node === document.querySelector("#task"), parkedTask),
      true,
    );

    assert.equal(await page.locator("#task-status").textContent(), "success");

    assert.equal(await page.locator("#task-effect").getAttribute("data-runs"), "2");

    assert.equal(await page.locator("#task-effect").getAttribute("data-value"), "settled");

    await page.locator("#start").click();

    await page.waitForFunction(() => {
      const fixture = globalThis.pageTaskFixture;

      return (
        fixture.started === 2 && document.querySelector("#task-status")?.textContent === "pending"
      );
    });

    const evictedTask = await page.locator("#task").elementHandle();

    if (!evictedTask) throw new Error("Second task page handle is missing");

    await page.locator("#task-other").click();

    await page.locator("#other").waitFor();

    await page.locator("#other-evict").click();

    await page.locator("#evict").waitFor();

    await page.waitForFunction(() => {
      const fixture = globalThis.pageTaskFixture;

      return (
        fixture.started === 2 && fixture.releases === 1 && fixture.aborts === 1 && !fixture.release
      );
    });

    assert.equal(await evictedTask.evaluate((node) => node.isConnected), false);

    console.log(engine.name() + " parked task and eviction verified");
  } finally {
    await browser.close();
  }
}
