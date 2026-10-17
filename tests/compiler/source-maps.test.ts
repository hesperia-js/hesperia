import { expect, test } from "bun:test";
import { originalPositionFor, TraceMap, type SourceMapInput } from "@jridgewell/trace-mapping";
import { parseSync } from "oxc-parser";
import { canonicalize } from "../../packages/compiler/src/canonical.ts";
import { compile } from "../../packages/compiler/src/index.ts";
import { generateModule } from "../../packages/compiler/src/generate.ts";

test("generated member access maps through erased TypeScript, CRLF and Unicode to authored code", async () => {
  const source =
    'type Removed = { value: string };\r\nexport function App() {\r\n const marker: number = 7; const cat = "🐈";\r\n return <span>{Math.abs(marker)}</span>;\r\n}';
  const result = await compile(source, { filename: "source-position.tsx" });

  expect(result.diagnostics).toStrictEqual([]);

  const generated = position(result.code, result.code.indexOf("abs"));
  const original = originalPositionFor(new TraceMap(result.map as SourceMapInput), generated);

  expect(original.source).toBe("source-position.tsx");

  expect({ line: original.line, column: original.column }).toStrictEqual(
    position(source, source.indexOf("abs")),
  );

  expect(new TraceMap(result.map as SourceMapInput).sourcesContent).toStrictEqual([source]);

  expect(
    Object.values(result.debug.spans).some((span) => span.start === source.indexOf("abs")),
  ).toBe(true);
});

test("binding errors retain authored offsets after erased declarations", async () => {
  const source =
    'import { bind } from "hesperia/client";\r\ntype Removed = number;\r\nexport function App(){ const text: string = "🐈"; const binding = bind<HTMLSpanElement>(); binding(); return <span>{text}</span>; }';
  const result = await compile(source, { filename: "diagnostic-position.tsx" });
  const diagnostic = result.diagnostics.find((item) => item.code === "HES-BIND-BODY");

  expect(result.code).toBe("");

  expect(diagnostic?.span?.start).toBe(source.indexOf("binding()"));

  expect(source.slice(diagnostic?.span?.start, diagnostic?.span?.end)).toBe("binding()");
});

test("generated maps preserve lone-CR lines and UTF-16 columns", () => {
  const filename = "lone-cr-source-position.tsx";
  const source =
    'const before = "🐈";\rexport function App() { const cat = "🐈"; return <span>{Math.abs(7)}</span>; }\r';
  const parsed = parseSync(filename, source, {
    lang: "jsx",
    astType: "js",
    range: true,
    sourceType: "module",
  });

  expect(parsed.errors).toStrictEqual([]);

  const ir = canonicalize(parsed.program, filename);

  expect(ir.diagnostics).toStrictEqual([]);

  const generated = generateModule(ir, {
    filename,
    runtimeModule: "hesperia/runtime",
    source,
    clientBindings: new Map(),
  });
  const offset = generated.code.indexOf("abs");

  expect(offset).toBeGreaterThanOrEqual(0);

  const trace = new TraceMap(generated.map as SourceMapInput);
  const original = originalPositionFor(trace, position(generated.code, offset));

  expect(original.source).toBe(filename);

  expect({ line: original.line, column: original.column }).toStrictEqual({ line: 2, column: 61 });

  expect(trace.sourcesContent).toStrictEqual([source]);
});

function position(source: string, offset: number): { line: number; column: number } {
  if (offset < 0) throw new Error("Expected generated token is absent.");

  const prefix = source.slice(0, offset);
  return { line: prefix.split("\n").length, column: offset - prefix.lastIndexOf("\n") - 1 };
}
