import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readConfiguration } from "../../src/tooling/configuration.ts";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

test("unsafe HTML requires an explicit boolean project permission", async () => {
  const root = await mkdtemp(join(tmpdir(), "hesperia-config-"));
  roots.push(root);
  expect(await readConfiguration(root)).toStrictEqual({
    allowUnsafeHTML: false,
    resolutionOverrides: { browser: {} },
  });
  await writeFile(join(root, "hesperia.config.json"), '{"allowUnsafeHTML":true}');
  expect(await readConfiguration(root)).toStrictEqual({
    allowUnsafeHTML: true,
    resolutionOverrides: { browser: {} },
  });
  await writeFile(join(root, "hesperia.config.json"), "{}");
  expect(await readConfiguration(root)).toStrictEqual({
    allowUnsafeHTML: false,
    resolutionOverrides: { browser: {} },
  });
  await writeFile(join(root, "hesperia.config.json"), '{"allowUnsafeHTML":"true"}');
  await expect(readConfiguration(root)).rejects.toThrow("must be a boolean");
  await writeFile(join(root, "hesperia.config.json"), '{"allowUnsafeHtml":true}');
  await expect(readConfiguration(root)).rejects.toThrow("Unknown Hesperia configuration option");
  await writeFile(join(root, "hesperia.config.json"), "[]");
  await expect(readConfiguration(root)).rejects.toThrow("must contain an object");
  await writeFile(join(root, "hesperia.config.json"), "");
  await expect(readConfiguration(root)).rejects.toThrow();
});

test("reads exact browser resolution overrides, including relative module names", async () => {
  const root = await mkdtemp(join(tmpdir(), "hesperia-config-"));
  roots.push(root);
  await writeFile(
    join(root, "hesperia.config.json"),
    JSON.stringify({
      resolutionOverrides: {
        browser: {
          "some-package": "./src/browser-replacement.ts",
          "./local-package.ts": "../src/browser-replacement.ts",
          "other-package/subpath": "fallback-package",
        },
      },
    }),
  );
  expect(await readConfiguration(root)).toStrictEqual({
    allowUnsafeHTML: false,
    resolutionOverrides: {
      browser: {
        "some-package": "./src/browser-replacement.ts",
        "./local-package.ts": "../src/browser-replacement.ts",
        "other-package/subpath": "fallback-package",
      },
    },
  });
  await writeFile(
    join(root, "hesperia.config.json"),
    JSON.stringify({ resolutionOverrides: { browser: { "some-*": "replacement" } } }),
  );
  await expect(readConfiguration(root)).rejects.toThrow(
    "Invalid browser resolution override import name",
  );
});
