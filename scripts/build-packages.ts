import { readdir, readFile, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

type JsonRecord = Record<string, unknown>;

interface PackageManifest extends JsonRecord {
  readonly name: string;
  readonly private?: boolean;
  readonly scripts?: JsonRecord;
  readonly exports?: unknown;
  readonly bin?: unknown;
  readonly dependencies?: JsonRecord;
  readonly devDependencies?: JsonRecord;
}

export interface PackageBuildTarget {
  readonly name: string;
  readonly directory: string;
  readonly packageRoot: string;
  readonly exportTargets: readonly string[];
  readonly binTargets: readonly string[];
  readonly workspaceDependencies: readonly string[];
}

interface DiscoveredPackage {
  readonly directoryName: string;
  readonly directory: string;
  readonly manifest: PackageManifest;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isInside(parent: string, child: string): boolean {
  const path = relative(resolve(parent), resolve(child));
  return path !== "" && path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

function parseManifest(value: unknown, manifestPath: string): PackageManifest {
  if (!isRecord(value) || typeof value.name !== "string" || value.name.length === 0) {
    throw new Error(`${manifestPath} must declare a package name`);
  }

  if (value.private !== undefined && typeof value.private !== "boolean") {
    throw new Error(`${manifestPath} has a non-boolean private field`);
  }

  return value as PackageManifest;
}

function collectExportTargets(value: unknown, path: string, targets: Set<string>): void {
  if (typeof value === "string") {
    targets.add(value);

    return;
  }

  if (value === null) return;

  if (Array.isArray(value)) {
    for (const item of value) collectExportTargets(item, path, targets);

    return;
  }

  if (isRecord(value)) {
    for (const [key, item] of Object.entries(value)) {
      collectExportTargets(item, `${path}.${key}`, targets);
    }

    return;
  }

  throw new Error(`Unsupported export target at ${path}`);
}

function validateDistTarget(package_: DiscoveredPackage, target: string, kind: "export" | "bin") {
  if (target.includes("*") || !target.startsWith("./dist/")) {
    throw new Error(
      `Publishable package ${package_.manifest.name} must use explicit ./dist ${kind} targets; received ${target}`,
    );
  }

  const absoluteTarget = resolve(package_.directory, target.slice(2));

  if (!isInside(join(package_.directory, "dist"), absoluteTarget)) {
    throw new Error(
      `${kind === "export" ? "Export" : "Bin"} target ${target} for ${package_.manifest.name} escapes its dist directory`,
    );
  }
}

function readOutputTargets(package_: DiscoveredPackage): {
  exportTargets: string[];
  binTargets: string[];
} {
  const hasExports = package_.manifest.exports !== undefined;
  const hasBin = package_.manifest.bin !== undefined;

  if (!hasExports && !hasBin) {
    throw new Error(
      `Publishable package ${package_.manifest.name} must declare exports or a bin command`,
    );
  }

  if (!Array.isArray(package_.manifest.files) || !package_.manifest.files.includes("dist")) {
    throw new Error(`Publishable package ${package_.manifest.name} must include dist in files`);
  }

  const exportTargets = new Set<string>();

  if (hasExports) {
    const rootExport = isRecord(package_.manifest.exports)
      ? package_.manifest.exports["."]
      : undefined;

    if (!isRecord(rootExport) || typeof rootExport.types !== "string") {
      throw new Error(
        `Publishable package ${package_.manifest.name} must declare exports["."].types`,
      );
    }

    collectExportTargets(package_.manifest.exports, `${package_.directory}/exports`, exportTargets);

    if (exportTargets.size === 0) {
      throw new Error(`Publishable package ${package_.manifest.name} has no export targets`);
    }

    for (const target of exportTargets) validateDistTarget(package_, target, "export");
  }

  const binTargets = new Set<string>();

  if (hasBin) {
    if (typeof package_.manifest.bin === "string") {
      if (package_.manifest.bin.length === 0) {
        throw new Error(`Publishable package ${package_.manifest.name} has an empty bin target`);
      }

      binTargets.add(package_.manifest.bin);
    } else if (isRecord(package_.manifest.bin)) {
      const entries = Object.entries(package_.manifest.bin);

      if (entries.length === 0) {
        throw new Error(`Publishable package ${package_.manifest.name} has no bin targets`);
      }

      for (const [command, target] of entries) {
        if (command.length === 0 || typeof target !== "string" || target.length === 0) {
          throw new Error(
            `Publishable package ${package_.manifest.name} has an invalid bin target`,
          );
        }

        binTargets.add(target);
      }
    } else {
      throw new Error(`Publishable package ${package_.manifest.name} has an invalid bin field`);
    }

    for (const target of binTargets) validateDistTarget(package_, target, "bin");
  }

  return {
    exportTargets: [...exportTargets].sort(),
    binTargets: [...binTargets].sort(),
  };
}

function workspaceDependencies(
  package_: DiscoveredPackage,
  allPackagesByName: ReadonlyMap<string, DiscoveredPackage>,
  buildPackagesByName: ReadonlyMap<string, DiscoveredPackage>,
): string[] {
  const dependencies = new Set<string>();

  for (const section of ["dependencies", "devDependencies"] as const) {
    const values = package_.manifest[section];

    if (values === undefined) continue;

    if (!isRecord(values)) {
      throw new Error(`${package_.directory}/package.json has invalid ${section}`);
    }

    for (const [name, version] of Object.entries(values)) {
      if (typeof version !== "string" || !version.startsWith("workspace:")) continue;

      const dependency = allPackagesByName.get(name);

      if (!dependency) {
        throw new Error(
          `${package_.manifest.name} declares ${name} as a workspace ${section} dependency, but no packages/* manifest provides it`,
        );
      }

      if (dependency.manifest.private === true) {
        throw new Error(
          `${package_.manifest.name} has a workspace dependency on private package ${name}, which is excluded from the root build`,
        );
      }

      if (!buildPackagesByName.has(name)) {
        throw new Error(`Workspace dependency ${name} is missing from the root build inventory`);
      }

      dependencies.add(name);
    }
  }

  return [...dependencies].sort();
}

/**
 * Discover and order every publishable package in the immediate packages directory.
 *
 * Workspace dependencies and development dependencies determine build order. A public
 * package that cannot participate in the build or expose explicit dist files is an error.
 */
export async function discoverPackageBuildPlan(
  workspaceRoot: string,
): Promise<PackageBuildTarget[]> {
  const packagesRoot = join(workspaceRoot, "packages");
  const directoryEntries = await readdir(packagesRoot, { withFileTypes: true });
  const discovered: DiscoveredPackage[] = [];

  for (const entry of directoryEntries.toSorted((left, right) =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
  )) {
    if (!entry.isDirectory()) continue;

    const directory = join(packagesRoot, entry.name);
    const manifestPath = join(directory, "package.json");
    const manifest = parseManifest(
      JSON.parse(await readFile(manifestPath, "utf8")) as unknown,
      relative(workspaceRoot, manifestPath).replaceAll(sep, "/"),
    );

    discovered.push({ directoryName: entry.name, directory, manifest });
  }

  const allPackagesByName = new Map<string, DiscoveredPackage>();

  for (const package_ of discovered) {
    if (allPackagesByName.has(package_.manifest.name)) {
      throw new Error(`Duplicate workspace package name ${package_.manifest.name}`);
    }

    allPackagesByName.set(package_.manifest.name, package_);
  }

  const publishable = discovered.filter((package_) => package_.manifest.private !== true);
  const buildPackagesByName = new Map(
    publishable.map((package_) => [package_.manifest.name, package_]),
  );

  for (const package_ of publishable) {
    if (typeof package_.manifest.scripts?.build !== "string") {
      throw new Error(`Publishable package ${package_.manifest.name} is missing a build script`);
    }
  }

  const targets = publishable.map((package_) => ({
    package: package_,
    ...readOutputTargets(package_),
    dependencies: workspaceDependencies(package_, allPackagesByName, buildPackagesByName),
  }));
  const dependents = new Map<string, string[]>();
  const remainingDependencies = new Map<string, Set<string>>();

  for (const target of targets) {
    remainingDependencies.set(target.package.manifest.name, new Set(target.dependencies));

    for (const dependency of target.dependencies) {
      const packageDependents = dependents.get(dependency) ?? [];

      packageDependents.push(target.package.manifest.name);

      dependents.set(dependency, packageDependents);
    }
  }

  const packageNames = new Map(
    targets.map((target) => [target.package.manifest.name, target.package]),
  );
  const ready = targets
    .filter((target) => target.dependencies.length === 0)
    .map((target) => target.package.manifest.name)
    .sort();
  const ordered: PackageBuildTarget[] = [];

  while (ready.length > 0) {
    const name = ready.shift();

    if (!name) break;

    const package_ = packageNames.get(name);
    const target = targets.find((entry) => entry.package.manifest.name === name);

    if (!package_ || !target) throw new Error(`Missing root build entry for ${name}`);

    ordered.push({
      name,
      directory: `packages/${package_.directoryName}`,
      packageRoot: package_.directory,
      exportTargets: target.exportTargets,
      binTargets: target.binTargets,
      workspaceDependencies: target.dependencies,
    });

    for (const dependent of dependents.get(name) ?? []) {
      const dependencies = remainingDependencies.get(dependent);

      dependencies?.delete(name);

      if (dependencies?.size === 0) {
        ready.push(dependent);

        ready.sort();
      }
    }
  }

  if (ordered.length !== publishable.length) {
    const cyclic = [...remainingDependencies.entries()]
      .filter(([, dependencies]) => dependencies.size > 0)
      .map(([name]) => name)
      .sort();
    throw new Error(`Cyclic workspace build dependencies: ${cyclic.join(", ")}`);
  }

  return ordered;
}

/**
 * Confirm that every declared export and command target exists after its package build.
 */
export async function validatePackageBuildOutputs(target: PackageBuildTarget): Promise<void> {
  const distRoot = join(target.packageRoot, "dist");

  for (const exportTarget of target.exportTargets) {
    const outputPath = resolve(target.packageRoot, exportTarget.slice(2));

    if (!isInside(distRoot, outputPath)) {
      throw new Error(`Export target ${exportTarget} for ${target.name} escapes dist`);
    }

    let outputStat;

    try {
      outputStat = await stat(outputPath);
    } catch {
      throw new Error(`Build for ${target.name} did not emit ${exportTarget}`);
    }

    if (!outputStat.isFile()) {
      throw new Error(`Build for ${target.name} did not emit a file at ${exportTarget}`);
    }
  }

  for (const binTarget of target.binTargets) {
    const outputPath = resolve(target.packageRoot, binTarget.slice(2));

    if (!isInside(distRoot, outputPath)) {
      throw new Error(`Bin target ${binTarget} for ${target.name} escapes dist`);
    }

    let outputStat;

    try {
      outputStat = await stat(outputPath);
    } catch {
      throw new Error(`Build for ${target.name} did not emit bin target ${binTarget}`);
    }

    if (!outputStat.isFile()) {
      throw new Error(`Build for ${target.name} did not emit a file at bin target ${binTarget}`);
    }
  }
}

export async function buildWorkspacePackages(workspaceRoot: string): Promise<void> {
  const plan = await discoverPackageBuildPlan(workspaceRoot);

  console.log(`Building ${plan.length} publishable workspace packages in dependency order`);

  for (const target of plan) {
    console.log(`Building ${target.name} (${target.directory})`);

    const process_ = Bun.spawn([process.execPath, "run", "--cwd", target.directory, "build"], {
      cwd: workspaceRoot,
      stdout: "inherit",
      stderr: "inherit",
    });
    const status = await process_.exited;

    if (status !== 0) throw new Error(`Build for ${target.name} exited with status ${status}`);

    await validatePackageBuildOutputs(target);

    console.log(
      `Validated ${target.exportTargets.length} dist export targets and ${target.binTargets.length} bin targets for ${target.name}`,
    );
  }
}

if (import.meta.main) await buildWorkspacePackages(resolve(import.meta.dir, ".."));
