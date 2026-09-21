import { expect, test } from "bun:test";
import { originalPositionFor, TraceMap, type SourceMapInput } from "@jridgewell/trace-mapping";
import { analyzeRouteModule } from "../../src/compiler/route-analysis.ts";
import { emitRouteGuardArtifact } from "../../src/compiler/route-emission.ts";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

test("emits a named/default/transitive guard graph that executes without server declarations", async () => {
  const route = `import { route } from "hesperia/routing";
import guard from "../guards.ts";
const serverOnly = (() => { throw new Error("server route executed"); })();
export default route({ guard, load: async () => ({ serverOnly }) });
`;
  const guards = `import { allowed } from "./policy.ts";
const guard = ({ params }: { params: { id: string } }) => allowed(params.id);
export const unrelated = () => { throw new Error("unrelated guard code executed"); };
export default guard;
`;
  const policy = `type Context = { id: string };
export const allowed = (id: string) => id === "ok";
`;
  const result = analyzeRouteModule(route, {
    filename: "src/routes/+route.ts",
    modules: [
      { filename: "src/routes/+route.ts", source: route },
      { filename: "src/guards.ts", source: guards },
      { filename: "src/policy.ts", source: policy },
    ],
  });
  expect(result.diagnostics).toStrictEqual([]);
  const artifact = result.artifact;
  expect(artifact).toBeDefined();

  const emitted = emitRouteGuardArtifact(artifact!, { runtimeModule: "../../runtime-stub.mjs" });
  expect(emitted.entryFilename).toBe("src/routes/+route.ts");
  expect(emitted.modules.map((item) => item.filename)).toStrictEqual([
    "src/guards.ts",
    "src/policy.ts",
    "src/routes/+route.ts",
  ]);
  const guardsOutput = emitted.modules.find((item) => item.filename === "src/guards.ts")!;
  expect(guardsOutput.imports).toStrictEqual([
    { source: "./policy.ts", resolvedFilename: "src/policy.ts" },
  ]);
  const routeOutput = emitted.modules.find((item) => item.filename === "src/routes/+route.ts")!;
  expect(routeOutput.imports).toStrictEqual([
    { source: "../guards.ts", resolvedFilename: "src/guards.ts" },
  ]);
  expect(emitted.modules.every((item) => !item.code.includes("server route executed"))).toBe(true);
  expect(
    emitted.modules.every((item) => !item.code.includes("unrelated guard code executed")),
  ).toBe(true);

  const temporary = await mkdtemp(join(resolve(import.meta.dir), "route-emission-"));
  try {
    await writeFile(join(temporary, "runtime-stub.mjs"), "export {};", "utf8");
    for (const item of emitted.modules) await Bun.write(join(temporary, item.filename), item.code);
    const module = await import(
      `${pathToFileURL(join(temporary, "src/routes/+route.ts")).href}?emission-test=${Date.now()}`
    );
    expect(module.default({ params: { id: "ok" } })).toBe(true);
    expect(module.default({ params: { id: "blocked" } })).toBe(false);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("composes route maps to authored typed source without publishing excluded source content", () => {
  const route = `import { route } from "hesperia/routing";\r\nimport guard from "../guards.ts";\r\nconst serverMarker = "ROUTE_SERVER_ONLY";\r\nexport default route({ guard, load: async () => serverMarker });\r\n`;
  const guards = `type Context = { params: { id: string } };\r\nconst marker = "🐈";\r\nconst guard = ({ params }: Context) => params.id === marker;\r\nexport default guard;\r\n`;
  const result = analyzeRouteModule(route, {
    filename: "src/routes/+route.ts",
    modules: [
      { filename: "src/routes/+route.ts", source: route },
      { filename: "src/guards.ts", source: guards },
    ],
  });
  expect(result.diagnostics).toStrictEqual([]);
  const emitted = emitRouteGuardArtifact(result.artifact!, { runtimeModule: "hesperia/runtime" });
  const guard = emitted.modules.find((item) => item.filename === "src/guards.ts")!;
  expect(emitted.modules.every((item) => !item.code.includes("ROUTE_SERVER_ONLY"))).toBe(true);
  expect(
    emitted.modules.every((item) => !JSON.stringify(item.map).includes("ROUTE_SERVER_ONLY")),
  ).toBe(true);
  expect(emitted.modules.every((item) => item.map?.sourcesContent === undefined)).toBe(true);

  const generatedOffset = guard.code.indexOf("params.id");
  expect(generatedOffset).toBeGreaterThanOrEqual(0);
  const original = originalPositionFor(
    new TraceMap(guard.map as SourceMapInput),
    position(guard.code, generatedOffset),
  );
  expect(original.source).toBe("src/guards.ts");
  expect({ line: original.line, column: original.column }).toStrictEqual(
    position(guards, guards.indexOf("params.id")),
  );
});

function position(source: string, offset: number): { line: number; column: number } {
  const prefix = source.slice(0, offset);
  return { line: prefix.split("\n").length, column: offset - prefix.lastIndexOf("\n") - 1 };
}
