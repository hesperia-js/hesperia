import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { checkProjectModules } from "../../src/compiler/checking.ts";
import { compileProjectModules } from "../../src/compiler/project-compilation.ts";

const root = resolve(import.meta.dir, "../..");

test("page checking supports imported aliases and named query interfaces", () => {
  const result = checkProjectModules(
    [
      {
        filename: "src/page-inputs.ts",
        source: `import type { Page } from "hesperia";
interface Filters { tab?: string }
export type Inputs = Page.Props<{ queryParams: Filters }>;`,
      },
      {
        filename: "src/routes/users/[id]/+page.tsx",
        source: `import type { Inputs } from "../../../page-inputs";
export default function User(props: Inputs) { return <span>{props.params.id}:{props.queryParams().get("tab")}</span>; }`,
      },
    ],
    { root },
  );
  expect(result.diagnostics).toStrictEqual([]);
});

test("an explicitly required page binding remains required in compiled metadata", () => {
  const filename = "src/routes/[id]/+page.tsx";
  const result = compileProjectModules(
    [
      {
        filename,
        source: `import type { Page } from "hesperia";
export default function User(props: Page.Props<{ queryParams: {}; bind: { focus(): void } }>) { return <span>{props.params.id}</span>; }`,
      },
    ],
    { root },
  );
  expect(result.checking.diagnostics).toStrictEqual([]);
  expect(result.modules.get(filename)?.code).toMatch(
    /bind:\s*\{\s*kind: "binding",\s*optional: false/,
  );
});

test("Page.Props supplies immutable route params and declared native query names", () => {
  const source =
    'import type { Page as P } from "hesperia"; export default function UserPage(props: P.Props<{ queryParams: { page?: string; filter?: string }; ordinaryProp?: string }>) { const id: string = props.params.id; const page: string | null = props.queryParams().get("page"); const all: string[] = props.queryParams().getAll("filter"); const present: boolean = props.queryParams().has("page"); const ordinary: string | undefined = props.ordinaryProp(); return <span>{id}{page}{all}{present}{ordinary}</span>; }';
  expect(
    checkProjectModules([{ filename: "src/routes/[id]/+page.tsx", source }], { root }).diagnostics,
  ).toStrictEqual([]);
});

test("a page declaration named Page still receives the inferred route params", () => {
  const source =
    'import type { Page } from "hesperia"; export default function Page(props: Page.Props) { const id: string = props.params.id; props.params.missing; return <span>{id}</span>; }';
  const result = checkProjectModules([{ filename: "src/routes/users/[id]/+page.tsx", source }], {
    root,
  });
  expect(result.diagnostics.filter((item) => item.code === "TS2339")).toHaveLength(1);
  expect(result.diagnostics.find((item) => item.code === "TS2339")?.message).toContain("missing");
});

test("Page.Props rejects unknown route and query names", () => {
  const source =
    'import type { Page } from "hesperia"; export default function UserPage(props: Page.Props<{ queryParams: { page?: string } }>) { props.params.missing; props.queryParams().get("filter"); return <span />; }';
  const result = checkProjectModules([{ filename: "src/routes/[id]/+page.tsx", source }], { root });
  expect(result.diagnostics.filter((item) => item.code === "TS2339")).toHaveLength(1);
  expect(result.diagnostics.filter((item) => item.code === "TS2345")).toHaveLength(1);
});

test("Page.Props rejects non-string query declarations", () => {
  const modules = ["number", "boolean", "{ value: string }", "string[]"].map((type, index) => ({
    filename: `src/routes/invalid${index}/+page.tsx`,
    source: `import type { Page } from "hesperia"; export default function Invalid(props: Page.Props<{ queryParams: { page?: ${type} } }>) { return <span>{props.queryParams().get("page")}</span>; }`,
  }));
  const declarations = ["number", "boolean", "{ value: string }", "string[]"].map(
    (type, index) => ({
      filename: `src/invalid${index}.ts`,
      source: `import type { Page } from "hesperia"; export type Invalid = Page.Props<{queryParams: {page?: ${type}}}>;`,
    }),
  );
  const result = checkProjectModules([...modules, ...declarations], { root });
  for (const module of result.modules) {
    if (module.filename.endsWith(".ts")) {
      expect(module.diagnostics.some((item) => item.code === "TS2344")).toBe(true);
      continue;
    }
    expect(module.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "HES-PROPS",
        message: expect.stringContaining("page must be string"),
      }),
    );
  }
});

test("generated optional parameters and catch-all arrays are checked through current root declarations", () => {
  const required = "src/routes/files/[...path]/+page.tsx";
  const optional = "src/routes/docs/[[lang]]/[[...tail]]/+page.tsx";
  const result = checkProjectModules(
    [
      {
        filename: required,
        source: `import type { Page } from "hesperia";
export default function Files(props: Page.Props) { const path: readonly string[] = props.params.path; return <span>{path.join("/")}</span>; }`,
      },
      {
        filename: optional,
        source: `import type { Page } from "hesperia";
export default function Docs({ params }: Page.Props) { const language: string | undefined = params.lang; const tail: readonly string[] | undefined = params.tail; return <span>{language}:{tail?.join("/")}</span>; }`,
      },
    ],
    {
      root,
      additionalFiles: [
        {
          filename: "hesperia.d.ts",
          source:
            "// HESPERIA GENERATED PAGE ROUTES\nexport {};\ndeclare global { type __hesperia_page_route_0 = {wrong: number}; }",
        },
      ],
    },
  );
  expect(result.diagnostics).toStrictEqual([]);
  const invalid = checkProjectModules(
    [
      {
        filename: required,
        source: `import type { Page } from "hesperia";
export default function Files(props: Page.Props) { props.params.path.push("x"); props.params.path = []; return <span />; }`,
      },
    ],
    { root },
  );
  expect(invalid.diagnostics.filter((item) => item.code === "TS2339")).toHaveLength(1);
  expect(invalid.diagnostics.filter((item) => item.code === "TS2540")).toHaveLength(1);
});

test("page prop metadata keeps params and query views plain while ordinary props retain Component.Props", () => {
  const source =
    'import type { Page } from "hesperia"; export default function UserPage(props: Page.Props<{ queryParams: { page?: string }; ordinaryProp?: string }>) { return <span>{props.params.id}{props.queryParams().get("page")}{props.ordinaryProp()}</span>; }';
  const result = compileProjectModules([{ filename: "src/routes/[id]/+page.tsx", source }], {
    root,
  });
  expect(result.checking.diagnostics).toStrictEqual([]);
  const code = result.modules.get("src/routes/[id]/+page.tsx")?.code ?? "";
  expect(code).toContain('params: {\n\t\tkind: "plain"');
  expect(code).toContain('queryParams: {\n\t\tkind: "plain"');
  expect(code).toContain('ordinaryProp: {\n\t\tkind: "value"');
  expect(code).toContain("optional: true");
});
