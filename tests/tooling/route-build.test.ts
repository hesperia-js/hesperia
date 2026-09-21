import { afterEach, expect, test } from "bun:test";
import { originalPositionFor, TraceMap, type SourceMapInput } from "@jridgewell/trace-mapping";
import { buildRouteGuards, routeFilesFromManifest } from "../../src/tooling/route-build.ts";
import { scanRouteFiles } from "../../src/routing/scanner.ts";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const fixtureRoots: string[] = [];

afterEach(async () => {
  for (const root of fixtureRoots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function routeFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "hesperia-route-build-"));
  fixtureRoots.push(root);
  const packageRoot = join(root, "node_modules/hesperia");
  await mkdir(packageRoot, { recursive: true });
  await writeFile(
    join(packageRoot, "package.json"),
    JSON.stringify({
      name: "hesperia",
      exports: {
        "./routing": {
          browser: "./routing.js",
          import: "./routing.js",
          default: "./routing.js",
        },
      },
    }),
  );
  await writeFile(
    join(packageRoot, "routing.js"),
    "export const route = value => value; export const redirect = path => ({ redirect: path });\n",
  );
  return root;
}

test("flattens scanner-selected route files without evaluating route modules", () => {
  const manifest = scanRouteFiles("/project/src/routes", [
    "/project/src/routes/+route.ts",
    "/project/src/routes/admin/+route.ts",
    "/project/src/routes/admin/+page.tsx",
  ]);
  expect(routeFilesFromManifest(manifest)).toStrictEqual([
    resolve("/project/src/routes/+route.ts"),
    resolve("/project/src/routes/admin/+route.ts"),
  ]);
});

test("bundles isolated route guard graphs with distinct shared-helper selections", async () => {
  const root = await routeFixture();
  const routeA = `import { route } from "hesperia/routing";
import { guard } from "../../shared.ts";
const serverA = "SERVER_A";
export default route({ guard, load: () => serverA });
`;
  const routeB = `import { route } from "hesperia/routing";
import { otherGuard } from "../../shared.ts";
const serverB = "SERVER_B";
export default route({ guard: otherGuard, load: () => serverB });
`;
  const routeC = `import { route } from "hesperia/routing";
import { redirectGuard } from "../../shared.ts";
export default route({ guard: redirectGuard });
`;
  const shared = `import { redirect } from "hesperia/routing";
export const guard = ({ params }: { params: { id: string } }) => params.id === "a";
export const otherGuard = ({ params }: { params: { id: string } }) => params.id === "b";
export const redirectGuard = () => redirect("/login");
export const unrelated = () => "SERVER_SHARED";
`;
  const result = await buildRouteGuards(
    {
      modules: [
        { filename: join(root, "src/routes/a/+route.ts"), source: routeA },
        { filename: join(root, "src/routes/b/+route.ts"), source: routeB },
        { filename: join(root, "src/routes/c/+route.ts"), source: routeC },
        { filename: join(root, "src/shared.ts"), source: shared },
      ],
      routeFiles: [
        join(root, "src/routes/a/+route.ts"),
        join(root, "src/routes/b/+route.ts"),
        join(root, "src/routes/c/+route.ts"),
      ],
    },
    { root },
  );
  expect(result.diagnostics).toStrictEqual([]);
  expect(result.guards).toHaveLength(3);
  expect(result.guards.every((guard) => guard.outputUrl.startsWith("/assets/routes/guard-"))).toBe(
    true,
  );
  expect(
    result.guards.every((guard) =>
      guard.code.includes(`//# sourceMappingURL=${guard.outputUrl}.map`),
    ),
  ).toBe(true);
  expect(result.guards[0]!.outputUrl).not.toBe(result.guards[1]!.outputUrl);
  expect(result.guards.every((guard) => !guard.code.includes("SERVER_"))).toBe(true);
  expect(result.guards.every((guard) => !JSON.stringify(guard.map).includes("SERVER_"))).toBe(true);
  expect(result.guards.every((guard) => guard.map.sourcesContent === undefined)).toBe(true);

  const modules = result.guards.map((guard) => importBundle(guard.code));
  expect((await modules[0]!)({ params: { id: "a" } })).toBe(true);
  expect((await modules[0]!)({ params: { id: "b" } })).toBe(false);
  expect((await modules[1]!)({ params: { id: "b" } })).toBe(true);
  expect((await modules[1]!)({ params: { id: "a" } })).toBe(false);
  expect((await modules[2]!)({ params: { id: "a" } })).toStrictEqual({ redirect: "/login" });
});

test("published route bundle maps trace through Bun output to authored helper source", async () => {
  const route = `import { route } from "hesperia/routing";\r\nimport { guard } from "../shared.ts";\r\nconst excluded = "SERVER_ROUTE";\r\nexport default route({ guard, load: () => excluded });\r\n`;
  const shared = `type Context = { params: { id: string } };\r\nconst cat = "🐈";\r\nexport const guard = ({ params }: Context) => params.id === cat;\r\n`;
  const result = await buildRouteGuards(
    {
      modules: [
        { filename: "/project/src/routes/+route.ts", source: route },
        { filename: "/project/src/shared.ts", source: shared },
      ],
      routeFiles: ["/project/src/routes/+route.ts"],
    },
    { root: process.cwd() },
  );
  expect(result.diagnostics).toStrictEqual([]);
  const guard = result.guards[0]!;
  expect(guard.code).not.toContain("SERVER_ROUTE");
  expect(JSON.stringify(guard.map)).not.toContain("SERVER_ROUTE");
  const marker = guard.code.indexOf("params.id");
  const original = originalPositionFor(
    new TraceMap(guard.map as SourceMapInput),
    position(guard.code, marker),
  );
  expect(original.source).toBe("/project/src/shared.ts");
  expect({ line: original.line, column: original.column }).toStrictEqual(
    position(shared, shared.indexOf("params.id")),
  );
});

test("reports a real guard bundling failure with its route filename and no partial guards", async () => {
  const route = `import { route } from "hesperia/routing";
const guard = () => true;
export default route({ guard });
`;
  const result = await buildRouteGuards(
    {
      modules: [{ filename: "/project/src/routes/+route.ts", source: route }],
      routeFiles: ["/project/src/routes/+route.ts"],
    },
    {
      root: process.cwd(),
      runtimeModule: "hesperia/package-that-does-not-exist",
    },
  );
  expect(result.guards).toStrictEqual([]);
  expect(result.diagnostics).toContainEqual(
    expect.objectContaining({
      code: "HES-ROUTE-BUILD",
      severity: "error",
      filename: "/project/src/routes/+route.ts",
      message: expect.stringContaining("Could not bundle route guard"),
    }),
  );
});

async function importBundle(code: string): Promise<(value: unknown) => unknown> {
  const encoded = Buffer.from(code).toString("base64");
  const module = await import(`data:text/javascript;base64,${encoded}`);
  return module.default as (value: unknown) => unknown;
}

function position(source: string, offset: number): { line: number; column: number } {
  const prefix = source.slice(0, offset);
  return { line: prefix.split("\n").length, column: offset - prefix.lastIndexOf("\n") - 1 };
}
