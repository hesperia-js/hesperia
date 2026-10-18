import { expect, test } from "bun:test";
import { coverageVariable, type CoverageFile } from "../coverage-collector.ts";

const bootstrapSources = [
  "scripts/ci/coverage-preload.ts",
  "scripts/ci/coverage-collector.ts",
  "scripts/ci/coverage-inventory.ts",
] as const;

const coverage = Reflect.get(globalThis, coverageVariable) as
  | Record<string, CoverageFile>
  | undefined;

if (coverage) {
  for (const path of Object.keys(coverage)) {
    const source = path.replaceAll("\\", "/");

    if (bootstrapSources.some((candidate) => source.endsWith(`/${candidate}`))) {
      Reflect.deleteProperty(coverage, path);
    }
  }
}

test("the fixture removes bootstrap records before normal owner finalization", () => {
  expect(coverage).toBeDefined();

  for (const source of bootstrapSources) {
    const captured = Object.keys(coverage!).some((path) =>
      path.replaceAll("\\", "/").endsWith(`/${source}`),
    );

    expect(captured, source).toBe(false);
  }
});
