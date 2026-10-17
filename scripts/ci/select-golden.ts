import { Buffer } from "node:buffer";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { posix, resolve } from "node:path";
import { parseSync } from "oxc-parser";

export interface SelectorOptions {
  readonly repoPath: string;
  readonly base: string;
  readonly head: string;
  readonly catalogPath: string;
  readonly graphPath: string;
  readonly releaseCandidate?: boolean;
}

interface GoldenCase {
  readonly id: string;
  readonly suite: string;
  readonly behaviors: readonly string[];
}

interface Behavior {
  readonly id: string;
  readonly paths: readonly string[];
  readonly dependsOn: readonly string[];
}

interface Catalog {
  readonly cases: readonly GoldenCase[];
  readonly behaviors: readonly Behavior[];
}

interface DependencyEdge {
  readonly consumer: string;
  readonly dependency: string;
  readonly revisions: readonly string[];
}

interface IncompleteDependency {
  readonly path: string;
  readonly reason: string;
}

interface Graph {
  readonly nodes: ReadonlySet<string>;
  readonly edges: readonly DependencyEdge[];
  readonly issues: readonly string[];
  readonly incompleteDependencies: readonly IncompleteDependency[];
}

interface ChangedPath {
  readonly path: string;
  readonly status: string;
}

interface PathImpact {
  readonly path: string;
  readonly changedPath: string;
  readonly dependencyChain: readonly string[];
  readonly revisions: readonly string[];
}

export interface SelectedCase {
  readonly id: string;
  readonly suite: string;
  readonly reasons: readonly string[];
}

export interface GoldenSelection {
  readonly schemaVersion: 1;
  readonly base: string;
  readonly head: string;
  readonly catalogPath: string;
  readonly graphPath: string;
  readonly releaseCandidate: boolean;
  readonly fullSuite: boolean;
  readonly fallbackReasons: readonly string[];
  readonly changedPaths: readonly ChangedPath[];
  readonly affectedPaths: readonly PathImpact[];
  readonly affectedBehaviors: readonly string[];
  readonly selectedCaseIds: readonly string[];
  readonly selectedCases: readonly SelectedCase[];
}

const SELECTOR_PATHS = ["scripts/ci/", "tests/ci/", "docs/ci-selection.md"] as const;

function normalizeRepoPath(value: string, label: string): string {
  if (!value || value.includes("\0")) {
    throw new Error(`${label} must be a non-empty repository-relative path`);
  }

  const normalized = value.replaceAll("\\", "/");

  if (normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized)) {
    throw new Error(`${label} must be repository-relative: ${value}`);
  }

  const segments = normalized.split("/");

  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error(`${label} contains an invalid path segment: ${value}`);
  }

  return segments.join("/");
}

function parseJson(value: string, label: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`${label} is not valid JSON: ${detail}`);
  }
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`);
  }

  return value as Record<string, unknown>;
}

function asString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} must be a non-empty string`);
  }

  return value;
}

function asArray(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array`);
  }

  return value;
}

function parseCatalog(value: string, path: string): Catalog {
  const record = asRecord(parseJson(value, `Catalog ${path}`), `Catalog ${path}`);

  if (record.version !== 1) {
    throw new Error(`Catalog ${path} must have version 1`);
  }

  const cases = asArray(record.cases, `Catalog ${path} cases`).map((rawCase, index) => {
    const label = `Catalog ${path} case ${index}`;
    const item = asRecord(rawCase, label);
    const behaviors = asArray(item.behaviors, `${label} behaviors`).map((behavior, behaviorIndex) =>
      asString(behavior, `${label} behavior ${behaviorIndex}`),
    );

    if (behaviors.length === 0) {
      throw new Error(`${label} must reference at least one behavior`);
    }

    return {
      id: asString(item.id, `${label} id`),
      suite: asString(item.suite, `${label} suite`),
      behaviors: [...new Set(behaviors)],
    } satisfies GoldenCase;
  });

  const behaviorIds = new Set<string>();
  const behaviors = asArray(record.behaviors, `Catalog ${path} behaviors`).map(
    (rawBehavior, index) => {
      const label = `Catalog ${path} behavior ${index}`;
      const item = asRecord(rawBehavior, label);
      const id = asString(item.id, `${label} id`);

      if (behaviorIds.has(id)) {
        throw new Error(`Catalog ${path} has duplicate behavior id: ${id}`);
      }

      behaviorIds.add(id);

      return {
        id,
        paths: asArray(item.paths, `${label} paths`).map((filePath, pathIndex) =>
          normalizeRepoPath(asString(filePath, `${label} path ${pathIndex}`), `${label} path`),
        ),
        dependsOn: asArray(item.dependsOn ?? [], `${label} dependsOn`).map(
          (dependency, dependencyIndex) =>
            asString(dependency, `${label} dependency ${dependencyIndex}`),
        ),
      } satisfies Behavior;
    },
  );

  const caseIds = new Set<string>();

  for (const item of cases) {
    if (caseIds.has(item.id)) {
      throw new Error(`Catalog ${path} has duplicate case id: ${item.id}`);
    }

    caseIds.add(item.id);

    for (const behavior of item.behaviors) {
      if (!behaviorIds.has(behavior)) {
        throw new Error(`Catalog ${path} case ${item.id} references unknown behavior: ${behavior}`);
      }
    }
  }

  if (cases.length === 0) {
    throw new Error(`Catalog ${path} must contain at least one golden case`);
  }

  for (const behavior of behaviors) {
    for (const dependency of behavior.dependsOn) {
      if (!behaviorIds.has(dependency)) {
        throw new Error(
          `Catalog ${path} behavior ${behavior.id} references unknown behavior: ${dependency}`,
        );
      }
    }
  }

  return { cases, behaviors };
}

function parseGraph(value: string, label: string): Graph {
  const record = asRecord(parseJson(value, label), label);

  if (record.version !== 1) {
    throw new Error(`${label} must have version 1`);
  }

  const nodes = new Set(
    asArray(record.nodes, `${label} nodes`).map((node, index) =>
      normalizeRepoPath(asString(node, `${label} node ${index}`), `${label} node`),
    ),
  );
  const edges = asArray(record.dependencies, `${label} dependencies`).map((rawEdge, index) => {
    const edge = asRecord(rawEdge, `${label} dependency ${index}`);
    const consumer = normalizeRepoPath(
      asString(edge.consumer, `${label} dependency ${index} consumer`),
      `${label} dependency consumer`,
    );
    const dependency = normalizeRepoPath(
      asString(edge.dependency, `${label} dependency ${index} dependency`),
      `${label} dependency path`,
    );

    if (!nodes.has(consumer) || !nodes.has(dependency)) {
      throw new Error(`${label} dependency ${consumer} -> ${dependency} references a missing node`);
    }

    return { consumer, dependency, revisions: [] } satisfies DependencyEdge;
  });

  return { nodes, edges, issues: [], incompleteDependencies: [] };
}

function runGitBytes(repoPath: string, args: readonly string[], input?: Buffer): Buffer {
  const result = spawnSync("git", ["-C", repoPath, ...args], {
    encoding: "buffer",
    input,
    maxBuffer: 128 * 1024 * 1024,
    windowsHide: true,
  });

  if (result.error || result.status !== 0) {
    const detail = result.error?.message ?? result.stderr?.toString("utf8").trim();
    throw new Error(`git ${args.join(" ")} failed${detail ? `: ${detail}` : ""}`);
  }

  return result.stdout ?? Buffer.alloc(0);
}

function runGit(repoPath: string, args: readonly string[]): string {
  return runGitBytes(repoPath, args).toString("utf8");
}

function resolveCommit(repoPath: string, ref: string): string {
  return runGit(repoPath, [
    "rev-parse",
    "--verify",
    "--quiet",
    "--end-of-options",
    `${ref}^{commit}`,
  ]).trim();
}

function readRevisionFile(repoPath: string, commit: string, path: string): string {
  return runGit(repoPath, ["show", `${commit}:${path}`]);
}

function readGraph(
  repoPath: string,
  commit: string,
  side: string,
  path: string,
): {
  readonly graph: Graph;
  readonly reason?: string;
} {
  try {
    const value = readRevisionFile(repoPath, commit, path);
    return { graph: parseGraph(value, `Dependency graph ${side} (${path})`) };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      graph: { nodes: new Set(), edges: [], issues: [], incompleteDependencies: [] },
      reason: `Could not load the ${side} supplemental dependency graph: ${detail}`,
    };
  }
}

interface SourceSnapshot {
  readonly paths: ReadonlySet<string>;
  readonly sourceFiles: ReadonlyMap<string, string>;
  readonly packageJsons: ReadonlyMap<string, string>;
  readonly issues: readonly string[];
}

const SOURCE_FILE = /\.(?:[cm]?ts|tsx|[cm]?js|jsx)$/i;
const RESOLVABLE_EXTENSIONS = [
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".json",
  ".css",
];

function sourceFilePath(path: string): boolean {
  return SOURCE_FILE.test(path);
}

function parseGitTree(repoPath: string, commit: string): SourceSnapshot {
  const tree = runGitBytes(repoPath, ["ls-tree", "-r", "-z", "--full-tree", commit]);
  const paths = new Set<string>();
  const objectByPath = new Map<string, string>();
  let offset = 0;

  while (offset < tree.byteLength) {
    const end = tree.indexOf(0, offset);

    if (end < 0) break;

    const record = tree.subarray(offset, end).toString("utf8");
    offset = end + 1;
    const tab = record.indexOf("\t");

    if (tab < 0) continue;

    const [mode, kind, objectId] = record.slice(0, tab).split(" ");
    const path = normalizeRepoPath(record.slice(tab + 1), "Git tree path");

    if (kind !== "blob" || !objectId || !mode) continue;

    paths.add(path);

    if (sourceFilePath(path) || path === "package.json" || path.endsWith("/package.json")) {
      objectByPath.set(path, objectId);
    }
  }

  const objectIds = [...new Set(objectByPath.values())];
  const contents = readGitObjects(repoPath, objectIds);
  const sourceFiles = new Map<string, string>();
  const packageJsons = new Map<string, string>();

  for (const [path, objectId] of objectByPath) {
    const content = contents.get(objectId);

    if (content === undefined) continue;

    if (sourceFilePath(path)) sourceFiles.set(path, content);

    if (path === "package.json" || path.endsWith("/package.json")) {
      packageJsons.set(path, content);
    }
  }

  return { paths, sourceFiles, packageJsons, issues: [] };
}

function readGitObjects(
  repoPath: string,
  objectIds: readonly string[],
): ReadonlyMap<string, string> {
  if (objectIds.length === 0) return new Map();

  const output = runGitBytes(
    repoPath,
    ["cat-file", "--batch"],
    Buffer.from(`${objectIds.join("\n")}\n`),
  );
  const contents = new Map<string, string>();
  let offset = 0;

  while (offset < output.byteLength) {
    const lineEnd = output.indexOf(10, offset);

    if (lineEnd < 0) throw new Error("Git returned a malformed cat-file response");

    const header = output.subarray(offset, lineEnd).toString("utf8");
    const match = /^([0-9a-f]+) blob (\d+)$/i.exec(header);

    if (!match) throw new Error(`Git returned an unexpected cat-file header: ${header}`);

    const objectId = match[1];
    const length = Number(match[2]);

    if (!objectId || !Number.isSafeInteger(length) || length < 0) {
      throw new Error(`Git returned an invalid cat-file object length: ${header}`);
    }

    const contentStart = lineEnd + 1;
    const contentEnd = contentStart + length;

    if (contentEnd >= output.byteLength || output[contentEnd] !== 10) {
      throw new Error(`Git returned a truncated cat-file object: ${objectId}`);
    }

    contents.set(objectId, output.subarray(contentStart, contentEnd).toString("utf8"));

    offset = contentEnd + 1;
  }

  return contents;
}

function readWorkspaceSnapshot(repoPath: string): SourceSnapshot {
  const paths = new Set(
    runGit(repoPath, ["ls-files", "-z"])
      .split("\0")
      .filter(Boolean)
      .map((path) => normalizeRepoPath(path, "Workspace path")),
  );
  const sourceFiles = new Map<string, string>();
  const issues: string[] = [];

  for (const path of paths) {
    if (!sourceFilePath(path)) continue;

    try {
      sourceFiles.set(path, readFileSync(resolve(repoPath, ...path.split("/")), "utf8"));
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);

      issues.push(`Could not read workspace source ${path}: ${detail}`);
    }
  }

  const packageJsons = new Map<string, string>();

  for (const path of paths) {
    if (path !== "package.json" && !path.endsWith("/package.json")) continue;

    try {
      packageJsons.set(path, readFileSync(resolve(repoPath, ...path.split("/")), "utf8"));
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);

      issues.push(`Could not read workspace package manifest ${path}: ${detail}`);
    }
  }

  return { paths, sourceFiles, packageJsons, issues };
}

interface WorkspacePackageIndex {
  readonly names: ReadonlySet<string>;
  readonly sourceBySpecifier: ReadonlyMap<string, ReadonlySet<string>>;
  readonly issues: readonly string[];
}

function packagePath(packageRoot: string, relativePath: string): string | undefined {
  if (!relativePath.startsWith("./")) return undefined;

  const path = posix.normalize(posix.join(packageRoot || ".", relativePath.slice(2)));

  if (path === ".." || path.startsWith("../") || path.startsWith("/")) return undefined;

  return path === "." ? "" : path;
}

function sourcePathVariants(path: string): string[] {
  if (path.endsWith(".d.mts")) return [`${path.slice(0, -6)}.mts`, path];

  if (path.endsWith(".d.cts")) return [`${path.slice(0, -6)}.cts`, path];

  if (path.endsWith(".d.ts")) return [`${path.slice(0, -5)}.ts`, path];

  if (path.endsWith(".js")) return [`${path.slice(0, -3)}.ts`, `${path.slice(0, -3)}.tsx`, path];

  if (path.endsWith(".jsx")) return [`${path.slice(0, -4)}.tsx`, path];

  if (path.endsWith(".mjs")) return [`${path.slice(0, -4)}.mts`, path];

  if (path.endsWith(".cjs")) return [`${path.slice(0, -4)}.cts`, path];

  if (!posix.extname(path)) return RESOLVABLE_EXTENSIONS.map((extension) => `${path}${extension}`);

  return [path];
}

function exportSourceCandidates(packageRoot: string, target: string): string[] {
  const candidates: string[] = [];
  const direct = packagePath(packageRoot, target);

  if (!direct) return candidates;

  if (target.startsWith("./dist/")) {
    const sourceTarget = `./src/${target.slice("./dist/".length)}`;
    const sourcePath = packagePath(packageRoot, sourceTarget);

    if (sourcePath) candidates.push(...sourcePathVariants(sourcePath));
  }

  candidates.push(...sourcePathVariants(direct));

  return [...new Set(candidates)];
}

function packageExportEntries(
  manifest: Record<string, unknown>,
): readonly (readonly [string, unknown])[] {
  if (typeof manifest.exports === "string" || Array.isArray(manifest.exports)) {
    return [[".", manifest.exports]];
  }

  if (manifest.exports && typeof manifest.exports === "object") {
    const exports = asRecord(manifest.exports, "Package exports");
    const hasSubpathKeys = Object.keys(exports).some((key) => key === "." || key.startsWith("./"));
    return hasSubpathKeys ? Object.entries(exports) : [[".", exports]];
  }

  const rootTargets = [manifest.source, manifest.types, manifest.module, manifest.main].filter(
    (target): target is string => typeof target === "string",
  );
  return rootTargets.length > 0 ? [[".", rootTargets]] : [];
}

function targetStrings(value: unknown): string[] {
  if (typeof value === "string") return [value];

  if (Array.isArray(value)) return value.flatMap(targetStrings);

  if (typeof value === "object" && value !== null) {
    return Object.values(value as Record<string, unknown>).flatMap(targetStrings);
  }

  return [];
}

function packageSpecifier(packageName: string, exportName: string): string | undefined {
  if (exportName === ".") return packageName;

  if (!exportName.startsWith("./") || exportName.includes("*")) return undefined;

  return `${packageName}/${exportName.slice(2)}`;
}

function workspacePackageIndex(
  packageJsons: ReadonlyMap<string, string>,
  paths: ReadonlySet<string>,
): WorkspacePackageIndex {
  const names = new Set<string>();
  const sourceBySpecifier = new Map<string, Set<string>>();
  const issues: string[] = [];

  for (const [manifestPath, contents] of packageJsons) {
    let manifest: Record<string, unknown>;

    try {
      manifest = asRecord(
        parseJson(contents, `Package manifest ${manifestPath}`),
        `Package manifest ${manifestPath}`,
      );
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);

      issues.push(`Could not parse tracked package manifest ${manifestPath}: ${detail}`);

      continue;
    }

    const packageName = typeof manifest.name === "string" ? manifest.name : undefined;

    if (!packageName) continue;

    names.add(packageName);

    const packageRoot = posix.dirname(manifestPath) === "." ? "" : posix.dirname(manifestPath);

    for (const [exportName, rawTarget] of packageExportEntries(manifest)) {
      const specifier = packageSpecifier(packageName, exportName);

      if (!specifier) continue;

      const sources = sourceBySpecifier.get(specifier) ?? new Set<string>();

      for (const target of targetStrings(rawTarget)) {
        for (const candidate of exportSourceCandidates(packageRoot, target)) {
          if (paths.has(candidate)) sources.add(candidate);
        }
      }

      if (sources.size > 0) sourceBySpecifier.set(specifier, sources);
    }
  }

  return { names, sourceBySpecifier, issues };
}

function matchingWorkspaceNames(specifier: string, packages: WorkspacePackageIndex): string[] {
  return [...packages.names]
    .filter((name) => specifier === name || specifier.startsWith(`${name}/`))
    .sort((left, right) => right.length - left.length);
}

function isWorkspaceImport(specifier: string, packages: WorkspacePackageIndex): boolean {
  return (
    matchingWorkspaceNames(specifier, packages).length > 0 ||
    /^@(hesperia|aeolia)\//.test(specifier)
  );
}

function collectModuleSpecifiers(
  source: string,
  path: string,
): { readonly specifiers: readonly string[]; readonly issue?: string } {
  const extension = posix.extname(path).toLowerCase();
  const lang =
    extension === ".tsx"
      ? "tsx"
      : extension === ".jsx"
        ? "jsx"
        : extension === ".js" || extension === ".mjs" || extension === ".cjs"
          ? "js"
          : "ts";
  const parsed = parseSync(path, source, { lang, sourceType: "unambiguous", astType: "ts" });

  if (parsed.errors.some((error) => error.severity === "Error")) {
    return {
      specifiers: [],
      issue: `Could not parse imports from ${path} because it has syntax errors`,
    };
  }

  const specifiers = new Set<string>();
  const unresolvedExpressions = new Set<string>();

  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);

      return;
    }

    if (typeof value !== "object" || value === null) return;

    const node = value as Record<string, unknown>;
    const nodeType = typeof node.type === "string" ? node.type : "";

    const addLiteral = (literal: unknown): boolean => {
      if (typeof literal === "object" && literal !== null) {
        const record = literal as Record<string, unknown>;

        if (record.type === "Literal" && typeof record.value === "string") {
          specifiers.add(record.value);

          return true;
        }
      }

      return false;
    };

    if (
      nodeType === "ImportDeclaration" ||
      nodeType === "ExportNamedDeclaration" ||
      nodeType === "ExportAllDeclaration"
    ) {
      addLiteral(node.source);
    } else if (nodeType === "ImportExpression") {
      if (!addLiteral(node.source)) unresolvedExpressions.add("import()");
    } else if (
      nodeType === "CallExpression" &&
      typeof node.callee === "object" &&
      node.callee !== null
    ) {
      const callee = node.callee as Record<string, unknown>;
      const args = Array.isArray(node.arguments) ? node.arguments : [];

      if (callee.type === "Identifier" && callee.name === "require" && !addLiteral(args[0])) {
        unresolvedExpressions.add("require()");
      }
    } else if (
      nodeType === "TSImportType" &&
      typeof node.argument === "object" &&
      node.argument !== null
    ) {
      const argument = node.argument as Record<string, unknown>;

      if (argument.type === "LiteralType") addLiteral(argument.literal);
    }

    for (const child of Object.values(node)) visit(child);
  };

  visit(parsed.program);

  const issue =
    unresolvedExpressions.size > 0
      ? `Could not resolve non-literal ${[...unresolvedExpressions].join(" and non-literal ")} dependencies from ${path}`
      : undefined;
  return { specifiers: [...specifiers], issue };
}

function resolveRelativeImport(
  importer: string,
  specifier: string,
  paths: ReadonlySet<string>,
): string | undefined {
  if (!specifier.startsWith(".")) return undefined;

  const base = posix.normalize(posix.join(posix.dirname(importer), specifier));

  if (base === ".." || base.startsWith("../") || base.startsWith("/")) return undefined;

  const candidates = [base];
  const extension = posix.extname(base);

  if (extension === ".js") candidates.push(`${base.slice(0, -3)}.ts`);

  if (extension === ".jsx") candidates.push(`${base.slice(0, -4)}.tsx`);

  if (extension === ".mjs") candidates.push(`${base.slice(0, -4)}.mts`);

  if (extension === ".cjs") candidates.push(`${base.slice(0, -4)}.cts`);

  if (!extension) {
    for (const extension of RESOLVABLE_EXTENSIONS) candidates.push(`${base}${extension}`);

    for (const extension of RESOLVABLE_EXTENSIONS)
      candidates.push(posix.join(base, `index${extension}`));
  }

  return candidates.find((candidate) => paths.has(candidate));
}

function acquireSourceGraph(snapshot: SourceSnapshot, label: string): Graph {
  const nodes = new Set<string>();
  const edges: DependencyEdge[] = [];
  const incompleteDependencies: IncompleteDependency[] = [];
  const packages = workspacePackageIndex(snapshot.packageJsons, snapshot.paths);
  const issues = [...snapshot.issues, ...packages.issues];

  for (const [consumer, source] of snapshot.sourceFiles) {
    nodes.add(consumer);

    const parsed = collectModuleSpecifiers(source, consumer);

    if (parsed.issue) {
      incompleteDependencies.push({ path: consumer, reason: `${label}: ${parsed.issue}` });
    }

    for (const specifier of parsed.specifiers) {
      let dependency = resolveRelativeImport(consumer, specifier, snapshot.paths);
      let unresolvedWorkspaceImport = false;

      if (!dependency && isWorkspaceImport(specifier, packages)) {
        const sources = packages.sourceBySpecifier.get(specifier);

        if (sources?.size === 1) dependency = [...sources][0];
        else unresolvedWorkspaceImport = true;
      }

      if (dependency) {
        nodes.add(dependency);

        edges.push({ consumer, dependency, revisions: [] });
      } else if (
        specifier.startsWith(".") ||
        specifier.startsWith("@/") ||
        specifier.startsWith("~/") ||
        unresolvedWorkspaceImport
      ) {
        incompleteDependencies.push({
          path: consumer,
          reason: `${label}: local import ${JSON.stringify(specifier)} from ${consumer} has no unique tracked source export`,
        });
      }
    }
  }

  return {
    nodes,
    edges,
    issues: [...new Set(issues)],
    incompleteDependencies: dedupeIncompleteDependencies(incompleteDependencies),
  };
}

function dedupeIncompleteDependencies(
  incompleteDependencies: readonly IncompleteDependency[],
): IncompleteDependency[] {
  const unique = new Map<string, IncompleteDependency>();

  for (const item of incompleteDependencies) unique.set(`${item.path}\0${item.reason}`, item);

  return [...unique.values()];
}

function safeAcquireSourceGraph(
  acquire: () => Graph,
  side: string,
): { readonly graph: Graph; readonly reason?: string } {
  try {
    return { graph: acquire() };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      graph: { nodes: new Set(), edges: [], issues: [], incompleteDependencies: [] },
      reason: `Could not acquire the ${side} source dependency graph: ${detail}`,
    };
  }
}

function mergeGraphInputs(...graphs: readonly Graph[]): Graph {
  const nodes = new Set<string>();
  const edges = new Map<string, DependencyEdge>();
  const issues = new Set<string>();
  const incompleteDependencies: IncompleteDependency[] = [];

  for (const graph of graphs) {
    for (const node of graph.nodes) nodes.add(node);

    for (const issue of graph.issues) issues.add(issue);

    incompleteDependencies.push(...graph.incompleteDependencies);

    for (const edge of graph.edges) edges.set(`${edge.consumer}\0${edge.dependency}`, edge);
  }

  return {
    nodes,
    edges: [...edges.values()],
    issues: [...issues],
    incompleteDependencies: dedupeIncompleteDependencies(incompleteDependencies),
  };
}

function workspaceStateReasons(repoPath: string, headCommit: string): string[] {
  const reasons: string[] = [];
  const workspaceHead = resolveCommit(repoPath, "HEAD");

  if (workspaceHead !== headCommit) {
    reasons.push(
      `the checked-out workspace HEAD ${workspaceHead} does not match requested head ${headCommit}`,
    );
  }

  if (
    runGitBytes(repoPath, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]).byteLength >
    0
  ) {
    reasons.push(
      "the workspace has uncommitted or untracked files; selection uses the complete golden suite",
    );
  }

  return reasons;
}

function parseNameStatus(output: string): ChangedPath[] {
  const fields = output.split("\0");
  const changed = new Map<string, string>();
  let index = 0;

  while (index < fields.length - 1) {
    const status = fields[index++];

    if (!status) continue;

    const code = status[0] ?? "?";

    if (code === "R" || code === "C") {
      const oldPath = fields[index++];
      const newPath = fields[index++];

      if (oldPath) changed.set(normalizeRepoPath(oldPath, "Changed path"), "D");

      if (newPath) changed.set(normalizeRepoPath(newPath, "Changed path"), "A");

      continue;
    }

    const path = fields[index++];

    if (path) changed.set(normalizeRepoPath(path, "Changed path"), code);
  }

  return [...changed]
    .map(([path, status]) => ({ path, status }))
    .sort((left, right) => left.path.localeCompare(right.path));
}

function combineGraphs(
  base: Graph,
  head: Graph,
): {
  readonly nodes: ReadonlySet<string>;
  readonly reverseDependencies: ReadonlyMap<string, readonly DependencyEdge[]>;
  readonly dependenciesByConsumer: ReadonlyMap<string, readonly DependencyEdge[]>;
  readonly incompleteDependencies: readonly IncompleteDependency[];
} {
  const nodes = new Set([...base.nodes, ...head.nodes]);
  const combined = new Map<string, Set<string>>();

  for (const [revision, graph] of [
    ["base", base],
    ["head", head],
  ] as const) {
    for (const edge of graph.edges) {
      const key = `${edge.consumer}\0${edge.dependency}`;
      let revisions = combined.get(key);

      if (!revisions) {
        revisions = new Set();

        combined.set(key, revisions);
      }

      revisions.add(revision);
    }
  }

  const reverseDependencies = new Map<string, DependencyEdge[]>();
  const dependenciesByConsumer = new Map<string, DependencyEdge[]>();

  for (const [key, revisions] of combined) {
    const [consumer, dependency] = key.split("\0");

    if (!consumer || !dependency) continue;

    const edge: DependencyEdge = { consumer, dependency, revisions: [...revisions].sort() };
    const incoming = reverseDependencies.get(dependency) ?? [];

    incoming.push(edge);

    reverseDependencies.set(dependency, incoming);

    const outgoing = dependenciesByConsumer.get(consumer) ?? [];

    outgoing.push(edge);

    dependenciesByConsumer.set(consumer, outgoing);
  }

  for (const edges of reverseDependencies.values()) {
    edges.sort((left, right) => left.consumer.localeCompare(right.consumer));
  }

  for (const edges of dependenciesByConsumer.values()) {
    edges.sort((left, right) => left.dependency.localeCompare(right.dependency));
  }

  return {
    nodes,
    reverseDependencies,
    dependenciesByConsumer,
    incompleteDependencies: dedupeIncompleteDependencies([
      ...base.incompleteDependencies,
      ...head.incompleteDependencies,
    ]),
  };
}

function traceImpacts(
  seed: string,
  reverseDependencies: ReadonlyMap<string, readonly DependencyEdge[]>,
): PathImpact[] {
  const impacts: PathImpact[] = [];
  const visited = new Set([seed]);
  const queue: {
    readonly path: string;
    readonly chain: readonly string[];
    readonly revisions: readonly string[];
  }[] = [{ path: seed, chain: [seed], revisions: [] }];

  while (queue.length > 0) {
    const current = queue.shift();

    if (!current) continue;

    impacts.push({
      path: current.path,
      changedPath: seed,
      dependencyChain: current.chain,
      revisions: current.revisions,
    });

    for (const edge of reverseDependencies.get(current.path) ?? []) {
      if (visited.has(edge.consumer)) continue;

      visited.add(edge.consumer);

      queue.push({
        path: edge.consumer,
        chain: [...current.chain, edge.consumer],
        revisions: [...new Set([...current.revisions, ...edge.revisions])].sort(),
      });
    }
  }

  return impacts;
}

function dependencyClosure(
  roots: Iterable<string>,
  dependenciesByConsumer: ReadonlyMap<string, readonly DependencyEdge[]>,
): Set<string> {
  const reachable = new Set(roots);
  const queue = [...reachable];

  for (let index = 0; index < queue.length; index += 1) {
    const consumer = queue[index];

    if (!consumer) continue;

    for (const edge of dependenciesByConsumer.get(consumer) ?? []) {
      if (reachable.has(edge.dependency)) continue;

      reachable.add(edge.dependency);

      queue.push(edge.dependency);
    }
  }

  return reachable;
}

function selectorChangeReason(path: string, catalogPath: string): string | undefined {
  if (path === catalogPath) return `the golden case catalog changed: ${path}`;

  if (path === "package.json" || path.endsWith("/package.json")) {
    return `workspace package manifest changed: ${path}`;
  }

  if (
    SELECTOR_PATHS.some((prefix) =>
      prefix.endsWith("/") ? path.startsWith(prefix) : path === prefix,
    )
  ) {
    return `the selector implementation, tests, or guidance changed: ${path}`;
  }

  return undefined;
}

function selectFromInputs(input: {
  readonly base: string;
  readonly head: string;
  readonly catalogPath: string;
  readonly graphPath: string;
  readonly catalog: Catalog;
  readonly baseGraph: Graph;
  readonly headGraph: Graph;
  readonly changedPaths: readonly ChangedPath[];
  readonly releaseCandidate: boolean;
  readonly graphReadReasons: readonly string[];
}): GoldenSelection {
  const fallbackReasons: string[] = [...input.graphReadReasons];
  const graph = combineGraphs(input.baseGraph, input.headGraph);
  const behaviorByPath = new Map<string, string[]>();
  const behaviorDependants = new Map<string, string[]>();

  for (const behavior of input.catalog.behaviors) {
    for (const path of behavior.paths) {
      const behaviors = behaviorByPath.get(path) ?? [];

      behaviors.push(behavior.id);

      behaviorByPath.set(path, behaviors);
    }

    for (const dependency of behavior.dependsOn) {
      const dependants = behaviorDependants.get(dependency) ?? [];

      dependants.push(behavior.id);

      behaviorDependants.set(dependency, dependants);
    }
  }

  const relevantDependencyPaths = dependencyClosure(
    behaviorByPath.keys(),
    graph.dependenciesByConsumer,
  );

  const pathImpacts: PathImpact[] = [];
  const impactSeeds = input.changedPaths.filter(
    (changed) => changed.path !== input.graphPath && changed.path !== input.catalogPath,
  );

  if (input.changedPaths.length === 0) {
    fallbackReasons.push("the base-to-head diff contains no changed paths");
  }

  if (input.releaseCandidate) {
    fallbackReasons.push("release candidates require the complete golden suite");
  }

  const behaviorIds = new Set(input.catalog.behaviors.map((behavior) => behavior.id));
  const impactedBehaviorReasons = new Map<string, Set<string>>();

  for (const changed of input.changedPaths) {
    const configReason = selectorChangeReason(changed.path, input.catalogPath);

    if (configReason) fallbackReasons.push(configReason);

    if (changed.path === input.catalogPath || changed.path === input.graphPath) continue;

    const directlyMapped = behaviorByPath.has(changed.path);

    if (!graph.nodes.has(changed.path) && !directlyMapped) {
      fallbackReasons.push(
        `impact is unknown for changed path ${changed.path}; it appears in neither Git dependency graph nor the behavior catalog`,
      );
    }
  }

  for (const changed of impactSeeds) {
    for (const impact of traceImpacts(changed.path, graph.reverseDependencies)) {
      pathImpacts.push(impact);

      relevantDependencyPaths.add(impact.path);

      for (const behaviorId of behaviorByPath.get(impact.path) ?? []) {
        if (!behaviorIds.has(behaviorId)) continue;

        const revisions =
          impact.revisions.length > 0
            ? ` through ${[...new Set(impact.revisions)].join(" and ")} graph edge(s)`
            : "";
        const chain = impact.dependencyChain.join(" -> ");
        const reason =
          impact.path === changed.path
            ? `changed path ${changed.path} maps to behavior ${behaviorId}`
            : `changed path ${changed.path} reaches ${impact.path} via ${chain}${revisions}; that path maps to behavior ${behaviorId}`;
        const reasons = impactedBehaviorReasons.get(behaviorId) ?? new Set<string>();

        reasons.add(reason);

        impactedBehaviorReasons.set(behaviorId, reasons);
      }
    }
  }

  for (const incomplete of graph.incompleteDependencies) {
    if (relevantDependencyPaths.has(incomplete.path)) {
      fallbackReasons.push(
        `source dependency graph is incomplete at ${incomplete.path}: ${incomplete.reason}`,
      );
    }
  }

  const behaviorQueue: {
    readonly id: string;
    readonly reason: string;
    readonly chain: readonly string[];
  }[] = [];

  for (const [id, reasons] of impactedBehaviorReasons) {
    for (const reason of reasons) behaviorQueue.push({ id, reason, chain: [id] });
  }

  for (let index = 0; index < behaviorQueue.length; index += 1) {
    const current = behaviorQueue[index];

    if (!current) continue;

    for (const dependant of behaviorDependants.get(current.id) ?? []) {
      if (current.chain.includes(dependant)) continue;

      const chain = [...current.chain, dependant];
      const reason = `behavior dependency ${chain.join(" -> ")} carries impact from ${current.reason}`;
      const reasons = impactedBehaviorReasons.get(dependant) ?? new Set<string>();
      const sizeBefore = reasons.size;

      reasons.add(reason);

      impactedBehaviorReasons.set(dependant, reasons);

      if (reasons.size > sizeBefore)
        behaviorQueue.push({ id: dependant, reason: current.reason, chain });
    }
  }

  const casesById = new Map(input.catalog.cases.map((item) => [item.id, item]));
  const selectedReasons = new Map<string, Set<string>>();

  for (const item of input.catalog.cases) {
    const reasons = new Set<string>();

    for (const behaviorId of item.behaviors) {
      for (const reason of impactedBehaviorReasons.get(behaviorId) ?? []) reasons.add(reason);
    }

    if (reasons.size > 0) selectedReasons.set(item.id, reasons);
  }

  if (selectedReasons.size === 0 && fallbackReasons.length === 0) {
    fallbackReasons.push("the known code impact maps to no golden cases");
  }

  const uniqueFallbackReasons = [...new Set(fallbackReasons)];
  const useFullSuite = uniqueFallbackReasons.length > 0;

  if (useFullSuite) {
    for (const item of input.catalog.cases) {
      const reasons = selectedReasons.get(item.id) ?? new Set<string>();

      for (const reason of uniqueFallbackReasons)
        reasons.add(`full suite required because ${reason}`);

      selectedReasons.set(item.id, reasons);
    }
  }

  const selectedCases = [...casesById.values()]
    .filter((item) => selectedReasons.has(item.id))
    .map((item) => ({
      id: item.id,
      suite: item.suite,
      reasons: [...(selectedReasons.get(item.id) ?? [])].sort(),
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
  const affectedPaths = pathImpacts
    .sort(
      (left, right) =>
        left.path.localeCompare(right.path) || left.changedPath.localeCompare(right.changedPath),
    )
    .filter(
      (impact, index, impacts) =>
        index ===
        impacts.findIndex(
          (candidate) =>
            candidate.path === impact.path &&
            candidate.changedPath === impact.changedPath &&
            candidate.dependencyChain.join("\0") === impact.dependencyChain.join("\0"),
        ),
    );

  return {
    schemaVersion: 1,
    base: input.base,
    head: input.head,
    catalogPath: input.catalogPath,
    graphPath: input.graphPath,
    releaseCandidate: input.releaseCandidate,
    fullSuite: useFullSuite || selectedCases.length === input.catalog.cases.length,
    fallbackReasons: uniqueFallbackReasons.sort(),
    changedPaths: [...input.changedPaths],
    affectedPaths,
    affectedBehaviors: [...impactedBehaviorReasons.keys()].sort(),
    selectedCaseIds: selectedCases.map((item) => item.id),
    selectedCases,
  };
}

export function selectGoldenCases(options: SelectorOptions): GoldenSelection {
  const repoPath = resolve(options.repoPath);
  const catalogPath = normalizeRepoPath(options.catalogPath, "Catalog path");
  const graphPath = normalizeRepoPath(options.graphPath, "Dependency graph path");
  const baseCommit = resolveCommit(repoPath, options.base);
  const headCommit = resolveCommit(repoPath, options.head);
  const catalog = parseCatalog(readRevisionFile(repoPath, headCommit, catalogPath), catalogPath);
  const diff = runGit(repoPath, [
    "diff",
    "--name-status",
    "-z",
    "--no-renames",
    baseCommit,
    headCommit,
    "--",
  ]);
  const changedPaths = parseNameStatus(diff);
  const baseSupplement = readGraph(repoPath, baseCommit, "base", graphPath);
  const headSupplement = readGraph(repoPath, headCommit, "head", graphPath);
  const baseSource = safeAcquireSourceGraph(
    () => acquireSourceGraph(parseGitTree(repoPath, baseCommit), "base"),
    "base",
  );
  const headSource = safeAcquireSourceGraph(
    () => acquireSourceGraph(readWorkspaceSnapshot(repoPath), "workspace head"),
    "workspace head",
  );
  const baseGraph = mergeGraphInputs(baseSource.graph, baseSupplement.graph);
  const headGraph = mergeGraphInputs(headSource.graph, headSupplement.graph);
  const graphReadReasons = [
    baseSupplement.reason,
    headSupplement.reason,
    baseSource.reason,
    headSource.reason,
    ...baseGraph.issues.map((issue) => `Base source graph is incomplete: ${issue}`),
    ...headGraph.issues.map((issue) => `Workspace head source graph is incomplete: ${issue}`),
    ...workspaceStateReasons(repoPath, headCommit),
  ].filter((reason): reason is string => reason !== undefined);

  return selectFromInputs({
    base: baseCommit,
    head: headCommit,
    catalogPath,
    graphPath,
    catalog,
    baseGraph,
    headGraph,
    changedPaths,
    releaseCandidate: options.releaseCandidate ?? false,
    graphReadReasons,
  });
}

interface ParsedArgs {
  readonly options?: SelectorOptions;
  readonly help?: boolean;
}

function parseArguments(args: readonly string[]): ParsedArgs {
  const values = new Map<string, string>();
  let releaseCandidate = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--help" || arg === "-h") return { help: true };

    if (arg === "--release-candidate") {
      releaseCandidate = true;
      continue;
    }

    if (!arg?.startsWith("--")) throw new Error(`Unexpected argument: ${arg ?? ""}`);

    if (!["--base", "--head", "--repo", "--catalog-path", "--graph-path"].includes(arg)) {
      throw new Error(`Unknown option: ${arg}`);
    }

    const value = args[index + 1];

    if (!value || value.startsWith("--")) throw new Error(`${arg} requires a value`);

    values.set(arg, value);

    index += 1;
  }

  const required = ["--base", "--head", "--catalog-path", "--graph-path"];
  const missing = required.filter((key) => !values.has(key));

  if (missing.length > 0) throw new Error(`Missing required options: ${missing.join(", ")}`);

  return {
    options: {
      repoPath: resolve(values.get("--repo") ?? process.cwd()),
      base: values.get("--base") ?? "",
      head: values.get("--head") ?? "",
      catalogPath: values.get("--catalog-path") ?? "",
      graphPath: values.get("--graph-path") ?? "",
      releaseCandidate,
    },
  };
}

const usage = `Usage: bun run scripts/ci/select-golden.ts --base <git-ref> --head <git-ref> --catalog-path <repo-path> --graph-path <repo-path> [--repo <directory>] [--release-candidate]

Reads the catalog from the head commit and the dependency graph from both commits.
Writes a JSON selection with affected golden case IDs and reasons to stdout.`;

if (import.meta.main) {
  try {
    const parsed = parseArguments(Bun.argv.slice(2));

    if (parsed.help) {
      console.log(usage);
    } else if (parsed.options) {
      console.log(JSON.stringify(selectGoldenCases(parsed.options), null, 2));
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));

    console.error(usage);

    process.exitCode = 2;
  }
}
