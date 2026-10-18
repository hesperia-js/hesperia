import { expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EditorProject } from "../../packages/language-server/src/project.ts";

test("an override uses the project-selected package types despite a nested package of the same name", async () => {
  const root = await mkdtemp(join(tmpdir(), "hesperia-override-identity-"));
  const filename = join(root, "src/nested/example.ts");
  const source =
    'import { label } from "chosen"; import type { Suffix } from "settings"; const suffix: Suffix = "!"; export const upper = label.toUpperCase() + suffix;';

  try {
    for (const [directory, type] of [
      [root, "string"],
      [join(root, "src/nested"), "number"],
    ] as const) {
      const library = join(directory, "node_modules/replacement");

      await mkdir(library, { recursive: true });

      await writeFile(
        join(library, "package.json"),
        JSON.stringify({
          name: "replacement",
          type: "module",
          exports: { ".": { browser: { types: "./api.d.ts", default: "./browser.js" } } },
        }),
      );

      await writeFile(join(library, "api.d.ts"), `export declare const label: ${type};`);

      await writeFile(join(library, "browser.js"), 'export const label = "root";');
    }

    await writeFile(join(root, "src/settings.ts"), 'export type Suffix = "!";');

    await writeFile(
      join(root, "base.json"),
      JSON.stringify({
        compilerOptions: { paths: { settings: ["./src/settings.ts"] } },
      }),
    );

    await writeFile(
      join(root, "tsconfig.json"),
      "// Preserve inherited aliases alongside browser replacements.\n" +
        JSON.stringify({
          extends: "./base.json",
          compilerOptions: {
            target: "ESNext",
            module: "ESNext",
            moduleResolution: "Bundler",
            lib: ["ESNext", "DOM"],
            strict: true,
            skipLibCheck: true,
            types: [],
          },
        }),
    );

    const project = await EditorProject.create([{ filename, source }], {
      root,
      resolutionOverrides: { browser: { chosen: "replacement" } },
    });

    try {
      expect(project.diagnostics.diagnostics).toStrictEqual([]);

      const definitions = await project.definitions(filename, source.indexOf("label.toUpperCase"));

      expect(definitions).toHaveLength(1);

      expect(await realpath(definitions[0]!.filename)).toBe(
        await realpath(join(root, "node_modules/replacement/api.d.ts")),
      );
    } finally {
      await project.dispose();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
