import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rmdir, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { originalPositionFor, TraceMap, type SourceMapInput } from "@jridgewell/trace-mapping";
import { prepareBuild } from "../../src/tooling/project.ts";

test("browser bundle locations point to authored TSX after type removal, CRLF and Unicode", async () => {
  const parent = resolve(import.meta.dir, "../../.hesperia");
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, "bundle-map-"));
  const source = [
    "type Removed = { value: number };",
    "export default function App() {",
    '  const marker: number = -7; const cat = "🐈";',
    "  return <span>{Math.abs(marker)}</span>;",
    "}",
  ].join("\r\n");
  const files = new Map([
    ["src/App.tsx", source],
    [
      "app.tsx",
      'import Content from "./src/App.tsx"; export default function App() { return <html><head></head><body><Content /></body></html>; }',
    ],
    [
      "tsconfig.json",
      JSON.stringify({
        compilerOptions: {
          target: "ESNext",
          module: "ESNext",
          moduleResolution: "bundler",
          jsx: "preserve",
          strict: true,
          noEmit: true,
          allowImportingTsExtensions: true,
          skipLibCheck: true,
        },
        include: ["src"],
      }),
    ],
  ]);
  await mkdir(join(root, "src"));
  try {
    for (const [name, contents] of files) await writeFile(join(root, name), contents);
    const built = await prepareBuild(root);
    expect(built.diagnostics).toStrictEqual([]);
    const scripts = await Promise.all(
      [...built.files]
        .filter(([name]) => name.endsWith(".js"))
        .map(async ([name, blob]) => ({
          name,
          contents: await blob.text(),
        })),
    );
    const scriptPath = scripts.find(({ contents }) => contents.includes("Math.abs"))!.name;
    const script = await built.files.get(scriptPath)!.text();
    const map = JSON.parse(await built.files.get(scriptPath + ".map")!.text()) as SourceMapInput;
    const token = script.indexOf("Math.abs");
    expect(token).toBeGreaterThanOrEqual(0);
    const generated = position(script, token + "Math.".length);
    const trace = new TraceMap(map);
    const original = originalPositionFor(trace, generated);
    expect(original.source?.replaceAll("\\", "/")).toEndWith("/src/App.tsx");
    expect({ line: original.line, column: original.column }).toStrictEqual(
      position(source, source.indexOf("abs")),
    );
    const sourceIndex = trace.sources.indexOf(original.source!);
    expect(trace.sourcesContent?.[sourceIndex]).toBe(source);
  } finally {
    for (const name of [...files.keys(), "hesperia.d.ts"])
      await unlink(join(root, name)).catch((error) => {
        if (error.code !== "ENOENT") throw error;
      });
    await rmdir(join(root, "src"));
    await rmdir(root);
  }
});

function position(source: string, offset: number): { line: number; column: number } {
  const prefix = source.slice(0, offset);
  return { line: prefix.split("\n").length, column: offset - prefix.lastIndexOf("\n") - 1 };
}
