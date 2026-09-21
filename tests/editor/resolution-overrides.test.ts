import { expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EditorProject } from "../../src/editor/project.ts";
import { readConfiguration } from "../../src/tooling/configuration.ts";

test("editor import replacements use unsaved types and navigate to the authored replacement", async () => {
  const root = await mkdtemp(join(tmpdir(), "hesperia-editor-overrides-"));
  const filename = join(root, "src/nested/Example.tsx");
  const replacement = join(root, "src/replacement.ts");
  const source =
    'import { label } from "display-source";\r\nimport type { Suffix } from "settings";\r\nexport function Example(){ const suffix: Suffix = "!"; return <span>{label().toUpperCase() + suffix}</span>; }';
  const textReplacement = 'export function label(): string { return "browser"; }';
  const numberReplacement = "export function label(): number { return 42; }";
  try {
    await mkdir(join(root, "src/nested"), { recursive: true });
    await writeFile(replacement, numberReplacement);
    await writeFile(join(root, "src/settings.ts"), 'export type Suffix = "!";');
    await writeFile(
      join(root, "base.json"),
      JSON.stringify({ compilerOptions: { paths: { settings: [join(root, "src/settings.ts")] } } }),
    );
    await writeFile(
      join(root, "tsconfig.json"),
      "// Author configuration may inherit type aliases.\n" +
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
    await writeFile(
      join(root, "hesperia.config.json"),
      JSON.stringify({
        resolutionOverrides: { browser: { "display-source": "./src/replacement.ts" } },
      }),
    );
    const configuration = await readConfiguration(root);
    const project = new EditorProject(
      [
        { filename, source },
        { filename: replacement, source: textReplacement },
      ],
      { root, ...configuration },
    );
    try {
      expect(project.diagnostics.diagnostics).toStrictEqual([]);
      const definitions = project.definitions(filename, source.indexOf("label()"));
      expect(definitions).toHaveLength(1);
      expect(definitions[0]!.filename.replaceAll("\\", "/").toLowerCase()).toBe(
        replacement.replaceAll("\\", "/").toLowerCase(),
      );
      expect(definitions[0]!.start).toBe(textReplacement.indexOf("label"));
      expect(definitions[0]!.end).toBe(textReplacement.indexOf("label") + "label".length);
    } finally {
      project.dispose();
    }

    const edited = new EditorProject(
      [
        { filename, source },
        { filename: replacement, source: numberReplacement },
      ],
      { root, ...configuration },
    );
    try {
      const diagnostics = edited.diagnostics.diagnostics;
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0]!.code).toBe("TS2339");
      expect(diagnostics[0]!.span).toStrictEqual({
        start: source.indexOf("toUpperCase"),
        end: source.indexOf("toUpperCase") + "toUpperCase".length,
      });
    } finally {
      edited.dispose();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 30000);
