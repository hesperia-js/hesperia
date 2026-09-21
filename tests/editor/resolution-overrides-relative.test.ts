import { expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EditorProject } from "../../src/editor/project.ts";
import { readConfiguration } from "../../src/tooling/configuration.ts";

test.each([
  ["static", 'import { label } from "./local.ts"; export const value = label().toUpperCase();'],
  [
    "dynamic",
    'export async function load() { return (await import("./local.ts")).label().toUpperCase(); }',
  ],
])(
  "editor follows an exact relative %s import override to the selected replacement",
  async (_kind, source) => {
    const root = await mkdtemp(join(tmpdir(), "hesperia-editor-relative-overrides-"));
    const filename = join(root, "src/nested/example.ts");
    const replacement = join(root, "replacement.ts");
    const replacementSource = 'export function label(): string { return "browser"; }';
    try {
      await mkdir(join(root, "src/nested"), { recursive: true });
      await writeFile(replacement, "export function label(): number { return 42; }");
      await writeFile(
        join(root, "hesperia.config.json"),
        JSON.stringify({ resolutionOverrides: { browser: { "./local.ts": "./replacement.ts" } } }),
      );
      const configuration = await readConfiguration(root);
      const project = new EditorProject(
        [
          { filename, source },
          { filename: replacement, source: replacementSource },
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
      } finally {
        project.dispose();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
