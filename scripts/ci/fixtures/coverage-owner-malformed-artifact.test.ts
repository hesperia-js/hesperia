import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

test("the owner writes an unreadable coverage artifact", () => {
  const outputDirectory = process.env.HESPERIA_COVERAGE_OUTPUT_DIR;
  const runId = process.env.HESPERIA_COVERAGE_RUN_ID;

  expect(outputDirectory).toBeDefined();

  expect(runId).toBeDefined();

  writeFileSync(join(outputDirectory!, `${runId}-malformed.json`), "{");
});
