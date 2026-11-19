import { statSync } from "node:fs";
import { isAbsolute } from "node:path";

/**
 * @param {string} browserName
 * @returns {{ executablePath?: string }}
 */
export function browserLaunchOptions(browserName) {
  if (browserName !== "chromium") return {};

  const executablePath = process.env.HESPERIA_CHROME_EXECUTABLE_PATH;

  if (executablePath === undefined) {
    if (process.env.HESPERIA_REQUIRE_CHROME_EXECUTABLE_PATH === "1")
      throw new Error("HESPERIA_CHROME_EXECUTABLE_PATH is required for Chromium");

    return {};
  }

  if (executablePath.trim().length === 0)
    throw new Error("HESPERIA_CHROME_EXECUTABLE_PATH must be a non-empty absolute path");

  if (!isAbsolute(executablePath))
    throw new Error("HESPERIA_CHROME_EXECUTABLE_PATH must be an absolute path");

  let fileStats;

  try {
    fileStats = statSync(executablePath);
  } catch (error) {
    throw new Error("HESPERIA_CHROME_EXECUTABLE_PATH must name an existing regular file", {
      cause: error,
    });
  }

  if (!fileStats.isFile())
    throw new Error("HESPERIA_CHROME_EXECUTABLE_PATH must name an existing regular file");

  return { executablePath };
}
