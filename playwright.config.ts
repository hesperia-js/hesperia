import { defineConfig, devices } from "@playwright/test";

const browserPort = process.env.HESPERIA_BROWSER_PORT ?? "4178";
const browserURL = `http://127.0.0.1:${browserPort}`;

export default defineConfig({
  testDir: "./tests/browser",
  testMatch: "**/*.spec.ts",
  fullyParallel: true,
  workers: process.env.CI && process.platform === "win32" ? 1 : 3,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  reporter: "list",
  use: {
    baseURL: browserURL,
    trace: "retain-on-failure",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "firefox", use: { ...devices["Desktop Firefox"] } },
    { name: "webkit", use: { ...devices["Desktop Safari"] } },
  ],
  webServer: {
    command: "bun tests/browser/fixture-server.ts",
    url: `${browserURL}/health`,
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
