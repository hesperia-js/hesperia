import { afterEach, expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareBuild } from "../../packages/tooling/src/project.ts";
import { linkFrameworkPackages, unlinkFrameworkPackages } from "./fixture-dependencies.ts";

const roots: string[] = [];

const dependencyCases = [
  { name: "no dependency", clause: "", runtime: false },
  {
    name: "whole type import",
    clause: 'import type { Marker } from "./src/helper.ts";',
    runtime: false,
  },
  {
    name: "whole type export",
    clause: 'export type { Marker } from "./src/helper.ts";',
    runtime: false,
  },
  { name: "value import", clause: 'import { marker } from "./src/helper.ts";', runtime: true },
  { name: "side-effect import", clause: 'import "./src/helper.ts";', runtime: true },
  { name: "empty import", clause: 'import {} from "./src/helper.ts";', runtime: true },
  {
    name: "type specifier with retained import",
    clause: 'import { type Marker } from "./src/helper.ts";',
    runtime: true,
  },
];

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await unlinkFrameworkPackages(root);

    await rm(root, { recursive: true, force: true });
  }
});

test.each(dependencyCases)("built CSS ownership follows $name runtime semantics", async (entry) => {
  const root = await mkdtemp(join(tmpdir(), "hesperia-type-only-css-"));

  roots.push(root);

  await cp(join(import.meta.dir, "fixtures/applications/type-only-css"), root, {
    recursive: true,
  });

  await linkFrameworkPackages(root);

  const filename = join(root, "app.tsx");
  const authored = await readFile(filename, "utf8");

  await writeFile(filename, authored.replace("// dependency", entry.clause));

  const built = await prepareBuild(root, true);
  const plan = built.styleRevision!.plan;
  const expected = entry.runtime
    ? ["css:before.css", "css:src/dormant.css", "css:after.css"]
    : ["css:before.css", "css:after.css"];

  expect(built.diagnostics).toStrictEqual([]);

  expect(plan.assets.some((asset) => asset.id === "css:src/dormant.css")).toBe(true);

  expect(plan.entries.find((item) => item.entryId === "app.tsx")?.closure).toStrictEqual(expected);

  expect(plan.owners.find((item) => item.ownerId.startsWith("app.tsx#"))?.styles).toStrictEqual(
    expected,
  );

  expect(
    plan.compositions.find((item) => item.entries.includes("src/routes/+page.tsx"))?.styles,
  ).toStrictEqual(expected);
});

test("built page and not-found modes share shell and layout CSS but select distinct views", async () => {
  const root = await mkdtemp(join(tmpdir(), "hesperia-route-style-"));

  roots.push(root);

  await linkFrameworkPackages(root);

  await mkdir(join(root, "src", "routes"), { recursive: true });

  const files = new Map([
    [
      "app.tsx",
      'import "./shell.css"; export default function App(props: { children: () => unknown }) { return <html><head></head><body>{props.children()}</body></html>; }',
    ],
    ["shell.css", ".shell{color:black}"],
    [
      "src/routes/+layout.tsx",
      'import "./layout.css"; export default function Layout(props: { children: () => unknown }) { return <section>{props.children()}</section>; }',
    ],
    ["src/routes/layout.css", ".layout{color:green}"],
    [
      "src/routes/+page.tsx",
      'import "./page.css"; export default function Page() { return <h1>Page</h1>; }',
    ],
    ["src/routes/page.css", ".page{color:blue}"],
    [
      "src/routes/+not-found.tsx",
      'import "./not-found.css"; export default function NotFound() { return <h1>Missing</h1>; }',
    ],
    ["src/routes/not-found.css", ".missing{color:purple}"],
    [
      "src/routes/+error.tsx",
      'import "./error.css"; export default function ErrorPage() { return <h1>Error</h1>; }',
    ],
    ["src/routes/error.css", ".error{color:red}"],
  ]);

  for (const [name, source] of files) await writeFile(join(root, name), source);

  const built = await prepareBuild(root, true);
  const plan = built.styleRevision?.plan;

  expect(plan).toBeDefined();

  expect(plan!.compositions).toHaveLength(6);

  const byRole = (file: string) =>
    plan!.compositions.find((item) => item.entries.includes(`src/routes/${file}`))!;

  expect(byRole("+page.tsx").styles).toStrictEqual([
    "css:shell.css",
    "css:src/routes/layout.css",
    "css:src/routes/page.css",
  ]);

  expect(byRole("+not-found.tsx").styles).toStrictEqual([
    "css:shell.css",
    "css:src/routes/layout.css",
    "css:src/routes/not-found.css",
  ]);

  expect(
    plan!.compositions.filter((item) => item.entries.length === 2).map((item) => item.styles),
  ).toEqual(
    expect.arrayContaining([
      ["css:shell.css", "css:src/routes/layout.css"],
      ["css:shell.css", "css:src/routes/error.css"],
    ]),
  );

  const scripts = (
    await Promise.all(
      [...built.files].filter(([path]) => path.endsWith(".js")).map(([, blob]) => blob.text()),
    )
  ).join("\n");

  expect(scripts).toContain("viewStyles");

  expect(scripts).toContain("notFound");

  expect(scripts).toContain(byRole("+page.tsx").compositionId);

  expect(scripts).toContain(byRole("+not-found.tsx").compositionId);
});

test("a no-config application emits empty finite route compositions and a shared style plan", async () => {
  const root = await mkdtemp(join(tmpdir(), "hesperia-route-style-empty-"));

  roots.push(root);

  await linkFrameworkPackages(root);

  await mkdir(join(root, "src", "routes"), { recursive: true });

  await writeFile(
    join(root, "app.tsx"),
    "export default function App(props: { children: () => unknown }) { return <html><head></head><body>{props.children()}</body></html>; }",
  );

  await writeFile(
    join(root, "src", "routes", "+page.tsx"),
    "export default function Page() { return <h1>Page</h1>; }",
  );

  await writeFile(
    join(root, "src", "routes", "+not-found.tsx"),
    "export default function Missing() { return <h1>Missing</h1>; }",
  );

  const built = await prepareBuild(root, true);
  const plan = built.styleRevision?.plan;

  expect(plan).toBeDefined();

  expect(plan!.assets).toEqual([]);

  expect(plan!.entries).toEqual(
    expect.arrayContaining([
      { entryId: "app.tsx", closure: [] },
      { entryId: "src/routes/+page.tsx", closure: [] },
      { entryId: "src/routes/+not-found.tsx", closure: [] },
    ]),
  );

  expect(plan!.compositions).toHaveLength(4);

  expect(plan!.compositions.every((item) => item.styles.length === 0)).toBe(true);

  expect(plan!.compositions.map((item) => item.entries)).toEqual(
    expect.arrayContaining([
      ["app.tsx", "src/routes/+page.tsx"],
      ["app.tsx", "src/routes/+not-found.tsx"],
      ["app.tsx"],
    ]),
  );

  const scripts = (
    await Promise.all(
      [...built.files].filter(([path]) => path.endsWith(".js")).map(([, blob]) => blob.text()),
    )
  ).join("\n");

  expect(scripts).toContain("viewStyles");

  expect(scripts).toContain("createInternalStyleRuntime");
});

test("a CSS-free shell shares the plan with a styled page without preloading the shell", async () => {
  const root = await mkdtemp(join(tmpdir(), "hesperia-route-style-shell-"));

  roots.push(root);

  await linkFrameworkPackages(root);

  await mkdir(join(root, "src", "routes"), { recursive: true });

  await writeFile(
    join(root, "app.tsx"),
    "export default function App(props: { children: () => unknown }) { return <html><head></head><body>{props.children()}</body></html>; }",
  );

  await writeFile(
    join(root, "src", "routes", "+page.tsx"),
    'import "./page.css"; export default function Page() { return <h1>Page</h1>; }',
  );

  await writeFile(join(root, "src", "routes", "page.css"), ".page{color:blue}");

  const built = await prepareBuild(root, true);
  const plan = built.styleRevision!.plan;

  expect(plan.entries.find((item) => item.entryId === "app.tsx")?.closure).toEqual([]);

  expect(plan.entries.find((item) => item.entryId === "src/routes/+page.tsx")?.closure).toEqual([
    "css:src/routes/page.css",
  ]);

  expect(
    plan.compositions.find((item) => item.entries.includes("src/routes/+page.tsx"))?.styles,
  ).toEqual(["css:src/routes/page.css"]);
});
