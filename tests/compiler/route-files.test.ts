import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { checkProjectModules } from "../../src/compiler/index.ts";
import { EditorProject } from "../../src/editor/project.ts";

const root = resolve(import.meta.dir, "../..");
const page = "export default function Page() { return <main>page</main>; }";

test("shared checking reports ambiguous routes on both authored pages", () => {
  const filenames = [
    "src/routes/(first)/+page.tsx",
    "src/routes/(second)/+page.tsx",
    "src/routes/_draft/+page.tsx",
    "src/helpers/+page.tsx",
  ];
  const result = checkProjectModules(
    filenames.map((filename) => ({ filename, source: page })),
    { root },
  );
  expect(
    result.modules
      .filter((module) => module.diagnostics.some((item) => item.code === "HES-ROUTE-SCAN"))
      .map((module) => module.filename),
  ).toStrictEqual(filenames.slice(0, 2));
  expect(result.diagnostics.every((item) => item.code === "HES-ROUTE-SCAN")).toBe(true);
  expect(result.diagnostics).toHaveLength(2);
  expect(result.diagnostics[0]!.message).toContain("Ambiguous route patterns");
});

test("invalid route directories report the conventional files beneath them", () => {
  const filename = "src/routes/[id]/[id]/+page.tsx";
  const result = checkProjectModules([{ filename, source: page }], { root });
  expect(result.modules[0]!.diagnostics).toEqual([
    expect.objectContaining({
      code: "HES-ROUTE-SCAN",
      severity: "error",
      message: expect.stringContaining("Repeated route parameter name"),
    }),
  ]);
});

test("an editor snapshot clears the route collision after the page moves to a distinct URL", () => {
  const first = { filename: "src/routes/(first)/+page.tsx", source: page };
  const before = new EditorProject(
    [first, { filename: "src/routes/(second)/+page.tsx", source: page }],
    { root },
  );
  try {
    expect(
      before.diagnostics.diagnostics.filter((item) => item.code === "HES-ROUTE-SCAN"),
    ).toHaveLength(2);
  } finally {
    before.dispose();
  }
  const after = new EditorProject(
    [first, { filename: "src/routes/second/+page.tsx", source: page }],
    { root },
  );
  try {
    expect(after.diagnostics.diagnostics).toStrictEqual([]);
  } finally {
    after.dispose();
  }
});

test("route guard checking follows the project snapshot and reports the authored helper", () => {
  const filename = "src/routes/+route.ts";
  const helper = "src/guard.ts";
  const source = 'export const guard = () => process.env.ALLOWED === "yes";';
  const result = checkProjectModules(
    [
      {
        filename,
        source:
          'import { route } from "hesperia/routing"; import { guard } from "../guard.ts"; export default route({ guard });',
      },
      { filename: helper, source },
    ],
    { root },
  );
  expect(
    result.modules
      .find((module) => module.filename === filename)
      ?.diagnostics.filter((item) => item.code.startsWith("HES-ROUTE")),
  ).toStrictEqual([]);
  expect(result.modules.find((module) => module.filename === helper)?.diagnostics).toContainEqual(
    expect.objectContaining({
      code: "HES-ROUTE-CAPABILITY",
      span: { start: source.indexOf("process"), end: source.indexOf("process") + "process".length },
    }),
  );
});

test("editor snapshots reject inline route guards and accept the extracted identifier form", () => {
  const filename = "src/routes/+route.ts";
  const sources = [
    'import { route } from "hesperia/routing"; export default route({ guard: () => true });',
    'import { route } from "hesperia/routing"; const guard = () => true; export default route({ guard });',
  ];
  for (const [index, source] of sources.entries()) {
    const project = new EditorProject([{ filename, source }], { root });
    try {
      expect(
        project.diagnostics.diagnostics.filter((item) => item.code === "HES-ROUTE-GUARD"),
      ).toHaveLength(index === 0 ? 1 : 0);
      if (index === 0) {
        const diagnostic = project.diagnostics.diagnostics.find(
          (item) => item.code === "HES-ROUTE-GUARD",
        )!;
        expect(source.slice(diagnostic.span!.start, diagnostic.span!.end)).toBe("() => true");
      }
      if (index === 1) expect(project.diagnostics.diagnostics).toStrictEqual([]);
    } finally {
      project.dispose();
    }
  }
});
