import { defineConfig, devices } from "@playwright/test";

const port = Number(process.env.HESPERIA_GOLDEN_PORT ?? "4189");

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("HESPERIA_GOLDEN_PORT must be an integer between 1 and 65535");
}

const baseURL = "http://127.0.0.1:" + port;

export default defineConfig({
  testDir: "./tests",
  testMatch: "**/*.spec.ts",
  fullyParallel: true,
  workers: process.env.CI && process.platform === "win32" ? 1 : 3,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  reporter: "list",
  use: {
    baseURL,
    trace: "retain-on-failure",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "firefox", use: { ...devices["Desktop Firefox"] } },
    { name: "webkit", use: { ...devices["Desktop Safari"] } },
  ],
  webServer: {
    command: "bun run serve",
    url: baseURL + "/health",
    reuseExistingServer: false,
    timeout: process.platform === "win32" ? 120_000 : 30_000,
  },
});
