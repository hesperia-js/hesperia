import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { checkProjectModules } from "../../packages/compiler/src/checking.ts";

const projectRoot = resolve(import.meta.dir, "../..");
const consumerFixture = resolve(
  projectRoot,
  "tests/package/fixtures/applications/channels/consumer-types.ts",
);

test("channel declarations retain their public raw-tree and handle types", async () => {
  const source = await readFile(consumerFixture, "utf8");
  const result = await checkProjectModules(
    [
      {
        filename: "tests/package/fixtures/applications/channels/consumer-types.ts",
        source,
      },
    ],
    {
      root: projectRoot,
      resolutionOverrides: {
        browser: {
          hesperia: "./packages/hesperia/src/index.ts",
          "hesperia/aeolia": "./packages/hesperia/src/aeolia/index.ts",
        },
      },
    },
  );

  expect(result.diagnostics).toStrictEqual([]);
});
