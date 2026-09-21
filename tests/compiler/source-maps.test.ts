import { expect, test } from "bun:test";
import { originalPositionFor, TraceMap, type SourceMapInput } from "@jridgewell/trace-mapping";
import { compile } from "../../src/compiler/index.ts";

test("generated member access maps through erased TypeScript, CRLF and Unicode to authored code", () => {
  const source =
    'type Removed = { value: string };\r\nexport function App() {\r\n const marker: number = 7; const cat = "🐈";\r\n return <span>{Math.abs(marker)}</span>;\r\n}';
  const result = compile(source, { filename: "source-position.tsx" });
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

test("binding errors retain authored offsets after erased declarations", () => {
  const source =
    'import { bind } from "hesperia/client";\r\ntype Removed = number;\r\nexport function App(){ const text: string = "🐈"; const binding = bind<HTMLSpanElement>(); binding(); return <span>{text}</span>; }';
  const result = compile(source, { filename: "diagnostic-position.tsx" });
  const diagnostic = result.diagnostics.find((item) => item.code === "HES-BIND-BODY");
  expect(result.code).toBe("");
  expect(diagnostic?.span?.start).toBe(source.indexOf("binding()"));
  expect(source.slice(diagnostic?.span?.start, diagnostic?.span?.end)).toBe("binding()");
});

function position(source: string, offset: number): { line: number; column: number } {
  if (offset < 0) throw new Error("Expected generated token is absent.");
  const prefix = source.slice(0, offset);
  return { line: prefix.split("\n").length, column: offset - prefix.lastIndexOf("\n") - 1 };
}
