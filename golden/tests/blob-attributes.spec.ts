import { expect, test } from "@playwright/test";

type URLSnapshot = { created: string[]; revoked: string[] };

declare global {
  interface Window {
    blobAttributesFixture: {
      replaceSources(): void;

      useGenericString(): void;

      dispose(): Promise<URLSnapshot>;

      snapshot(): URLSnapshot;
    };
    foreignFileFixture: {
      mount(): Promise<URLSnapshot & { parentCreated: number }>;

      replace(): void;

      snapshot(): URLSnapshot & { parentCreated: number };

      dispose(): URLSnapshot & { parentCreated: number };
    };
  }
}

test("public package mount loads Blob sources and releases replaced and destroyed URLs", async ({
  page,
}) => {
  const windowsFirefoxCi =
    process.env.CI === "true" &&
    process.platform === "win32" &&
    test.info().project.name === "firefox";

  if (windowsFirefoxCi) test.setTimeout(60_000);

  const errors: string[] = [];

  page.on("pageerror", (error) => errors.push(error.message));

  await page.goto("/blob-attributes");

  await expect(page.locator("html")).toHaveAttribute("data-ready", "true");

  const image = await page.locator("#blob-image").elementHandle();

  if (!image) throw new Error("Blob image was not rendered");

  await expect
    .poll(() =>
      page.locator("#blob-image").evaluate((node) => (node as HTMLImageElement).naturalWidth),
    )
    .toBeGreaterThan(0);

  await expect
    .poll(() =>
      page.locator("#responsive-image").evaluate((node) => (node as HTMLImageElement).naturalWidth),
    )
    .toBeGreaterThan(0);

  const initial = await page.evaluate(() => ({
    urls: window.blobAttributesFixture.snapshot(),
    generic: document.querySelector("#generic-src")?.getAttribute("src"),
    image: document.querySelector("#blob-image")?.getAttribute("src"),
    responsive: document.querySelector("#responsive-image")?.getAttribute("srcset"),
    poster: (document.querySelector("#blob-video") as HTMLVideoElement).poster,
    audio: (document.querySelector("#blob-audio") as HTMLAudioElement).getAttribute("src"),
  }));

  expect(initial.urls.created).toHaveLength(5);

  expect(new Set(initial.urls.created).size).toBe(5);

  expect(initial.generic).toMatch(/^blob:/u);

  expect(initial.image).toMatch(/^blob:/u);

  expect(initial.generic).not.toBe(initial.image);

  expect(initial.responsive).toContain(`${initial.urls.created[2]} 1x`);

  expect(initial.responsive).toContain(", data:image/svg+xml,");

  expect(initial.poster).toMatch(/^blob:/u);

  expect(initial.audio).toMatch(/^blob:/u);

  const posterDecoded = await page.locator("#blob-video").evaluate(async (node) => {
    const image = new Image();
    image.src = (node as HTMLVideoElement).poster;

    await image.decode();

    return image.naturalWidth;
  });

  expect(posterDecoded).toBeGreaterThan(0);

  await page.evaluate(() => window.blobAttributesFixture.useGenericString());

  const genericReplacement = await page.evaluate(() => ({
    src: document.querySelector("#generic-src")?.getAttribute("src"),
    urls: window.blobAttributesFixture.snapshot(),
  }));

  expect(genericReplacement.src).toBe("https://author.example.test/generic.svg");

  expect(genericReplacement.urls.created).toHaveLength(initial.urls.created.length);

  expect(genericReplacement.urls.revoked).toContain(initial.generic);

  expect(genericReplacement.urls.revoked).not.toContain(initial.image);

  await page.evaluate(() => window.blobAttributesFixture.replaceSources());

  await expect.poll(() => page.locator("#blob-image").getAttribute("src")).not.toBe(initial.image);

  expect(await image.evaluate((node) => node === document.querySelector("#blob-image"))).toBe(true);

  await expect
    .poll(
      () => page.locator("#blob-image").evaluate((node) => (node as HTMLImageElement).naturalWidth),
      { timeout: windowsFirefoxCi ? 20_000 : undefined },
    )
    .toBeGreaterThan(0);

  const replaced = await page.evaluate(() => ({
    responsive: document.querySelector("#responsive-image")?.getAttribute("srcset"),
    poster: (document.querySelector("#blob-video") as HTMLVideoElement).poster,
    audio: (document.querySelector("#blob-audio") as HTMLAudioElement).getAttribute("src"),
    urls: window.blobAttributesFixture.snapshot(),
  }));

  expect(replaced.responsive).toContain(", data:image/svg+xml,");

  expect(replaced.poster).toMatch(/^blob:/u);

  expect(replaced.audio).toMatch(/^blob:/u);

  expect(replaced.urls.created).toHaveLength(10);

  expect(replaced.urls.revoked).toContain(initial.image);

  expect(replaced.urls.revoked).toContain(initial.urls.created[2]);

  expect(replaced.urls.revoked).toContain(initial.poster);

  expect(replaced.urls.revoked).not.toContain("https://author.example.test/generic.svg");

  const disposed = await page.evaluate(() => window.blobAttributesFixture.dispose());

  expect(new Set(disposed.revoked).size).toBe(disposed.created.length);

  expect(disposed.revoked).toHaveLength(disposed.created.length);

  expect(errors).toStrictEqual([]);
});

test("a parent-document File uses the target document URL lease across replacement and release", async ({
  page,
}) => {
  const errors: string[] = [];

  page.on("pageerror", (error) => errors.push(error.message));

  await page.goto("/blob-attributes");

  await expect(page.locator("html")).toHaveAttribute("data-ready", "true");

  const initial = await page.evaluate(() => window.foreignFileFixture.mount());

  expect(initial.created).toHaveLength(1);

  expect(initial.revoked).toStrictEqual([]);

  expect(initial.parentCreated).toBe(5);

  const image = page.frameLocator("#foreign-file-frame").locator("#foreign-file-image");
  const nativeImage = await image.elementHandle();

  if (!nativeImage) throw new Error("The target-document File image was not rendered");

  await expect
    .poll(() => image.evaluate((node) => (node as HTMLImageElement).naturalWidth))
    .toBeGreaterThan(0);

  expect(await image.getAttribute("src")).toBe(initial.created[0]);

  await page.evaluate(() => window.foreignFileFixture.replace());

  await expect.poll(() => image.getAttribute("src")).not.toBe(initial.created[0]);

  await expect
    .poll(() => image.evaluate((node) => (node as HTMLImageElement).naturalWidth))
    .toBeGreaterThan(0);

  expect(
    await nativeImage.evaluate((node) => node === document.querySelector("#foreign-file-image")),
  ).toBe(true);

  const replaced = await page.evaluate(() => window.foreignFileFixture.snapshot());

  expect(replaced.created).toHaveLength(2);

  expect(replaced.revoked).toStrictEqual([initial.created[0]]);

  expect(replaced.parentCreated).toBe(initial.parentCreated);

  expect(await image.getAttribute("src")).toBe(replaced.created[1]);

  const disposed = await page.evaluate(() => window.foreignFileFixture.dispose());

  expect(disposed.revoked).toStrictEqual(disposed.created);

  expect(disposed.parentCreated).toBe(initial.parentCreated);

  expect(errors).toStrictEqual([]);
});

test("native srcset loads one of its emitted Blob and author candidates", async ({ browser }) => {
  for (const deviceScaleFactor of [1, 2]) {
    const context = await browser.newContext({ deviceScaleFactor });

    try {
      const page = await context.newPage();

      await page.goto("/blob-attributes");

      await expect(page.locator("html")).toHaveAttribute("data-ready", "true");

      await expect
        .poll(() =>
          page
            .locator("#responsive-image")
            .evaluate((node) => (node as HTMLImageElement).naturalWidth),
        )
        .toBeGreaterThan(0);

      const selection = await page.locator("#responsive-image").evaluate((node) => {
        const image = node as HTMLImageElement;
        return {
          srcset: image.getAttribute("srcset"),
          currentSrc: image.currentSrc,
          naturalWidth: image.naturalWidth,
          urls: window.blobAttributesFixture.snapshot(),
        };
      });
      const blobURL = selection.urls.created[2];
      const prefix = `${blobURL} 1x, `;

      expect(selection.srcset?.startsWith(prefix)).toBe(true);

      expect(selection.srcset?.endsWith(" 2x")).toBe(true);

      const authorURL = selection.srcset!.slice(prefix.length, -" 2x".length);

      expect(authorURL).toMatch(/^data:image\/svg\+xml,/u);

      expect(selection.srcset).toBe(`${blobURL} 1x, ${authorURL} 2x`);

      expect([blobURL, authorURL]).toContain(selection.currentSrc);

      expect(selection.naturalWidth).toBeGreaterThan(0);

      expect(selection.urls.revoked).not.toContain(blobURL);

      const disposed = await page.evaluate(() => window.blobAttributesFixture.dispose());

      expect(disposed.revoked).toContain(blobURL);

      expect(new Set(disposed.revoked).size).toBe(disposed.created.length);
    } finally {
      await context.close();
    }
  }
});
