import { mkdir, symlink, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";

const workspace = resolve(import.meta.dir, "../..");

/** Give an external fixture the same explicit framework dependencies as an application. */
export async function linkFrameworkPackages(
  root: string,
  options: {
    readonly elysia?: boolean;
    readonly eden?: boolean;
    readonly elysiaAdapter?: boolean;
  } = {},
): Promise<void> {
  const modules = join(root, "node_modules");

  await mkdir(join(modules, "@hesperia"), { recursive: true });

  if (options.eden) await mkdir(join(modules, "@elysia"), { recursive: true });

  const packages: [string, string][] = [
    ["hesperia", join(workspace, "packages/hesperia")],
    ["aeolia", join(workspace, "node_modules/aeolia")],
    ["@hesperia/compiler", join(workspace, "packages/compiler")],
    ["@hesperia/tooling", join(workspace, "packages/tooling")],
  ];

  if (options.elysia) packages.push(["elysia", join(workspace, "node_modules/elysia")]);

  if (options.eden) packages.push(["@elysia/eden", join(workspace, "node_modules/@elysia/eden")]);

  if (options.elysiaAdapter)
    packages.push(["@hesperia/elysia", join(workspace, "packages/elysia")]);

  for (const [name, target] of packages) {
    await symlink(target, join(modules, name), "junction");
  }
}

/** Unlink junctions before recursively removing a temporary application on Windows. */
export async function unlinkFrameworkPackages(root: string): Promise<void> {
  const modules = join(root, "node_modules");

  for (const name of [
    "hesperia",
    "aeolia",
    "@hesperia/compiler",
    "@hesperia/tooling",
    "@hesperia/elysia",
    "@elysia/eden",
    "elysia",
  ]) {
    try {
      await unlink(join(modules, name));
    } catch (error) {
      if (
        !(typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")
      )
        throw error;
    }
  }
}
