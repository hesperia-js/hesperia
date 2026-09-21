import { expect, test } from "bun:test";
import { TextDocument } from "vscode-languageserver-textdocument";
import { SymbolKind } from "vscode-languageserver/node";
import { extractDocumentSymbols } from "../../src/editor/symbols.ts";

function slice(
  document: TextDocument,
  range: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  },
): string {
  return document.getText().slice(document.offsetAt(range.start), document.offsetAt(range.end));
}

test("extracts authored nested symbols with UTF-16 ranges from unsaved TSX", () => {
  const source = [
    "export function App() {",
    '  const emoji = "🐈";',
    "  function nested() {",
    "    return emoji;",
    "  }",
    "  return <Widget value={emoji} />;",
    "}",
  ].join("\r\n");
  const document = TextDocument.create("file:///App.tsx", "typescriptreact", 4, source);
  const [app] = extractDocumentSymbols("App.tsx", source);

  expect(app?.name).toBe("App");
  expect(app?.kind).toBe(SymbolKind.Function);
  expect(app && slice(document, app.range)).toBe(source);
  expect(app && slice(document, app.selectionRange)).toBe("App");
  expect(app?.children?.map((item) => item.name)).toStrictEqual(["emoji", "nested"]);
  expect(app?.children?.[0]?.kind).toBe(SymbolKind.Constant);
  expect(app?.children?.[0] && slice(document, app.children[0].range)).toBe('const emoji = "🐈";');
  expect(app?.children?.[0] && slice(document, app.children[0].selectionRange)).toBe("emoji");
  expect(app?.children?.[1]?.kind).toBe(SymbolKind.Function);
  expect(app?.children?.[1] && slice(document, app.children[1].range)).toBe(
    "function nested() {\r\n    return emoji;\r\n  }",
  );
  expect(app?.children?.[1] && slice(document, app.children[1].selectionRange)).toBe("nested");
});

test("includes declarations, class members, object members, and type members", () => {
  const source = [
    "interface Props { title: string; render(): void }",
    "type RecordShape = { id: string; nested: { enabled: boolean } }",
    "enum Status { Ready, Done }",
    "namespace Models { export interface Item { id: string } }",
    "class Counter {",
    "  value = 0;",
    "  increment() { const next = this.value + 1; return next; }",
    "}",
    'const config = { title: "Counter", nested: { enabled: true }, render() { const local = 1; return local; } };',
    "const { item: alias, plain } = sourceValue;",
  ].join("\n");
  const symbols = extractDocumentSymbols("App.ts", source);

  expect(symbols.map((item) => [item.name, item.kind])).toStrictEqual([
    ["Props", SymbolKind.Interface],
    ["RecordShape", SymbolKind.TypeParameter],
    ["Status", SymbolKind.Enum],
    ["Models", SymbolKind.Namespace],
    ["Counter", SymbolKind.Class],
    ["config", SymbolKind.Constant],
    ["alias", SymbolKind.Constant],
    ["plain", SymbolKind.Constant],
  ]);
  expect(symbols[0]?.children?.map((item) => item.name)).toStrictEqual(["title", "render"]);
  expect(symbols[1]?.children?.map((item) => item.name)).toStrictEqual(["id", "nested"]);
  expect(symbols[2]?.children?.map((item) => item.name)).toStrictEqual(["Ready", "Done"]);
  expect(symbols[3]?.children?.[0]?.name).toBe("Item");
  expect(symbols[4]?.children?.map((item) => item.name)).toStrictEqual(["value", "increment"]);
  expect(symbols[4]?.children?.[1]?.children?.[0]?.name).toBe("next");
  expect(symbols[5]?.children?.map((item) => item.name)).toStrictEqual([
    "title",
    "nested",
    "render",
  ]);
  expect(symbols[5]?.children?.[1]?.children?.[0]?.name).toBe("enabled");
  expect(symbols[5]?.children?.[2]?.children?.[0]?.name).toBe("local");
  expect(symbols[6]?.name).toBe("alias");
  expect(symbols[7]?.name).toBe("plain");
});

test("uses the current unsaved source and does not expose generated helpers", () => {
  const first = "export const diskVersion = true;";
  const second = "export const unsavedVersion = true;\nconst component = <Widget />;";

  expect(extractDocumentSymbols("App.tsx", first).map((item) => item.name)).toStrictEqual([
    "diskVersion",
  ]);
  expect(extractDocumentSymbols("App.tsx", second).map((item) => item.name)).toStrictEqual([
    "unsavedVersion",
    "component",
  ]);
  expect(
    extractDocumentSymbols("App.tsx", second).some((item) => item.name.startsWith("__hesperia_")),
  ).toBe(false);
});

test("returns an empty outline while the authored source is incomplete", () => {
  expect(extractDocumentSymbols("App.tsx", "export function App(")).toStrictEqual([]);
  expect(() => extractDocumentSymbols("App.tsx", "const value = <Widget")).not.toThrow();
});

test("symbol selections follow editor offsets after emoji and all newline forms", () => {
  for (const newline of ["\n", "\r\n", "\r"]) {
    const source = `const emoji = "🐈"; const after = 1;${newline}function next() {}`;
    const document = TextDocument.create("file:///offsets.tsx", "hesperia-tsx", 1, source);
    const symbols = extractDocumentSymbols("offsets.tsx", source);
    expect(symbols.map((symbol) => slice(document, symbol.selectionRange))).toStrictEqual([
      "emoji",
      "after",
      "next",
    ]);
    expect(symbols[2]?.selectionRange.start).toStrictEqual({ line: 1, character: 9 });
  }
});
