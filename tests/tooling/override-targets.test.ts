import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { prepareBuild } from "../../packages/tooling/src/project.ts";

test("a package replacement uses its public declarations and browser implementation", async () => {
  const parent = resolve(import.meta.dir, "../../.hesperia");
  const root = await mkdtemp(join(parent, "override-package-types-"));

  try {
    const library = join(root, "node_modules/replacement-library");

    await mkdir(join(library, "types"), { recursive: true });

    await mkdir(join(root, "src/routes"), { recursive: true });

    await writeFile(
      join(library, "package.json"),
      JSON.stringify({
        name: "replacement-library",
        type: "module",
        exports: {
          ".": {
            types: "./types/api.d.ts",
            browser: "./browser.js",
            default: "./server.js",
          },
        },
      }),
    );

    await writeFile(join(library, "types/api.d.ts"), "export declare const label: string;");

    await writeFile(join(library, "browser.js"), 'export const label = "browser-target";');

    await writeFile(
      join(library, "server.js"),
      'import "node:fs"; export const label = "server-target";',
    );

    await writeFile(
      join(root, "hesperia.config.json"),
      JSON.stringify({
        resolutionOverrides: { browser: { "chosen-library": "replacement-library" } },
      }),
    );

    await writeFile(
      join(root, "app.tsx"),
      'import { label } from "chosen-library"; export default function App() { return <html><head/><body><span>{label.toUpperCase()}</span></body></html>; }',
    );

    const built = await prepareBuild(root).catch((error) => {
      throw new Error(JSON.stringify(error.diagnostics ?? error), { cause: error });
    });

    expect(built.diagnostics).toStrictEqual([]);

    const record = JSON.parse(await built.files.get("/hesperia-build.json")!.text());

    expect(record.resolution.edges).toContainEqual(
      expect.objectContaining({
        specifier: "chosen-library",
        resolvedFilename: "node_modules/replacement-library/browser.js",
      }),
    );

    const scripts = await Promise.all(
      [...built.files].filter(([name]) => name.endsWith(".js")).map(([, file]) => file.text()),
    );

    expect(scripts.join("\n")).toContain("browser-target");

    expect(scripts.join("\n")).not.toContain("server-target");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 30000);
