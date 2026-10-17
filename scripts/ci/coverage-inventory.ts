import { existsSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";

const excludedSourceDirectories = new Set([
  "__fixtures__",
  "__tests__",
  "__temp__",
  "__tmp__",
  "dist",
  "fixture",
  "fixtures",
  "node_modules",
  ".temp",
  ".tmp",
  "temp",
  "tests",
  "test",
  "tmp",
]);

export function isCoverageTypeScriptSource(filename: string): boolean {
  return (
    /\.tsx?$/iu.test(filename) &&
    !/\.d\.ts$/iu.test(filename) &&
    !/\.(?:test|spec|fixture)\.tsx?$/iu.test(filename)
  );
}

export function coverageSourceFiles(repoPath: string): readonly string[] {
  const result: string[] = [];

  const addDirectFiles = (directory: string) => {
    if (!existsSync(directory)) return;

    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isFile() && isCoverageTypeScriptSource(entry.name))
        result.push(join(directory, entry.name));
    }
  };

  const visitSources = (current: string) => {
    if (!existsSync(current)) return;

    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.isDirectory() && excludedSourceDirectories.has(entry.name.toLowerCase())) continue;

      const path = join(current, entry.name);

      if (entry.isDirectory()) visitSources(path);
      else if (entry.isFile() && isCoverageTypeScriptSource(entry.name)) result.push(path);
    }
  };

  const packagesDirectory = join(repoPath, "packages");

  if (existsSync(packagesDirectory)) {
    for (const entry of readdirSync(packagesDirectory, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;

      visitSources(join(packagesDirectory, entry.name, "src"));
    }
  }

  addDirectFiles(join(repoPath, "scripts"));

  addDirectFiles(join(repoPath, "scripts", "ci"));

  visitSources(join(repoPath, "editors", "vscode", "src"));

  return result
    .map((path) => relative(repoPath, path).split(sep).join("/"))
    .sort((left, right) => left.localeCompare(right));
}
