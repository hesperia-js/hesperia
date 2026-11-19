import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { checkProjectModules } from "../../packages/compiler/src/checking.ts";
import {
  checkingView,
  checkingViewRouteLoadCapture,
} from "../../packages/compiler/src/checking-view.ts";
import { compileProjectModules } from "../../packages/compiler/src/project-compilation.ts";

const root = resolve(import.meta.dir, "../..");

test("explicit route loader checking retains the authored configuration and pattern", () => {
  const source =
    "import { route } from 'hesperia/routing'; export default route<'/users/[id]'>({ load: async ({ request }) => ({ item: 'own' as const, path: new URL(request.url).pathname }) });";
  const view = checkingView(source, "src/routes/users/[id]/+route.ts", false);
  const capture = checkingViewRouteLoadCapture(view);
  const projection = capture?.projections[0];

  expect(capture?.complete).toBe(true);
  expect(capture?.projections).toHaveLength(1);
  expect(projection?.authoredPatternText).toBe("'/users/[id]'");
  expect(
    view.source.slice(
      projection!.generatedConfigurationSpan.start,
      projection!.generatedConfigurationSpan.end,
    ),
  ).toContain("load:");
  expect(
    view.source.slice(
      projection!.generatedTypeArgumentsSpan.start,
      projection!.generatedTypeArgumentsSpan.end,
    ),
  ).toContain(`typeof ${projection!.identifier}`);

  const position = source.indexOf("request.url");
  const generated = view.generatedOffset(position);

  expect(view.source.slice(generated, generated + "request.url".length)).toBe("request.url");
  expect(view.mapOffset(generated)).toBe(position);
});

test("explicit tag type arguments are not rewritten as route patterns", () => {
  const source =
    "import { route } from 'hesperia/routing'; type Tags = readonly ['news']; export default route<Tags>({ tags: ['news'] });";
  const view = checkingView(source, "src/routes/+route.ts", false);

  expect(view.source).toBe(source);
  expect(checkingViewRouteLoadCapture(view)?.projections).toHaveLength(0);
});

test("page checking supports imported aliases and named query interfaces", async () => {
  const result = await checkProjectModules(
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

test("an explicitly required page binding remains required in compiled metadata", async () => {
  const filename = "src/routes/[id]/+page.tsx";
  const result = await compileProjectModules(
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

test("Page.Props supplies immutable route params and declared native query names", async () => {
  const source =
    'import type { Page as P } from "hesperia"; export default function UserPage(props: P.Props<{ queryParams: { page?: string; filter?: string }; ordinaryProp?: string }>) { const id: string = props.params.id; const page: string | null = props.queryParams().get("page"); const all: string[] = props.queryParams().getAll("filter"); const present: boolean = props.queryParams().has("page"); const ordinary: string | undefined = props.ordinaryProp(); return <span>{id}{page}{all}{present}{ordinary}</span>; }';

  expect(
    (await checkProjectModules([{ filename: "src/routes/[id]/+page.tsx", source }], { root }))
      .diagnostics,
  ).toStrictEqual([]);
});

test("a page declaration named Page still receives the inferred route params", async () => {
  const source =
    'import type { Page } from "hesperia"; export default function Page(props: Page.Props) { const id: string = props.params.id; props.params.missing; return <span>{id}</span>; }';
  const result = await checkProjectModules(
    [{ filename: "src/routes/users/[id]/+page.tsx", source }],
    {
      root,
    },
  );

  expect(result.diagnostics.filter((item) => item.code === "TS2339")).toHaveLength(1);

  expect(result.diagnostics.find((item) => item.code === "TS2339")?.message).toContain("missing");
});

test("Page.Props rejects unknown route and query names", async () => {
  const source =
    'import type { Page } from "hesperia"; export default function UserPage(props: Page.Props<{ queryParams: { page?: string } }>) { props.params.missing; props.queryParams().get("filter"); return <span />; }';
  const result = await checkProjectModules([{ filename: "src/routes/[id]/+page.tsx", source }], {
    root,
  });

  expect(result.diagnostics.filter((item) => item.code === "TS2339")).toHaveLength(1);

  expect(result.diagnostics.filter((item) => item.code === "TS2345")).toHaveLength(1);
});

test("Page.Props rejects non-string query declarations", async () => {
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
  const result = await checkProjectModules([...modules, ...declarations], { root });

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

test("generated optional parameters and catch-all arrays are checked through current root declarations", async () => {
  const required = "src/routes/files/[...path]/+page.tsx";
  const optional = "src/routes/docs/[[lang]]/[[...tail]]/+page.tsx";
  const result = await checkProjectModules(
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

  const invalid = await checkProjectModules(
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

test("page prop metadata keeps params and query views plain while ordinary props retain Component.Props", async () => {
  const source =
    'import type { Page } from "hesperia"; export default function UserPage(props: Page.Props<{ queryParams: { page?: string }; ordinaryProp?: string }>) { return <span>{props.params.id}{props.queryParams().get("page")}{props.ordinaryProp()}</span>; }';
  const result = await compileProjectModules([{ filename: "src/routes/[id]/+page.tsx", source }], {
    root,
  });

  expect(result.checking.diagnostics).toStrictEqual([]);

  const code = result.modules.get("src/routes/[id]/+page.tsx")?.code ?? "";

  expect(code).toContain('params: {\n\t\tkind: "plain"');

  expect(code).toContain('queryParams: {\n\t\tkind: "plain"');

  expect(code).toContain('ordinaryProp: {\n\t\tkind: "value"');

  expect(code).toContain("optional: true");
});

test("Page.Props checks selected own and ancestor route loader values", async () => {
  const modules = [
    {
      filename: "src/routes/+route.ts",
      source:
        "import { route } from 'hesperia/routing'; export default route({ tags: ['root'], load: () => ({ root: 'root' as const }) });",
    },
    {
      filename: "src/routes/users/+route.ts",
      source:
        "import { route } from 'hesperia/routing'; export default route({ load: async ({ request }) => ({ count: 7 as const, missing: undefined, path: new URL(request.url).pathname }) });",
    },
    {
      filename: "src/routes/users/[id]/+route.ts",
      source:
        "import { route } from 'hesperia/routing'; export default route<'/users/[id]'>({ load: async ({ request }) => ({ item: 'own' as const, path: new URL(request.url).pathname }) });",
    },
    {
      filename: "src/routes/users/+layout.tsx",
      source:
        "import type { Page } from 'hesperia'; export default function UsersLayout(props: Page.Props) { const root: 'root' = props.routeData['/']().root; const count: 7 = props.routeData['/users']().count; return <section>{root}{count}</section>; }",
    },
    {
      filename: "src/routes/users/[id]/+page.tsx",
      source:
        "import type { Page } from 'hesperia'; export default function UserPage(props: Page.Props) { const root: 'root' = props.routeData['/']().root; const count: 7 = props.routeData['/users']().count; const missing: undefined = props.routeData['/users']().missing; const own: 'own' = props.routeData['/users/[id]']().item; return <span>{root}{count}{String(missing)}{own}</span>; }",
    },
  ];
  const result = await checkProjectModules(modules, { root });

  expect(result.diagnostics).toStrictEqual([]);
});

test("Page.Props retains an authored routeData prop when no route loader supplies one", async () => {
  const source =
    'import type { Page } from "hesperia"; export default function Example(props: Page.Props<{ queryParams: {}; routeData?: { label: string } }>) { const label: string | undefined = props.routeData()?.label; return <span>{label}</span>; }';
  const result = await compileProjectModules(
    [{ filename: "src/routes/example/+page.tsx", source }],
    { root },
  );

  expect(result.checking.diagnostics).toStrictEqual([]);
  expect(result.modules.get("src/routes/example/+page.tsx")?.code).toMatch(
    /routeData:\s*\{\s*kind: "value",\s*optional: true/,
  );
});

test("Page.Props rejects route data from sibling and terminal-response loaders", async () => {
  const modules = [
    {
      filename: "src/routes/users/[id]/+route.ts",
      source:
        "import { route } from 'hesperia/routing'; export default route({ load: () => ({ own: true as const }) });",
    },
    {
      filename: "src/routes/admin/+route.ts",
      source:
        "import { route } from 'hesperia/routing'; export default route({ load: () => ({ admin: true as const }) });",
    },
    {
      filename: "src/routes/users/[id]/+page.tsx",
      source:
        "import type { Page } from 'hesperia'; export default function User(props: Page.Props) { props.routeData['/admin'](); return <span />; }",
    },
    {
      filename: "src/routes/terminal/+route.ts",
      source:
        "import { route } from 'hesperia/routing'; export default route({ load: () => new Response() });",
    },
    {
      filename: "src/routes/terminal/+page.tsx",
      source:
        "import type { Page } from 'hesperia'; export default function Terminal(props: Page.Props) { props.routeData['/terminal'](); return <span />; }",
    },
  ];
  const result = await checkProjectModules(modules, { root });

  for (const item of [
    { filename: "src/routes/users/[id]/+page.tsx", expression: "props.routeData['/admin']" },
    { filename: "src/routes/terminal/+page.tsx", expression: "props.routeData['/terminal']" },
  ]) {
    const checked = result.modules.find((module) => module.filename.endsWith(item.filename));
    const source = modules.find((module) => module.filename === item.filename)!.source;
    const start = source.indexOf(item.expression);

    expect(start).toBeGreaterThanOrEqual(0);
    expect(
      checked?.diagnostics.some(
        (diagnostic) =>
          diagnostic.severity === "error" &&
          diagnostic.span !== undefined &&
          diagnostic.span.start < start + item.expression.length &&
          diagnostic.span.end > start,
      ),
    ).toBe(true);
  }
});
