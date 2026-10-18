import { expect, test } from "bun:test";
import { compile } from "../../packages/compiler/src/project-compilation.ts";

test("compiled definitions keep their identities while binding CSS entries and owners", async () => {
  const filename = "/virtual/Card.tsx";
  const source = `export default function Card() { return <div />; }
export const Badge = () => <span />;`;
  const compiled = await compile(source, {
    filename,
    browserTarget: true,
    styleRuntimeModule: "hesperia:style-plan",
    styleEntryId: filename,
    allowUnsafeEmbed: true,
  });

  expect(compiled.diagnostics.filter((item) => item.severity === "error")).toStrictEqual([]);

  expect(compiled.code).toContain('from "hesperia:style-plan"');

  expect(compiled.code).toContain("await");

  expect(compiled.code).toContain(".preloadEntry(");

  expect(compiled.code).toContain(".bindEntry(");

  expect(compiled.code).toContain(".bindStyles(");

  expect(compiled.code.match(/\.bindEntry\(/gu)).toHaveLength(2);

  expect(compiled.code.match(/\.bindStyles\(/gu)).toHaveLength(2);

  expect(compiled.code).toContain("registerProjectPolicy");

  expect(compiled.styleOwners?.map((item) => item.name)).toStrictEqual(["Card", "Badge"]);

  expect(compiled.styleOwners?.every((item) => item.id.startsWith(`${filename}#`))).toBe(true);
});

test("unstyled standalone compilation has no private style calls", async () => {
  const compiled = await compile("export default function Card() { return <div />; }", {
    filename: "/virtual/Card.tsx",
    browserTarget: true,
  });

  expect(compiled.diagnostics.filter((item) => item.severity === "error")).toStrictEqual([]);

  expect(compiled.code).not.toContain("preloadEntry");

  expect(compiled.code).not.toContain("bindStyles");
});

test("a CSS-free shell binds its entry without introducing top-level preload", async () => {
  const compiled = await compile(
    "export default function App() { return <html><head></head><body></body></html>; }",
    {
      filename: "/virtual/app.tsx",
      browserTarget: true,
      documentShell: true,
      styleRuntimeModule: "hesperia:style-plan",
      styleEntryId: "app.tsx",
      stylePreloadEntry: false,
    },
  );

  expect(compiled.diagnostics.filter((item) => item.severity === "error")).toStrictEqual([]);

  expect(compiled.code).toContain('from "hesperia:style-plan"');

  expect(compiled.code).toContain(".bindEntry(");

  expect(compiled.code).not.toContain("preloadEntry");

  expect(compiled.code).not.toContain("await");
});
