import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));

/**
 * Locate this package's declaration sources through its fixed neutral resource module.
 *
 * @param entry - The package entry whose factory declarations are being checked.
 * @param callerUrl - The actual analysis module URL, retaining source-versus-output identity.
 * @returns The caller's original source or shared-output declaration candidates.
 * @throws Error when the caller is outside the owned source and profile directories.
 */
export function elysiaDeclarationCandidates(
  entry: "client" | "effects",
  callerUrl: string,
): readonly string[] {
  const callerDirectory = dirname(fileURLToPath(callerUrl));
  const sourceDirectory = resolve(packageRoot, "src");
  const outputDirectory = resolve(packageRoot, "dist");
  const developmentDirectory = resolve(outputDirectory, "development");
  const sameDirectory = (left: string, right: string): boolean =>
    process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
  const sourceCaller = sameDirectory(callerDirectory, sourceDirectory);

  if (
    !sourceCaller &&
    !sameDirectory(callerDirectory, outputDirectory) &&
    !sameDirectory(callerDirectory, developmentDirectory)
  ) {
    throw new Error(
      "Elysia declaration analysis must run from its package source or profile output.",
    );
  }

  const declarationDirectory = sourceCaller ? sourceDirectory : outputDirectory;

  return [
    resolve(declarationDirectory, `${entry}.ts`),
    resolve(declarationDirectory, `${entry}.d.ts`),
    resolve(outputDirectory, `${entry}.d.ts`),
  ];
}
