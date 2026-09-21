import { expect, test } from "@playwright/test";

interface StructureFixture {
  readonly errors: readonly string[];
  readonly warnings: readonly string[];
  readonly panelCleanups: number;
  readonly controls: {
    reorder(): void;
    updateRow(id: string, label: string): void;
    togglePanel(): void;
    replaceRaw(): void;
    dispose(): void;
  };
  dispose(): void;
}

test("compiled structures preserve keyed DOM, scope updates, cleanup, and raw regions", async ({
  page,
}) => {
  await page.goto("/structure");
  await expect(page.locator("html")).toHaveAttribute("data-ready", "true");
  expect(await page.locator("#raw-integrated").evaluate((node) => node.namespaceURI)).toBe(
    "http://www.w3.org/1999/xhtml",
  );
  const readFixture = () =>
    page.evaluate(() => {
      const fixture = (globalThis as unknown as { structureFixture: StructureFixture })
        .structureFixture;
      return {
        errors: [...fixture.errors],
        warnings: [...fixture.warnings],
        panelCleanups: fixture.panelCleanups,
      };
    });

  await expect(page.locator("#keyed-rows button")).toHaveText(["A:0", "B:0", "C:0"]);
  await expect(page.locator("#native-rows span")).toHaveText(["A", "B", "C"]);
  const initialSpans = await page.locator("#native-rows span").elementHandles();
  const initialButtons = await page.locator("#keyed-rows button").elementHandles();
  await page.evaluate(() => {
    const buttons = [...document.querySelectorAll<HTMLButtonElement>("#keyed-rows button")];
    buttons[0]!.click();
  });
  await page.evaluate(() => {
    const fixture = (globalThis as unknown as { structureFixture: StructureFixture })
      .structureFixture;
    fixture.controls.reorder();
  });
  const moved = await page.evaluate(
    ({ firstButtons }) => {
      const buttons = [...document.querySelectorAll<HTMLButtonElement>("#keyed-rows button")];
      return {
        order: buttons.map((button) => button.dataset.row ?? button.closest("li")?.dataset.row),
        preserved:
          buttons[1] === firstButtons[0] &&
          buttons[2] === firstButtons[1] &&
          buttons[0] === firstButtons[2],
        text: buttons.map((button) => button.textContent),
      };
    },
    { firstButtons: initialButtons },
  );
  expect(moved.order).toEqual(["c", "a", "b"]);
  expect(moved.preserved).toBe(true);
  expect(moved.text).toEqual(["C:0", "A:1", "B:0"]);
  await expect(page.locator("#native-rows span")).toHaveText(["C", "A", "B"]);
  expect(
    await page.evaluate(
      ({ previous }) => {
        const spans = [...document.querySelectorAll("#native-rows span")];
        return spans[0] === previous[2] && spans[1] === previous[0] && spans[2] === previous[1];
      },
      { previous: initialSpans },
    ),
  ).toBe(true);

  const beforeScoped = await page.locator("#keyed-rows button").elementHandles();
  await page.evaluate(() => {
    const fixture = (globalThis as unknown as { structureFixture: StructureFixture })
      .structureFixture;
    fixture.controls.updateRow("b", "Bee");
  });
  const scopedIdentity = await page.evaluate(
    ({ previous }) =>
      [...document.querySelectorAll<HTMLButtonElement>("#keyed-rows button")].every(
        (button, index) => button === previous[index],
      ),
    { previous: beforeScoped },
  );
  expect(scopedIdentity).toBe(true);
  await expect(page.locator("#keyed-rows button")).toHaveText(["C:0", "A:1", "Bee:0"]);
  await expect(page.locator("#native-rows span")).toHaveText(["C", "A", "Bee"]);
  expect(
    await initialSpans[1]!.evaluate(
      (element) => element === document.querySelector('[data-native-row="b"] span'),
    ),
  ).toBe(true);

  expect((await readFixture()).panelCleanups).toBe(0);
  await page.evaluate(() => {
    const fixture = (globalThis as unknown as { structureFixture: StructureFixture })
      .structureFixture;
    fixture.controls.togglePanel();
  });
  await expect(page.locator("#panel")).toHaveCount(0);
  await expect(page.locator("#panel-removed")).toHaveText("removed");
  expect((await readFixture()).panelCleanups).toBe(1);
  await expect(page.locator("#native-rows span")).toHaveCount(0);
  await expect(page.locator("#native-rows em")).toHaveText(["C", "A", "Bee"]);
  expect(await initialSpans[1]!.evaluate((element) => element.isConnected)).toBe(false);

  const oldHost = await page.locator("#raw-host").elementHandle();
  const oldContent = await page.locator("[data-raw-fragment]").elementHandles();
  expect(oldHost).toBeTruthy();
  expect(oldContent).toHaveLength(2);
  await page.evaluate(() => {
    const fixture = (globalThis as unknown as { structureFixture: StructureFixture })
      .structureFixture;
    fixture.controls.replaceRaw();
  });
  const rawAfter = await page.evaluate(
    ({ oldHost, oldContent }) => ({
      hostChanged: oldHost !== document.querySelector("#raw-host"),
      oldDetached: !oldHost.isConnected && oldContent.every((node) => !node.isConnected),
      hostText: document.querySelector("#raw-host")?.textContent,
      fragment: [...document.querySelectorAll("[data-raw-fragment]")].map(
        (node) => node.textContent,
      ),
    }),
    { oldHost, oldContent },
  );
  expect(rawAfter).toEqual({
    hostChanged: true,
    oldDetached: true,
    hostText: "host two",
    fragment: ["fragment three", "fragment four"],
  });
  await expect(page.locator("[data-independent-raw]")).toHaveText(["host two", "host two"]);
  await page.evaluate(() => {
    const fixture = (globalThis as unknown as { structureFixture: StructureFixture })
      .structureFixture;
    fixture.controls.replaceRaw();
  });

  await page.evaluate(() => {
    const fixture = (globalThis as unknown as { structureFixture: StructureFixture })
      .structureFixture;
    fixture.dispose();
  });
  await expect(page.locator("#structure")).toHaveCount(0);
  const final = await readFixture();
  expect(final.errors).toEqual([]);
  expect(final.warnings.filter((message) => message.includes("unsafe HTML"))).toHaveLength(5);
  expect(final.warnings.filter((message) => !message.includes("unsafe HTML"))).toStrictEqual([]);
});
