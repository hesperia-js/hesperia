import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { analyzeBrowserCapabilities, compile } from "../../src/compiler/index.ts";

test.each([
  "switch (process.env.KEY) { default: break; } export const value = 1;",
  "switch (1) { case process.env.KEY: break; } export const value = 1;",
  "let value; switch (1) { case 1: const callback = () => process.env.SECRET; value = callback; } export { value };",
  "export function value(...[input = process.env.SECRET]) { return input; }",
  "const [...[value = () => process.env.SECRET]] = []; export { value };",
  "const { safe, ...value } = { safe: 1, read: () => process.env.SECRET }; export { value };",
])("switch and rest bindings retain their host provenance: %s", (source) => {
  const diagnostics = analyzeBrowserCapabilities(
    [
      {
        filename: "app.tsx",
        source:
          'import { value } from "./api.ts"; export default function App() { return <html><head/><body>{value}</body></html>; }',
      },
      { filename: "api.ts", source },
    ],
    ".",
  );
  expect(diagnostics.map((item) => item.code)).toStrictEqual(["HES-CAPABILITY"]);
});

test("generated startup makes app.config.ts a browser entry even without a shell import", () => {
  const diagnostics = analyzeBrowserCapabilities(
    [
      {
        filename: "app.tsx",
        source: "export default function App() { return <html><head/><body/></html>; }",
      },
      {
        filename: "app.config.ts",
        source: "export default { pageCacheSize: Number(process.env.CACHE_SIZE) };",
      },
    ],
    ".",
  );
  expect(diagnostics.map((item) => item.code)).toStrictEqual(["HES-CAPABILITY"]);
  expect(diagnostics[0]!.filename).toBe("app.config.ts");
});

test("reachable generator yield operands retain host capability provenance", () => {
  const diagnostics = analyzeBrowserCapabilities([
    {
      filename: "app.tsx",
      source:
        'import { load } from "./route.ts"; export default function App() { load(); return <html><head/><body/></html>; }',
    },
    {
      filename: "route.ts",
      source: "export function* load() { yield globalThis.process.env.SECRET; }",
    },
  ]);
  expect(diagnostics).toEqual(
    expect.arrayContaining([expect.objectContaining({ code: "HES-CAPABILITY" })]),
  );
});

test("generated async component continuations cannot conceal a yielded host operation", () => {
  const compiled = compile(
    `export default async function Page() {
      const value = await globalThis.process.load();
      return <span>{value}</span>;
    }`,
    { filename: "async-page.tsx" },
  );
  expect(compiled.diagnostics).toStrictEqual([]);
  expect(compiled.code).toContain("yield globalThis.process.load()");
  const filename = resolve("generated-async-page.js");
  const diagnostics = analyzeBrowserCapabilities(
    [{ filename, source: compiled.code }],
    process.cwd(),
    undefined,
    [filename],
  );
  expect(diagnostics).toContainEqual(
    expect.objectContaining({
      filename,
      code: "HES-CAPABILITY",
      message: expect.stringContaining("process"),
    }),
  );
  expect(diagnostics.some((item) => item.code === "HES-CAPABILITY-UNRESOLVED")).toBe(false);
});

test("an unreferenced nested app.tsx file is not a browser entry by its basename", () => {
  const diagnostics = analyzeBrowserCapabilities(
    [
      {
        filename: "app.tsx",
        source: "export default function App() { return <html><head/><body/></html>; }",
      },
      {
        filename: "server/app.tsx",
        source: "export default function read() { return process.env.SECRET; }",
      },
    ],
    ".",
  );
  expect(diagnostics).toStrictEqual([]);
});

test.each([
  "var value = () => process.env.SECRET;",
  "for (var value of [() => process.env.SECRET]) {}",
  "for (var value in { allowed: true }) {}",
])("a catch-local var write does not taint its separate exported hoisted binding: %s", (body) => {
  const diagnostics = analyzeBrowserCapabilities(
    [
      {
        filename: "app.tsx",
        source:
          'import { value } from "./api.ts"; export default function App() { return <html><head/><body>{value}</body></html>; }',
      },
      {
        filename: "api.ts",
        source: `try {} catch (value) { ${body} } export { value };`,
      },
    ],
    ".",
  );
  expect(diagnostics).toStrictEqual([]);
});

test("a nested var iteration exposes its callable value through the function scope", () => {
  const diagnostics = analyzeBrowserCapabilities(
    [
      {
        filename: "app.tsx",
        source:
          'import { value } from "./api.ts"; export default function App() { return <html><head/><body>{value}</body></html>; }',
      },
      {
        filename: "api.ts",
        source: "{ for (var value of [() => process.env.SECRET]) {} } export { value };",
      },
    ],
    ".",
  );
  expect(diagnostics.map((item) => item.code)).toStrictEqual(["HES-CAPABILITY"]);
});

test("an escaping catch-local var initializer retains its host capability", () => {
  const diagnostics = analyzeBrowserCapabilities(
    [
      {
        filename: "app.tsx",
        source:
          'import { value } from "./api.ts"; export default function App() { return <html><head/><body>{value}</body></html>; }',
      },
      {
        filename: "api.ts",
        source:
          "let value; try { throw 1; } catch (caught) { var caught = () => process.env.SECRET; value = caught; } export { value };",
      },
    ],
    ".",
  );
  expect(diagnostics.map((item) => item.code)).toStrictEqual(["HES-CAPABILITY"]);
});

test.each([
  "try { process.env.SECRET; } catch {}",
  "try { throw 1; } catch (error) { process.env.SECRET; }",
  "try {} finally { process.env.SECRET; }",
  "try { throw {}; } catch ({ value = process.env.SECRET }) {}",
  "const values = [...process.env.VALUES];",
])("try and spread execution retain host provenance: %s", (body) => {
  const entry = {
    filename: "app.tsx",
    source:
      'import { value } from "./api.ts"; export default function App() { return <html><head/><body>{value}</body></html>; }',
  };
  for (const source of [`${body} export const value = 1;`, `export function value() { ${body} }`]) {
    const diagnostics = analyzeBrowserCapabilities([entry, { filename: "api.ts", source }], ".");
    expect(diagnostics.map((item) => item.code)).toStrictEqual(["HES-CAPABILITY"]);
    expect(diagnostics[0]!.message).toContain("process");
  }
});

test("a catch binding shadows an outer host-backed helper", () => {
  const diagnostics = analyzeBrowserCapabilities(
    [
      {
        filename: "app.tsx",
        source:
          'import { value } from "./api.ts"; export default function App() { return <html><head/><body>{value}</body></html>; }',
      },
      {
        filename: "api.ts",
        source:
          'const process = () => Bun.env.SECRET; export function value() { try { throw { message: "caught" }; } catch (process) { return process.message; } }',
      },
    ],
    ".",
  );
  expect(diagnostics).toStrictEqual([]);
});

test.each([
  "let value; try { throw {}; } catch ({ callback = () => process.env.SECRET }) { value = callback; } export { value };",
  "let value; try { throw 1; } catch { const callback = () => process.env.SECRET; value = callback; } export { value };",
  "let value; try {} finally { const callback = () => process.env.SECRET; value = callback; } export { value };",
])("exported catch and finally closures retain their captured host values: %s", (source) => {
  const diagnostics = analyzeBrowserCapabilities(
    [
      {
        filename: "app.tsx",
        source:
          'import { value } from "./api.ts"; export default function App() { return <html><head/><body>{value}</body></html>; }',
      },
      { filename: "api.ts", source },
    ],
    ".",
  );
  expect(diagnostics.map((item) => item.code)).toStrictEqual(["HES-CAPABILITY"]);
});

test("an unused catch default callback is not executed by binding initialization", () => {
  const diagnostics = analyzeBrowserCapabilities(
    [
      {
        filename: "app.tsx",
        source:
          'import { value } from "./api.ts"; export default function App() { return <html><head/><body>{value}</body></html>; }',
      },
      {
        filename: "api.ts",
        source:
          "try { throw {}; } catch ({ callback = () => process.env.SECRET }) {} export const value = 1;",
      },
    ],
    ".",
  );
  expect(diagnostics).toStrictEqual([]);
});

test.each([
  "for (const item of process.env.ITEMS) {}",
  "for (const key in process.env.ITEMS) {}",
  "for (let index = process.env.START; index < 2; index++) {}",
  "for (let index = 0; index < process.env.END; index++) {}",
  "for (let index = 0; index < 2; index += process.env.STEP) {}",
  "while (process.env.RUN) { break; }",
  "do { break; } while (process.env.RUN);",
  "outer: for (const item of [1]) { process.env.READ; continue outer; }",
  "for (const { value = process.env.DEFAULT } of [{}]) {}",
  "const target = {}; for (target[process.env.KEY] of [1]) {}",
])("loop execution and retained functions preserve host provenance: %s", (body) => {
  const entry = {
    filename: "app.tsx",
    source:
      'import { value } from "./api.ts"; export default function App() { return <html><head/><body>{value}</body></html>; }',
  };
  for (const source of [
    `${body} export const value = "ok";`,
    `export function value() { ${body} }`,
  ]) {
    const diagnostics = analyzeBrowserCapabilities([entry, { filename: "api.ts", source }], ".");
    expect(diagnostics.map((item) => item.code)).toStrictEqual(["HES-CAPABILITY"]);
    expect(diagnostics[0]!.message).toContain("process");
  }
});

test.each([
  "var value = () => process.env.SECRET; for (var value; false;) {} export { value };",
  "for (var value = () => process.env.SECRET; false;) {} export { value };",
  "let value; for (const callback of [() => process.env.SECRET]) { value = callback; } export { value };",
  "let value; for (value of [() => process.env.SECRET]) {} export { value };",
  "let value; { const callback = () => process.env.SECRET; value = callback; } export { value };",
])("escaping loop and block bindings retain their callable values: %s", (source) => {
  const diagnostics = analyzeBrowserCapabilities(
    [
      {
        filename: "app.tsx",
        source:
          'import { value } from "./api.ts"; export default function App() { return <html><head/><body>{value}</body></html>; }',
      },
      { filename: "api.ts", source },
    ],
    ".",
  );
  expect(diagnostics.map((item) => item.code)).toStrictEqual(["HES-CAPABILITY"]);
});

test("unused loop closures stay deferred and local loop bindings do not inherit a global name", () => {
  const diagnostics = analyzeBrowserCapabilities(
    [
      {
        filename: "app.tsx",
        source:
          'import { value } from "./api.ts"; export default function App() { return <html><head/><body>{value}</body></html>; }',
      },
      {
        filename: "api.ts",
        source:
          "for (const callback of [() => process.env.SECRET]) {} export function value() { for (const process of [{ value: 1 }]) { return process.value; } }",
      },
    ],
    ".",
  );
  expect(diagnostics).toStrictEqual([]);
});

test("browser re-exports reject route declarations before following their server dependencies", () => {
  const diagnostics = analyzeBrowserCapabilities(
    [
      {
        filename: "app.tsx",
        source:
          'import { value } from "./api.ts"; export default function App() { return <html><head/><body>{value}</body></html>; }',
      },
      { filename: "api.ts", source: 'export { default as value } from "./src/routes/+route.ts";' },
      {
        filename: "src/routes/+route.ts",
        source:
          'import { readFileSync } from "node:fs"; export default { load: () => readFileSync("secret") };',
      },
    ],
    ".",
  );
  expect(diagnostics.map((item) => item.code)).toStrictEqual(["HES-ROUTE-SERVER"]);
  expect(diagnostics[0]!.filename).toBe("src/routes/+route.ts");
  expect(diagnostics[0]!.message).toContain("./api.ts");
});

test.each([
  "let output; output = process.env.SECRET; return output;",
  "const output = {}; output[process.env.KEY] = 1; return output;",
  "let output = 0; output ||= process.env.SECRET; return output;",
  "let output; output ??= process.env.SECRET; return output;",
  "return Math.max(...process.env.VALUES);",
  "return new Array(...process.env.VALUES);",
])("assignment and argument evaluation retain host provenance: %s", (body) => {
  const diagnostics = analyzeBrowserCapabilities(
    [
      {
        filename: "app.tsx",
        source:
          'import { value } from "./api.ts"; export default function App() { return <html><head/><body>{value()}</body></html>; }',
      },
      { filename: "api.ts", source: `export function value() { ${body} }` },
    ],
    ".",
  );
  expect(diagnostics.map((item) => item.code)).toStrictEqual(["HES-CAPABILITY"]);
  expect(diagnostics[0]!.message).toContain("process");
});

test("module assignments execute while unused callback assignments remain deferred", () => {
  const entry = {
    filename: "app.tsx",
    source:
      'import { value } from "./api.ts"; export default function App() { return <html><head/><body>{value}</body></html>; }',
  };
  const check = (source: string) =>
    analyzeBrowserCapabilities([entry, { filename: "api.ts", source }], ".");
  expect(
    check('export const value = "ok"; let result; result = process.env.SECRET;').map(
      (item) => item.code,
    ),
  ).toStrictEqual(["HES-CAPABILITY"]);
  expect(
    check(
      'export const value = "ok"; function unused() { let result; result = process.env.SECRET; return result; }',
    ),
  ).toStrictEqual([]);
});

test("a used binding retains callable values assigned through another initializer", () => {
  const check = (exported: string) =>
    analyzeBrowserCapabilities(
      [
        {
          filename: "app.tsx",
          source:
            'import { value } from "./api.ts"; export default function App() { return <html><head/><body>{value}</body></html>; }',
        },
        {
          filename: "api.ts",
          source: `let callback; const ignored = callback = () => process.env.SECRET; const safe = "ok"; export { ${exported} as value };`,
        },
      ],
      ".",
    );
  expect(check("callback").map((item) => item.code)).toStrictEqual(["HES-CAPABILITY"]);
  expect(check("safe")).toStrictEqual([]);
});

test.each([
  "const output = {}; const ignored = output.read = () => process.env.SECRET; export const value = output;",
  "export const value = (() => process.env.SECRET)();",
])("module evaluation includes escaping assignments and invoked closures: %s", (source) => {
  const diagnostics = analyzeBrowserCapabilities(
    [
      {
        filename: "app.tsx",
        source:
          'import { value } from "./api.ts"; export default function App() { return <html><head/><body>{value}</body></html>; }',
      },
      { filename: "api.ts", source },
    ],
    ".",
  );
  expect(diagnostics.map((item) => item.code)).toStrictEqual(["HES-CAPABILITY"]);
});

test("browser capability checking follows a referenced imported binding", () => {
  const diagnostics = analyzeBrowserCapabilities(
    [
      {
        filename: "app.tsx",
        source:
          'import { api } from "./api.ts"; export default function App() { return <html><head/><body><main>{api()}</main></body></html>; }',
      },
      {
        filename: "api.ts",
        source: 'import fs from "node:fs"; export const api = () => fs.existsSync(".");',
      },
    ],
    ".",
  );

  expect(diagnostics).toHaveLength(1);
  expect(diagnostics[0]).toMatchObject({
    code: "HES-CAPABILITY",
    filename: "api.ts",
  });
  expect(diagnostics[0]!.message).toContain("app.tsx -> ./api.ts");
  expect(diagnostics[0]!.message).toContain("node:fs");
});

test("type-only host imports and unreferenced server bindings do not taint a browser entry", () => {
  const diagnostics = analyzeBrowserCapabilities(
    [
      {
        filename: "app.tsx",
        source:
          'import type { Stats } from "node:fs"; import { safe } from "./api.ts"; export default function App() { return <html><head/><body><main>{safe}</main></body></html>; }',
      },
      {
        filename: "api.ts",
        source: 'export const serverOnly = () => process.env.SECRET; export const safe = "ok";',
      },
    ],
    ".",
  );

  expect(diagnostics).toStrictEqual([]);
});

test("a referenced server binding reports its captured host global", () => {
  const diagnostics = analyzeBrowserCapabilities(
    [
      {
        filename: "app.tsx",
        source:
          'import { serverOnly } from "./api.ts"; export default function App() { return <html><head/><body><main>{serverOnly()}</main></body></html>; }',
      },
      {
        filename: "api.ts",
        source: "export const serverOnly = () => process.env.SECRET;",
      },
    ],
    ".",
  );

  expect(diagnostics).toHaveLength(1);
  expect(diagnostics[0]!.message).toContain("process");
  expect(diagnostics[0]!.message).toContain("app.tsx -> default -> serverOnly");
});

test("package conditions select source for proof without granting browser safety", () => {
  const parent = resolve(import.meta.dir, "../../.hesperia");
  mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, "capability-package-"));
  try {
    const dependency = join(root, "node_modules/example");
    mkdirSync(dependency, { recursive: true });
    const modules = [
      {
        filename: join(root, "app.tsx"),
        source:
          'import { value } from "example"; export default function App() { return <html><head/><body><main>{value}</main></body></html>; }',
      },
    ];
    const manifest = (exports: unknown) =>
      writeFileSync(
        join(dependency, "package.json"),
        JSON.stringify({ name: "example", exports, main: "./safe.js" }),
      );
    writeFileSync(join(dependency, "safe.js"), 'export const value = "safe";');
    writeFileSync(join(dependency, "host.js"), "export const value = process.env.SECRET;");
    manifest({ browser: "./safe.js", default: "./host.js" });
    expect(analyzeBrowserCapabilities(modules, root)).toStrictEqual([]);
    manifest({ default: "./host.js", browser: "./safe.js" });
    expect(
      analyzeBrowserCapabilities(modules, root).some(
        (item) => item.code === "HES-CAPABILITY" && item.message.includes("process"),
      ),
    ).toBe(true);
    manifest({ browser: "./host.js", default: "./safe.js" });
    expect(
      analyzeBrowserCapabilities(modules, root).some((item) => item.code === "HES-CAPABILITY"),
    ).toBe(true);
    manifest({ node: "./safe.js" });
    expect(
      analyzeBrowserCapabilities(modules, root).some(
        (item) => item.code === "HES-CAPABILITY-RESOLVE",
      ),
    ).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function throughExports(modules: Record<string, string>, imported = "value") {
  return analyzeBrowserCapabilities(
    [
      {
        filename: "app.tsx",
        source: `import { ${imported} as value } from "./barrel.ts";
export default function App() { return <html><head/><body><main>{value}</main></body></html>; }`,
      },
      ...Object.entries(modules).map(([filename, source]) => ({ filename, source })),
    ],
    ".",
  );
}

test("local export aliases and named reexports retain the host provenance path", () => {
  const diagnostics = throughExports({
    "barrel.ts": 'export { operation as value } from "./operations.ts";',
    "operations.ts": "const hidden = () => process.env.SECRET; export { hidden as operation };",
  });
  expect(diagnostics).toHaveLength(1);
  expect(diagnostics[0]).toMatchObject({ code: "HES-CAPABILITY", filename: "operations.ts" });
  expect(diagnostics[0]!.message).toContain("./barrel.ts.value -> ./operations.ts.operation");
  expect(diagnostics[0]!.message).toContain("process");
});

test("a safe reexport does not retain an unrelated server-only function", () => {
  expect(
    throughExports({
      "barrel.ts": 'export { safe as value, hidden } from "./operations.ts";',
      "operations.ts":
        'const safe = "browser"; const hidden = () => process.env.SECRET; export { safe, hidden };',
    }),
  ).toStrictEqual([]);
});

test("an unused broken reexport still prevents native module linking", () => {
  const diagnostics = throughExports({
    "barrel.ts": 'export { missing } from "./operations.ts"; export const value = "browser";',
    "operations.ts": 'export const available = "browser";',
  });
  expect(diagnostics).toHaveLength(1);
  expect(diagnostics[0]).toMatchObject({ code: "HES-CAPABILITY-RESOLVE", filename: "barrel.ts" });
  expect(diagnostics[0]!.message).toContain("missing export missing");
});

test("star reexports traverse cycles and retain only the requested binding", () => {
  const modules = {
    "barrel.ts": 'export * from "./cycle.ts";',
    "cycle.ts": 'export * from "./barrel.ts"; export * from "./operations.ts";',
    "operations.ts":
      'export const value = "browser"; export const hidden = () => process.env.SECRET;',
  };
  expect(throughExports(modules)).toStrictEqual([]);
  const diagnostics = throughExports(modules, "hidden");
  expect(diagnostics).toHaveLength(1);
  expect(diagnostics[0]!.code).toBe("HES-CAPABILITY");
  expect(diagnostics[0]!.message).toContain("./cycle.ts.hidden -> ./operations.ts.hidden");
});

test("star export ambiguity differs from two paths to the same binding", () => {
  const modules = {
    "barrel.ts": 'export * from "./left.ts"; export * from "./right.ts";',
    "left.ts": 'export { value } from "./operations.ts";',
    "right.ts": 'export { value } from "./operations.ts";',
    "operations.ts": 'export const value = "browser";',
  };
  expect(throughExports(modules)).toStrictEqual([]);
  const diagnostics = throughExports({ ...modules, "right.ts": 'export const value = "other";' });
  expect(diagnostics).toHaveLength(1);
  expect(diagnostics[0]).toMatchObject({ code: "HES-CAPABILITY-RESOLVE", filename: "app.tsx" });
  expect(diagnostics[0]!.message).toContain("ambiguous export value");
  expect(
    throughExports({
      ...modules,
      "left.ts": 'import { value as local } from "./operations.ts"; export { local as value };',
      "right.ts": 'import { value } from "./operations.ts"; export { value };',
    }),
  ).toStrictEqual([]);
});

test("an explicit export overrides competing stars and stars never forward default", () => {
  expect(
    throughExports({
      "barrel.ts": 'export * from "./host.ts"; export { value } from "./safe.ts";',
      "host.ts": "export const value = () => process.env.SECRET;",
      "safe.ts": 'export const value = "browser";',
    }),
  ).toStrictEqual([]);
  const diagnostics = throughExports(
    {
      "barrel.ts": 'export * from "./safe.ts";',
      "safe.ts": 'const value = "browser"; export default value;',
    },
    "default",
  );
  expect(diagnostics).toHaveLength(1);
  expect(diagnostics[0]!.message).toContain("missing export default");
});

test("reexport source evaluation remains part of the browser closure", () => {
  const diagnostics = throughExports({
    "barrel.ts": 'export { value } from "./operations.ts";',
    "operations.ts": 'process.env.SECRET; export const value = "browser";',
  });
  expect(diagnostics).toHaveLength(1);
  expect(diagnostics[0]).toMatchObject({ code: "HES-CAPABILITY", filename: "operations.ts" });
  const empty = throughExports({
    "barrel.ts": 'export {} from "./operations.ts"; export const value = "browser";',
    "operations.ts": "process.env.SECRET;",
  });
  expect(empty).toHaveLength(1);
  expect(empty[0]).toMatchObject({ code: "HES-CAPABILITY", filename: "operations.ts" });
});

test.each([
  'const helper = () => 0; export const value = helper.constructor("return 1")();',
  'function helper() {} export const value = helper.constructor("return 1")();',
  "const scope = globalThis; export const value = scope.eval();",
  'const name = "eval"; export const value = Reflect.get(globalThis, name)();',
  'const name = "eval"; export const value = globalThis[name]("1");',
  'const name = true ? "eval" : "location"; export const value = globalThis[name]("1");',
  'const scope = globalThis; const name = "Function"; export const value = scope[name]("return 1")();',
  'let name = "location"; export const value = globalThis[name];',
  'const name = "constructor"; const helper = () => 0; export const value = helper[name]("return 1")();',
  'const name = "constructor"; export function value() { const helper = () => 0; return helper[name]("return 1")(); }',
  'let name = "name"; const helper = () => 0; export const value = helper[name];',
  'const name = "prototype"; export const value = Function[name].constructor("return 1")();',
  'const name = "constructor"; export const value = Function.prototype[name]("return 1")();',
  'export const value = Object.constructor("return 1")();',
  'export const value = Math.max.constructor("return 1")();',
  'const ObjectAlias = Object; export const value = ObjectAlias.constructor("return 1")();',
  'const MathAlias = Math; export const value = MathAlias.max.constructor("return 1")();',
  'const scope = globalThis; export const value = scope.Object.constructor("return 1")();',
  'const scope = globalThis; export const value = scope.Math.max.constructor("return 1")();',
  'export const value = Object.prototype.constructor.constructor("return 1")();',
  'export const value = Math.max.bind(null).constructor("return 1")();',
  'const bound = Math.max.bind(null); export const value = bound.constructor("return 1")();',
  'const scope = globalThis; export const value = scope.Object.prototype.constructor.constructor("return 1")();',
])("reachable native execution aliases remain prohibited: %s", (source) => {
  const diagnostics = throughExports({
    "barrel.ts": 'export { value } from "./operations.ts";',
    "operations.ts": source,
  });
  expect(diagnostics).toContainEqual(
    expect.objectContaining({ code: "HES-CAPABILITY-DYNAMIC", filename: "operations.ts" }),
  );
});

test.each([
  'const name = "location"; export const value = globalThis[name];',
  'const name = `loc${"ation"}`; export const value = globalThis[name];',
  'const globalThis = { eval: () => "safe" }; export const value = globalThis["eval"]();',
  'export function value(globalThis) { return globalThis["eval"]?.(); }',
  'const name = "name"; const helper = () => 0; export const value = helper[name];',
  'const name = "prototype"; export const value = Function[name];',
  'const name = "name"; export const value = Function[name];',
  'const name = "prototype"; export const value = globalThis.Function[name];',
  "export const value = Math.max(1, 2);",
  "export const value = Object.keys({ value: 1 }).length;",
  "export const value = Math.max.name;",
  "export const value = Object.prototype.constructor(1);",
])("finite safe global properties and shadowing remain ordinary: %s", (source) => {
  expect(
    throughExports({
      "barrel.ts": 'export { value } from "./operations.ts";',
      "operations.ts": source,
    }),
  ).toStrictEqual([]);
});

test.each([
  'export const value = Function[process.env.KEY ? "name" : "length"];',
  'export const value = globalThis["Function"][process.env.KEY ? "name" : "length"];',
  'export const value = globalThis[process.env.KEY ? "Function" : "Function"].name;',
])("computed metadata keys retain their executable operands: %s", (source) => {
  const diagnostics = throughExports({
    "barrel.ts": 'export { value } from "./operations.ts";',
    "operations.ts": source,
  });
  expect(diagnostics.some((diagnostic) => diagnostic.code.startsWith("HES-CAPABILITY"))).toBe(true);
});

test.each([
  'export function value(enabled) { return globalThis[enabled ? "Function" : "process"].name; }',
  'export function value(enabled) { return globalThis[enabled ? "process" : "Function"].name; }',
  'export function value(enabled) { return globalThis[enabled ? "Function" : "eval"].name; }',
  'export function value(enabled) { return globalThis[enabled ? "eval" : "Function"].name; }',
])("mixed native global alternatives cannot use the metadata exemption: %s", (source) => {
  const diagnostics = throughExports({
    "barrel.ts": 'export { value } from "./operations.ts";',
    "operations.ts": source,
  });
  expect(diagnostics.some((diagnostic) => diagnostic.code.startsWith("HES-CAPABILITY"))).toBe(true);
});

test.each([
  "export function value() { const helper = () => 0; return helper.constructor(); }",
  "export function value() { const alias = (() => 0); const helper = alias; return helper.constructor(); }",
  "export function value() { const scope = globalThis; return scope.eval(); }",
  "export function value() { { const helper = () => 0; return helper.constructor(); } }",
])("reachable helper-local native aliases remain prohibited: %s", (source) => {
  const diagnostics = throughExports({
    "barrel.ts": 'export { value } from "./operations.ts";',
    "operations.ts": source,
  });
  expect(diagnostics).toContainEqual(
    expect.objectContaining({ code: "HES-CAPABILITY-DYNAMIC", filename: "operations.ts" }),
  );
});

test.each([
  'export function value() { const scope = { constructor: () => "safe" }; return scope.constructor(); }',
  "export function value(process) { return process; }",
  "export function value(Function) { return Function; }",
])("helper-local custom and shadowed values remain ordinary: %s", (source) => {
  expect(
    throughExports({
      "barrel.ts": 'export { value } from "./operations.ts";',
      "operations.ts": source,
    }),
  ).toStrictEqual([]);
});

test.each([
  'export function value(scope) { return scope.constructor("return 1")(); }',
  "export function value(scope) { return scope.constructor; }",
  "export function value(scope) { return scope.constructor?.(); }",
])("unknown constructor values fail closed: %s", (source) => {
  expect(
    throughExports({
      "barrel.ts": 'export { value } from "./operations.ts";',
      "operations.ts": source,
    }),
  ).toContainEqual(
    expect.objectContaining({ code: "HES-CAPABILITY-DYNAMIC", filename: "operations.ts" }),
  );
});

test.each([
  'export function value(scope, enabled) { return scope[enabled ? "constructor" : "other"]("return 1")(); }',
  'export function value(replacement) { const scope = { constructor: () => 0 }; scope.constructor = replacement; return scope.constructor("return 1")(); }',
  'export function value(extra) { const scope = { constructor: () => 0, ...extra }; return scope.constructor("return 1")(); }',
])(
  "uncertain constructor alternatives and overwritten own properties fail closed: %s",
  (source) => {
    expect(
      throughExports({
        "barrel.ts": 'export { value } from "./operations.ts";',
        "operations.ts": source,
      }),
    ).toContainEqual(
      expect.objectContaining({ code: "HES-CAPABILITY-DYNAMIC", filename: "operations.ts" }),
    );
  },
);

test.each([
  "export function value(scope) { return scope.constructor.name; }",
  "export function value(scope) { return scope.constructor.length; }",
  "export function value(scope) { return scope.constructor?.name; }",
])("unknown constructor metadata remains readable: %s", (source) => {
  expect(
    throughExports({
      "barrel.ts": 'export { value } from "./operations.ts";',
      "operations.ts": source,
    }),
  ).toStrictEqual([]);
});

test("a known own constructor after an uncertain spread remains ordinary", () => {
  expect(
    throughExports({
      "barrel.ts": 'export { value } from "./operations.ts";',
      "operations.ts":
        'export function value(extra) { const scope = { ...extra, constructor: () => "safe" }; return scope.constructor(); }',
    }),
  ).toStrictEqual([]);
});

test("a helper-local custom constructor remains ordinary after the native alias repair", () => {
  expect(
    throughExports({
      "barrel.ts": 'export { value } from "./operations.ts";',
      "operations.ts":
        'export function value() { const helper = () => 0; helper.constructor = () => "safe"; return helper.constructor(); }',
    }),
  ).toStrictEqual([]);
});

test("unreachable helper-local native aliases do not become browser roots", () => {
  expect(
    throughExports({
      "barrel.ts": 'export { value } from "./operations.ts";',
      "operations.ts":
        'function hidden() { const helper = () => 0; return helper.constructor(); } export const value = "safe";',
    }),
  ).toStrictEqual([]);
});

test.each([
  "const helper = () => process.env.SECRET; export const value = helper.constructor.name;",
  "export const value = (() => process.env.SECRET).constructor.name;",
  "export const value = (() => process.env.SECRET).name;",
])("metadata retains the source of its ordinary function receiver: %s", (source) => {
  const diagnostics = throughExports({
    "barrel.ts": 'export { value } from "./operations.ts";',
    "operations.ts": source,
  });
  expect(diagnostics).toContainEqual(
    expect.objectContaining({ code: "HES-CAPABILITY", filename: "operations.ts" }),
  );
});

test("local function metadata and an assigned custom constructor remain ordinary", () => {
  expect(
    throughExports({
      "barrel.ts": 'export { value } from "./operations.ts";',
      "operations.ts":
        'const helper = () => 0; helper.constructor = () => "safe"; export const value = helper.constructor();',
    }),
  ).toStrictEqual([]);
  expect(
    throughExports({
      "barrel.ts": 'export { value } from "./operations.ts";',
      "operations.ts":
        'const helper = () => 0; const key = "constructor"; helper[key] = () => "safe"; export const value = helper.constructor();',
    }),
  ).toStrictEqual([]);
  expect(
    throughExports({
      "barrel.ts": 'export { value } from "./operations.ts";',
      "operations.ts": "const helper = () => 0; export const value = helper.name + helper.length;",
    }),
  ).toStrictEqual([]);
});

test.each([
  'const helper = () => 0; const alias = helper; export const value = alias.constructor("return 1")();',
  'const helper = () => 0; export const value = helper.constructor("return 1")(); helper.constructor = () => "safe";',
  'const helper = () => 0; function never() { helper.constructor = () => "safe"; } export const value = helper.constructor("return 1")();',
  'const helper = () => 0; helper.constructor = helper.constructor("return 1"); export const value = 1;',
  'const helper = () => 0; helper.constructor = () => "safe"; delete helper.constructor; export const value = helper.constructor("return 1")();',
  'const helper = () => 0; helper.constructor = () => "safe"; const key = "constructor"; delete helper[key]; export const value = helper.constructor("return 1")();',
  'const helper = () => 0; helper.constructor = () => "safe"; const key = process.env.KEY ? "constructor" : "name"; delete helper[key]; export const value = helper.constructor("return 1")();',
  'const helper = () => 0; helper.constructor = () => "safe"; const key = process.env.KEY; delete helper[key]; export const value = helper.constructor("return 1")();',
  'const helper = () => 0; helper.constructor = () => "safe"; const key = process.env.KEY ? "constructor" : "name"; helper[key] = () => "safe"; export const value = helper.constructor("return 1")();',
  'const helper = () => 0; helper.constructor = () => "safe"; const key = process.env.KEY; helper[key] = () => "safe"; export const value = helper.constructor("return 1")();',
  'export function value() { const helper = () => 0; helper.constructor = () => "safe"; const key = "constructor"; delete helper[key]; return helper.constructor("return 1")(); }',
  'const helper = () => 0; false && (helper.constructor = () => "safe"); export const value = helper.constructor("return 1")();',
])("function constructor provenance remains unsafe across mutations: %s", (source) => {
  const diagnostics = throughExports({
    "barrel.ts": 'export { value } from "./operations.ts";',
    "operations.ts": source,
  });
  expect(diagnostics).toContainEqual(
    expect.objectContaining({ code: "HES-CAPABILITY-DYNAMIC", filename: "operations.ts" }),
  );
});

test("a missing reexport dependency reports the source without inventing a missing binding", () => {
  const diagnostics = throughExports({
    "barrel.ts": 'export { value } from "./missing-capability-source.ts";',
  });
  expect(diagnostics).toHaveLength(1);
  expect(diagnostics[0]).toMatchObject({ code: "HES-CAPABILITY-RESOLVE", filename: "barrel.ts" });
  expect(diagnostics[0]!.message).toContain("missing module ./missing-capability-source.ts");
});

test("a reexported namespace cannot hide a host-backed member", () => {
  const modules = {
    "barrel.ts": 'export * as value from "./operations.ts";',
    "operations.ts": 'export const safe = "browser";',
  };
  expect(throughExports(modules)).toStrictEqual([]);
  const diagnostics = throughExports({
    ...modules,
    "operations.ts": "export const hidden = () => process.env.SECRET;",
  });
  expect(diagnostics).toHaveLength(1);
  expect(diagnostics[0]!.message).toContain("process");
});

test("default expression exports retain their callable closure", () => {
  expect(
    throughExports({
      "barrel.ts": 'export { default as value } from "./operation.ts";',
      "operation.ts": 'export default () => "browser";',
    }),
  ).toStrictEqual([]);
  const diagnostics = throughExports({
    "barrel.ts": 'export { default as value } from "./operation.ts";',
    "operation.ts": "export default () => process.env.SECRET;",
  });
  expect(diagnostics).toHaveLength(1);
  expect(diagnostics[0]).toMatchObject({ code: "HES-CAPABILITY", filename: "operation.ts" });
});

test.each([
  "export function value(input = process.env.SECRET) { return input; }",
  "export const value = (input = process.env.SECRET) => input;",
  "export const value = function(input = process.env.SECRET) { return input; };",
  "export const { value = process.env.SECRET } = {};",
  "export const [value = () => process.env.SECRET] = [];",
  "export function value({ input = process.env.SECRET } = {}) { return input; }",
])("default values retain host provenance: %s", (source) => {
  const diagnostics = throughExports({ "barrel.ts": source });
  expect(diagnostics).toHaveLength(1);
  expect(diagnostics[0]).toMatchObject({ code: "HES-CAPABILITY", filename: "barrel.ts" });
  expect(diagnostics[0]!.message).toContain("process");
});

test("a body-local declaration cannot conceal a parameter default's outer dependency", () => {
  const diagnostics = throughExports({
    "barrel.ts": `const read = () => process.env.SECRET;
export function value(input = read()) { const read = () => "local"; return input; }`,
  });
  expect(diagnostics).toHaveLength(1);
  expect(diagnostics[0]!.code).toBe("HES-CAPABILITY");
  expect(diagnostics[0]!.message).toContain("process");
});

test("unused parameter defaults remain outside module evaluation", () => {
  expect(
    throughExports({
      "barrel.ts": `export function hidden(input = process.env.SECRET) { return input; }
export function value(process = "browser") { return process; }`,
    }),
  ).toStrictEqual([]);
});

test("a default closure captures a later parameter rather than the same-named outer binding", () => {
  expect(
    throughExports({
      "barrel.ts": `const later = () => process.env.SECRET;
export function value(first = () => later(), later = () => "browser") { return first; }`,
    }),
  ).toStrictEqual([]);
});

test("a rendered list's destructuring default retains its host dependency", () => {
  const diagnostics = throughExports({
    "barrel.ts": 'export { value } from "./list.tsx";',
    "list.tsx": `export function value() {
      const rows = [{}];
      return <div>{rows.map(({label = process.env.SECRET}) => <span key={label}>{label}</span>)}</div>;
    }`,
  });
  expect(diagnostics).toHaveLength(1);
  expect(diagnostics[0]).toMatchObject({ code: "HES-CAPABILITY", filename: "list.tsx" });
});
