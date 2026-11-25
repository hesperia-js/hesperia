import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { preparePluginEditor } from "../../packages/tooling/src/project.ts";
import { EditorProject } from "../../packages/language-server/src/project.ts";
import type { Plugin } from "../../packages/tooling/src/plugins.ts";
import { identityMappings, pluginSourceMap } from "../tooling/plugin-source-map-fixture.ts";

test("editor uses the configured import declaration and maps authored cursor positions", async () => {
  const root = await mkdtemp(join(tmpdir(), "hesperia-editor-plugin-"));
  const filename = join(root, "app.ts");
  const authored =
    'import palette from "./palette.dat" with { type: "palette" };\nexport const upper = palette.toUpperCase();';

  try {
    await writeFile(join(root, "palette.dat"), "red,blue");

    const plugin: Plugin = {
      name: "palette",
      importTypes: {
        palette(input) {
          return {
            declaration: {
              code: "declare const palette: string; export default palette;",
              origin: input.importSpan,
            },
            browser: { code: 'export default "red,blue";', origin: input.importSpan },
          };
        },
      },
    };
    const prepared = await preparePluginEditor(new Map([[filename, authored]]), root, {
      allowUnsafeHTML: false,
      mountURL: "/",
      resolutionOverrides: { browser: {} },
      plugins: [plugin],
    });

    expect(prepared.diagnostics).toStrictEqual([]);

    const project = await EditorProject.create(prepared.modules, {
      root,
      additionalFiles: prepared.additionalFiles,
      resolution: prepared.resolution,
      documentShell: false,
    });

    try {
      expect(project.diagnostics.diagnostics).toStrictEqual([]);

      const authoredOffset = authored.indexOf("palette.toUpperCase");
      const transformedOffset = prepared.generatedOffset(filename, authoredOffset);

      expect(transformedOffset).toBeGreaterThan(authoredOffset);

      const hover = await project.hover(filename, transformedOffset);

      expect(hover?.type).toBe("string");

      const definition = (await project.definitions(filename, transformedOffset))[0]!;

      expect(prepared.declarationOrigin(definition.filename)).toMatchObject({ filename });

      expect(prepared.authoredOffset(filename, transformedOffset)).toBe(authoredOffset);
    } finally {
      await project.dispose();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("editor mappings retain authored identity across source order and transform chains", async () => {
  const root = await mkdtemp(join(tmpdir(), "hesperia-editor-source-map-"));
  const filename = join(root, "author.ts");
  const vendor = join(root, "vendor.ts");
  const authored = "const localValue = { answer: 42 };\nlocalValue.answer;";
  const injected = 'export const fromVendor: number = "wrong";';

  try {
    const inspect = async (sourceOrder: readonly string[]) => {
      const plugins: Plugin[] = [
        {
          name: "inject-vendor-source",

          transformSource(input) {
            if (input.filename !== filename) return undefined;

            const authorLines = input.current.split("\n");
            const sourceFiles = sourceOrder.map((source) => ({
              filename: source,
              content: source === vendor ? injected : input.current,
            }));
            return {
              code: `${injected}\n${input.current}`,
              map: pluginSourceMap(
                sourceFiles,
                identityMappings([
                  {
                    generatedLine: 0,
                    sourceIndex: sourceOrder.indexOf(vendor),
                    originalLine: 0,
                    text: injected,
                  },
                  ...authorLines.map((text, originalLine) => ({
                    generatedLine: originalLine + 1,
                    sourceIndex: sourceOrder.indexOf(filename),
                    originalLine,
                    text,
                  })),
                ]),
              ),
            };
          },
        },
        {
          name: "prefix-first-wrapper",

          transformSource(input) {
            if (input.filename !== filename) return undefined;

            return {
              code: `// first wrapper\n${input.current}`,
              map: pluginSourceMap(
                [{ filename, content: input.current }],
                identityMappings(
                  input.current.split("\n").map((text, originalLine) => ({
                    generatedLine: originalLine + 1,
                    sourceIndex: 0,
                    originalLine,
                    text,
                  })),
                ),
              ),
            };
          },
        },
        {
          name: "prefix-second-wrapper",

          transformSource(input) {
            if (input.filename !== filename) return undefined;

            return {
              code: `// second wrapper\n${input.current}`,
              map: pluginSourceMap(
                [{ filename, content: input.current }],
                identityMappings(
                  input.current.split("\n").map((text, originalLine) => ({
                    generatedLine: originalLine + 1,
                    sourceIndex: 0,
                    originalLine,
                    text,
                  })),
                ),
              ),
            };
          },
        },
      ];
      const prepared = await preparePluginEditor(new Map([[filename, authored]]), root, {
        allowUnsafeHTML: false,
        mountURL: "/",
        resolutionOverrides: { browser: {} },
        plugins,
      });
      const project = await EditorProject.create(prepared.modules, {
        root,
        additionalFiles: prepared.additionalFiles,
        resolution: prepared.resolution,
        documentShell: false,
      });

      try {
        const useOffset = authored.lastIndexOf("localValue");
        const generatedUseOffset = prepared.generatedOffset(filename, useOffset);
        const hover = await project.hover(filename, generatedUseOffset);
        const definitions = await project.definitions(filename, generatedUseOffset);
        const generatedVendorOffset = prepared.modules
          .find((module) => module.filename === filename)!
          .source.indexOf("fromVendor");
        const vendorProjection = prepared.authoredOffset(filename, generatedVendorOffset);
        const completionOffset = authored.lastIndexOf("localValue.") + "localValue.".length;
        const completions = await project.completions(
          filename,
          prepared.generatedOffset(filename, completionOffset),
        );
        const mappedDiagnostics = prepared.diagnostics
          .map(({ code, filename: diagnosticFile, message, span }) => ({
            code,
            filename: diagnosticFile,
            message,
            span,
          }))
          .sort((left, right) => left.filename.localeCompare(right.filename));
        return {
          hover: hover?.type,
          definitions: definitions.map((location) => ({
            filename: location.filename,
            start: prepared.authoredOffset(location.filename, location.start),
            end: prepared.authoredOffset(location.filename, location.end),
          })),
          vendorProjection,
          generatedVendorOffset,
          completions: completions.map(({ label, insertText }) => ({ label, insertText })),
          mappedDiagnostics,
        };
      } finally {
        await project.dispose();
      }
    };

    const vendorFirst = await inspect([vendor, filename]);
    const authorFirst = await inspect([filename, vendor]);

    expect(vendorFirst).toStrictEqual(authorFirst);

    expect(vendorFirst.hover).toContain("answer: number");

    expect(vendorFirst.definitions).toContainEqual({
      filename: filename.replaceAll("\\", "/"),
      start: authored.indexOf("localValue"),
      end: authored.indexOf("localValue") + "localValue".length,
    });

    expect(vendorFirst.vendorProjection).toBe(vendorFirst.generatedVendorOffset);

    expect(vendorFirst.completions.map((item) => item.label)).toContain("answer");

    expect(vendorFirst.mappedDiagnostics).toContainEqual({
      code: "TS2322",
      filename: vendor,
      message: "Type 'string' is not assignable to type 'number'.",
      span: {
        start: injected.indexOf("fromVendor"),
        end: injected.indexOf("fromVendor") + "fromVendor".length,
      },
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("editor projects built-in JSON, text, and Blob imports without project plugins", async () => {
  const root = await mkdtemp(join(tmpdir(), "hesperia-editor-asset-"));
  const filename = join(root, "app.ts");
  const authored = `import data from "./data.json" with { "type": "json" };
import photo from "./photo.jpg" with { type: "image/png" };
import label from "./label.txt";
import "./card.css" with { "type": "css" };
const count: number = data.count;
export const later = () => import("./data.json", { with: { "type": "json" } });
const labelUpper = label.toUpperCase();
const photoValue = photo;
export { count, photo, labelUpper, photoValue };`;

  try {
    await writeFile(join(root, "data.json"), '{"count":7,"tags":["one","two"]}');

    await writeFile(join(root, "photo.jpg"), new Uint8Array([255, 0]));

    await writeFile(join(root, "label.txt"), "built-in text");

    await writeFile(join(root, "card.css"), ".card{color:red}");

    const prepared = await preparePluginEditor(new Map([[filename, authored]]), root, {
      allowUnsafeHTML: false,
      mountURL: "/",
      resolutionOverrides: { browser: {} },
    });

    expect(prepared.diagnostics.some((item) => item.severity === "error")).toBe(false);

    expect(prepared.diagnostics.find((item) => item.severity === "warning")?.message).toContain(
      "bytes are not converted",
    );

    const project = await EditorProject.create(prepared.modules, {
      root,
      additionalFiles: prepared.additionalFiles,
      resolution: prepared.resolution,
      documentShell: false,
    });

    try {
      expect(
        project.diagnostics.diagnostics.filter((item) => item.severity === "error"),
      ).toStrictEqual([]);

      const position = authored.indexOf("data.count") + "data.".length;
      const hover = await project.hover(filename, prepared.generatedOffset(filename, position));

      expect(hover?.type).toContain("number");

      const textPosition = authored.indexOf("label.toUpperCase");
      const textHover = await project.hover(
        filename,
        prepared.generatedOffset(filename, textPosition),
      );

      expect(textHover?.type).toBe("string");

      const binaryPosition = authored.indexOf("photoValue = photo;") + "photoValue = ".length;
      const binaryHover = await project.hover(
        filename,
        prepared.generatedOffset(filename, binaryPosition),
      );

      expect(binaryHover?.type).toBe("Blob");

      expect(
        prepared.additionalFiles.some((file) => file.source.includes('"tags": string[]')),
      ).toBe(true);

      expect(prepared.watch).toContainEqual({ kind: "file", file: join(root, "card.css") });
    } finally {
      await project.dispose();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
