import { describe, expect, test } from "bun:test";
import { checkProjectModules, compile } from "../../src/compiler/index.ts";

const shell = `export default function App() {
  return <html lang="en">
    <head>
      <meta charSet="utf-8" />
      <link rel="stylesheet" href="/app.css" />
      <title>Hesperia</title>
    </head>
    <body><main>Ready</main></body>
  </html>;
}`;

describe("document-shell compilation mode", () => {
  test("emits a native html/head/body tree only when the mode is enabled", () => {
    const rejected = compile(shell, { filename: "app.tsx" });
    expect(rejected.code).toBe("");
    expect(
      rejected.diagnostics.filter((item) => item.code === "HES-HTML-CONTEXT"),
    ).not.toHaveLength(0);

    const result = compile(shell, { filename: "app.tsx", documentShell: true });
    expect(result.diagnostics).toEqual([]);
    expect(result.code).toContain('element(owner, "html"');
    expect(result.code).toContain('element(owner, "head"');
    expect(result.code).toContain('element(owner, "body"');
    expect(result.code).toContain('element(owner, "meta"');
    expect(result.code).toContain('element(owner, "title"');
    expect(result.code).toContain('element(owner, "link"');
  }, 30000);

  test("enables shell validation for the root app only in a project snapshot", () => {
    const result = checkProjectModules(
      [
        { filename: "app.tsx", source: shell },
        {
          filename: "Child.tsx",
          source: "export default function Child(){ return <title>x</title>; }",
        },
      ],
      { root: ".", documentShell: true },
    );
    const child = result.modules.find((module) => module.filename === "Child.tsx");
    expect(child?.diagnostics.some((item) => item.code === "HES-HTML-CONTEXT")).toBe(true);
    expect(result.modules.find((module) => module.filename === "app.tsx")?.diagnostics).toEqual([]);
  });

  test.each([
    "export default function App(){ return <html><head/><main/></html>; }",
    "export default function App(){ return <html><head/><head/><body/></html>; }",
    "export default function App(){ return <html><head/><body><head/></body></html>; }",
    "export default function App(){ return <html><head><script>serverOnly()</script></head><body/></html>; }",
  ])("rejects malformed shell: %s", (source) => {
    const result = compile(source, { filename: "app.tsx", documentShell: true });
    expect(result.code).toBe("");
    expect(result.diagnostics.some((item) => item.code === "HES-DOCUMENT-SHELL")).toBe(true);
  });

  test("a project containing only a non-root module does not enable shell mode for it", () => {
    const result = checkProjectModules([{ filename: "Child.tsx", source: shell }], {
      root: ".",
      documentShell: true,
    });
    expect(result.diagnostics.some((item) => item.code === "HES-HTML-CONTEXT")).toBe(true);
  });

  test("an empty default component cannot borrow an unused html expression", () => {
    const result = compile(
      "const Unused = () => <html><head/><body/></html>; export default function App(){ return null; }",
      { filename: "app.tsx", documentShell: true },
    );
    expect(result.code).toBe("");
    expect(result.diagnostics.some((item) => item.code === "HES-DOCUMENT-SHELL")).toBe(true);
  });

  test("does not mistake an unused html expression for the app shell", () => {
    const source = `const Unused = () => <html><head/><body/></html>;
export default function App(){ return <div>content</div>; }`;
    const result = compile(source, { filename: "app.tsx", documentShell: true });
    expect(result.code).toBe("");
    expect(
      result.diagnostics.some(
        (item) => item.code === "HES-DOCUMENT-SHELL" && item.message.includes("root <html>"),
      ),
    ).toBe(true);
  });

  test("preserves authored spans for shell placement errors", () => {
    const source = `export default function App() {
  return <html><head /><body><head /></body></html>;
}`;
    const result = compile(source, { filename: "app.tsx", documentShell: true });
    const diagnostic = result.diagnostics.find(
      (item) => item.code === "HES-DOCUMENT-SHELL" && item.message.startsWith("<head> must"),
    );
    expect(diagnostic?.span).toEqual({
      start: source.lastIndexOf("<head />"),
      end: source.lastIndexOf("<head />") + "<head />".length,
    });
  });
});
