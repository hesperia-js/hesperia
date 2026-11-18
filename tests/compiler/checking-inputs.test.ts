import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CheckingInputSnapshot } from "../../packages/compiler/src/checking-inputs.ts";
import {
  checkedAnalysisOrigin,
  checkedSourceOrigin,
} from "../../packages/compiler/src/checking-origin.ts";
import { checkProjectModules, openCheckingProject } from "../../packages/compiler/src/checking.ts";
import { ModuleResolver } from "../../packages/compiler/src/module-resolution.ts";
import { emitCheckingSession } from "../../packages/compiler/src/project-compilation.ts";
import {
  issuedProjectTypingEvidence,
  requestTypingEvidenceCapture,
} from "../../packages/compiler/src/typing-inputs.ts";
import { normalizeFilename } from "../../packages/compiler/src/utils.ts";

test("typing evidence stays tied to the actual emitted module population", async () => {
  const root = await mkdtemp(join(tmpdir(), "hesperia-typing-evidence-"));
  const filename = join(root, "entry.ts");
  let session: Awaited<ReturnType<typeof openCheckingProject>> | undefined;

  try {
    session = await openCheckingProject(
      [{ filename, source: "export const value: string = 'ok';" }],
      requestTypingEvidenceCapture({ root }),
    );
    const result = session.result;
    const origin = checkedSourceOrigin(session, result);
    const analysis = session.analyses.get(filename);
    expect(origin).toBeDefined();
    expect(checkedSourceOrigin(session, { ...result })).toBeUndefined();
    expect(analysis && checkedAnalysisOrigin(analysis)?.origin).toBe(origin);
    const compilation = emitCheckingSession(session);
    const evidence = issuedProjectTypingEvidence(compilation);
    const emitted = compilation.modules.get(filename);

    expect(compilation.checking.diagnostics.filter((item) => item.severity === "error")).toEqual(
      [],
    );
    expect(emitted).toBeDefined();
    expect(evidence).toMatchObject({
      state: "sealed",
      captureState: "incomplete-capture",
      projectPolicy: { kind: "unproved" },
      modulePopulationJoin: true,
    });
    expect(evidence?.modules.map((item) => item.filename)).toEqual([filename]);

    const modules = compilation.modules as Map<string, NonNullable<typeof emitted>>;
    modules.delete(filename);
    expect(issuedProjectTypingEvidence(compilation)).toBeUndefined();
    modules.set(filename, emitted!);
    expect(issuedProjectTypingEvidence(compilation)).toBe(evidence);
    await session.dispose();
    expect(checkedSourceOrigin(session, result)).toBe(origin);
    expect(analysis && checkedAnalysisOrigin(analysis)).toBeUndefined();
    session = undefined;
  } finally {
    await session?.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("checked origin retains an emitted JSX component and its checked props", async () => {
  const filename = "checked-origin-component.tsx";
  const source = `import { type Component } from "hesperia";
export function formatTitle(value: string) {
  return value.trim();
}
export function Page(props: Component.Props<{ title: string; serial: bigint }>) {
  return <main>{props.title()}</main>;
}`;
  const session = await openCheckingProject(
    [{ filename, source }],
    requestTypingEvidenceCapture({ root: join(import.meta.dir, "../..") }),
  );

  try {
    const checking = session.result;
    const origin = checkedSourceOrigin(session, checking);
    const analysis = session.analyses.get(filename);
    const compilation = emitCheckingSession(session);
    const evidence = issuedProjectTypingEvidence(compilation);
    const sourceDigest = `sha256-${createHash("sha256").update(source).digest("hex")}`;

    expect(checking.diagnostics.filter((item) => item.severity === "error")).toEqual([]);
    expect(analysis?.componentProps?.diagnostics).toEqual([]);
    expect(Object.keys(analysis?.componentProps?.byParameterStart ?? {})).toHaveLength(1);
    expect(origin?.analyses.get(filename)?.analysis).toBe(analysis);
    expect(analysis && checkedAnalysisOrigin(analysis)?.origin).toBe(origin);
    expect(origin?.project).toBe(session.project);
    expect(origin?.population).toHaveLength(1);
    expect(origin?.population[0]).toMatchObject({ filename, source, sourceDigest });
    expect(compilation.modules.get(filename)?.code).toBeTruthy();
    expect(evidence).toMatchObject({
      state: "sealed",
      captureState: "incomplete-capture",
      checkingResultJoin: true,
      analysisJoin: true,
      modulePopulationJoin: true,
    });
    expect(evidence?.modules.map((item) => item.filename)).toEqual([filename]);
    const moduleEvidence = evidence?.modules[0];
    expect(moduleEvidence?.sourceDigest).toBe(sourceDigest);
    expect(moduleEvidence?.sourceJoin).toBe(true);
    expect(moduleEvidence?.components).toHaveLength(1);
    const component = moduleEvidence?.components[0];
    expect(component?.emittedComponentJoin).toBe("matched");
    expect(component?.parameterStart).toBe(source.indexOf("props: Component"));
    expect(component?.props).toMatchObject({
      kind: "props",
      entries: [
        {
          name: "serial",
          category: "value",
          optional: false,
          mappedType: { kind: "unproved", reason: "unsupported-type" },
        },
        {
          name: "title",
          category: "value",
          optional: false,
          mappedType: {
            kind: "structural",
            schema: 1,
            algorithm: "ts-shape-v1",
            shape: { kind: "primitive", name: "string" },
          },
        },
      ],
    });
  } finally {
    await session.dispose();
  }
});

test("captures a declaration on first existence check and keeps its bytes immutable", async () => {
  const root = await mkdtemp(join(tmpdir(), "hesperia-checking-inputs-"));
  const physicalRoot = join(root, "physical");
  const aliasRoot = join(root, "alias");
  const declaration = join(physicalRoot, "node_modules/replacement/types/api.d.ts");
  const aliasedDeclaration = join(aliasRoot, "node_modules/replacement/types/api.d.ts");

  try {
    await mkdir(physicalRoot);
    await symlink(physicalRoot, aliasRoot, process.platform === "win32" ? "junction" : "dir");
    await mkdir(join(physicalRoot, "node_modules/replacement/types"), { recursive: true });

    await writeFile(declaration, "export declare const label: string;", { encoding: "utf8" });

    const snapshot = new CheckingInputSnapshot(new Map());

    expect(snapshot.fileExists(declaration)).toBe(true);

    expect(snapshot.captured).toHaveLength(1);

    const captured = snapshot.captured[0]!;

    expect(captured.filename).toBe(declaration);

    expect(captured.source).toContain("label: string");

    await writeFile(declaration, "export declare const label: number;", { encoding: "utf8" });

    expect(snapshot.readFile(declaration)).toBe(captured.source);

    expect(snapshot.readFile(aliasedDeclaration)).toBe(captured.source);

    expect(snapshot.captured[0]!.digest).toBe(captured.digest);

    await rm(declaration);

    expect(snapshot.fileExists(declaration)).toBe(true);

    expect(snapshot.fileExists(aliasedDeclaration)).toBe(true);

    expect(snapshot.readFile(declaration)).toBe(captured.source);

    expect(snapshot.readFile(aliasedDeclaration)).toBe(captured.source);

    const virtual = new CheckingInputSnapshot(
      new Map([
        [normalizeFilename(aliasedDeclaration), "virtual alias source"],
        [normalizeFilename(declaration), "virtual physical source"],
      ]),
    );

    expect(virtual.readFile(declaration)).toBe("virtual physical source");

    expect(virtual.readFile(aliasedDeclaration)).toBe("virtual alias source");

    const lateFiles = new Map<string, string>();
    const lateVirtual = new CheckingInputSnapshot(lateFiles);

    lateFiles.set(normalizeFilename(aliasedDeclaration), "virtual alias source added later");

    expect(lateVirtual.readFile(declaration)).toBe("virtual alias source added later");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("remembers a missing declaration instead of falling back after it appears", async () => {
  const root = await mkdtemp(join(tmpdir(), "hesperia-checking-inputs-"));
  const physicalRoot = join(root, "physical");
  const aliasRoot = join(root, "alias");
  const declaration = join(physicalRoot, "node_modules/replacement/types/api.d.ts");
  const aliasedDeclaration = join(aliasRoot, "node_modules/replacement/types/api.d.ts");

  try {
    await mkdir(physicalRoot);
    await symlink(physicalRoot, aliasRoot, process.platform === "win32" ? "junction" : "dir");

    const snapshot = new CheckingInputSnapshot(new Map());

    expect(snapshot.fileExists(declaration)).toBe(false);

    await mkdir(join(physicalRoot, "node_modules/replacement/types"), { recursive: true });

    await writeFile(declaration, "export declare const label: string;", { encoding: "utf8" });

    expect(snapshot.fileExists(declaration)).toBe(false);

    expect(snapshot.fileExists(aliasedDeclaration)).toBe(false);

    expect(snapshot.readFile(declaration)).toBeNull();

    expect(snapshot.readFile(aliasedDeclaration)).toBeNull();

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

    const declarationIdentity = normalizeFilename(realpathSync(declaration));
    const dependency = (result: typeof initial) =>
      result.checkingInputs.find(
        (input) => normalizeFilename(realpathSync(input.filename)) === declarationIdentity,
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
