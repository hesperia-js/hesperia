import { expect, test } from "@playwright/test";

for (const mode of ["development", "production"] as const) {
  test(`${mode} optional CSS integrations produce observable browser styles`, async ({ page }) => {
    const pageErrors: string[] = [];
    const cssAssets: { readonly pathname: string; readonly status: number }[] = [];

    page.on("pageerror", (error) => pageErrors.push(error.message));

    page.on("response", (response) => {
      const url = new URL(response.url());

      if (url.pathname.includes("/_hesperia/assets/") && url.pathname.endsWith(".css")) {
        cssAssets.push({ pathname: url.pathname, status: response.status() });
      }
    });

    await page.goto(`/optional-styling/${mode}`);

    const postcss = page.locator("#postcss-proof");

    await expect(postcss).toHaveCSS("color", "rgb(12, 34, 56)");

    const tailwind = page.locator("#tailwind-proof");

    await expect(tailwind).toHaveCSS("padding-left", "28px");

    expect(await tailwind.evaluate((node) => getComputedStyle(node).backgroundColor)).not.toBe(
      "rgba(0, 0, 0, 0)",
    );

    const stylex = page.locator("#stylex-proof");

    await expect(stylex).toHaveCSS("color", "rgb(102, 51, 153)");

    await stylex.click();

    await expect(stylex).toHaveCSS("color", "rgb(70, 130, 180)");

    expect(cssAssets.length).toBeGreaterThan(0);

    expect(cssAssets.every(({ status }) => status === 200)).toBe(true);

    expect(pageErrors).toStrictEqual([]);
  });
}
