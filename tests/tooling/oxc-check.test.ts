import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkOxcProject } from "../../packages/tooling/src/oxc-check.ts";
import { readProject } from "../../packages/tooling/src/project.ts";

const roots: string[] = [];

async function temporaryProject(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "hesperia-oxc-check-"));

  roots.push(root);

  return root;
}

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("configured Oxc project checks", () => {
  test("an empty project has no synthetic Oxc diagnostics", async () => {
    const root = await temporaryProject();
    const checked = await checkOxcProject(root, new Map());

    expect(checked).toStrictEqual({ diagnostics: [], failed: false });
  });

  test("checks config and nested CSS imports while excluding generated and dependency inputs", async () => {
    const root = await temporaryProject();

    await mkdir(join(root, "src"), { recursive: true });

    await mkdir(join(root, ".hesperia"), { recursive: true });

    await mkdir(join(root, "node_modules", "fixture"), { recursive: true });

    await mkdir(join(root, "styles"), { recursive: true });

    await writeFile(join(root, ".oxlintrc.json"), '{"rules":{"prefer-const":"error"}}\n');

    await writeFile(join(root, ".oxfmtrc.json"), '{"singleQuote":false}\n');

    await writeFile(
      join(root, "app.tsx"),
      'import { greeting } from "./api.ts";\nimport { generated } from "./.hesperia/generated.ts";\nimport { dependency } from "./node_modules/fixture/ignored.ts";\nimport "./src/site.css";\nexport default function App() { return <main>{greeting}{generated}{dependency}</main>; }\n',
    );

    await writeFile(
      join(root, "hesperia.config.ts"),
      'import { projectFlag } from "./configuration-helper.ts";\nexport default { projectFlag };\n',
    );

    await writeFile(
      join(root, "configuration-helper.ts"),
      "let projectFlag = true;\nexport { projectFlag };\n",
    );

    await writeFile(
      join(root, "api.ts"),
      "export const greeting = 'hello';\nlet stable = greeting;\nexport const greetingCopy = stable;\n",
    );

    await writeFile(join(root, "src", "main.ts"), "export const page = true;\n");

    await mkdir(join(root, "src", "nested"), { recursive: true });

    const nestedJs = join(root, "src", "nested", "unimported.js");
    const originalJs = "let nested = 'value';\nexport { nested };\n";

    await writeFile(nestedJs, originalJs);

    await writeFile(
      join(root, "src", "site.css"),
      '@import url(../styles/nested.css);\n@import url( "./../styles/quoted.css" );\n/* @import url(../styles/commented.css); */\n\nmain {\n  content: "@import url(../styles/string.css)";\n  color: red;\n}\n',
    );

    await writeFile(join(root, "styles", "nested.css"), "main{ color:red }\n");

    await writeFile(join(root, "styles", "quoted.css"), "body{display:block}\n");

    await writeFile(join(root, "styles", "commented.css"), "aside{color:blue}\n");

    await writeFile(join(root, "styles", "string.css"), "footer{color:green}\n");

    await writeFile(
      join(root, ".hesperia", "generated.ts"),
      "let generated = true;\nexport { generated };\n",
    );

    await writeFile(
      join(root, "node_modules", "fixture", "ignored.ts"),
      "let dependency = true;\nexport { dependency };\n",
    );

    const snapshot = new Map(await readProject(root));

    snapshot.set(
      join(root, "hesperia.d.ts"),
      "// HESPERIA GENERATED PAGE ROUTES\nlet generated = true;\n",
    );

    const checked = await checkOxcProject(root, snapshot);

    expect(checked.failed).toBe(true);

    expect(await readFile(nestedJs, "utf8")).toBe(originalJs);

    const falseImportSnapshots = await Promise.all(
      ["commented.css", "string.css"].map(async (name) => {
        const filename = join(root, "styles", name);
        return { filename, source: await readFile(filename, "utf8") };
      }),
    );
    const fixed = await checkOxcProject(root, snapshot, { fix: true });

    expect(fixed.failed).toBe(false);

    for (const { filename, source } of falseImportSnapshots)
      expect(await readFile(filename, "utf8")).toBe(source);

    expect(await readFile(join(root, "styles", "nested.css"), "utf8")).not.toBe(
      "main{ color:red }\n",
    );

    expect(await readFile(join(root, "styles", "quoted.css"), "utf8")).not.toBe(
      "body{display:block}\n",
    );

    expect(
      checked.diagnostics.some(
        (item) => item.code.includes("prefer-const") && item.filename === join(root, "api.ts"),
      ),
    ).toBe(true);

    expect(
      checked.diagnostics.some(
        (item) => item.code === "OXFMT" && item.filename === join(root, "api.ts"),
      ),
    ).toBe(true);

    expect(
      checked.diagnostics.some(
        (item) =>
          item.code.includes("prefer-const") &&
          item.filename === join(root, "configuration-helper.ts"),
      ),
    ).toBe(true);

    expect(
      checked.diagnostics.some(
        (item) => item.code === "OXFMT" && item.filename === join(root, "styles", "nested.css"),
      ),
    ).toBe(true);

    expect(
      checked.diagnostics.some(
        (item) => item.code === "OXFMT" && item.filename === join(root, "styles", "quoted.css"),
      ),
    ).toBe(true);

    expect(
      checked.diagnostics.some(
        (item) => item.code.includes("prefer-const") && item.filename === nestedJs,
      ),
    ).toBe(true);

    expect(
      checked.diagnostics.some((item) => item.code === "OXFMT" && item.filename === nestedJs),
    ).toBe(true);

    expect(
      checked.diagnostics.some((item) => item.filename === join(root, "styles", "commented.css")),
    ).toBe(false);

    expect(
      checked.diagnostics.some((item) => item.filename === join(root, "styles", "string.css")),
    ).toBe(false);

    expect(
      checked.diagnostics.some((item) => item.filename === join(root, ".hesperia", "generated.ts")),
    ).toBe(false);

    expect(
      checked.diagnostics.some(
        (item) => item.filename === join(root, "node_modules", "fixture", "ignored.ts"),
      ),
    ).toBe(false);

    expect(checked.diagnostics.some((item) => item.filename === join(root, "hesperia.d.ts"))).toBe(
      false,
    );

    expect(await readFile(nestedJs, "utf8")).toBe('const nested = "value";\nexport { nested };\n');
  });

  test("large file sets preserve diagnostics and fixes across bounded tool batches", async () => {
    const root = await temporaryProject();
    const sourceDirectory = join(root, "src");

    await mkdir(sourceDirectory, { recursive: true });

    await writeFile(join(root, ".oxlintrc.json"), '{"rules":{"prefer-const":"error"}}\n');

    await writeFile(join(root, ".oxfmtrc.json"), '{"singleQuote":false}\n');

    const files: Array<{ filename: string; identifier: string }> = [];
    let pathCharacters = 0;

    for (let index = 0; pathCharacters <= 36_000; index += 1) {
      const identifier = `value${index}`;
      const filename = join(sourceDirectory, `batch-${String(index).padStart(4, "0")}.ts`);

      files.push({ filename, identifier });

      pathCharacters += filename.length;

      await writeFile(filename, `let ${identifier} = 'value';\nexport { ${identifier} };\n`);
    }

    expect(pathCharacters).toBeGreaterThan(32_767);

    const checked = await checkOxcProject(root, new Map());

    expect(checked.failed).toBe(true);

    expect(
      checked.diagnostics
        .filter(
          (item) => item.code.includes("prefer-const") && item.filename.startsWith(sourceDirectory),
        )
        .map((item) => item.filename)
        .sort(),
    ).toStrictEqual(files.map(({ filename }) => filename).sort());

    expect(
      checked.diagnostics
        .filter((item) => item.code === "OXFMT" && item.filename.startsWith(sourceDirectory))
        .map((item) => item.filename)
        .sort(),
    ).toStrictEqual(files.map(({ filename }) => filename).sort());

    const fixed = await checkOxcProject(root, new Map(), { fix: true });

    expect(fixed.failed).toBe(false);

    const fixedSources = await Promise.all(
      files.map(async ({ filename }) => readFile(filename, "utf8")),
    );

    expect(fixedSources).toStrictEqual(
      files.map(({ identifier }) => `const ${identifier} = "value";\nexport { ${identifier} };\n`),
    );
  });
});
