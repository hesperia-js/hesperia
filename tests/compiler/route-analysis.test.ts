import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { generateModule } from "../../src/compiler/generate.ts";
import { analyzeRouteModule } from "../../src/compiler/index.ts";
import { ModuleResolver } from "../../src/compiler/module-resolution.ts";

function routeSource(body: string): string {
  return `import { route } from "hesperia/routing";\n${body}\nexport default route({ guard, load: async () => { if (true) return { server: true }; }, headers: { "cache-control": "private" } });\n`;
}

test("a generated guard retains dependencies reached through yield and yield delegation", async () => {
  const result = analyzeRouteModule(
    routeSource(`
const allowed = (id: string) => id === "ok";
function* delegated(id: string) { yield allowed(id); }
function* decisions(id: string) { yield; return yield* delegated(id); }
const guard = ({ params }: { params: { id: string } }) => {
  const iterator = decisions(params.id);
  iterator.next();
  return iterator.next().value;
};`),
    { filename: "src/routes/+route.ts" },
  );
  expect(result.diagnostics).toStrictEqual([]);
  expect(result.artifact).toBeDefined();
  const temporary = await mkdtemp(join(resolve(import.meta.dir), "route-yield-artifact-"));
  try {
    await writeFile(join(temporary, "runtime-stub.mjs"), "export {};", "utf8");
    for (const item of result.artifact!.modules) {
      const generated = generateModule(item.module, {
        filename: item.filename,
        runtimeModule: "../../runtime-stub.mjs",
        source: item.source,
        clientBindings: new Map(),
      });
      await Bun.write(join(temporary, item.filename), generated.code);
    }
    const module = await import(pathToFileURL(join(temporary, "src/routes/+route.ts")).href);
    expect(module.default({ params: { id: "ok" } })).toBe(true);
    expect(module.default({ params: { id: "blocked" } })).toBe(false);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test.each(["yield process.env.ALLOWED", "yield* process.env.ALLOWED"])(
  "route guards cannot hide a server read inside a generator: %s",
  (expression) => {
    const result = analyzeRouteModule(
      routeSource(
        `function* decisions() { ${expression}; } const guard = () => decisions().next().value;`,
      ),
      { filename: "src/routes/+route.ts" },
    );
    expect(result.artifact).toBeUndefined();
    expect(result.diagnostics.map((item) => item.code)).toStrictEqual(["HES-ROUTE-CAPABILITY"]);
  },
);

test("a referenced class helper is retained in the browser guard artifact", () => {
  const result = analyzeRouteModule(
    routeSource(
      "class Policy { static allowed() { return true; } } const guard = () => Policy.allowed();",
    ),
    {
      filename: "src/routes/+route.ts",
    },
  );
  expect(result.diagnostics).toStrictEqual([]);
  expect(result.artifact).toBeDefined();
  expect(
    result.artifact!.modules[0]!.module.body.some((statement) => statement.kind === "class"),
  ).toBe(true);
});

test("a retained class helper cannot hide a server read in a private method", () => {
  const result = analyzeRouteModule(
    routeSource(
      "class Policy { static #read() { return process.env.ALLOWED; } static allowed() { return this.#read(); } } const guard = () => Policy.allowed();",
    ),
    {
      filename: "src/routes/+route.ts",
    },
  );
  expect(result.artifact).toBeUndefined();
  expect(result.diagnostics.map((item) => item.code)).toStrictEqual(["HES-ROUTE-CAPABILITY"]);
});

test.each([
  "try { return process.env.ALLOWED; } catch { return false; }",
  "try { throw 1; } catch { return process.env.ALLOWED; }",
  "try { return true; } finally { process.env.ALLOWED; }",
  "try { throw {}; } catch ({ allowed = process.env.ALLOWED }) { return allowed; }",
  "return [...process.env.ALLOWED].length > 0;",
])("route guards cannot hide server reads in try or array spreads: %s", (body) => {
  const result = analyzeRouteModule(routeSource(`const guard = () => { ${body} };`), {
    filename: "src/routes/+route.ts",
  });
  expect(result.artifact).toBeUndefined();
  expect(result.diagnostics.map((item) => item.code)).toStrictEqual(["HES-ROUTE-CAPABILITY"]);
});

test("a catch-local process name is safe in a retained route guard", () => {
  const result = analyzeRouteModule(
    routeSource("const guard = () => { try { throw true; } catch (process) { return process; } };"),
    {
      filename: "src/routes/+route.ts",
    },
  );
  expect(result.diagnostics).toStrictEqual([]);
  expect(result.artifact).toBeDefined();
});

test("extracts only the referenced guard closure and excludes route-time members and side effects", () => {
  const source = routeSource(`
const serverSetup = (() => { throw new Error("must stay server-only"); })();
const guard = ({ params }: { params: { id: string } }) => params.id !== "blocked";
`);
  const result = analyzeRouteModule(source, { filename: "src/routes/+route.ts" });

  expect(result.diagnostics).toStrictEqual([]);
  expect(result.artifact?.entry.name).toBe("guard");
  const artifact = JSON.stringify(result.artifact?.modules.map((item) => item.module));
  expect(artifact).toContain("guard");
  expect(artifact).not.toContain("serverSetup");
  expect(artifact).not.toContain("server-only");
  expect(artifact).not.toContain("cache-control");
  expect(artifact).not.toContain("load");
  expect(result.artifact?.modules).toHaveLength(1);
});

test("route guard dependency analysis traverses assignments and spread arguments", () => {
  const result = analyzeRouteModule(
    [
      'import { route } from "hesperia/routing";',
      "const values = process.env.VALUES;",
      "const guard = () => { let result; result = Math.max(...values); return result; };",
      "export default route({ guard });",
    ].join("\n"),
    { filename: "src/routes/+route.ts" },
  );
  expect(result.artifact).toBeUndefined();
  expect(result.diagnostics).toContainEqual(
    expect.objectContaining({
      code: "HES-ROUTE-CAPABILITY",
      message: "Route guard references server capability process.",
    }),
  );
});

test("rejects an inline route guard at its authored expression span", () => {
  const source = `import { route } from "hesperia/routing";
export default route({ guard: ({ params }) => params.id === "ok" });
`;
  const result = analyzeRouteModule(source, { filename: "src/routes/+route.ts" });
  const diagnostic = result.diagnostics.find((item) => item.code === "HES-ROUTE-GUARD");

  expect(diagnostic).toMatchObject({
    code: "HES-ROUTE-GUARD",
    severity: "error",
    message:
      "The route guard must be a binding referenced by identifier; inline functions are not allowed.",
    span: {
      start: source.indexOf("({ params })"),
      end: source.indexOf(" });", source.indexOf("({ params })")),
    },
  });
  expect(result.artifact).toBeUndefined();
});

test("maps typed inline guards to exact authored ranges across CRLF and Unicode", () => {
  const source = `import { route } from "hesperia/routing";\r\n// 🧭 route guard\r\nexport default route({ guard: ({ params }: { params: { id: string } }) => params.id === "ok" });\r\n`;
  const start = source.indexOf("({ params }");
  const end = source.indexOf(" });", start);
  const result = analyzeRouteModule(source, { filename: "src/routes/+route.ts" });
  const diagnostic = result.diagnostics.find((item) => item.code === "HES-ROUTE-GUARD");

  expect(diagnostic).toMatchObject({
    code: "HES-ROUTE-GUARD",
    span: { start, end },
  });
  expect(source.slice(diagnostic!.span!.start, diagnostic!.span!.end)).toBe(
    '({ params }: { params: { id: string } }) => params.id === "ok"',
  );
});

test("route and configuration type wrappers preserve the rejected guard's authored range", () => {
  const expression = "() => true";
  for (const declaration of [
    "route({ guard: () => true } satisfies Route.Declaration)",
    "route({ guard: () => true } as Route.Declaration)",
    "route({ guard: () => true }) satisfies Route.Declaration",
  ]) {
    const source = `import { route, type Route } from "hesperia/routing"; export default ${declaration};`;
    const result = analyzeRouteModule(source, { filename: "src/routes/+route.ts" });
    const diagnostic = result.diagnostics.find((item) => item.code === "HES-ROUTE-GUARD");
    expect(diagnostic?.span).toStrictEqual({
      start: source.indexOf(expression),
      end: source.indexOf(expression) + expression.length,
    });
  }
});

test("accepts a route declaration without a guard and produces no browser artifact", () => {
  const source = `import { route } from "hesperia/routing";
export default route({ load: async () => ({ value: 1 }), headers: { "cache-control": "private" } });
`;
  const result = analyzeRouteModule(source, { filename: "src/routes/+route.ts" });

  expect(result.diagnostics).toStrictEqual([]);
  expect(result.artifact).toBeUndefined();
});

test("rejects route configuration spreads and computed properties instead of hiding a guard", () => {
  const spread = `import { route } from "hesperia/routing";
const guard = () => true;
const settings = { guard };
export default route({ ...settings });
`;
  const computed = `import { route } from "hesperia/routing";
const guard = () => true;
export default route({ ["guard"]: guard });
`;
  for (const source of [spread, computed]) {
    const result = analyzeRouteModule(source, { filename: "src/routes/+route.ts" });
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: "HES-ROUTE-SHAPE", severity: "error" }),
    );
    expect(result.artifact).toBeUndefined();
  }
});

test("fails closed for a host-runtime import reached by the guard", () => {
  const source = `import { route } from "hesperia/routing";
import fs from "node:fs";
const guard = () => fs.existsSync("/private");
export default route({ guard });
`;
  const result = analyzeRouteModule(source, { filename: "src/routes/+route.ts" });

  expect(result.diagnostics).toContainEqual(
    expect.objectContaining({
      code: "HES-ROUTE-CAPABILITY",
      severity: "error",
      message: "Route guard imports server capability node:fs.",
      span: { start: source.indexOf("import fs"), end: expect.any(Number) },
    }),
  );
  expect(result.artifact).toBeUndefined();
});

test("follows host capability references in guard parameter defaults", () => {
  const source = `import { route } from "hesperia/routing";
const guard = (allowed = process.env.ALLOWED === "yes") => allowed;
export default route({ guard });
`;
  const result = analyzeRouteModule(source, { filename: "src/routes/+route.ts" });

  expect(result.diagnostics).toContainEqual(
    expect.objectContaining({
      code: "HES-ROUTE-CAPABILITY",
      severity: "error",
      message: "Route guard references server capability process.",
    }),
  );
  expect(result.artifact).toBeUndefined();
});

test("follows relative app imports by binding and keeps unrelated declarations out", () => {
  const route = `import { route } from "hesperia/routing";
import { guard } from "../guards.ts";
export default route({ guard, load: async () => ({ server: true }) });
`;
  const guards = `import { redirect } from "hesperia/routing";
import { allowed } from "./policy.ts";
export const guard = ({ params }: { params: { id: string } }) => allowed(params.id) || redirect("/login");
export const serverOnly = () => process.env.SECRET;
`;
  const policy = `export function allowed(id: string) { return id !== "blocked"; }
export const unrelated = () => process.env.SECRET;
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
  expect(result.artifact?.modules.map((item) => item.filename)).toStrictEqual([
    "src/guards.ts",
    "src/policy.ts",
    "src/routes/+route.ts",
  ]);
  const artifact = JSON.stringify(result.artifact?.modules.map((item) => item.module));
  expect(artifact).toContain("allowed");
  expect(artifact).toContain("redirect");
  expect(artifact).not.toContain("serverOnly");
  expect(artifact).not.toContain("unrelated");
  expect(artifact).not.toContain("process");
});

test("rejects unknown third-party imports instead of guessing client eligibility", () => {
  const source = `import { route } from "hesperia/routing";
import { check } from "auth-package";
const guard = ({ params }) => check(params.id);
export default route({ guard });
`;
  const result = analyzeRouteModule(source, { filename: "src/routes/+route.ts" });

  expect(result.diagnostics).toContainEqual(
    expect.objectContaining({
      code: "HES-ROUTE-UNRESOLVED",
      message: "Route guard dependency auth-package is not a proven client module.",
    }),
  );
  expect(result.artifact).toBeUndefined();
});

test("uses the shared resolver's browser package condition and retains direct and transitive imports", async () => {
  const temporary = await mkdtemp(join(resolve(import.meta.dir), "route-package-conditions-"));
  try {
    const routeFilename = join(temporary, "src/routes/+route.ts");
    await mkdir(join(temporary, "src/routes"), { recursive: true });
    await mkdir(join(temporary, "node_modules/route-policy"), { recursive: true });
    const route = `import { route } from "hesperia/routing";
import { guard } from "route-policy";
export default route({ guard });
`;
    await writeFile(
      join(temporary, "node_modules/route-policy/package.json"),
      JSON.stringify({
        name: "route-policy",
        exports: {
          ".": {
            browser: "./browser.ts",
            import: "./import.ts",
            default: "./default.ts",
          },
        },
      }),
      "utf8",
    );
    await writeFile(
      join(temporary, "node_modules/route-policy/browser.ts"),
      `import { allowed } from "./policy.ts";
export const guard = ({ params }: { params: { id: string } }) => allowed(params.id);
`,
      "utf8",
    );
    await writeFile(
      join(temporary, "node_modules/route-policy/policy.ts"),
      `export function allowed(id: string) { return id !== "blocked"; }
export const unrelated = () => process.env.SECRET;
`,
      "utf8",
    );
    await writeFile(
      join(temporary, "node_modules/route-policy/import.ts"),
      `export const guard = () => process.env.IMPORT_ONLY;
`,
      "utf8",
    );
    await writeFile(
      join(temporary, "node_modules/route-policy/default.ts"),
      `export const guard = () => process.env.DEFAULT_ONLY;
`,
      "utf8",
    );

    const resolver = new ModuleResolver(temporary, new Map([[routeFilename, route]]), "production");
    const result = analyzeRouteModule(route, { filename: routeFilename, resolution: resolver });

    expect(result.diagnostics).toStrictEqual([]);
    expect(result.artifact?.modules.map((item) => item.filename)).toEqual([
      join(temporary, "node_modules/route-policy/browser.ts"),
      join(temporary, "node_modules/route-policy/policy.ts"),
      routeFilename,
    ]);
    const artifact = JSON.stringify(result.artifact?.modules.map((item) => item.module));
    expect(artifact).toContain("allowed");
    expect(artifact).not.toContain("IMPORT_ONLY");
    expect(artifact).not.toContain("DEFAULT_ONLY");
    expect(artifact).not.toContain("unrelated");
    expect(artifact).not.toContain("process");
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("reports a host capability retained by a resolver-selected package entry", async () => {
  const temporary = await mkdtemp(join(resolve(import.meta.dir), "route-package-host-"));
  try {
    const routeFilename = join(temporary, "src/routes/+route.ts");
    await mkdir(join(temporary, "src/routes"), { recursive: true });
    await mkdir(join(temporary, "node_modules/route-policy"), { recursive: true });
    const route = `import { route } from "hesperia/routing";
import { guard } from "route-policy";
export default route({ guard });
`;
    await writeFile(
      join(temporary, "node_modules/route-policy/package.json"),
      JSON.stringify({ name: "route-policy", exports: { ".": { browser: "./browser.ts" } } }),
      "utf8",
    );
    const browserFilename = join(temporary, "node_modules/route-policy/browser.ts");
    await writeFile(browserFilename, `export const guard = () => process.env.ALLOWED;\n`, "utf8");

    const resolver = new ModuleResolver(temporary, new Map([[routeFilename, route]]), "production");
    const result = analyzeRouteModule(route, { filename: routeFilename, resolution: resolver });

    expect(result.artifact).toBeUndefined();
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "HES-ROUTE-CAPABILITY",
        filename: browserFilename,
        message: "Route guard references server capability process.",
      }),
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("reports unresolved host capability from a relative guard module on that module", () => {
  const route = `import { route } from "hesperia/routing";
import { guard } from "../guard.ts";
export default route({ guard });
`;
  const guard = `export const guard = () => process.env.ALLOWED === "yes";
`;
  const result = analyzeRouteModule(route, {
    filename: "src/routes/+route.ts",
    modules: [
      { filename: "src/routes/+route.ts", source: route },
      { filename: "src/guard.ts", source: guard },
    ],
  });
  expect(result.diagnostics).toContainEqual(
    expect.objectContaining({
      code: "HES-ROUTE-CAPABILITY",
      filename: "src/guard.ts",
      message: "Route guard references server capability process.",
    }),
  );
  expect(result.artifact).toBeUndefined();
});

test("classifies co-declared bindings independently of a server-only sibling", () => {
  const source = `import { route } from "hesperia/routing";
const guard = () => true, serverOnly = (() => { if (true) return process.env.SECRET; })();
export default route({ guard, load: async () => ({ serverOnly }) });
`;
  const result = analyzeRouteModule(source, { filename: "src/routes/+route.ts" });

  expect(result.diagnostics).toStrictEqual([]);
  const artifact = JSON.stringify(result.artifact?.modules.map((item) => item.module));
  expect(artifact).toContain("guard");
  expect(artifact).not.toContain("serverOnly");
  expect(artifact).not.toContain("process");
});

test("generated guard closure executes through emitted modules without route-time side effects", async () => {
  const route = `import { route } from "hesperia/routing";
import { guard } from "../guards.ts";
globalThis.__hesperiaRouteSideEffect = true;
export default route({ guard, load: async () => { if (globalThis.__hesperiaRouteLoad) throw new Error("load ran"); return { value: 1 }; }, headers: { "x-route": "server" } });
`;
  const guards = `export function guard({ params }: { params: { id: string } }) { return params.id === "ok"; }
export const unrelated = () => { throw new Error("unrelated declaration ran"); };
`;
  const result = analyzeRouteModule(route, {
    filename: "src/routes/+route.ts",
    modules: [
      { filename: "src/routes/+route.ts", source: route },
      { filename: "src/guards.ts", source: guards },
    ],
  });
  expect(result.diagnostics).toStrictEqual([]);
  expect(result.artifact).toBeDefined();

  const temporary = await mkdtemp(join(resolve(import.meta.dir), "route-artifact-"));
  try {
    await writeFile(join(temporary, "runtime-stub.mjs"), "export {};", "utf8");
    for (const item of result.artifact!.modules) {
      expect(item.map).toBeDefined();
      const generated = generateModule(item.module, {
        filename: item.filename,
        runtimeModule: "../../runtime-stub.mjs",
        source: item.source,
        clientBindings: new Map(),
      });
      const output = join(temporary, item.filename);
      await Bun.write(output, generated.code);
      if (item.filename.endsWith("+route.ts"))
        expect(generated.code).toContain("export default guard");
      expect(generated.code).not.toContain("__hesperiaRouteSideEffect");
      expect(generated.code).not.toContain("__hesperiaRouteLoad");
      expect(generated.code).not.toContain("unrelated");
    }
    const module = await import(
      `${pathToFileURL(join(temporary, "src/routes/+route.ts")).href}?route-test=${Date.now()}`
    );
    expect(module.default({ params: { id: "ok" } })).toBe(true);
    expect(module.default({ params: { id: "blocked" } })).toBe(false);
    expect(
      (globalThis as { __hesperiaRouteSideEffect?: unknown }).__hesperiaRouteSideEffect,
    ).toBeUndefined();
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("follows a relative default-exported guard through generated modules", async () => {
  const route = `import { route } from "hesperia/routing";
import guard from "../guard.ts";
export default route({ guard });
`;
  const guard = `const guard = () => true;
export default guard;
`;
  const result = analyzeRouteModule(route, {
    filename: "src/routes/+route.ts",
    modules: [
      { filename: "src/routes/+route.ts", source: route },
      { filename: "src/guard.ts", source: guard },
    ],
  });
  expect(result.diagnostics).toStrictEqual([]);
  expect(result.artifact?.entry.name).toBe("guard");

  const temporary = await mkdtemp(join(resolve(import.meta.dir), "route-default-artifact-"));
  try {
    await writeFile(join(temporary, "runtime-stub.mjs"), "export {};", "utf8");
    for (const item of result.artifact!.modules) {
      const generated = generateModule(item.module, {
        filename: item.filename,
        runtimeModule: "../../runtime-stub.mjs",
        source: item.source,
        clientBindings: new Map(),
      });
      await Bun.write(join(temporary, item.filename), generated.code);
    }
    const module = await import(
      `${pathToFileURL(join(temporary, "src/routes/+route.ts")).href}?default-route-test=${Date.now()}`
    );
    expect(module.default()).toBe(true);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
