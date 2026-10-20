import assert from "node:assert/strict";

const [playwrightModuleUrl, applicationUrl, group] = process.argv.slice(2);
const { chromium, firefox, webkit } = /** @type {typeof import("playwright")} */ (
  await import(playwrightModuleUrl)
);
const failures = [];

assert.ok(group === "continuation" || group === "terminal");

const continuationModes =
  group === "continuation" ? ["fresh-active", "restored-active", "reset-while-parked"] : [];
const terminalModes =
  group === "terminal" ? ["failed-active", "failed-parked", "completed-active"] : [];

for (const engine of [chromium, firefox, webkit]) {
  const browser = await engine.launch();

  try {
    for (const mode of continuationModes) {
      const page = await browser.newPage();
      const errors = /** @type {string[]} */ ([]);

      page.on("pageerror", (error) => errors.push(error.message));

      try {
        await page.goto(applicationUrl);

        await page.locator("#values").waitFor();

        assert.equal(await page.locator("#values").textContent(), "[]");

        assert.equal(await page.locator("#total").textContent(), "100");

        await page.locator("#emit-two").click();

        await page.waitForFunction(
          () =>
            document.querySelector("#values")?.textContent === "[2]" &&
            document.querySelector("#total")?.textContent === "102",
        );

        const retained = await page.locator("#values").elementHandle();

        assert.ok(retained);

        if (mode !== "fresh-active") {
          await page.locator("#other").click();

          await page.locator("#other-page").waitFor();

          assert.equal(await retained.evaluate((node) => node.isConnected), false);

          if (mode === "reset-while-parked") {
            await page.locator("#reset").click();

            await page.waitForFunction(
              () => document.querySelector("#resets")?.textContent === "1",
            );

            await page.locator("#stats").click();

            assert.equal(
              await page.locator("#stream-stats").textContent(),
              '{"opens":1,"aborts":1}',
            );
          }

          await page.goBack();

          await page.locator("#values").waitFor();

          assert.equal(
            await retained.evaluate((node) => node === document.querySelector("#values")),
            true,
          );

          if (mode === "restored-active") {
            assert.equal(await page.locator("#values").textContent(), "[2]");

            assert.equal(await page.locator("#total").textContent(), "102");

            await page.locator("#emit-two").click();

            await page.waitForFunction(
              () =>
                document.querySelector("#values")?.textContent === "[2,2]" &&
                document.querySelector("#total")?.textContent === "104",
            );
          }
        }

        await page.locator("#stats").click();

        assert.equal(
          await page.locator("#stream-stats").textContent(),
          mode === "reset-while-parked" ? '{"opens":2,"aborts":1}' : '{"opens":1,"aborts":0}',
        );

        if (mode !== "reset-while-parked") {
          await page.locator("#reset").click();

          await page.waitForFunction(() => document.querySelector("#resets")?.textContent === "1");
        }

        assert.deepEqual(
          {
            history: await page.locator("#values").textContent(),
            total: await page.locator("#total").textContent(),
          },
          { history: "[]", total: "100" },
          `${engine.name()} ${mode} resets both policies`,
        );

        await page.locator("#emit-seven").click();

        await page.waitForFunction(
          () =>
            document.querySelector("#values")?.textContent === "[7]" &&
            document.querySelector("#total")?.textContent === "107",
        );

        await page.locator("#stats").click();

        assert.equal(await page.locator("#stream-stats").textContent(), '{"opens":2,"aborts":1}');

        assert.deepEqual(errors, []);
      } catch (error) {
        failures.push(`${engine.name()} ${mode}: ${error instanceof Error ? error.stack : error}`);
      } finally {
        await page.close();
      }
    }

    for (const mode of terminalModes) {
      const page = await browser.newPage();

      try {
        await page.goto(new URL("terminal", applicationUrl).href);

        await page.locator("#terminal-page").waitFor();

        await page.locator("#emit-two").click();

        await page.waitForFunction(
          () => document.querySelector("#live-value")?.textContent === "[2]",
        );

        if (mode === "completed-active") {
          await page.locator("#finish").click();

          await page.waitForFunction(
            () => document.querySelector("#live-status")?.textContent === "closed",
          );
        } else {
          await page.locator("#emit-two").click();

          await page.waitForFunction(
            () => document.querySelector("#overflow-status")?.textContent === "failed",
          );

          await page.locator("#emit-seven").click();

          await page.waitForFunction(
            () => document.querySelector("#reducer-status")?.textContent === "failed",
          );

          assert.equal(await page.locator("#overflow-value").textContent(), "[2]");

          assert.equal(await page.locator("#reducer-value").textContent(), "104");

          assert.match(
            await page.locator("#overflow-error").innerText(),
            /accumulation exceeded max/u,
          );

          assert.equal(
            await page.locator("#reducer-error").textContent(),
            "Error: reducer stopped",
          );
        }

        const retained = await page.locator("#terminal-page").elementHandle();

        assert.ok(retained);

        if (mode === "failed-parked") {
          await page.locator("#other").click();

          await page.locator("#other-page").waitFor();
        }

        await page.locator("#reset").click();

        await page.waitForFunction(() => document.querySelector("#resets")?.textContent === "1");

        if (mode === "failed-parked") {
          await page.locator("#stats").click();

          assert.equal(await page.locator("#stream-stats").textContent(), '{"opens":1,"aborts":1}');

          await page.goBack();

          await page.locator("#terminal-page").waitFor();

          assert.equal(
            await retained.evaluate((node) => node === document.querySelector("#terminal-page")),
            true,
          );
        }

        assert.equal(await page.locator("#live-value").textContent(), "[]");

        assert.equal(await page.locator("#overflow-value").textContent(), "[]");

        assert.equal(await page.locator("#reducer-value").textContent(), "100");

        assert.deepEqual(
          {
            overflow: await page.locator("#overflow-error").textContent(),
            reducer: await page.locator("#reducer-error").textContent(),
          },
          { overflow: "undefined", reducer: "undefined" },
          `${engine.name()} ${mode} clears terminal errors`,
        );

        if (mode === "completed-active") {
          await page.locator("#stats").click();

          assert.equal(await page.locator("#stream-stats").textContent(), '{"opens":2,"aborts":1}');

          await page.locator("#emit-five").click();

          await page.waitForFunction(
            () => document.querySelector("#live-status")?.textContent === "live",
          );

          assert.deepEqual(
            {
              live: await page.locator("#live-value").textContent(),
              overflow: await page.locator("#overflow-value").textContent(),
              reducer: await page.locator("#reducer-value").textContent(),
            },
            { live: "[]", overflow: "[]", reducer: "100" },
            "completed projections remain terminal after the shared stream restarts",
          );
        } else {
          assert.equal(await page.locator("#overflow-status").textContent(), "failed");

          assert.equal(await page.locator("#reducer-status").textContent(), "failed");

          await page.locator("#emit-five").click();

          await page.waitForFunction(
            () => document.querySelector("#live-value")?.textContent === "[5]",
          );

          assert.equal(await page.locator("#overflow-value").textContent(), "[]");

          assert.equal(await page.locator("#reducer-value").textContent(), "100");

          await page.locator("#stats").click();

          assert.equal(await page.locator("#stream-stats").textContent(), '{"opens":2,"aborts":1}');
        }
      } catch (error) {
        failures.push(`${engine.name()} ${mode}: ${error instanceof Error ? error.stack : error}`);
      } finally {
        await page.close();
      }
    }

    console.log(`${engine.name()} ${group} verified`);
  } finally {
    await browser.close();
  }
}

assert.deepEqual(failures, []);
