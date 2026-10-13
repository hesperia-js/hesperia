import { expect, test } from "@playwright/test";

type URLSnapshot = { created: string[]; revoked: string[] };

declare global {
  interface Window {
    blobAttributesBrowserFixture: {
      goAway(): Promise<string>;

      replaceSources(): void;

      restorePrevious(): Promise<string>;

      dispose(): Promise<URLSnapshot>;

      snapshot(): URLSnapshot;

      detachedDocumentProbe(): {
        missingView: boolean;
        faults: { name: string; kind: string | undefined }[];
        imageRendered: boolean;
        impostorSource: string | null;
        impostorGetterCalls: number;
        createdURLs: number;
      };
    };
  }
}

test("Blob URLs survive route caching and release after replacement and final destruction", async ({
  page,
}) => {
  const errors: string[] = [];

  page.on("pageerror", (error) => errors.push(error.message));

  await page.goto("/blob-attributes-cache");

  await expect(page.locator("html")).toHaveAttribute("data-ready", "true");

  const image = await page.locator("#blob-image").elementHandle();

  if (!image) throw new Error("Blob image was not rendered");

  await expect
    .poll(() =>
      page.locator("#blob-image").evaluate((node) => (node as HTMLImageElement).naturalWidth),
    )
    .toBeGreaterThan(0);

  const initial = await page.evaluate(() => ({
    urls: window.blobAttributesBrowserFixture.snapshot(),
    generic: document.querySelector("#generic-src")?.getAttribute("src"),
    image: document.querySelector("#blob-image")?.getAttribute("src"),
    responsive: document.querySelector("#responsive-image")?.getAttribute("srcset"),
    poster: (document.querySelector("#blob-video") as HTMLVideoElement).poster,
  }));

  expect(initial.urls.created).toHaveLength(5);

  expect(initial.generic).toMatch(/^blob:/u);

  expect(initial.image).toMatch(/^blob:/u);

  expect(initial.responsive).toContain(`${initial.urls.created[2]} 1x`);

  expect(initial.poster).toMatch(/^blob:/u);

  expect(await page.evaluate(() => window.blobAttributesBrowserFixture.goAway())).toBe("committed");

  await expect(page.locator("#away-page")).toHaveText("Away");

  const suspended = await page.evaluate(() => window.blobAttributesBrowserFixture.snapshot());

  expect(suspended.created).toHaveLength(initial.urls.created.length);

  for (const url of initial.urls.created) expect(suspended.revoked).not.toContain(url);

  const suspendedRevoked = suspended.revoked.slice();

  await page.evaluate(() => window.blobAttributesBrowserFixture.replaceSources());

  const cachedUpdate = await page.evaluate(() => window.blobAttributesBrowserFixture.snapshot());

  expect(cachedUpdate.created).toHaveLength(suspended.created.length);

  expect(cachedUpdate.revoked).toStrictEqual(suspendedRevoked);

  expect(await image.getAttribute("src")).toBe(initial.image);

  expect(await page.evaluate(() => window.blobAttributesBrowserFixture.restorePrevious())).toBe(
    "committed",
  );

  await expect(page.locator("#blob-image")).toBeVisible();

  await expect.poll(() => page.locator("#blob-image").getAttribute("src")).not.toBe(initial.image);

  expect(await image.evaluate((node) => node === document.querySelector("#blob-image"))).toBe(true);

  const restored = await page.evaluate(() => ({
    image: document.querySelector("#blob-image")?.getAttribute("src"),
    responsive: document.querySelector("#responsive-image")?.getAttribute("srcset"),
    poster: (document.querySelector("#blob-video") as HTMLVideoElement).poster,
    urls: window.blobAttributesBrowserFixture.snapshot(),
  }));

  expect(restored.image).toMatch(/^blob:/u);

  expect(restored.responsive).toContain(", data:image/svg+xml,");

  expect(restored.poster).toMatch(/^blob:/u);

  expect(restored.urls.created).toHaveLength(10);

  for (const url of initial.urls.created) expect(restored.urls.revoked).toContain(url);

  await expect
    .poll(() =>
      page.locator("#blob-image").evaluate((node) => (node as HTMLImageElement).naturalWidth),
    )
    .toBeGreaterThan(0);

  const disposed = await page.evaluate(() => window.blobAttributesBrowserFixture.dispose());

  expect(new Set(disposed.revoked).size).toBe(disposed.created.length);

  expect(disposed.revoked).toHaveLength(disposed.created.length);

  expect(errors).toStrictEqual([]);
});

test("Blob recognition faults through a public mount into a detached Document", async ({
  page,
}) => {
  await page.goto("/blob-attributes-cache");

  await expect(page.locator("html")).toHaveAttribute("data-ready", "true");

  const result = await page.evaluate(() =>
    window.blobAttributesBrowserFixture.detachedDocumentProbe(),
  );

  expect(result).toStrictEqual({
    missingView: true,
    faults: [{ name: "RenderFault", kind: "blob-url" }],
    imageRendered: false,
    impostorSource: "[object Object]",
    impostorGetterCalls: 0,
    createdURLs: 0,
  });
});
