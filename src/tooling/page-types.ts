import { randomUUID } from "node:crypto";
import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { generatePageDeclarations, PAGE_DECLARATION_MARKER } from "../compiler/page-types.ts";

/**
 * Publish the root route declaration from the same source snapshot used for checking.
 *
 * Unchanged output is not rewritten. An existing authored file is never replaced;
 * only a declaration carrying the compiler's generated-file marker may be updated.
 * Generation and filesystem errors reject without publishing partial declarations.
 * @param root - Application project directory.
 * @param sources - Current authored source snapshot, including route file paths.
 * @returns Absolute filename of the generated root declaration.
 */
export async function writeProjectTypes(
  root: string,
  sources: ReadonlyMap<string, string>,
): Promise<string> {
  root = resolve(root);
  const { declaration, routeError } = generatePageDeclarations(
    [...sources].map(([filename, source]) => ({ filename, source })),
    { root },
  );
  if (routeError) throw routeError;
  const filename = declaration.filename;
  let previous: string | undefined;
  try {
    previous = await readFile(filename, "utf8");
  } catch (error) {
    if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT"))
      throw error;
  }
  if (previous === declaration.source) return filename;
  if (previous !== undefined && !previous.startsWith(PAGE_DECLARATION_MARKER))
    throw new Error(`${filename} contains authored declarations; Hesperia will not overwrite it.`);
  const temporary = `${filename}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, declaration.source, { flag: "wx" });
    await rename(temporary, filename);
  } finally {
    await unlink(temporary).catch((error: unknown) => {
      if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT"))
        throw error;
    });
  }
  return filename;
}
