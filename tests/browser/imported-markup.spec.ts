import { expect, test, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import type { Request, Route } from "@playwright/test";
import {
  browserCssCoverageOwnerIds,
  browserCssCoverageScenariosByOwnerId,
} from "../../scripts/ci/browser-css-coverage-contract.ts";

async function captureImportedMarkupCoverage(page: Page): Promise<void> {
  const runId = process.env.HESPERIA_BROWSER_COVERAGE_RUN_ID;

  if (!runId) return;

  const populationFingerprint = process.env.HESPERIA_BROWSER_COVERAGE_POPULATION;

  if (!populationFingerprint) {
    throw new Error("Imported-markup coverage is missing its source population identity");
  }

  const ownerId = browserCssCoverageOwnerIds.importedMarkup;
  const response = await page.evaluate(
    async ({ runId, populationFingerprint, ownerId, scenario, pid }) => {
      const result = await fetch("/__coverage/browser-css-page", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          runId,
          populationFingerprint,
          ownerId,
          scenario,
          pid,
          coverage: Reflect.get(globalThis, "__hesperiaCoverage__"),
        }),
      });
      return { status: result.status, body: await result.text() };
    },
    {
      runId,
      populationFingerprint,
      ownerId,
      scenario: browserCssCoverageScenariosByOwnerId[ownerId],
      pid: process.pid,
    },
  );

  expect(response).toStrictEqual({ status: 204, body: "" });
}

function responsiveUrls(value: string): string[] {
  return [...value.matchAll(/(?:^|,)\s*(\S+)\s+(?:\d+(?:\.\d+)?x|\d+w)/gu)].map(
    (match) => match[1]!,
  );
}

test("compiled imported markup keeps native root behavior, ownership, and cleanup", async ({
  page,
}) => {
  const errors: string[] = [];
  const requests: string[] = [];
  const requestObjects = new Map<string, Request>();
  const responses = new Map<string, number>();

  page.on("pageerror", (error) => errors.push(error.message));

  await page.addInitScript(() => {
    const target = window as Window & {
      __managedStyleErrors?: { href: string; integrity: string; title: string }[];
    };
    target.__managedStyleErrors = [];

    window.addEventListener(
      "error",
      (event) => {
        const link = event.target;

        if (!(link instanceof HTMLLinkElement) || !link.hasAttribute("data-hesperia-style-id"))
          return;

        target.__managedStyleErrors!.push({
          href: link.href,
          integrity: link.integrity,
          title: link.title,
        });
      },
      true,
    );
  });

  page.on("request", (request) => {
    requests.push(request.url());

    if (!requestObjects.has(request.url())) requestObjects.set(request.url(), request);
  });

  page.on("response", (response) => {
    responses.set(response.url(), response.status());
  });

  const remoteStylesheetURL =
    "https://hesperia.invalid/css/imported-native-remote.css?revision=remote";

  await page.route(`${remoteStylesheetURL}*`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "text/css",
      headers: { "access-control-allow-origin": "*" },
      body: ".markup-panel { letter-spacing: 17px; }",
    });
  });

  await page.goto("/?importedMarkup");

  await expect(page.locator("#show-panels")).toBeVisible();

  const styleLinks = page.locator("head link[data-hesperia-style-id]");
  const disabledLink = page.locator('head link[title="Imported disabled sheet"]');

  await expect(page.locator("#first")).toHaveCount(0);

  await expect(page.locator("#second")).toHaveCount(0);

  await expect(styleLinks.first()).toBeAttached();

  const activeStyleCount = await styleLinks.count();

  expect(activeStyleCount).toBeGreaterThan(0);

  await expect
    .poll(async () =>
      styleLinks.evaluateAll((links) =>
        links.map((link) => {
          const stylesheet = link as HTMLLinkElement;
          return {
            media: stylesheet.sheet?.media.mediaText ?? stylesheet.media,
            ready: stylesheet.sheet !== null || stylesheet.disabled,
          };
        }),
      ),
    )
    .toEqual(Array.from({ length: activeStyleCount }, () => ({ media: "not all", ready: true })));

  await expect(disabledLink).toHaveCount(1);

  expect(await disabledLink.evaluate((link) => (link as HTMLLinkElement).disabled)).toBe(true);

  const disabledStyleURL = await disabledLink.evaluate((link) => (link as HTMLLinkElement).href);

  expect(requests).toContain(disabledStyleURL.replace(/#.*$/u, ""));

  const protectedLink = page.locator('head link[data-request-contract="retained"]');

  await expect(protectedLink).toHaveCount(1);

  await expect(protectedLink).toHaveAttribute("title", "Imported print style element");

  await expect(protectedLink).toHaveAttribute("integrity", /^sha384-/u);

  await expect(protectedLink).toHaveAttribute("crossorigin", "anonymous");

  await expect(protectedLink).toHaveAttribute("referrerpolicy", "no-referrer");

  await expect(protectedLink).toHaveAttribute("fetchpriority", "high");

  await expect(protectedLink).toHaveAttribute("nonce", "imported-protected");

  await expect(protectedLink).toHaveAttribute("type", "text/css");

  await expect(protectedLink).toHaveAttribute("hreflang", "en");

  await expect(protectedLink).toHaveAttribute("data-request-contract", "retained");

  const protectedURL = await protectedLink.evaluate((link) => (link as HTMLLinkElement).href);
  const protectedRequestURL = new URL(protectedURL);

  expect(protectedRequestURL.search).toBe("?variant=preserved");

  expect(protectedRequestURL.hash).toBe("#native-sheet");

  protectedRequestURL.hash = "";

  expect(requests).toContain(protectedRequestURL.href);

  const authoredNativeCss = await readFile(
    new URL("./fixtures/imported-markup/src/native.css", import.meta.url),
  );
  const protectedResponse = await page.evaluate(async (href) => {
    const response = await fetch(href, { cache: "no-store" });
    return {
      bytes: [...new Uint8Array(await response.arrayBuffer())],
      contentType: response.headers.get("content-type"),
    };
  }, protectedRequestURL.href);

  expect(protectedResponse.bytes).toStrictEqual([...authoredNativeCss]);

  expect(protectedResponse.contentType).toBe("text/css");

  const inheritedStylesheetURL = new URL("./native-nested.css?from=main", protectedRequestURL).href;
  const inheritedStylesheetPath = new URL(inheritedStylesheetURL).pathname;

  expect(inheritedStylesheetPath).toMatch(/^\/_hesperia\/assets\//u);

  const inheritedStylesheetAssetPath = inheritedStylesheetPath.slice("/_hesperia".length);
  const inheritedStylesheetHeaders = await page.evaluate(async (href) => {
    const response = await fetch(href, { cache: "no-store" });
    return {
      bytes: [...new Uint8Array(await response.arrayBuffer())],
      contentType: response.headers.get("content-type"),
    };
  }, inheritedStylesheetURL);
  const authoredNestedStylesheet = await readFile(
    new URL("./fixtures/imported-markup/src/native-nested.css", import.meta.url),
  );

  expect(inheritedStylesheetHeaders.bytes).toStrictEqual([...authoredNestedStylesheet]);

  const inheritedStylesheetRecordType = await page.evaluate(async (path) => {
    const record = await (await fetch("/hesperia-build.json")).json();
    return record.hosting.assets.find((asset: { path: string }) => asset.path === path)
      ?.contentType;
  }, inheritedStylesheetAssetPath);

  expect(inheritedStylesheetRecordType).toBe("text/css");

  expect(inheritedStylesheetHeaders.contentType).toBe(inheritedStylesheetRecordType);

  const protectedRequest = requestObjects.get(protectedRequestURL.href);

  if (!protectedRequest) throw new Error("The protected stylesheet request was not observed");

  const protectedHeaders = await protectedRequest.allHeaders();

  expect(protectedHeaders["referer"]).toBeUndefined();

  const remoteLink = page.locator('head link[data-request-contract="remote"]');

  await expect(remoteLink).toHaveAttribute("title", "Imported print style element");

  await expect(remoteLink).toHaveAttribute(
    "href",
    "https://hesperia.invalid/css/imported-native-remote.css?revision=remote#native",
  );

  await expect(remoteLink).toHaveAttribute("data-request-contract", "remote");

  const remoteRequest = requestObjects.get(remoteStylesheetURL);

  if (!remoteRequest) throw new Error("The remote protected stylesheet request was not observed");

  const remoteHeaders = await remoteRequest.allHeaders();

  expect(remoteHeaders.origin).toBe(new URL(page.url()).origin);

  expect(remoteHeaders["referer"]).toBeUndefined();

  if (remoteHeaders["sec-fetch-mode"] !== undefined)
    expect(remoteHeaders["sec-fetch-mode"]).toBe("cors");

  await page.locator("#show-panels").click();

  const first = page.locator("#first");
  const second = page.locator("#second");

  await expect(first).toHaveCount(1);

  await expect(second).toHaveCount(1);

  await expect(page.locator("#fragment-one")).toHaveText("one");

  await expect(page.locator("#fragment-two")).toHaveText("two");

  expect(
    await page.locator("#fragment-svg-use").evaluate((element) => {
      const attribute = element.getAttributeNode("xlink:href");
      const svg = element.closest("svg");
      return {
        name: attribute?.name,
        prefix: attribute?.prefix,
        localName: attribute?.localName,
        namespace: attribute?.namespaceURI,
        value: attribute?.value,
        declaration: svg?.getAttributeNode("xmlns:xlink")?.namespaceURI,
        declarationValue: svg?.getAttributeNS("http://www.w3.org/2000/xmlns/", "xlink"),
      };
    }),
  ).toEqual({
    name: "xlink:href",
    prefix: "xlink",
    localName: "href",
    namespace: "http://www.w3.org/1999/xlink",
    value: "#fragment-one",
    declaration: "http://www.w3.org/2000/xmlns/",
    declarationValue: "http://www.w3.org/1999/xlink",
  });

  await expect(page.locator("#projection-markers")).toHaveText(
    "hesperia:markup-style-runtime __HESPERIA_MARKUP_OWNER__ hesperia:markup-resource:0",
  );

  await expect(page.locator("#projection-markers")).toHaveAttribute(
    "data-literal",
    "hesperia:markup-style-runtime",
  );

  await expect(first).toHaveAttribute("title", "initial");

  await expect(second).toHaveAttribute("title", "second");

  expect(await first.evaluate((element) => element.tagName)).toBe("BUTTON");

  expect(await first.evaluate((element) => element !== document.querySelector("#second"))).toBe(
    true,
  );

  await expect(first).toHaveCSS("color", "rgb(90, 90, 90)");

  await expect(first).toHaveCSS("background-color", "rgb(1, 2, 3)");

  await expect(first).toHaveCSS("background-image", /data:image\/gif;base64/);

  const activeMedia = await styleLinks.evaluateAll((links) =>
    links.map((link) => {
      const stylesheet = link as HTMLLinkElement;
      return stylesheet.sheet?.media.mediaText ?? stylesheet.media;
    }),
  );

  expect(activeMedia).not.toContain("not all");

  expect(activeMedia).toContain("print");

  await expect(disabledLink).toHaveAttribute("rel", "stylesheet");

  expect(await disabledLink.evaluate((link) => (link as HTMLLinkElement).disabled)).toBe(true);

  const alternateLink = page.locator('head link[title="Imported alternate sheet"]');

  await expect(alternateLink).toHaveCount(1);

  await expect(alternateLink).toHaveAttribute("rel", "alternate stylesheet");

  const printStyleElement = page.locator(
    'head link[title="Imported print style element"]:not([data-request-contract])',
  );

  await expect(printStyleElement).toHaveCount(1);

  expect(
    await printStyleElement.evaluate((link) => (link as HTMLLinkElement).sheet?.media.mediaText),
  ).toBe("print");

  expect(await first.evaluate((element) => getComputedStyle(element).borderBottomWidth)).toBe(
    "2px",
  );

  await expect(first).toHaveCSS("border-top-width", "2px");

  const screenOutlineWidth = await first.evaluate(
    (element) => getComputedStyle(element).outlineWidth,
  );

  await page.emulateMedia({ media: "print" });

  await expect(first).toHaveCSS("border-top-width", "7px");

  await expect(first).toHaveCSS("border-left-width", "13px");

  await expect(first).toHaveCSS("border-right-width", "5px");

  await expect(first).toHaveCSS("letter-spacing", "17px");

  await expect(first).toHaveCSS("outline-width", "11px");

  expect(await first.evaluate((element) => getComputedStyle(element, "::before").content)).toBe(
    '"café"',
  );

  const encodingProbe = first.locator("#encoding-probe");
  const inheritedBackgroundImage = await encodingProbe.evaluate(
    (element) => getComputedStyle(element).backgroundImage,
  );
  const inheritedAssetMatch = /url\(["']?(.*?)["']?\)/u.exec(inheritedBackgroundImage);

  if (!inheritedAssetMatch) throw new Error("The inherited stylesheet did not set its image URL");

  const inheritedAssetURL = new URL(inheritedAssetMatch[1]!).href;

  expect(inheritedAssetURL).toContain("caf%C3%A9.png?charset=inherited");

  await expect.poll(() => requests).toContain(inheritedAssetURL);

  await expect.poll(() => responses.get(inheritedAssetURL)).toBe(200);

  const authoredInheritedAsset = await readFile(
    new URL("./fixtures/imported-markup/src/assets/caf\u00e9.png", import.meta.url),
  );
  const inheritedAssetResponse = await page.evaluate(async (href) => {
    const response = await fetch(href, { cache: "no-store" });
    return {
      status: response.status,
      bytes: [...new Uint8Array(await response.arrayBuffer())],
    };
  }, inheritedAssetURL);

  expect(inheritedAssetResponse.status).toBe(200);

  expect(inheritedAssetResponse.bytes).toStrictEqual([...authoredInheritedAsset]);

  const nativeBorderImage = await first.evaluate(
    (element) => getComputedStyle(element).borderImageSource,
  );
  const nativeAssetMatch = /url\("([^"]+)"\)/u.exec(nativeBorderImage);

  if (!nativeAssetMatch)
    throw new Error("The mirrored stylesheet did not emit its relative image URL");

  const nativeAssetRequestURL = new URL(nativeAssetMatch[1]!);
  nativeAssetRequestURL.hash = "";

  expect(nativeAssetRequestURL.search).toBe("?native=asset");

  expect(nativeAssetRequestURL.pathname).toMatch(/\/assets\/native%20pic%20%23%25\.png$/u);

  expect(requests).toContain(nativeAssetRequestURL.href);

  await expect.poll(() => responses.get(nativeAssetRequestURL.href)).toBe(200);

  await expect(first).toHaveAttribute("style", /--invalid-url: url\(foo bar\.png\);/u);

  expect(await first.evaluate((element) => getComputedStyle(element).outlineWidth)).not.toBe(
    screenOutlineWidth,
  );

  await page.emulateMedia({ media: "screen" });

  const queryImage = first.locator("#markup-query-image");

  await expect(queryImage).toHaveAttribute("src", /\?variant=small#frame$/u);

  await expect
    .poll(() => queryImage.evaluate((image) => (image as HTMLImageElement).naturalWidth))
    .toBe(1);

  const queryImageURL = await queryImage.getAttribute("src");

  if (!queryImageURL) throw new Error("The imported query image has no emitted URL");

  const srcsetImage = first.locator("#markup-srcset-image");

  await expect(srcsetImage).toHaveAttribute(
    "srcset",
    /\/assets\/.*density-1-.* 1x, .*density-2-.* 2x/u,
  );

  const srcset = await srcsetImage.getAttribute("srcset");
  const srcsetCandidates = srcset ? responsiveUrls(srcset) : [];

  if (srcsetCandidates.length < 2)
    throw new Error("The imported responsive image has no emitted candidates");

  const srcsetURL = await srcsetImage.evaluate((image) => (image as HTMLImageElement).currentSrc);

  if (!srcsetURL) throw new Error("The browser selected no imported responsive image URL");

  await expect.poll(() => responses.get(srcsetURL), { timeout: 15_000 }).toBe(200);

  const responsivePreload = page.locator("link[imagesrcset]");

  await expect(responsivePreload).toHaveAttribute("imagesizes", "100vw");

  const preloadSrcset = await responsivePreload.getAttribute("imagesrcset");
  const preloadCandidates = preloadSrcset ? responsiveUrls(preloadSrcset) : [];

  if (preloadCandidates.length < 2)
    throw new Error("The imported preload has no responsive candidates");

  const hrefPreload = page.locator('link[rel="preload"][href]');
  const hrefPreloadURL = await hrefPreload.getAttribute("href");

  if (!hrefPreloadURL) throw new Error("The imported preload has no emitted href URL");

  const computedBackground = await first.evaluate(
    (element) => getComputedStyle(element).backgroundImage,
  );
  const cssResourceURL = /,\s*url\("([^"]+)"\)$/u.exec(computedBackground)?.[1];

  if (!cssResourceURL) throw new Error("The imported CSS URL was not emitted into computed style");

  await page.locator("#inspect").click();

  await expect(page.locator("#bound-id")).toHaveText("first");

  await page.locator("#update").click();

  await expect(first).toHaveAttribute("title", "updated");

  await first.click();

  await expect(page.locator("#clicks")).toHaveText("1");

  await second.click();

  await expect(page.locator("#clicks")).toHaveText("2");

  await second.click();

  await expect(page.locator("#clicks")).toHaveText("2");

  await page.locator("#replace-listener").click();

  await first.click();

  await expect(page.locator("#clicks")).toHaveText("10");

  const directStyleURL = await styleLinks.first().getAttribute("href");

  if (!directStyleURL) throw new Error("The compiled markup style has no emitted URL");

  let releaseFrameStyle!: () => void;
  let frameStyleRequested = false;
  const frameStyleGate = new Promise<void>((resolve) => {
    releaseFrameStyle = resolve;
  });

  const holdDirectStyle: (route: Route) => Promise<void> = async (route) => {
    if (route.request().frame() !== page.mainFrame()) {
      frameStyleRequested = true;
      await frameStyleGate;
    }

    await route.continue();
  };

  await page.route(directStyleURL, holdDirectStyle);

  await page.locator("#mount-direct").click();

  const directFrame = page.frameLocator("#direct-frame");

  await expect(page.locator("#direct-frame")).toBeAttached();

  await expect.poll(() => frameStyleRequested).toBe(true);

  await expect(directFrame.locator("#direct")).toBeHidden();

  releaseFrameStyle();

  await expect(directFrame.locator("#direct")).toHaveCount(1);

  await expect(directFrame.locator("#direct")).toBeVisible();

  await expect(directFrame.locator("#direct")).toHaveCSS("color", "rgb(90, 90, 90)");

  await expect(directFrame.locator("head link[data-hesperia-style-id]").first()).toBeAttached();

  await page.unroute(directStyleURL, holdDirectStyle);

  const detached = await first.elementHandle();

  if (!detached) throw new Error("The imported component root was not mounted");

  await page.locator("#remove-first").click();

  await expect(first).toHaveCount(0);

  await expect(styleLinks).toHaveCount(activeStyleCount);

  await expect
    .poll(async () =>
      styleLinks.evaluateAll((links) =>
        links.map((link) => {
          const stylesheet = link as HTMLLinkElement;
          return stylesheet.sheet?.media.mediaText ?? stylesheet.media;
        }),
      ),
    )
    .toEqual(activeMedia);

  await detached.evaluate((element) =>
    element.dispatchEvent(new MouseEvent("click", { bubbles: true })),
  );

  await expect(page.locator("#clicks")).toHaveText("10");

  await page.locator("#remove-all").click();

  await expect(second).toHaveCount(0);

  await expect(styleLinks).toHaveCount(activeStyleCount);

  await expect
    .poll(async () =>
      styleLinks.evaluateAll((links) =>
        links.map((link) => {
          const stylesheet = link as HTMLLinkElement;
          return stylesheet.sheet?.media.mediaText ?? stylesheet.media;
        }),
      ),
    )
    .toEqual(Array.from({ length: activeStyleCount }, () => "not all"));

  expect(await disabledLink.evaluate((link) => (link as HTMLLinkElement).disabled)).toBe(true);

  expect(requests).toContain(cssResourceURL);

  expect(requests).toContain(queryImageURL.replace(/#.*$/u, ""));

  expect(requests).toContain(hrefPreloadURL);

  expect(requests).toContain(srcsetURL);

  const requestedPreloadCandidates = preloadCandidates
    .map((candidate) => new URL(candidate, page.url()).href)
    .filter((candidate) => requests.includes(candidate));

  expect(requestedPreloadCandidates.length).toBeGreaterThan(0);

  expect(requestedPreloadCandidates.some((candidate) => responses.get(candidate) === 200)).toBe(
    true,
  );

  expect(requests.some((url) => new URL(url).pathname === "/css/imported-markup.css")).toBe(true);

  await page.locator("#load-managed-bad-sri").click();

  await expect(page.locator("#managed-bad-sri-state")).toContainText("rejected:", {
    timeout: 10_000,
  });

  const managedSriFailure = await page.evaluate(
    () =>
      (
        window as Window & {
          __managedStyleErrors?: { href: string; integrity: string; title: string }[];
        }
      ).__managedStyleErrors,
  );
  const failedManagedLink = managedSriFailure?.find(({ title }) =>
    title.includes("Imported managed bad-SRI sheet"),
  );

  expect(failedManagedLink).toEqual({
    href: expect.stringContaining("/css/imported-native-sri-failure.css?managed=1"),
    integrity: "sha384-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    title: "Imported managed bad-SRI sheet",
  });

  if (!failedManagedLink)
    throw new Error("The generated managed bad-SRI link did not fail visibly");

  expect(requests).toContain(failedManagedLink.href);

  await expect.poll(() => responses.get(failedManagedLink.href)).toBe(200);

  await expect(page.locator("#managed-bad-sri-content")).toHaveCount(0);

  await expect(page.locator('link[title="Imported managed bad-SRI sheet"]')).toHaveCount(0);

  await expect(page.locator("#managed-bad-sri-target")).not.toHaveCSS("color", "rgb(255, 1, 2)");

  expect(errors).toStrictEqual([]);

  await captureImportedMarkupCoverage(page);
});
