import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { ModuleResolver } from "../../src/compiler/module-resolution.ts";

function temporaryProject(): string {
  const parent = resolve(import.meta.dir, "../../.hesperia");
  mkdirSync(parent, { recursive: true });
  return mkdtempSync(join(parent, "module-resolution-"));
}

function write(root: string, filename: string, contents: string): string {
  const path = join(root, filename);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
  return path;
}

function writePackage(
  root: string,
  name: string,
  manifest: unknown,
  files: Record<string, string>,
) {
  const directory = join(root, "node_modules", name);
  mkdirSync(directory, { recursive: true });
  const packageFields = manifest && typeof manifest === "object" ? manifest : {};
  writeFileSync(join(directory, "package.json"), JSON.stringify({ name, ...packageFields }));
  for (const [filename, source] of Object.entries(files)) {
    const path = join(directory, filename);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, source);
  }
}

test("linked imports and the compiler entry share one captured module identity", () => {
  const root = temporaryProject();
  try {
    const entry = write(root, "packages/shared/index.js", "export const state = {};");
    write(
      root,
      "packages/shared/package.json",
      JSON.stringify({ name: "shared", exports: "./index.js" }),
    );
    const app = write(root, "application/app.ts", "");
    const library = write(root, "library/index.js", "");
    for (const location of ["application", "library"]) {
      const modules = join(root, location, "node_modules");
      mkdirSync(modules, { recursive: true });
      symlinkSync(join(root, "packages/shared"), join(modules, "shared"), "junction");
    }
    const resolver = new ModuleResolver(root, new Map(), "development");
    const applicationImport = resolver.resolve(app, "shared");
    writeFileSync(entry, "throw new Error('must keep captured bytes');");
    const libraryImport = resolver.resolve(library, "shared");
    const runtimeImport = resolver.resolveCompilerEntry(app, "runtime", entry);
    expect(applicationImport.kind).toBe("resolved");
    expect(libraryImport.kind).toBe("resolved");
    expect(runtimeImport.kind).toBe("resolved");
    if (
      applicationImport.kind !== "resolved" ||
      libraryImport.kind !== "resolved" ||
      runtimeImport.kind !== "resolved"
    )
      return;
    expect(libraryImport.filename).toBe(applicationImport.filename);
    expect(runtimeImport.filename).toBe(applicationImport.filename);
    expect(libraryImport.source).toBe("export const state = {};");
    expect(runtimeImport.source).toBe(applicationImport.source);
    expect(resolver.capturedSources).toHaveLength(1);
    expect(
      resolver.capturedManifests.filter((manifest) => manifest.packageName === "shared"),
    ).toHaveLength(1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test.each(["development", "production"] as const)(
  "selects the mode-specific browser export and records its condition path: %s",
  (mode) => {
    const root = temporaryProject();
    try {
      const app = write(root, "app.tsx", "export default 1;");
      writePackage(
        root,
        "conditions",
        {
          exports: {
            ".": {
              browser: {
                development: "./development.js",
                production: "./production.js",
              },
              import: "./import.js",
              default: "./default.js",
            },
          },
        },
        {
          "development.js": "export const source = 'development';",
          "production.js": "export const source = 'production';",
          "import.js": "export const source = 'import';",
          "default.js": "export const source = 'default';",
        },
      );
      const resolver = new ModuleResolver(
        root,
        new Map([[join(root, "app.tsx"), "export default 1;"]]),
        mode,
      );
      const result = resolver.resolve(app, "conditions");
      expect(result.kind).toBe("resolved");
      if (result.kind !== "resolved") return;
      expect(result.source).toContain(`source = '${mode}'`);
      expect(result.provenance.conditionPath).toEqual([".", "browser", mode]);
      expect(result.provenance.conditions).toEqual(["browser", "default", mode, "import"].sort());
      expect(resolver.capturedEdges).toHaveLength(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test("resolution does not treat a browser condition as a capability-safety claim", () => {
  const root = temporaryProject();
  try {
    const app = join(root, "app.tsx");
    writeFileSync(app, "export default 1;");
    writePackage(
      root,
      "unsafe-browser",
      { exports: { browser: "./browser.js", default: "./default.js" } },
      {
        "browser.js": "import fs from 'node:fs'; export const value = fs;",
        "default.js": "export const value = 'default';",
      },
    );
    const result = new ModuleResolver(
      root,
      new Map([[app, "export default 1;"]]),
      "production",
    ).resolve(app, "unsafe-browser");
    expect(result.kind).toBe("resolved");
    if (result.kind === "resolved") expect(result.source).toContain("node:fs");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an unmatched exports map fails without falling back to main", () => {
  const root = temporaryProject();
  try {
    const app = join(root, "app.tsx");
    writeFileSync(app, "export default 1;");
    writePackage(
      root,
      "no-browser",
      { exports: { node: "./node.js" }, main: "./main.js" },
      {
        "node.js": "export const value = 'node';",
        "main.js": "export const value = 'main';",
      },
    );
    const result = new ModuleResolver(
      root,
      new Map([[app, "export default 1;"]]),
      "production",
    ).resolve(app, "no-browser");
    expect(result).toMatchObject({ kind: "failure", code: "EXPORTS_NO_MATCH" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("conditional export sugar only applies to the package root", () => {
  const root = temporaryProject();
  try {
    const app = write(root, "app.tsx", "export default 1;");
    writePackage(
      root,
      "sugar",
      { exports: { browser: "./browser.js", default: "./default.js" } },
      {
        "browser.js": "export const value = 'browser';",
        "default.js": "export const value = 'default';",
      },
    );
    const resolver = new ModuleResolver(root, new Map([[app, "export default 1;"]]), "production");
    expect(resolver.resolve(app, "sugar")).toMatchObject({ kind: "resolved" });
    expect(resolver.resolve(app, "sugar/hidden")).toMatchObject({
      kind: "failure",
      code: "EXPORTS_NO_MATCH",
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("exact exports win over wildcard exports and longer wildcards win over shorter ones", () => {
  const root = temporaryProject();
  try {
    const app = write(root, "app.tsx", "export default 1;");
    writePackage(
      root,
      "patterns",
      {
        exports: {
          "./*": "./broad/*.js",
          "./feature": "./exact.js",
          "./feature/*": "./specific/*.js",
        },
      },
      {
        "broad/feature.js": "export const value = 'broad';",
        "exact.js": "export const value = 'exact';",
        "specific/item.js": "export const value = 'specific';",
      },
    );
    const resolver = new ModuleResolver(root, new Map([[app, "export default 1;"]]), "production");
    const exact = resolver.resolve(app, "patterns/feature");
    const specific = resolver.resolve(app, "patterns/feature/item");
    expect(exact.kind === "resolved" ? exact.source : "").toContain("exact");
    expect(specific.kind === "resolved" ? specific.source : "").toContain("specific");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a matched conditional null blocks later conditions while array null permits fallback", () => {
  const root = temporaryProject();
  try {
    const app = write(root, "app.tsx", "export default 1;");
    writePackage(
      root,
      "null-conditions",
      { exports: { browser: null, default: "./default.js" } },
      { "default.js": "export const value = 'default';" },
    );
    writePackage(
      root,
      "null-array",
      { exports: [null, "./fallback.js"] },
      { "fallback.js": "export const value = 'fallback';" },
    );
    const resolver = new ModuleResolver(root, new Map([[app, "export default 1;"]]), "production");
    expect(resolver.resolve(app, "null-conditions")).toMatchObject({
      kind: "failure",
      code: "EXPORTS_BLOCKED",
    });
    expect(resolver.resolve(app, "null-array")).toMatchObject({ kind: "resolved" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("malformed manifests are authoritative failures", () => {
  const root = temporaryProject();
  try {
    const app = write(root, "app.tsx", "export default 1;");
    const directory = join(root, "node_modules", "broken");
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "package.json"), "{ invalid");
    const result = new ModuleResolver(
      root,
      new Map([[app, "export default 1;"]]),
      "production",
    ).resolve(app, "broken");
    expect(result).toMatchObject({ kind: "failure", code: "INVALID_PACKAGE" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("package target restrictions reject node_modules and dot segments but decode safe percent escapes", () => {
  const root = temporaryProject();
  try {
    const app = write(root, "app.tsx", "export default 1;");
    writePackage(
      root,
      "target-rules",
      {
        exports: {
          "./node": "./node_modules/file.js",
          "./dot": "././entry.js",
          "./space": "./foo%20bar.js",
        },
      },
      {
        "foo bar.js": "export const value = 'space';",
        "entry.js": "export const value = 'entry';",
      },
    );
    const resolver = new ModuleResolver(root, new Map([[app, "export default 1;"]]), "production");
    expect(resolver.resolve(app, "target-rules/node")).toMatchObject({
      kind: "failure",
      code: "INVALID_PACKAGE_TARGET",
    });
    expect(resolver.resolve(app, "target-rules/dot")).toMatchObject({
      kind: "failure",
      code: "INVALID_PACKAGE_TARGET",
    });
    const space = resolver.resolve(app, "target-rules/space");
    expect(space.kind === "resolved" ? space.source : "").toContain("space");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("integer condition keys are invalid package configuration", () => {
  const root = temporaryProject();
  try {
    const app = write(root, "app.tsx", "export default 1;");
    writePackage(
      root,
      "integer-condition",
      { exports: { "0": "./zero.js", default: "./default.js" } },
      {
        "zero.js": "export const value = 'zero';",
        "default.js": "export const value = 'default';",
      },
    );
    const result = new ModuleResolver(
      root,
      new Map([[app, "export default 1;"]]),
      "production",
    ).resolve(app, "integer-condition");
    expect(result).toMatchObject({ kind: "failure", code: "INVALID_PACKAGE" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("array resolution skips invalid targets but does not skip a valid missing target", () => {
  const root = temporaryProject();
  try {
    const app = join(root, "app.tsx");
    writeFileSync(app, "export default 1;");
    writePackage(
      root,
      "array-targets",
      { exports: ["../escape.js", "./missing.js", "./fallback.js"] },
      { "fallback.js": "export const value = 'fallback';" },
    );
    const result = new ModuleResolver(
      root,
      new Map([[app, "export default 1;"]]),
      "production",
    ).resolve(app, "array-targets");
    expect(result).toMatchObject({ kind: "failure", code: "MODULE_NOT_FOUND" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("captured dependency bytes remain stable after the file changes on disk", () => {
  const root = temporaryProject();
  try {
    const app = join(root, "app.tsx");
    writeFileSync(app, "export default 1;");
    writePackage(
      root,
      "stable",
      { exports: "./entry.js" },
      { "entry.js": "export const value = 'first';" },
    );
    const resolver = new ModuleResolver(root, new Map([[app, "export default 1;"]]), "production");
    const first = resolver.resolve(app, "stable");
    expect(first.kind).toBe("resolved");
    writeFileSync(
      join(root, "node_modules", "stable", "entry.js"),
      "export const value = 'second';",
    );
    const second = resolver.resolve(app, "stable");
    expect(second).toEqual(first);
    expect(
      resolver.capturedSources.find((item) =>
        item.filename.replaceAll("\\", "/").endsWith("stable/entry.js"),
      )?.source,
    ).toContain("first");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a failed self-reference does not fall through to a shadowing node_modules package", () => {
  const root = temporaryProject();
  try {
    const app = join(root, "app.tsx");
    writeFileSync(app, "export default 1;");
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ name: "shadowed", exports: { "./allowed": "./allowed.js" } }),
    );
    writeFileSync(join(root, "allowed.js"), "export const value = 'root';");
    writePackage(
      root,
      "shadowed",
      { exports: { "./missing": "./node_modules.js" } },
      { "node_modules.js": "export const value = 'shadow';" },
    );
    const result = new ModuleResolver(
      root,
      new Map([[app, "export default 1;"]]),
      "production",
    ).resolve(app, "shadowed/missing");
    expect(result).toMatchObject({ kind: "failure", code: "EXPORTS_NO_MATCH" });
    expect(result.kind === "resolved" ? result.filename : "").not.toContain("node_modules");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("missing manifest observations remain stable after a package appears on disk", () => {
  const root = temporaryProject();
  try {
    const app = write(root, "app.tsx", "export default 1;");
    const resolver = new ModuleResolver(root, new Map([[app, "export default 1;"]]), "production");
    const first = resolver.resolve(app, "late");
    expect(first).toMatchObject({ kind: "failure", code: "PACKAGE_NOT_FOUND" });
    writePackage(
      root,
      "late",
      { exports: "./entry.js" },
      { "entry.js": "export const value = 'late';" },
    );
    expect(resolver.resolve(app, "late")).toEqual(first);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("applies exact browser overrides to root-relative local modules", () => {
  const root = temporaryProject();
  try {
    const app = write(root, "app.tsx", 'import { value } from "some-package"; export { value };');
    const replacement = write(
      root,
      "src/browser-replacement.ts",
      "export const value = 'replacement';",
    );
    writePackage(
      root,
      "some-package",
      { exports: "./entry.js" },
      { "entry.js": "export const value = 'package';" },
    );
    const resolver = new ModuleResolver(root, new Map([[app, "export {};"]]), "production", {
      "some-package": "./src/browser-replacement.ts",
    });
    const selected = resolver.resolve(app, "some-package");
    expect(selected).toMatchObject({ kind: "resolved", filename: replacement });
    expect(selected.kind === "resolved" ? selected.source : "").toContain("replacement");
    expect(selected.kind === "resolved" ? selected.provenance.conditionPath : []).toEqual([
      "override",
      "some-package",
      "./src/browser-replacement.ts",
    ]);
    expect(resolver.resolve(app, "some-package/subpath")).toMatchObject({
      kind: "failure",
      code: "EXPORTS_NO_MATCH",
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("resolves bare override targets through browser package conditions without chaining overrides", () => {
  const root = temporaryProject();
  try {
    const app = write(root, "app.tsx", "export default 1;");
    writePackage(
      root,
      "source-package",
      { exports: { ".": { browser: "./browser.js", default: "./server.js" } } },
      {
        "browser.js": "export const value = 'browser';",
        "server.js": "export const value = 'server';",
      },
    );
    const resolver = new ModuleResolver(root, new Map([[app, "export {};"]]), "production", {
      "some-package": "source-package",
      "source-package": "./should-not-be-selected.ts",
    });
    const selected = resolver.resolve(app, "some-package");
    expect(selected).toMatchObject({
      kind: "resolved",
      filename: join(root, "node_modules/source-package/browser.js"),
    });
    expect(selected.kind === "resolved" ? selected.provenance.conditionPath : []).toEqual([
      "override",
      "some-package",
      "source-package",
      ".",
      "browser",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("does not treat inherited object properties as browser overrides", () => {
  const root = temporaryProject();
  try {
    const app = write(root, "app.tsx", "export default 1;");
    const resolver = new ModuleResolver(root, new Map([[app, "export {};"]]), "production", {});
    expect(resolver.resolve(app, "toString")).toMatchObject({
      kind: "failure",
      code: "PACKAGE_NOT_FOUND",
    });
    expect(resolver.resolve(app, "__proto__")).toMatchObject({
      kind: "failure",
      code: "PACKAGE_NOT_FOUND",
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a missing root-relative override never falls back to the generated directory", () => {
  const root = temporaryProject();
  try {
    const app = write(root, "app.tsx", "export default 1;");
    write(root, ".hesperia/src/replacement.ts", "export const value = 'wrong directory';");
    const resolver = new ModuleResolver(root, new Map([[app, "export default 1;"]]), "production", {
      "some-package": "./src/replacement.ts",
    });
    expect(resolver.resolve(app, "some-package")).toMatchObject({
      kind: "failure",
      code: "MODULE_NOT_FOUND",
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("applies exact relative import overrides and resolves targets from the project root", () => {
  const root = temporaryProject();
  const replacementName = `${basename(root)}-replacement.ts`;
  const replacement = join(dirname(root), replacementName);
  try {
    const app = write(
      root,
      "src/routes/+page.tsx",
      'import { value } from "./local.ts"; export { value };',
    );
    write(dirname(root), replacementName, "export const value = 'replacement';");
    const resolver = new ModuleResolver(root, new Map([[app, "export {};"]]), "production", {
      "./local.ts": `../${replacementName}`,
    });
    const selected = resolver.resolve(app, "./local.ts");
    expect(selected).toMatchObject({ kind: "resolved", filename: replacement });
    expect(selected.kind === "resolved" ? selected.source : "").toContain("replacement");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(replacement, { force: true });
  }
});
