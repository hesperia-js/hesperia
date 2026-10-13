import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compileProjectModules, ModuleResolver } from "@hesperia/compiler/tooling";
import { bundleCssRoots } from "../../packages/tooling/src/css-bundling.ts";
import { PluginPipeline } from "../../packages/tooling/src/plugin-pipeline.ts";
import { buildStyleTopology } from "../../packages/tooling/src/style-topology.ts";
import { linkFrameworkPackages, unlinkFrameworkPackages } from "./fixture-dependencies.ts";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await unlinkFrameworkPackages(root);

    await rm(root, { recursive: true, force: true });
  }
});

test("static preload sees conditional component CSS while direct owners stay separate", async () => {
  const root = await mkdtemp(join(tmpdir(), "hesperia-style-topology-"));

  roots.push(root);

  await linkFrameworkPackages(root);

  await mkdir(join(root, "src"));

  const app = join(root, "app.tsx");
  const reversed = join(root, "reversed.tsx");
  const card = join(root, "src", "Card.tsx");
  const badge = join(root, "src", "Badge.tsx");

  await writeFile(join(root, "src", "card.css"), ".card{color:red}");

  await writeFile(join(root, "src", "shared.css"), ".shared{color:green}");

  await writeFile(join(root, "src", "badge.css"), ".badge{color:blue}");

  const sources = new Map([
    [
      app,
      'import { Card } from "./src/Card.tsx"; import { Badge } from "./src/Badge.tsx"; export default function App() { return <div><Card/><Badge/></div>; }',
    ],
    [
      reversed,
      'import { Badge } from "./src/Badge.tsx"; import { Card } from "./src/Card.tsx"; export default function Reversed() { return <div><Badge/><Card/></div>; }',
    ],
    [card, 'import "./card.css"; import "./shared.css"; export function Card() { return <div/>; }'],
    [badge, 'import "./shared.css"; import "./badge.css"; export const Badge = () => <span/>;'],
  ]);
  const pipeline = new PluginPipeline();
  const prepared = await pipeline.prepareImports(sources, root);
  const transformed = await pipeline.transformSources(prepared.sources, root);
  const current = new Map([...transformed].map(([filename, value]) => [filename, value.current]));
  const resolution = new ModuleResolver(root, current, "production");
  const compilation = await compileProjectModules(
    [...current].map(([filename, source]) => ({ filename, source })),
    { root, resolution, styleIdentityRoot: root },
  );

  expect(
    compilation.checking.diagnostics.filter((item) => item.severity === "error"),
  ).toStrictEqual([]);

  const bundled = await bundleCssRoots(root, prepared.styles, [], pipeline);
  const topology = buildStyleTopology(
    root,
    transformed,
    compilation,
    resolution,
    prepared.styles,
    [],
    bundled.roots,
    (_, offset) => offset,
  );

  const id = (name: string) => `css:src/${name}`;

  expect(topology.entries.find((item) => item.entryId === "app.tsx")?.closure).toStrictEqual([
    id("card.css"),
    id("shared.css"),
    id("badge.css"),
  ]);

  expect(topology.entries.find((item) => item.entryId === "reversed.tsx")?.closure).toStrictEqual([
    id("shared.css"),
    id("badge.css"),
    id("card.css"),
  ]);

  expect(
    topology.owners.find((item) => item.ownerId.startsWith("src/Card.tsx#"))?.styles,
  ).toStrictEqual([id("card.css"), id("shared.css")]);

  expect(
    topology.owners.find((item) => item.ownerId.startsWith("src/Badge.tsx#"))?.styles,
  ).toStrictEqual([id("shared.css"), id("badge.css")]);

  expect(topology.owners.find((item) => item.ownerId.startsWith("app.tsx#"))?.styles).toStrictEqual(
    [],
  );
});

test("case-distinct CSS roots survive on Linux while repeated references dedupe", async () => {
  const root = await mkdtemp(join(tmpdir(), "hesperia-style-topology-"));

  roots.push(root);

  await linkFrameworkPackages(root);

  const app = join(root, "app.tsx");
  const upper = join(root, "Theme.css");
  const lower = join(root, "theme.css");

  await writeFile(upper, ".upper{color:red}");

  if (process.platform !== "win32") await writeFile(lower, ".lower{color:blue}");

  const distinctImport = process.platform === "win32" ? "" : 'import "./theme.css"; ';
  const authored = `import "./Theme.css"; ${distinctImport}import "./Theme.css"; export default function App() { return <div/>; }`;
  const pipeline = new PluginPipeline();
  const prepared = await pipeline.prepareImports(new Map([[app, authored]]), root);
  const transformed = await pipeline.transformSources(prepared.sources, root);
  const current = new Map([...transformed].map(([filename, value]) => [filename, value.current]));
  const resolution = new ModuleResolver(root, current, "production");
  const compilation = await compileProjectModules(
    [...current].map(([filename, source]) => ({ filename, source })),
    { root, resolution, styleIdentityRoot: root },
  );

  expect(
    compilation.checking.diagnostics.filter((item) => item.severity === "error"),
  ).toStrictEqual([]);

  const bundled = await bundleCssRoots(root, prepared.styles, [], pipeline);
  const topology = buildStyleTopology(
    root,
    transformed,
    compilation,
    resolution,
    prepared.styles,
    [],
    bundled.roots,
    (_, offset) => offset,
  );
  const expected =
    process.platform === "win32" ? ["css:Theme.css"] : ["css:Theme.css", "css:theme.css"];

  expect(bundled.roots.map((item) => item.id)).toStrictEqual(expected);

  expect(topology.entries.find((item) => item.entryId === "app.tsx")?.closure).toStrictEqual(
    expected,
  );

  expect(topology.owners.find((item) => item.ownerId.startsWith("app.tsx#"))?.styles).toStrictEqual(
    expected,
  );
});

test("generated CSS enters its owning module closure even when provenance is elsewhere", async () => {
  const root = await mkdtemp(join(tmpdir(), "hesperia-style-topology-"));

  roots.push(root);

  await linkFrameworkPackages(root);

  await mkdir(join(root, "src"));

  const app = join(root, "app.tsx");
  const card = join(root, "src", "Card.tsx");
  const origin = join(root, "theme.config.ts");
  const sources = new Map([
    [
      app,
      'import { Card } from "./src/Card.tsx"; export default function App() { return <div><Card/></div>; }',
    ],
    [card, 'export function Card() { return <div class="card"/>; }'],
  ]);
  const pipeline = new PluginPipeline();
  const prepared = await pipeline.prepareImports(sources, root);
  const transformed = await pipeline.transformSources(prepared.sources, root);
  const current = new Map([...transformed].map(([filename, value]) => [filename, value.current]));
  const resolution = new ModuleResolver(root, current, "production");
  const compilation = await compileProjectModules(
    [...current].map(([filename, source]) => ({ filename, source })),
    { root, resolution, styleIdentityRoot: root },
  );

  expect(
    compilation.checking.diagnostics.filter((item) => item.severity === "error"),
  ).toStrictEqual([]);

  const styles = [
    {
      id: "generated-card",
      owner: { kind: "component" as const, id: `${card}#Card` },
      css: ".card { color: purple }",
      origin: { filename: origin, start: 0, end: 1 },
    },
  ];
  const bundled = await bundleCssRoots(root, [], styles, pipeline);
  const topology = buildStyleTopology(
    root,
    transformed,
    compilation,
    resolution,
    [],
    styles,
    bundled.roots,
    (_, offset) => offset,
  );

  expect(topology.entries.find((item) => item.entryId === "src/Card.tsx")?.closure).toStrictEqual([
    "generated:generated-card",
  ]);

  expect(topology.entries.find((item) => item.entryId === "app.tsx")?.closure).toStrictEqual([
    "generated:generated-card",
  ]);

  expect(
    topology.owners.find((item) => item.ownerId.startsWith("src/Card.tsx#"))?.styles,
  ).toStrictEqual(["generated:generated-card"]);
});
