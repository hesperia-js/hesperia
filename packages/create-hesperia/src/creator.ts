import { constants } from "node:fs";
import { copyFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { elysiaTemplate } from "./templates/elysia.ts";
import { frontendTemplate } from "./templates/frontend.ts";

export type HostIntegration = "elysia" | "none";

export interface PreparedProject {
  readonly packageName: string;
  readonly projectRoot: string;
}

const templateRoot = fileURLToPath(new URL("../templates/", import.meta.url));
const projectNamePlaceholder = "HESPERIA_PROJECT_NAME";
const projectNameFiles = new Set(["package.json", "app.tsx", "README.md"]);

function packageNameFor(destination: string): string {
  const name = basename(destination)
    .toLowerCase()
    .replace(/[^a-z0-9-]+/gu, "-")
    .replace(/-+/gu, "-")
    .replace(/^-|-$/gu, "");

  return name || "hesperia-app";
}

/** Create an empty destination or reject an existing nonempty one before writing templates. */
export async function prepareProject(destination: string): Promise<PreparedProject> {
  const projectRoot = resolve(destination);

  await mkdir(projectRoot, { recursive: true });

  if ((await readdir(projectRoot)).length > 0) {
    throw new Error(`Destination must be empty: ${projectRoot}`);
  }

  return { packageName: packageNameFor(projectRoot), projectRoot };
}

/** Write the selected starter without overwriting any files created since preparation. */
export async function writeProject(
  project: PreparedProject,
  hostIntegration: HostIntegration,
): Promise<void> {
  const templateFiles = new Map<
    string,
    { readonly variant: "frontend" | "elysia"; readonly assetPath: string }
  >();

  for (const [relativePath, assetPath] of frontendTemplate) {
    templateFiles.set(relativePath, { variant: "frontend", assetPath });
  }

  if (hostIntegration === "elysia") {
    for (const [relativePath, assetPath] of elysiaTemplate) {
      templateFiles.set(relativePath, { variant: "elysia", assetPath });
    }
  }

  for (const [relativePath, template] of templateFiles) {
    const filename = join(project.projectRoot, relativePath);

    await mkdir(dirname(filename), { recursive: true });

    const source = join(templateRoot, template.variant, template.assetPath);

    if (projectNameFiles.has(relativePath)) {
      const text = await readFile(source, "utf8");

      await writeFile(filename, text.replaceAll(projectNamePlaceholder, project.packageName), {
        encoding: "utf8",
        flag: "wx",
      });
    } else {
      await copyFile(source, filename, constants.COPYFILE_EXCL);
    }
  }
}

/** Install using the current Bun executable and the caller's output file descriptors. */
export async function installDependencies(
  project: PreparedProject,
  output: { readonly stdout: number; readonly stderr: number },
): Promise<void> {
  const installation = Bun.spawn([process.execPath, "install"], {
    cwd: project.projectRoot,
    stdout: output.stdout,
    stderr: output.stderr,
  });

  const exitCode = await installation.exited;

  if (exitCode !== 0) {
    throw new Error(`Dependency installation failed with exit code ${exitCode}.`);
  }
}
