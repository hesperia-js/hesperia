import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { readConfiguration } from "../../packages/tooling/src/configuration.ts";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

test("unsafe HTML and embedded documents require explicit boolean project permissions", async () => {
  const root = await mkdtemp(join(tmpdir(), "hesperia-config-"));

  roots.push(root);

  expect(await readConfiguration(root)).toStrictEqual({
    allowUnsafeHTML: false,
    allowUnsafeEmbed: false,
    mountURL: "/",
    resolutionOverrides: { browser: {} },
  });

  await writeFile(
    join(root, "hesperia.config.json"),
    '{"allowUnsafeHTML":true,"allowUnsafeEmbed":true}',
  );

  expect(await readConfiguration(root)).toStrictEqual({
    allowUnsafeHTML: true,
    allowUnsafeEmbed: true,
    mountURL: "/",
    resolutionOverrides: { browser: {} },
  });

  await writeFile(join(root, "hesperia.config.json"), "{}");

  expect(await readConfiguration(root)).toStrictEqual({
    allowUnsafeHTML: false,
    allowUnsafeEmbed: false,
    mountURL: "/",
    resolutionOverrides: { browser: {} },
  });

  await writeFile(join(root, "hesperia.config.json"), '{"allowUnsafeHTML":"true"}');

  await expect(readConfiguration(root)).rejects.toThrow("must be a boolean");

  await writeFile(join(root, "hesperia.config.json"), '{"allowUnsafeEmbed":"true"}');

  await expect(readConfiguration(root)).rejects.toThrow("allowUnsafeEmbed must be a boolean");

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
    allowUnsafeEmbed: false,
    mountURL: "/",
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

test("mountURL defaults and canonicalizes from JSON and TypeScript configuration", async () => {
  const root = await mkdtemp(join(tmpdir(), "hesperia-config-"));

  roots.push(root);

  await writeFile(join(root, "hesperia.config.json"), JSON.stringify({ mountURL: "/dashboard/" }));

  expect(await readConfiguration(root)).toStrictEqual({
    allowUnsafeHTML: false,
    allowUnsafeEmbed: false,
    mountURL: "/dashboard",
    resolutionOverrides: { browser: {} },
  });

  await rm(join(root, "hesperia.config.json"));

  await writeFile(join(root, "hesperia.config.ts"), "export default {};");

  const defaultConfig = await readTypeScriptConfiguration(root);

  expect(defaultConfig.exitCode).toBe(0);

  expect(JSON.parse(defaultConfig.stdout)).toStrictEqual({
    allowUnsafeHTML: false,
    allowUnsafeEmbed: false,
    mountURL: "/",
    resolutionOverrides: { browser: {} },
  });

  await writeFile(join(root, "hesperia.config.ts"), 'export default { mountURL: "/東京/café/" };');

  const unicodeConfig = await readTypeScriptConfiguration(root);

  expect(unicodeConfig.exitCode).toBe(0);

  expect(JSON.parse(unicodeConfig.stdout)).toStrictEqual({
    allowUnsafeHTML: false,
    allowUnsafeEmbed: false,
    mountURL: "/%E6%9D%B1%E4%BA%AC/caf%C3%A9",
    resolutionOverrides: { browser: {} },
  });
});

test("same-process TypeScript configuration reads reject changed file contents", async () => {
  const root = await mkdtemp(join(tmpdir(), "hesperia-config-reload-"));

  roots.push(root);

  await writeFile(
    join(root, "hesperia.config.ts"),
    'export default { allowUnsafeHTML: true, allowUnsafeEmbed: true, mountURL: "/first" };',
  );

  const moduleUrl = pathToFileURL(
    join(import.meta.dir, "../../packages/tooling/src/configuration.ts"),
  ).href;
  const changedSource =
    'export default { allowUnsafeHTML: false, allowUnsafeEmbed: false, mountURL: "/second" };';
  const script = `
import { writeFile } from "node:fs/promises";
import { readConfiguration } from ${JSON.stringify(moduleUrl)};

const initial = await readConfiguration(process.cwd());
const unchanged = await readConfiguration(process.cwd());
await writeFile("hesperia.config.ts", ${JSON.stringify(changedSource)});
let afterChange;
try {
  afterChange = { kind: "value", configuration: await readConfiguration(process.cwd()) };
} catch (error) {
  afterChange = { kind: "error", message: error instanceof Error ? error.message : String(error) };
}
console.log(JSON.stringify({ initial, unchanged, afterChange }));
`;
  const result = Bun.spawnSync({
    cmd: [process.execPath, "-e", script],
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = new TextDecoder().decode(result.stdout).trim();
  const stderr = new TextDecoder().decode(result.stderr);

  expect(result.exitCode, stderr).toBe(0);

  expect(JSON.parse(stdout)).toStrictEqual({
    initial: {
      allowUnsafeHTML: true,
      allowUnsafeEmbed: true,
      mountURL: "/first",
      resolutionOverrides: { browser: {} },
    },
    unchanged: {
      allowUnsafeHTML: true,
      allowUnsafeEmbed: true,
      mountURL: "/first",
      resolutionOverrides: { browser: {} },
    },
    afterChange: {
      kind: "error",
      message: "hesperia.config.ts changed; restart the project Bun command to load it",
    },
  });
});

test("mountURL validation uses the same canonical path rules for JSON and TypeScript", async () => {
  const root = await mkdtemp(join(tmpdir(), "hesperia-config-"));

  roots.push(root);

  for (const mountURL of [42, "/dashboard//child", "/team%2fdocs"]) {
    await writeFile(join(root, "hesperia.config.json"), JSON.stringify({ mountURL }));

    await expect(readConfiguration(root)).rejects.toThrow(TypeError);
  }

  await rm(join(root, "hesperia.config.json"));

  await writeFile(join(root, "hesperia.config.ts"), 'export default { mountURL: "/team%41docs" };');

  const invalidConfig = await readTypeScriptConfiguration(root);

  expect(invalidConfig.exitCode).not.toBe(0);

  expect(invalidConfig.stderr).toContain("mountURL with percent escapes must already be canonical");
});

async function readTypeScriptConfiguration(root: string): Promise<{
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
}> {
  const moduleUrl = pathToFileURL(
    join(import.meta.dir, "../../packages/tooling/src/configuration.ts"),
  ).href;
  const script = `import { readConfiguration } from ${JSON.stringify(moduleUrl)}; console.log(JSON.stringify(await readConfiguration(process.cwd())));`;
  const result = Bun.spawnSync({
    cmd: [process.execPath, "-e", script],
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: result.exitCode,
    stdout: new TextDecoder().decode(result.stdout).trim(),
    stderr: new TextDecoder().decode(result.stderr),
  };
}

test("TypeScript and JSON configuration are exclusive, and JSON cannot execute plugins", async () => {
  const root = await mkdtemp(join(tmpdir(), "hesperia-config-"));

  roots.push(root);

  await writeFile(join(root, "hesperia.config.json"), '{"plugins":[]}');

  await expect(readConfiguration(root)).rejects.toThrow("plugins require hesperia.config.ts");

  await writeFile(join(root, "hesperia.config.ts"), "export default {};");

  await expect(readConfiguration(root)).rejects.toThrow(
    "either hesperia.config.ts or hesperia.config.json",
  );
});

test("configured plugins cannot claim the built-in CSS import type", async () => {
  const root = await mkdtemp(join(tmpdir(), "hesperia-config-"));

  roots.push(root);

  await writeFile(
    join(root, "hesperia.config.ts"),
    'export default { plugins: [{ name: "claim-css", importTypes: { css: () => { throw new Error("claimed"); } } }] };',
  );

  const moduleUrl = pathToFileURL(
    join(import.meta.dir, "../../packages/tooling/src/configuration.ts"),
  );
  const check = Bun.spawnSync({
    cmd: [
      process.execPath,
      "-e",
      `import { readConfiguration } from ${JSON.stringify(moduleUrl.href)}; await readConfiguration(process.cwd());`,
    ],
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });

  expect(check.exitCode).not.toBe(0);

  expect(new TextDecoder().decode(check.stderr)).toContain(
    "Duplicate or built-in import type: css",
  );
});
