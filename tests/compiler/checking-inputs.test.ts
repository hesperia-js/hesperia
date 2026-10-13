import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CheckingInputSnapshot } from "../../packages/compiler/src/checking-inputs.ts";
import { checkProjectModules, openCheckingProject } from "../../packages/compiler/src/checking.ts";
import { ModuleResolver } from "../../packages/compiler/src/module-resolution.ts";

test("captures a declaration on first existence check and keeps its bytes immutable", async () => {
  const root = await mkdtemp(join(tmpdir(), "hesperia-checking-inputs-"));
  const declaration = join(root, "node_modules/replacement/types/api.d.ts");

  try {
    await mkdir(join(root, "node_modules/replacement/types"), { recursive: true });

    await writeFile(declaration, "export declare const label: string;", { encoding: "utf8" });

    const snapshot = new CheckingInputSnapshot(new Map());

    expect(snapshot.fileExists(declaration)).toBe(true);

    expect(snapshot.captured).toHaveLength(1);

    const captured = snapshot.captured[0]!;

    expect(captured.filename).toBe(declaration);

    expect(captured.source).toContain("label: string");

    await writeFile(declaration, "export declare const label: number;", { encoding: "utf8" });

    expect(snapshot.readFile(declaration)).toBe(captured.source);

    expect(snapshot.captured[0]!.digest).toBe(captured.digest);

    await rm(declaration);

    expect(snapshot.fileExists(declaration)).toBe(true);

    expect(snapshot.readFile(declaration)).toBe(captured.source);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("remembers a missing declaration instead of falling back after it appears", async () => {
  const root = await mkdtemp(join(tmpdir(), "hesperia-checking-inputs-"));
  const declaration = join(root, "node_modules/replacement/types/api.d.ts");

  try {
    const snapshot = new CheckingInputSnapshot(new Map());

    expect(snapshot.fileExists(declaration)).toBe(false);

    await mkdir(join(root, "node_modules/replacement/types"), { recursive: true });

    await writeFile(declaration, "export declare const label: string;", { encoding: "utf8" });

    expect(snapshot.fileExists(declaration)).toBe(false);

    expect(snapshot.readFile(declaration)).toBeNull();

    expect(snapshot.captured).toStrictEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("checking captures dependencies of the supplied project without opening an extra workspace project", async () => {
  const root = await mkdtemp(join(tmpdir(), "hesperia-checking-project-"));
  const dependency = join(root, "other-types.d.ts");
  const other = {
    filename: join(root, "other.ts"),
    source: 'import type { Other } from "./other-types.d.ts"; export const other: Other = 1;',
  };
  const entry = { filename: join(root, "entry.ts"), source: "export const value = 1;" };

  try {
    await writeFile(dependency, "export type Other = number;");

    await writeFile(other.filename, other.source);

    await writeFile(
      join(root, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          target: "ESNext",
          module: "ESNext",
          moduleResolution: "Bundler",
          types: [],
          skipLibCheck: true,
        },
        include: ["other.ts"],
      }),
    );

    const selected = await checkProjectModules([entry], { root });

    expect(selected.diagnostics).toStrictEqual([]);

    expect(selected.checkingInputs.some((input) => input.filename === dependency)).toBe(false);

    const included = await checkProjectModules([entry, other], { root });

    expect(included.diagnostics).toStrictEqual([]);

    expect(included.checkingInputs.some((input) => input.filename === dependency)).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("repeated checking retains the captured public type target in dependency records", async () => {
  const root = await mkdtemp(join(tmpdir(), "hesperia-reused-checking-inputs-"));
  const library = join(root, "node_modules/replacement");
  const declaration = join(library, "index.d.ts");
  const entry = {
    filename: join(root, "entry.ts"),
    source: 'import { label } from "chosen-library"; export const display: string = label;',
  };
  const original = "export declare const label: string;";
  const updated = "export declare const label: number;";
  const resolutionOverrides = { browser: { "chosen-library": "replacement" } };

  try {
    await mkdir(library, { recursive: true });

    await writeFile(
      join(library, "package.json"),
      JSON.stringify({
        name: "replacement",
        type: "module",
        exports: { ".": { types: "./index.d.ts", default: "./index.js" } },
      }),
    );

    await writeFile(join(library, "index.js"), 'export const label = "initial";');

    await writeFile(declaration, original);

    const sources = new Map([[entry.filename, entry.source]]);
    const resolution = new ModuleResolver(root, sources, "production", resolutionOverrides.browser);
    const options = { root, resolution, resolutionOverrides, browserTarget: true };
    const initial = await checkProjectModules([entry], options);

    const dependency = (result: typeof initial) =>
      result.checkingInputs.find(
        (input) =>
          input.filename.replaceAll("\\", "/").toLowerCase() ===
          declaration.replaceAll("\\", "/").toLowerCase(),
      );

    expect(initial.diagnostics).toStrictEqual([]);

    expect(dependency(initial)?.source).toBe(original);

    await writeFile(declaration, updated);

    const repeated = await checkProjectModules([entry], options);

    expect(repeated.diagnostics).toStrictEqual([]);

    expect(dependency(repeated)).toStrictEqual(dependency(initial));

    const refreshed = await checkProjectModules([entry], {
      ...options,
      resolution: new ModuleResolver(root, sources, "production", resolutionOverrides.browser),
    });

    expect(refreshed.diagnostics.some((item) => item.code === "TS2322")).toBe(true);

    expect(dependency(refreshed)?.source).toBe(updated);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("each checking project keeps the dependency bytes captured for its own revision", async () => {
  const root = await mkdtemp(join(tmpdir(), "hesperia-checking-revisions-"));
  const dependency = join(root, "dependency.d.ts");
  const entry = join(root, "entry.ts");
  const module = {
    filename: entry,
    source: 'import { value } from "./dependency.d.ts"; export const numeric: number = value;',
  };
  let original: Awaited<ReturnType<typeof openCheckingProject>> | undefined;
  let refreshed: Awaited<ReturnType<typeof openCheckingProject>> | undefined;

  try {
    await writeFile(dependency, "export declare const value: string;");

    original = await openCheckingProject([module], { root });
    const originalInput = original.result.checkingInputs.find(
      (input) =>
        input.filename.replaceAll("\\", "/").toLowerCase() ===
        dependency.replaceAll("\\", "/").toLowerCase(),
    );

    expect(originalInput?.source).toBe("export declare const value: string;");

    expect(original.result.diagnostics.some((item) => item.code === "TS2322")).toBe(true);

    await writeFile(dependency, "export declare const value: number;");

    expect(originalInput?.source).toBe("export declare const value: string;");

    refreshed = await openCheckingProject([module], { root });
    const refreshedInput = refreshed.result.checkingInputs.find(
      (input) =>
        input.filename.replaceAll("\\", "/").toLowerCase() ===
        dependency.replaceAll("\\", "/").toLowerCase(),
    );

    expect(refreshedInput?.source).toBe("export declare const value: number;");

    expect(refreshed.result.diagnostics.some((item) => item.code === "TS2322")).toBe(false);
  } finally {
    await Promise.all([original?.dispose(), refreshed?.dispose()]);

    await rm(root, { recursive: true, force: true });
  }
});
