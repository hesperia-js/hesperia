import { expect, test, type Page } from "@playwright/test";

interface EmbedLoadObservation {
  readonly type: string;
  readonly targetTag: string;
  readonly targetName: string;
  readonly sourceAttribute: string;
  readonly targetIsCurrent: boolean;
  readonly targetParentIsWrapper: boolean;
}

interface EmbedReplacementObservation {
  readonly wrapperBindingStable: boolean;
  readonly wrapperConnected: boolean;
  readonly frameReplaced: boolean;
  readonly previousFrameDetached: boolean;
}

interface ChildMessage {
  readonly caseId: string;
  readonly childOrigin: string;
  readonly parentAccess: string;
  readonly eventOrigin: string;
}

declare global {
  interface Window {
    hesperiaEmbedGolden: {
      readonly messages: ChildMessage[];
      readonly loads: readonly EmbedLoadObservation[];

      wrapper(): HTMLElement;

      remember(): void;

      identity(): EmbedReplacementObservation;

      dispose(): void;
    };
  }
}

async function openEmbed(page: Page): Promise<void> {
  await page.goto("/embed-security");

  await expect(page.locator("html")).toHaveAttribute("data-ready", "true");
}

async function waitForChildMessage(
  page: Page,
  caseId: string,
  occurrence = 0,
): Promise<ChildMessage> {
  await page.waitForFunction(
    ({ expectedCase, expectedOccurrence }) =>
      window.hesperiaEmbedGolden.messages.filter(
        ({ caseId: actualCase }) => actualCase === expectedCase,
      ).length > expectedOccurrence,
    { expectedCase: caseId, expectedOccurrence: occurrence },
  );

  return page.evaluate(
    ({ expectedCase, expectedOccurrence }) => {
      const message = window.hesperiaEmbedGolden.messages.filter(
        ({ caseId: actualCase }) => actualCase === expectedCase,
      )[expectedOccurrence];

      if (!message) throw new Error("The expected child message was not recorded");

      return message;
    },
    { expectedCase: caseId, expectedOccurrence: occurrence },
  );
}

test("embed-sandbox-isolation: scripts run while a same-origin child cannot write the parent", async ({
  page,
}) => {
  await openEmbed(page);

  const isolated = await waitForChildMessage(page, "embed-security");

  expect(isolated.parentAccess).toBe("denied");

  expect(isolated.eventOrigin).toBe("null");

  await expect(
    page.frameLocator('iframe[name="hesperia-embed-golden"]').locator("html"),
  ).toHaveAttribute("data-embed-script-ran", "true");

  await expect(page.locator("html")).not.toHaveAttribute(
    "data-embed-child-access",
    "embed-security",
  );

  await page.evaluate(() => {
    const control = document.createElement("iframe");
    control.name = "unsandboxed-negative-control";
    control.title = "Unsandboxed parent-access control";
    control.src = "/embed-child?case=unsandboxed-control";

    document.body.append(control);
  });

  const controlFrame = page.locator('iframe[name="unsandboxed-negative-control"]');

  await expect(controlFrame).not.toHaveAttribute("sandbox");

  const control = await waitForChildMessage(page, "unsandboxed-control");
  const parentOrigin = new URL(page.url()).origin;

  expect(control.parentAccess).toBe("allowed");

  expect(control.childOrigin).toBe(parentOrigin);

  expect(control.eventOrigin).toBe(parentOrigin);

  await expect(page.locator("html")).toHaveAttribute(
    "data-embed-child-access",
    "unsandboxed-control",
  );
});

test("embed-permission-replacement: the wrapper survives while the old frame is detached", async ({
  page,
}) => {
  await openEmbed(page);

  const initial = await waitForChildMessage(page, "embed-security");

  expect(initial.parentAccess).toBe("denied");

  await page.evaluate(() => window.hesperiaEmbedGolden.remember());

  await page.locator("#grant-same-origin").click();

  const replacement = await waitForChildMessage(page, "embed-security", 1);
  const identity = await page.evaluate(() => window.hesperiaEmbedGolden.identity());

  expect(identity).toStrictEqual({
    wrapperBindingStable: true,
    wrapperConnected: true,
    frameReplaced: true,
    previousFrameDetached: true,
  });

  expect(replacement.parentAccess).toBe("allowed");

  expect(replacement.childOrigin).toBe(new URL(page.url()).origin);

  expect(replacement.eventOrigin).toBe(new URL(page.url()).origin);

  await expect(page.locator('iframe[name="hesperia-embed-golden"]')).toHaveAttribute(
    "sandbox",
    "allow-scripts allow-same-origin",
  );

  await expect(page.locator("html")).toHaveAttribute("data-embed-child-access", "embed-security");

  const sizeAfterReplacement = await page.evaluate(() => {
    const wrapper = window.hesperiaEmbedGolden.wrapper();
    const frame = wrapper.querySelector("iframe");

    if (!(frame instanceof HTMLIFrameElement)) throw new Error("The replacement iframe is missing");

    const wrapperRect = wrapper.getBoundingClientRect();
    const frameRect = frame.getBoundingClientRect();
    return {
      wrapperStyleWidth: wrapper.style.width,
      wrapperStyleHeight: wrapper.style.height,
      wrapperWidth: wrapperRect.width,
      wrapperHeight: wrapperRect.height,
      frameParentIsWrapper: frame.parentElement === wrapper,
      frameWidth: frameRect.width,
      frameHeight: frameRect.height,
    };
  });

  expect(sizeAfterReplacement).toStrictEqual({
    wrapperStyleWidth: "320px",
    wrapperStyleHeight: "180px",
    wrapperWidth: 320,
    wrapperHeight: 180,
    frameParentIsWrapper: true,
    frameWidth: 320,
    frameHeight: 180,
  });
});

test("embed-wrapper-binding-sizing: authored numeric and CSS dimensions reach the native layout", async ({
  page,
}) => {
  await openEmbed(page);

  await waitForChildMessage(page, "embed-security");

  const size = await page.evaluate(() => {
    const wrapper = window.hesperiaEmbedGolden.wrapper();
    const frame = wrapper.querySelector("iframe");

    if (!(frame instanceof HTMLIFrameElement)) throw new Error("The bound iframe is missing");

    const wrapperRect = wrapper.getBoundingClientRect();
    const frameRect = frame.getBoundingClientRect();
    return {
      wrapperTag: wrapper.tagName,
      wrapperIsHTMLElement: wrapper instanceof HTMLElement,
      wrapperConnected: wrapper.isConnected,
      wrapperStyleWidth: wrapper.style.width,
      wrapperStyleHeight: wrapper.style.height,
      wrapperWidth: wrapperRect.width,
      wrapperHeight: wrapperRect.height,
      frameParentIsWrapper: frame.parentElement === wrapper,
      frameStyleWidth: frame.style.width,
      frameStyleHeight: frame.style.height,
      frameWidth: frameRect.width,
      frameHeight: frameRect.height,
    };
  });

  expect(size).toStrictEqual({
    wrapperTag: "DIV",
    wrapperIsHTMLElement: true,
    wrapperConnected: true,
    wrapperStyleWidth: "320px",
    wrapperStyleHeight: "180px",
    wrapperWidth: 320,
    wrapperHeight: 180,
    frameParentIsWrapper: true,
    frameStyleWidth: "100%",
    frameStyleHeight: "100%",
    frameWidth: 320,
    frameHeight: 180,
  });

  const rangeSelectsBoundNativeElement = await page.evaluate(() => {
    const wrapper = window.hesperiaEmbedGolden.wrapper();
    const range = document.createRange();

    range.selectNode(wrapper);

    return (
      range.startContainer === wrapper.parentNode &&
      range.startContainer.childNodes[range.startOffset] === wrapper
    );
  });

  expect(rangeSelectsBoundNativeElement).toBe(true);
});

test("embed-native-load-callback: native options are present and load targets the bound frame", async ({
  page,
}) => {
  await openEmbed(page);

  await waitForChildMessage(page, "embed-security");

  await page.waitForFunction(() =>
    window.hesperiaEmbedGolden.loads.some(
      ({ type, sourceAttribute }) =>
        type === "load" && sourceAttribute === "/embed-child?case=embed-security",
    ),
  );

  const load = await page.evaluate(() =>
    window.hesperiaEmbedGolden.loads.find(
      ({ type, sourceAttribute }) =>
        type === "load" && sourceAttribute === "/embed-child?case=embed-security",
    ),
  );

  expect(load).toStrictEqual({
    type: "load",
    targetTag: "iframe",
    targetName: "hesperia-embed-golden",
    sourceAttribute: "/embed-child?case=embed-security",
    targetIsCurrent: true,
    targetParentIsWrapper: true,
  });

  const frame = page.locator('iframe[name="hesperia-embed-golden"]');

  await expect(frame).toHaveAttribute("title", "Golden controlled child");

  await expect(frame).toHaveAttribute("loading", "eager");

  await expect(frame).toHaveAttribute("referrerpolicy", "no-referrer");

  await expect(frame).toHaveAttribute("sandbox", "allow-scripts");
});

test("embed-parent-disposal: disposing the parent removes its owned iframe", async ({ page }) => {
  await openEmbed(page);

  await waitForChildMessage(page, "embed-security");

  const frame = await page.locator('iframe[name="hesperia-embed-golden"]').elementHandle();

  expect(frame).not.toBeNull();

  await page.evaluate(() => window.hesperiaEmbedGolden.dispose());

  await expect(page.locator("iframe")).toHaveCount(0);

  await expect(page.locator("#app > *")).toHaveCount(0);

  expect(await frame!.evaluate((element) => element.isConnected)).toBe(false);
});
