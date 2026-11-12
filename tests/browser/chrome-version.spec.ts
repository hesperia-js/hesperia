import { expect, test } from "@playwright/test";

test("uses the selected Chrome version", async ({ browser, browserName }) => {
  const expectedVersion = process.env.HESPERIA_CHROME_EXPECTED_VERSION;

  test.skip(browserName !== "chromium" || expectedVersion === undefined);
  expect(browser.version()).toBe(expectedVersion);
});
