import { expect, test } from "bun:test";

test("the owner has a run directory before it exits", () => {
  expect(process.env.HESPERIA_COVERAGE_OUTPUT_DIR).toBeDefined();

  process.exit(0);
});
