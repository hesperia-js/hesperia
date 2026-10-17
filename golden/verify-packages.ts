import { createRequire } from "node:module";
import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

function samePath(left: string, right: string): boolean {
  const a = resolve(left);
  const b = resolve(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

async function publicPath(specifier: string): Promise<string> {
  return realpath(fileURLToPath(import.meta.resolve(specifier)));
}

/** Prove the golden applications use the local workspace packages and one Aeolia engine. */
export async function verifyWorkspacePackages(): Promise<void> {
  const workspace = resolve(import.meta.dir, "..");
  const aeoliaRoot = await realpath(resolve(workspace, "node_modules/aeolia"));
  const [hesperia, compiler, tooling, client, runtime, aeolia] = await Promise.all([
    publicPath("hesperia"),
    publicPath("@hesperia/compiler"),
    publicPath("@hesperia/tooling/project-service"),
    publicPath("hesperia/client"),
    publicPath("hesperia/runtime"),
    publicPath("aeolia"),
  ]);
  const expected = [
    [hesperia, resolve(workspace, "packages/hesperia/dist/index.js")],
    [compiler, resolve(workspace, "packages/compiler/dist/index.js")],
    [tooling, resolve(workspace, "packages/tooling/dist/project-service.js")],
    [client, resolve(workspace, "packages/hesperia/dist/client.js")],
    [runtime, resolve(workspace, "packages/hesperia/dist/runtime/index.js")],
    [aeolia, resolve(aeoliaRoot, "dist/index.js")],
  ] as const;

  for (const [actual, path] of expected) {
    if (!samePath(actual, await realpath(path)))
      throw new Error(`Public package export resolved to ${actual}, expected ${path}`);
  }

  const fromRuntime = await realpath(createRequire(runtime).resolve("aeolia"));
  const fromCompiler = await realpath(createRequire(compiler).resolve("hesperia/runtime"));

  if (!samePath(fromRuntime, aeolia) || !samePath(fromCompiler, runtime))
    throw new Error("Golden and Hesperia packages resolved duplicate runtime or Aeolia entries");

  console.log(
    `[hesperia-golden] public workspace exports verified: ${hesperia}; ${compiler}; ${tooling}; ${client}`,
  );

  console.log(
    `[hesperia-golden] shared runtime and Aeolia entries verified: ${runtime}; ${aeolia}`,
  );
}

if (import.meta.main) await verifyWorkspacePackages();
