import { expect, test } from "@playwright/test";

type HarnessState =
  | "not-started"
  | "mounting-control"
  | "preloading"
  | "pending"
  | "ready"
  | "failed";

interface ComponentCssHarness {
  start(options?: {
    readonly panelCount?: 1 | 2;
    readonly includeControl?: boolean;
  }): Promise<void>;

  whenSettled(): Promise<void>;

  dispose(name: "first" | "second" | "control"): void;

  snapshot(): {
    readonly effects: readonly string[];
    readonly state: HarnessState;
  };
}

declare global {
  interface Window {
    hesperiaComponentCss?: ComponentCssHarness;
  }
}

function holdStylesheets(page: import("@playwright/test").Page) {
  const releases: (() => void)[] = [];
  const observations: Promise<void>[] = [];
  const signals: (() => void)[] = [];
  const gates: Promise<void>[] = [];
  const requests: { readonly assetPath: string; readonly documentPath: string }[] = [];

  for (let index = 0; index < 2; index++) {
    let release!: () => void;

    gates.push(new Promise<void>((resolve) => (release = resolve)));

    releases.push(() => release());

    let signal!: () => void;

    observations.push(new Promise<void>((resolve) => (signal = resolve)));

    signals.push(signal);
  }

  const route = page.route("**/*.css", async (intercepted) => {
    const index = requests.length;

    requests.push({
      assetPath: new URL(intercepted.request().url()).pathname,
      documentPath: new URL(intercepted.request().frame().url()).pathname,
    });

    if (index < gates.length) {
      signals[index]?.();

      await gates[index];
    }

    await intercepted.continue();
  });

  return {
    requests,
    route,

    waitFor(index: number) {
      return observations[index]!;
    },

    release(index: number) {
      releases[index]!();
    },

    gates,
  };
}

async function openFixture(page: import("@playwright/test").Page): Promise<void> {
  await page.goto("/component-css");

  await expect.poll(() => page.evaluate(() => Boolean(window.hesperiaComponentCss))).toBe(true);

  await page.evaluate(() => {
    const host = document.querySelector("#mount-frame-host");

    if (!host) throw new Error("The component CSS mount host is missing");

    const frame = document.createElement("iframe");
    frame.id = "mount-frame";
    frame.src = "/component-css-frame";
    frame.title = "Component CSS mount document";

    host.append(frame);
  });

  await expect(page.locator("#mount-frame")).toBeVisible();

  await expect(page.frameLocator("#mount-frame").locator("#first-target")).toBeAttached();
}

async function waitForRequest(
  stylesheet: ReturnType<typeof holdStylesheets>,
  index: number,
): Promise<void> {
  await expect.poll(() => stylesheet.requests.length, { timeout: 5_000 }).toBeGreaterThan(index);

  await stylesheet.waitFor(index);
}

test("compiled component CSS gates module preload and mount effects on their own Documents", async ({
  page,
}) => {
  const pageErrors: string[] = [];

  page.on("pageerror", (error) => pageErrors.push(error.message));

  const stylesheet = holdStylesheets(page);
  await stylesheet.route;

  await openFixture(page);

  await page.evaluate(() => {
    void window.hesperiaComponentCss!.start({ panelCount: 1, includeControl: true });
  });

  await waitForRequest(stylesheet, 0);

  await expect(
    page.frameLocator("#mount-frame").locator("#control-target .golden-component-css"),
  ).toBeVisible();

  const modulePreload = await page.evaluate(() => {
    const frameDocument =
      document.querySelector<HTMLIFrameElement>("#mount-frame")!.contentDocument!;
    return {
      state: window.hesperiaComponentCss!.snapshot().state,
      effects: window.hesperiaComponentCss!.snapshot().effects,
      firstPanelCount: frameDocument.querySelectorAll("#first-target .golden-component-css").length,
      controlVisible:
        frameDocument
          .querySelector<HTMLElement>("#control-target .golden-component-css")!
          .getClientRects().length > 0,
      mainStyleLinks: document.head.querySelectorAll('link[rel="stylesheet"]').length,
      mountStyleLinks: frameDocument.head.querySelectorAll('link[rel="stylesheet"]').length,
    };
  });

  expect(modulePreload).toStrictEqual({
    state: "preloading",
    effects: ["control:rgb(0, 0, 0)"],
    firstPanelCount: 0,
    controlVisible: true,
    mainStyleLinks: 1,
    mountStyleLinks: 0,
  });

  expect(stylesheet.requests[0]!.documentPath).toBe("/component-css");

  stylesheet.release(0);

  await waitForRequest(stylesheet, 1);

  await expect(
    page.frameLocator("#mount-frame").locator("#first-target .golden-component-css"),
  ).toHaveCount(1);

  const pending = await page.evaluate(() => {
    const frameDocument =
      document.querySelector<HTMLIFrameElement>("#mount-frame")!.contentDocument!;
    const target = frameDocument.querySelector("#first-target")!;
    const panel = target.querySelector<HTMLElement>(".golden-component-css")!;
    const control = frameDocument.querySelector<HTMLElement>(
      "#control-target .golden-component-css",
    )!;
    return {
      panelConnected: panel.isConnected,
      panelVisible: panel.getClientRects().length > 0,
      controlVisible: control.getClientRects().length > 0,
      controlColor: getComputedStyle(control).color,
      effects: window.hesperiaComponentCss!.snapshot().effects,
      readiness: window.hesperiaComponentCss!.snapshot().state,
      mountStyleLinks: frameDocument.head.querySelectorAll('link[rel="stylesheet"]').length,
    };
  });

  expect(pending).toStrictEqual({
    panelConnected: true,
    panelVisible: false,
    controlVisible: true,
    controlColor: "rgb(0, 0, 0)",
    effects: ["control:rgb(0, 0, 0)"],
    readiness: "pending",
    mountStyleLinks: 1,
  });

  const pendingPanel = await page
    .frameLocator("#mount-frame")
    .locator("#first-target .golden-component-css")
    .elementHandle();

  expect(pendingPanel).not.toBeNull();

  stylesheet.release(1);

  await page.evaluate(() => window.hesperiaComponentCss!.whenSettled());

  const revealed = await page.evaluate(() => {
    const frameDocument =
      document.querySelector<HTMLIFrameElement>("#mount-frame")!.contentDocument!;
    const panel = frameDocument.querySelector<HTMLElement>("#first-target .golden-component-css")!;
    const control = frameDocument.querySelector<HTMLElement>(
      "#control-target .golden-component-css",
    )!;
    return {
      panelVisible: panel.getClientRects().length > 0,
      panelColor: getComputedStyle(panel).color,
      controlColor: getComputedStyle(control).color,
      effects: window.hesperiaComponentCss!.snapshot().effects,
      readiness: window.hesperiaComponentCss!.snapshot().state,
      mountStyleLinks: frameDocument.head.querySelectorAll('link[rel="stylesheet"]').length,
    };
  });

  expect(revealed).toStrictEqual({
    panelVisible: true,
    panelColor: "rgb(196, 30, 78)",
    controlColor: "rgb(196, 30, 78)",
    effects: ["control:rgb(0, 0, 0)", "first:rgb(196, 30, 78)"],
    readiness: "ready",
    mountStyleLinks: 1,
  });

  expect(
    await pendingPanel!.evaluate(
      (node) => node === document.querySelector("#first-target .golden-component-css"),
    ),
  ).toBe(true);

  expect(stylesheet.requests).toHaveLength(2);

  expect(stylesheet.requests.map(({ documentPath }) => documentPath)).toStrictEqual([
    "/component-css",
    "/component-css-frame",
  ]);

  expect(stylesheet.requests.every(({ assetPath }) => assetPath.endsWith(".css"))).toBe(true);

  expect(pageErrors).toStrictEqual([]);

  await page.evaluate(() => {
    window.hesperiaComponentCss!.dispose("first");

    window.hesperiaComponentCss!.dispose("control");
  });

  await expect(
    page.frameLocator("#mount-frame").locator('head link[rel="stylesheet"]'),
  ).toHaveCount(0);
});

test("multiple component mounts share CSS until the last mount is disposed", async ({ page }) => {
  const pageErrors: string[] = [];

  page.on("pageerror", (error) => pageErrors.push(error.message));

  const stylesheet = holdStylesheets(page);
  await stylesheet.route;

  await openFixture(page);

  await page.evaluate(() => {
    void window.hesperiaComponentCss!.start({ panelCount: 2 });
  });

  await waitForRequest(stylesheet, 0);

  await expect(
    page.frameLocator("#mount-frame").locator("#first-target .golden-component-css"),
  ).toHaveCount(0);

  expect(await page.evaluate(() => window.hesperiaComponentCss!.snapshot())).toStrictEqual({
    effects: [],
    state: "preloading",
  });

  stylesheet.release(0);

  await waitForRequest(stylesheet, 1);

  const frame = page.frameLocator("#mount-frame");

  await expect(frame.locator("#first-target .golden-component-css")).toHaveCount(1);

  await expect(frame.locator("#second-target .golden-component-css")).toHaveCount(1);

  expect(stylesheet.requests).toHaveLength(2);

  const firstPanel = await frame.locator("#first-target .golden-component-css").elementHandle();
  const secondPanel = await frame.locator("#second-target .golden-component-css").elementHandle();

  expect(firstPanel).not.toBeNull();

  expect(secondPanel).not.toBeNull();

  const mounting = await page.evaluate(() => {
    const frameDocument =
      document.querySelector<HTMLIFrameElement>("#mount-frame")!.contentDocument!;
    return {
      firstVisible:
        frameDocument
          .querySelector<HTMLElement>("#first-target .golden-component-css")!
          .getClientRects().length > 0,
      secondVisible:
        frameDocument
          .querySelector<HTMLElement>("#second-target .golden-component-css")!
          .getClientRects().length > 0,
      effects: window.hesperiaComponentCss!.snapshot().effects,
      state: window.hesperiaComponentCss!.snapshot().state,
      styleLinks: frameDocument.head.querySelectorAll('link[rel="stylesheet"]').length,
    };
  });

  expect(mounting).toStrictEqual({
    firstVisible: false,
    secondVisible: false,
    effects: [],
    state: "pending",
    styleLinks: 1,
  });

  stylesheet.release(1);

  await page.evaluate(() => window.hesperiaComponentCss!.whenSettled());

  expect(
    await Promise.all([
      firstPanel!.evaluate(
        (node) => node === document.querySelector("#first-target .golden-component-css"),
      ),
      secondPanel!.evaluate(
        (node) => node === document.querySelector("#second-target .golden-component-css"),
      ),
    ]),
  ).toStrictEqual([true, true]);

  await page.evaluate(() => window.hesperiaComponentCss!.dispose("first"));

  const afterFirstRelease = await page.evaluate(() => {
    const frameDocument =
      document.querySelector<HTMLIFrameElement>("#mount-frame")!.contentDocument!;
    const remaining = frameDocument.querySelector<HTMLElement>(
      "#second-target .golden-component-css",
    )!;
    return {
      remainingVisible: remaining.getClientRects().length > 0,
      remainingColor: getComputedStyle(remaining).color,
      styleLinkCount: frameDocument.head.querySelectorAll('link[rel="stylesheet"]').length,
    };
  });

  expect(afterFirstRelease).toStrictEqual({
    remainingVisible: true,
    remainingColor: "rgb(196, 30, 78)",
    styleLinkCount: 1,
  });

  await page.evaluate(() => window.hesperiaComponentCss!.dispose("second"));

  await expect(frame.locator('head link[rel="stylesheet"]')).toHaveCount(0);

  const final = await page.evaluate(() => {
    const frameDocument =
      document.querySelector<HTMLIFrameElement>("#mount-frame")!.contentDocument!;
    return {
      effects: window.hesperiaComponentCss!.snapshot().effects,
      firstCount: frameDocument.querySelectorAll("#first-target .golden-component-css").length,
      secondCount: frameDocument.querySelectorAll("#second-target .golden-component-css").length,
    };
  });

  expect(final.firstCount).toBe(0);

  expect(final.secondCount).toBe(0);

  expect(
    final.effects.filter((effect) => effect.endsWith(":rgb(196, 30, 78)")).sort(),
  ).toStrictEqual(["first:rgb(196, 30, 78)", "second:rgb(196, 30, 78)"]);

  expect(stylesheet.requests.map(({ documentPath }) => documentPath)).toStrictEqual([
    "/component-css",
    "/component-css-frame",
  ]);

  expect(pageErrors).toStrictEqual([]);
});
