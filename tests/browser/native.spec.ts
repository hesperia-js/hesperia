import { expect, test } from "@playwright/test";

declare global {
  interface Window {
    nativeFixture: { events(): string[]; optionEvents(): string[]; dispose(): void };
    eventOptionRemovals: string[];
    eventOptionsCacheFixture: {
      calls(): string[];

      errors(): string[];

      goTwo(): Promise<string>;

      goBack(): Promise<void>;

      dispatchParked(): void;

      sameRestoredNode(): boolean;
    };
  }
}

test("compiled browser constructors read native form state and release an abortable listener", async ({
  page,
}) => {
  const errors: string[] = [];

  page.on("pageerror", (error) => errors.push(error.message));

  await page.goto("/native");

  await expect(page.locator("html")).toHaveAttribute("data-ready", "true");

  const form = await page.locator("#constructor-form").elementHandle();
  const field = await page.locator("#constructor-name").elementHandle();

  if (!form || !field) throw new Error("The native form was not mounted");

  await page.locator("#constructor-name").fill("Grace Hopper");

  await page.locator("#constructor-submit").click();

  await expect(page.locator("#constructor-result")).toHaveText("/profile?name=Grace+Hopper");

  expect(await page.evaluate(() => window.nativeFixture.events())).toStrictEqual(["profile-ready"]);

  expect(await field.evaluate((node) => node === document.getElementById("constructor-name"))).toBe(
    true,
  );

  await page.locator("#constructor-name").fill("Ada");

  await page.locator("#constructor-submit").click();

  await expect(page.locator("#constructor-result")).toHaveText("/profile?name=Ada");

  expect(await page.evaluate(() => window.nativeFixture.events())).toStrictEqual([
    "profile-ready",
    "profile-ready",
  ]);

  await page.evaluate(() => window.nativeFixture.dispose());

  await expect(page.locator("#app")).toBeEmpty();

  await form.evaluate((node) => node.dispatchEvent(new CustomEvent("profile-ready")));

  expect(await page.evaluate(() => window.nativeFixture.events())).toStrictEqual([
    "profile-ready",
    "profile-ready",
  ]);

  expect(await page.locator("html").getAttribute("data-fault")).toBeNull();

  expect(errors).toStrictEqual([]);
});

test("compiled typed native bindings, namespaces, scalar attributes and events agree", async ({
  page,
}) => {
  const errors: string[] = [];

  page.on("pageerror", (error) => errors.push(error.message));

  await page.goto("/native");

  await expect(page.locator("html")).toHaveAttribute("data-ready", "true");

  await expect(page.locator("#binding-result")).toHaveText(
    "http://www.w3.org/2000/svg|3|http://www.w3.org/1999/xhtml|http://www.w3.org/1998/Math/MathML",
  );

  await expect(page.locator("#native")).toHaveCSS("color", "rgb(255, 0, 0)");

  expect(await page.locator("#svg-link").evaluate((element) => element.namespaceURI)).toBe(
    "http://www.w3.org/2000/svg",
  );

  expect(await page.locator("#math-html").evaluate((element) => element.namespaceURI)).toBe(
    "http://www.w3.org/1999/xhtml",
  );

  await page.locator("#native-click").dispatchEvent("click", { clientX: 23 });

  await expect(page.locator("#event-result")).toHaveText("BUTTON:23");

  await page.locator("#native-input").dispatchEvent("keydown", { key: "Enter" });

  await expect(page.locator("#event-result")).toHaveText("Enter");

  expect(await page.locator("html").getAttribute("data-fault")).toBeNull();

  expect(errors).toStrictEqual([]);
});

test("compiled event pairs retain native once, capture, passive, fault, and release behavior", async ({
  page,
}) => {
  const errors: string[] = [];

  page.on("pageerror", (error) => errors.push(error.message));

  await page.goto("/native");

  await expect(page.locator("html")).toHaveAttribute("data-ready", "true");

  await page.locator("#native-option-once-a").click();

  await page.locator("#native-option-once-a").click();

  await page.locator("#native-option-once-b").click();

  await page.locator("#native-option-once-b").click();

  await page.locator("#native-option-capture-target").click();

  const passiveDispatch = await page
    .locator("#native-option-passive")
    .evaluate((node) => node.dispatchEvent(new Event("click", { cancelable: true })));
  const ordinaryDispatch = await page
    .locator("#native-option-ordinary")
    .evaluate((node) => node.dispatchEvent(new Event("click", { cancelable: true })));

  expect(passiveDispatch).toBe(true);

  expect(ordinaryDispatch).toBe(false);

  await page.locator("#native-option-fault").click();

  await expect(page.locator("html")).toHaveAttribute("data-fault", "native event pair failed");

  expect(await page.evaluate(() => window.nativeFixture.optionEvents())).toStrictEqual([
    "once:native-option-once-a:true",
    "once:native-option-once-b:true",
    "capture",
    "target",
    "passive:false",
    "ordinary:true",
    "fault",
  ]);

  const capture = await page.locator("#native-option-capture").elementHandle();
  const ordinary = await page.locator("#native-option-ordinary").elementHandle();

  if (!capture || !ordinary) throw new Error("The native option listeners are missing");

  const removals: string[] = [];

  await capture.evaluate((node) => {
    window.eventOptionRemovals = [];
    const remove = node.removeEventListener.bind(node);
    node.removeEventListener = ((
      type: string,
      listener: EventListener | null,
      options?: boolean | EventListenerOptions,
    ) => {
      window.eventOptionRemovals.push(
        `${type}:${typeof options === "boolean" ? options : (options?.capture ?? false)}`,
      );

      Reflect.apply(remove, node, [type, listener, options]);
    }) as typeof node.removeEventListener;
  });

  await ordinary.evaluate((node) => {
    const remove = node.removeEventListener.bind(node);
    node.removeEventListener = ((
      type: string,
      listener: EventListener | null,
      options?: boolean | EventListenerOptions,
    ) => {
      window.eventOptionRemovals.push(
        `${type}:${typeof options === "boolean" ? options : (options?.capture ?? false)}`,
      );

      Reflect.apply(remove, node, [type, listener, options]);
    }) as typeof node.removeEventListener;
  });

  await page.evaluate(() => window.nativeFixture.dispose());

  await expect(page.locator("#app")).toBeEmpty();

  removals.push(...(await page.evaluate(() => window.eventOptionRemovals)));

  expect(removals).toContain("click:true");

  expect(removals).toContain("click:false");

  expect(await page.evaluate(() => window.nativeFixture.optionEvents())).toHaveLength(7);

  expect(errors).toStrictEqual([]);
});

test("compiled once state survives a cached route suspension and restoration", async ({ page }) => {
  const errors: string[] = [];

  page.on("pageerror", (error) => errors.push(error.message));

  await page.goto("/event-options-cache");

  await expect(page.locator("html")).toHaveAttribute("data-ready", "true");

  await page.locator("#event-cache-once-a").click();

  await page.locator("#event-cache-regular").click();

  expect(await page.evaluate(() => window.eventOptionsCacheFixture.calls())).toStrictEqual([
    "once:event-cache-once-a:true",
    "regular",
  ]);

  expect(await page.evaluate(() => window.eventOptionsCacheFixture.goTwo())).toBe("committed");

  await expect(page.locator("#event-cache-two")).toBeVisible();

  await expect(page.locator("#event-cache-one")).toHaveCount(0);

  await page.evaluate(() => window.eventOptionsCacheFixture.dispatchParked());

  expect(await page.evaluate(() => window.eventOptionsCacheFixture.calls())).toStrictEqual([
    "once:event-cache-once-a:true",
    "regular",
  ]);

  await page.evaluate(() => window.eventOptionsCacheFixture.goBack());

  await expect(page.locator("#event-cache-one")).toBeVisible();

  expect(await page.evaluate(() => window.eventOptionsCacheFixture.sameRestoredNode())).toBe(true);

  await page.locator("#event-cache-regular").click();

  await page.locator("#event-cache-once-a").click();

  await page.locator("#event-cache-once-b").click();

  expect(await page.evaluate(() => window.eventOptionsCacheFixture.calls())).toStrictEqual([
    "once:event-cache-once-a:true",
    "regular",
    "regular",
    "once:event-cache-once-b:true",
  ]);

  expect(await page.evaluate(() => window.eventOptionsCacheFixture.errors())).toStrictEqual([]);

  expect(errors).toStrictEqual([]);
});

test("an optional native binding preserves synchronous moves and publishes permanent removal", async ({
  page,
}) => {
  const errors: string[] = [];

  page.on("pageerror", (error) => errors.push(error.message));

  await page.goto("/native");

  await expect(page.locator("html")).toHaveAttribute("data-ready", "true");

  await expect(page.locator("#optional-result")).toHaveText("present");

  const target = await page.locator("#optional-native").elementHandle();

  if (!target) throw new Error("Optional binding target was not rendered");

  await target.evaluate((element) => {
    element.remove();

    document.querySelector("#native")!.appendChild(element);
  });

  expect(
    await target.evaluate((element) => element === document.querySelector("#optional-native")),
  ).toBe(true);

  await expect(page.locator("#optional-result")).toHaveText("present");

  expect(await page.locator("html").getAttribute("data-fault")).toBeNull();

  await target.evaluate((element) => element.remove());

  await expect(page.locator("#optional-result")).toHaveText("absent");

  await expect(page.locator("html")).toHaveAttribute(
    "data-fault",
    "A bound element was removed from its rendered tree",
  );

  expect(errors).toStrictEqual([]);
});
