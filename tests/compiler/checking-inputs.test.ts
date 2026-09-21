import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CheckingInputSnapshot } from "../../src/compiler/checking-inputs.ts";
import { checkProjectModules } from "../../src/compiler/checking.ts";

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
    const selected = checkProjectModules([entry], { root });
    expect(selected.diagnostics).toStrictEqual([]);
    expect(selected.checkingInputs.some((input) => input.filename === dependency)).toBe(false);
    const included = checkProjectModules([entry, other], { root });
    expect(included.diagnostics).toStrictEqual([]);
    expect(included.checkingInputs.some((input) => input.filename === dependency)).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
