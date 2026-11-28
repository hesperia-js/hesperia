import { readFile, realpath } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";

interface PackageOwner {
  readonly name: string;
  readonly root: string;
}

function samePath(left: string, right: string): boolean {
  const a = resolve(left);
  const b = resolve(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function withinPath(path: string, root: string): boolean {
  const prefix = `${resolve(root)}${sep}`;
  return process.platform === "win32"
    ? path.toLowerCase().startsWith(prefix.toLowerCase())
    : path.startsWith(prefix);
}

export async function verifyAeoliaInputs(
  inputs: readonly string[],
  expectedRoot: string,
): Promise<string[]> {
  const expected = await realpath(expectedRoot);
  const owners = new Map<string, Promise<PackageOwner | undefined>>();

  function ownerOf(directory: string): Promise<PackageOwner | undefined> {
    const existing = owners.get(directory);

    if (existing) return existing;

    const lookup = (async (): Promise<PackageOwner | undefined> => {
      try {
        const manifest = JSON.parse(await readFile(resolve(directory, "package.json"), "utf8")) as {
          name?: unknown;
        };

        if (typeof manifest.name === "string") return { name: manifest.name, root: directory };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }

      const parent = dirname(directory);
      return parent === directory ? undefined : ownerOf(parent);
    })();

    owners.set(directory, lookup);

    return lookup;
  }

  const aeoliaInputs: string[] = [];

  for (const input of inputs) {
    const physical = await realpath(input);
    const owner = await ownerOf(dirname(physical));

    if (owner?.name !== "aeolia") continue;

    if (!samePath(owner.root, expected) || !withinPath(physical, resolve(expected, "dist"))) {
      throw new Error(`Golden bundle loaded Aeolia outside its emitted dist: ${physical}`);
    }

    aeoliaInputs.push(physical);
  }

  if (aeoliaInputs.length === 0)
    throw new Error("Golden bundles did not include public Aeolia dist inputs");

  return aeoliaInputs;
}
