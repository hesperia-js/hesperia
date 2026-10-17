import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareBuild, ProjectError } from "../../packages/tooling/src/project.ts";
import { linkFrameworkPackages, unlinkFrameworkPackages } from "./fixture-dependencies.ts";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await unlinkFrameworkPackages(root);

    await rm(root, { recursive: true, force: true });
  }
});

test("explicit CSS interpretation builds a non-css file and reports its nested failure at the import", async () => {
  const root = await mkdtemp(join(tmpdir(), "hesperia-explicit-css-"));

  roots.push(root);

  await linkFrameworkPackages(root);

  await mkdir(join(root, "src"));

  const card = join(root, "src", "Card.tsx");
  const style = join(root, "src", "Card.theme");
  const source =
    'import "./Card.theme" with { type: "css" }; export function Card() { return <div class="card">Card</div>; }';

  await writeFile(style, ".card { color: red }");

  await writeFile(card, source);

  await writeFile(
    join(root, "app.tsx"),
    'import { Card } from "./src/Card.tsx"; export default function App() { return <html><head></head><body><Card/></body></html>; }',
  );

  const built = await prepareBuild(root);
  const development = await prepareBuild(root, true);
  const css = [...built.files].filter(([path]) => path.endsWith(".css"));

  expect(css).toHaveLength(1);

  expect(await css[0]![1].text()).toContain(".card{color:red}");

  const scripts = (
    await Promise.all(
      [...built.files].filter(([path]) => path.endsWith(".js")).map(([, blob]) => blob.text()),
    )
  ).join("\n");

  expect(scripts).toContain("css:src/Card.theme");

  await writeFile(style, ".card { color: blue }");

  const cssUpdate = await prepareBuild(root, true);

  expect(cssUpdate.styleRevision?.semanticKey).toBe(development.styleRevision?.semanticKey);

  expect(cssUpdate.styleRevision?.plan.assets[0]?.revision).not.toBe(
    development.styleRevision?.plan.assets[0]?.revision,
  );

  await writeFile(style, '@import "./missing.css";');

  const error = await prepareBuild(root).catch((value: unknown) => value);

  expect(error).toBeInstanceOf(ProjectError);

  expect((error as ProjectError).diagnostics).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        code: "HES-CSS",
        filename: card,
        span: { start: 0, end: source.indexOf("; ") + 1 },
        message: expect.stringContaining("missing.css"),
      }),
    ]),
  );
});

test("a no-config application emits a shared CSS plan and bundled component stylesheet", async () => {
  const root = await mkdtemp(join(tmpdir(), "hesperia-direct-css-"));

  roots.push(root);

  await linkFrameworkPackages(root);

  await mkdir(join(root, "src"));

  await writeFile(join(root, "src", "Card.css"), ".card { color: red; }");

  await writeFile(
    join(root, "src", "Card.tsx"),
    'import "./Card.css"; export function Card() { return <div class="card">Card</div>; }',
  );

  await writeFile(
    join(root, "app.tsx"),
    'import { Card } from "./src/Card.tsx"; export default function App() { return <html><head></head><body><Card/></body></html>; }',
  );

  const built = await prepareBuild(root).catch((error: unknown) => {
    if (error instanceof Error && "diagnostics" in error)
      throw new Error(JSON.stringify(error.diagnostics));

    throw error;
  });
  const css = [...built.files].filter(([path]) => path.endsWith(".css"));

  expect(css.length).toBe(1);

  expect(css[0]![0]).toMatch(/^\/assets\/Card-[^/]+\.css$/);

  expect(await css[0]![1].text()).toContain(".card{color:red}");

  const scripts = (
    await Promise.all(
      [...built.files].filter(([path]) => path.endsWith(".js")).map(([, blob]) => blob.text()),
    )
  ).join("\n");

  expect(scripts).toContain("createInternalStyleRuntime");

  expect(scripts).toContain("new URL(");

  expect(scripts).toContain("css:src/Card.css");

  expect(scripts).toContain("src/Card.tsx#");

  expect(scripts).not.toContain(`id: "css:${root.replaceAll("\\", "/")}`);

  expect(scripts).not.toContain(`entryId: "${root.replaceAll("\\", "/")}`);

  expect(scripts).not.toContain(`ownerId: "${root.replaceAll("\\", "/")}`);

  const development = await prepareBuild(root, true);

  expect(development.styleRevision?.plan.assets).toHaveLength(1);

  expect(development.styleRevision?.plan.assets[0]?.path).toMatch(/^\.\/Card-[^/]+\.css$/);

  const developmentScripts = (
    await Promise.all(
      [...development.files]
        .filter(([path]) => path.endsWith(".js"))
        .map(([, blob]) => blob.text()),
    )
  ).join("\n");

  expect(developmentScripts).toContain("hesperia:style-revision");

  await writeFile(join(root, "src", "Card.css"), ".card { color: blue; }");

  const cssUpdate = await prepareBuild(root, true);

  expect(cssUpdate.styleRevision?.semanticKey).toBe(development.styleRevision?.semanticKey);

  expect(cssUpdate.styleRevision?.plan.assets[0]?.revision).not.toBe(
    development.styleRevision?.plan.assets[0]?.revision,
  );

  await writeFile(
    join(root, "src", "Card.tsx"),
    'import "./Card.css"; export function Card() { return <div class="card">Changed</div>; }',
  );

  const executableUpdate = await prepareBuild(root, true);

  expect(executableUpdate.styleRevision?.semanticKey).not.toBe(
    cssUpdate.styleRevision?.semanticKey,
  );
});
