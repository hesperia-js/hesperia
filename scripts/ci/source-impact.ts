import { Buffer } from "node:buffer";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { posix, resolve } from "node:path";
import { parseSync } from "oxc-parser";

/** A resolved module edge with the revisions that establish it. */
export interface DependencyEdge {
  /** Repository-relative module that imports the dependency. */
  readonly consumer: string;
  /** Unique tracked module imported by the consumer. */
  readonly dependency: string;
  /** Compared revisions that establish this edge or impact chain. */
  readonly revisions: readonly string[];
}

/** A module dependency whose target could not be established. */
export interface IncompleteDependency {
  /** Repository-relative path. */
  readonly path: string;
  /** Explanation retained in selection diagnostics. */
  readonly reason: string;
  /** Opaque loaders can have owner domains; invalid resolution requires fail-closed policy. */
  readonly kind: "opaque" | "invalid";
}

/** Dependencies and uncertainty acquired from one tracked snapshot. */
export interface SourceGraph {
  /** Tracked dependency graph paths. */
  readonly nodes: ReadonlySet<string>;
  /** Resolved consumer-to-dependency edges. */
  readonly edges: readonly DependencyEdge[];
  /** Acquisition failures that prevent a complete graph. */
  readonly issues: readonly string[];
  /** Unresolved dependencies, including their uncertainty classification. */
  readonly incompleteDependencies: readonly IncompleteDependency[];
  /** Modules with runtime loading, filesystem, or process capabilities. */
  readonly opaqueConsumers: ReadonlySet<string>;
}

/** One side of a changed, added, removed, or renamed tracked path. */
export interface ChangedPath {
  /** Repository-relative path. */
  readonly path: string;
  /** Git name-status code; renames retain separate removed and added paths. */
  readonly status: string;
}

/** A changed path and the consumer chain through which it carries impact. */
export interface PathImpact {
  /** Repository-relative path. */
  readonly path: string;
  /** Original path from the base-to-head diff. */
  readonly changedPath: string;
  /** Ordered changed-path-to-consumer chain, including both endpoints. */
  readonly dependencyChain: readonly string[];
  /** Compared revisions that establish this edge or impact chain. */
  readonly revisions: readonly string[];
}

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

function parseGraph(value: string, label: string): SourceGraph {
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

  return { nodes, edges, issues: [], incompleteDependencies: [], opaqueConsumers: new Set() };
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

/** Read one tracked revision file; throws when Git cannot resolve it. */
export function readRevisionFile(repoPath: string, commit: string, path: string): string {
  return runGit(repoPath, ["show", `${commit}:${path}`]);
}

function readGraph(
  repoPath: string,
  commit: string,
  side: string,
  path: string,
): {
  readonly graph: SourceGraph;
  readonly reason?: string;
} {
  try {
    const value = readRevisionFile(repoPath, commit, path);
    return { graph: parseGraph(value, `Dependency graph ${side} (${path})`) };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      graph: {
        nodes: new Set(),
        edges: [],
        issues: [],
        incompleteDependencies: [],
        opaqueConsumers: new Set(),
      },
      reason: `Could not load the ${side} supplemental dependency graph: ${detail}`,
    };
  }
}

/** Tracked text inputs for dependency acquisition, excluding generated outputs. */
export interface SourceSnapshot {
  /** Tracked paths, including non-source inputs. */
  readonly paths: ReadonlySet<string>;
  /** Tracked executable source text keyed by repository-relative path. */
  readonly sourceFiles: ReadonlyMap<string, string>;
  /** Tracked package manifest text. */
  readonly packageJsons: ReadonlyMap<string, string>;
  /** Tracked JSON text used to prove package build identities. */
  readonly jsonFiles: ReadonlyMap<string, string>;
  /** Acquisition failures that prevent a complete graph. */
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

    if (sourceFilePath(path) || path.endsWith(".json")) {
      objectByPath.set(path, objectId);
    }
  }

  const objectIds = [...new Set(objectByPath.values())];
  const contents = readGitObjects(repoPath, objectIds);
  const sourceFiles = new Map<string, string>();
  const packageJsons = new Map<string, string>();
  const jsonFiles = new Map<string, string>();

  for (const [path, objectId] of objectByPath) {
    const content = contents.get(objectId);

    if (content === undefined) continue;

    if (sourceFilePath(path)) sourceFiles.set(path, content);
    if (path.endsWith(".json")) jsonFiles.set(path, content);

    if (path === "package.json" || path.endsWith("/package.json")) {
      packageJsons.set(path, content);
    }
  }

  return { paths, sourceFiles, packageJsons, jsonFiles, issues: [] };
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
  const jsonFiles = new Map<string, string>();

  for (const path of paths) {
    if (!path.endsWith(".json")) continue;

    try {
      const content = readFileSync(resolve(repoPath, ...path.split("/")), "utf8");
      jsonFiles.set(path, content);
      if (path === "package.json" || path.endsWith("/package.json"))
        packageJsons.set(path, content);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);

      issues.push(`Could not read workspace JSON input ${path}: ${detail}`);
    }
  }

  return { paths, sourceFiles, packageJsons, jsonFiles, issues };
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

type AstNode = Record<string, unknown>;

function astNode(value: unknown): AstNode | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as AstNode)
    : undefined;
}

interface DynamicBinding {
  readonly declaration: AstNode;
  readonly scope: AstNode;
  readonly constant: boolean;
  readonly imported?: { readonly source: string; readonly name: string };
}

function fixedConfigurationTargets(program: AstNode, paths: ReadonlySet<string>) {
  const bindings = new Map<string, DynamicBinding[]>();
  const mutated = new Set<string>();

  const identifiers = (value: unknown, visit: (name: string) => void): void => {
    if (Array.isArray(value)) {
      for (const item of value) identifiers(item, visit);

      return;
    }

    const node = astNode(value);

    if (!node) return;

    if (node.type === "Identifier" && typeof node.name === "string") visit(node.name);
    else for (const child of Object.values(node)) identifiers(child, visit);
  };

  const bind = (pattern: unknown, binding: DynamicBinding): void => {
    identifiers(pattern, (name) => {
      const entries = bindings.get(name) ?? [];

      entries.push(binding);

      bindings.set(name, entries);
    });
  };

  const acquire = (value: unknown, scope: AstNode, parent?: AstNode): void => {
    if (Array.isArray(value)) {
      for (const item of value) acquire(item, scope, parent);

      return;
    }

    const node = astNode(value);

    if (!node) return;

    if (node.type === "Program" || node.type === "BlockStatement") scope = node;

    if (node.type === "ImportDeclaration") {
      for (const item of Array.isArray(node.specifiers) ? node.specifiers : []) {
        const specifier = astNode(item);
        const source = astNode(node.source)?.value;
        const imported = astNode(specifier?.imported);
        const name = imported?.name ?? imported?.value;

        bind(specifier?.local, {
          declaration: node,
          scope,
          constant: true,
          ...(specifier?.type === "ImportSpecifier" &&
          node.importKind !== "type" &&
          specifier.importKind !== "type" &&
          typeof source === "string" &&
          typeof name === "string"
            ? { imported: { source, name } }
            : {}),
        });
      }
    } else if (node.type === "VariableDeclaration") {
      for (const item of Array.isArray(node.declarations) ? node.declarations : []) {
        const declaration = astNode(item);

        if (declaration)
          bind(declaration.id, {
            declaration,
            scope,
            constant: node.kind === "const" && parent === scope,
          });
      }
    } else if (typeof node.type === "string" && node.type.includes("Function")) {
      bind(node.id, { declaration: node, scope, constant: false });

      for (const parameter of Array.isArray(node.params) ? node.params : [])
        bind(parameter, { declaration: node, scope, constant: false });
    } else if (node.type === "ClassDeclaration" || node.type === "ClassExpression") {
      bind(node.id, { declaration: node, scope, constant: false });
    } else if (node.type === "CatchClause") {
      bind(node.param, { declaration: node, scope, constant: false });
    }

    if (node.type === "AssignmentExpression") identifiers(node.left, (name) => mutated.add(name));
    else if (node.type === "UpdateExpression")
      identifiers(node.argument, (name) => mutated.add(name));
    else if (node.type === "ForInStatement" || node.type === "ForOfStatement")
      identifiers(node.left, (name) => mutated.add(name));

    for (const child of Object.values(node)) acquire(child, scope, node);
  };

  acquire(program, program);

  const unique = (value: unknown): DynamicBinding | undefined => {
    const identifier = astNode(value);

    if (
      identifier?.type !== "Identifier" ||
      typeof identifier.name !== "string" ||
      mutated.has(identifier.name)
    )
      return undefined;

    const entries = bindings.get(identifier.name);
    return entries?.length === 1 ? entries[0] : undefined;
  };

  const importedFunction = (
    value: unknown,
    modules: readonly string[],
    names: readonly string[],
  ) => {
    const binding = unique(value);
    return (
      binding?.imported &&
      modules.includes(binding.imported.source) &&
      names.includes(binding.imported.name)
    );
  };

  return (expression: AstNode): readonly string[] | undefined => {
    const member = astNode(expression.source);
    const urlCall = astNode(member?.object);
    const argument =
      Array.isArray(urlCall?.arguments) && urlCall.arguments.length === 1
        ? urlCall.arguments[0]
        : undefined;
    const binding = unique(argument);
    const initializer = astNode(binding?.declaration.init);
    const args = Array.isArray(initializer?.arguments) ? initializer.arguments : [];

    if (
      member?.type !== "MemberExpression" ||
      member.computed ||
      member.optional ||
      astNode(member.property)?.name !== "href" ||
      urlCall?.type !== "CallExpression" ||
      urlCall.optional ||
      !importedFunction(urlCall.callee, ["node:url", "url"], ["pathToFileURL"]) ||
      !binding?.constant ||
      astNode(binding.declaration.id)?.type !== "Identifier" ||
      typeof binding.scope.start !== "number" ||
      typeof binding.scope.end !== "number" ||
      typeof expression.start !== "number" ||
      expression.start < binding.scope.start ||
      expression.start > binding.scope.end ||
      initializer?.type !== "CallExpression" ||
      initializer.optional ||
      args.length !== 2 ||
      !importedFunction(initializer.callee, ["node:path", "path"], ["resolve", "join"]) ||
      astNode(args[0])?.type !== "Identifier" ||
      astNode(args[1])?.type !== "Literal" ||
      astNode(args[1])?.value !== "hesperia.config.ts"
    )
      return undefined;

    const targets = [...paths].filter(
      (path) => posix.basename(path).toLowerCase() === "hesperia.config.ts",
    );
    return targets.length > 0 ? targets : undefined;
  };
}

function aliasedModuleLoading(program: AstNode) {
  const factories = new Set<string>();
  const namespaces = new Set<string>();
  const loaders = new Set<string>();
  const declarations: AstNode[] = [];

  const scan = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) scan(item);

      return;
    }

    const node = astNode(value);

    if (!node) return;

    if (
      node.type === "ImportDeclaration" &&
      ["node:module", "module"].includes(String(astNode(node.source)?.value))
    ) {
      for (const raw of Array.isArray(node.specifiers) ? node.specifiers : []) {
        const specifier = astNode(raw);
        const local = astNode(specifier?.local)?.name;

        if (typeof local !== "string") continue;

        if (specifier?.type === "ImportNamespaceSpecifier") namespaces.add(local);
        else if (
          (astNode(specifier?.imported)?.name ?? astNode(specifier?.imported)?.value) ===
          "createRequire"
        )
          factories.add(local);
      }
    } else if (node.type === "VariableDeclarator") declarations.push(node);

    for (const child of Object.values(node)) scan(child);
  };

  scan(program);

  const factoryCall = (value: unknown): boolean => {
    const call = astNode(value);
    const callee = astNode(call?.callee);

    if (call?.type !== "CallExpression") return false;

    if (callee?.type === "Identifier" && typeof callee.name === "string")
      return factories.has(callee.name);

    return (
      callee?.type === "MemberExpression" &&
      namespaces.has(String(astNode(callee.object)?.name)) &&
      (callee.computed ? astNode(callee.property)?.value : astNode(callee.property)?.name) ===
        "createRequire"
    );
  };

  for (let remaining = declarations.length; remaining > 0; remaining--) {
    const size = factories.size + loaders.size;

    for (const declaration of declarations) {
      const identifier = astNode(declaration.id);
      const init = astNode(declaration.init);

      if (identifier?.type !== "Identifier" || typeof identifier.name !== "string") continue;

      if (init?.type === "Identifier" && factories.has(String(init.name)))
        factories.add(identifier.name);
      else if (factoryCall(init) || (init?.type === "Identifier" && loaders.has(String(init.name))))
        loaders.add(identifier.name);
    }

    if (size === factories.size + loaders.size) break;
  }

  return (call: AstNode): boolean => {
    const callee = astNode(call.callee);

    return (
      factoryCall(callee) ||
      (callee?.type === "Identifier" && loaders.has(String(callee.name))) ||
      (callee?.type === "MemberExpression" &&
        loaders.has(String(astNode(callee.object)?.name)) &&
        ["call", "apply", "bind"].includes(
          String(
            callee.computed ? astNode(callee.property)?.value : astNode(callee.property)?.name,
          ),
        ))
    );
  };
}

function collectModuleSpecifiers(
  source: string,
  path: string,
  paths: ReadonlySet<string>,
): {
  readonly specifiers: readonly string[];
  readonly issue?: string;
  readonly issueKind?: "opaque" | "invalid";
  readonly dynamicTargets: readonly string[];
  readonly opaque: boolean;
} {
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
      dynamicTargets: [],
      opaque: true,
      issue: `Could not parse imports from ${path} because it has syntax errors`,
      issueKind: "invalid",
    };
  }

  const specifiers = new Set<string>();
  const unresolvedExpressions = new Set<string>();
  const dynamicTargets = new Set<string>();
  const configurationTargets = fixedConfigurationTargets(
    parsed.program as unknown as AstNode,
    paths,
  );
  const moduleLoading = aliasedModuleLoading(parsed.program as unknown as AstNode);
  let opaque = false;

  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);

      return;
    }

    if (typeof value !== "object" || value === null) return;

    const node = value as Record<string, unknown>;
    const nodeType = typeof node.type === "string" ? node.type : "";

    if (
      (nodeType === "VariableDeclarator" &&
        astNode(node.init)?.type === "Identifier" &&
        astNode(node.init)?.name === "Bun") ||
      (nodeType === "AssignmentExpression" &&
        astNode(node.right)?.type === "Identifier" &&
        astNode(node.right)?.name === "Bun")
    )
      opaque = true;

    if (
      nodeType === "MemberExpression" &&
      astNode(node.object)?.type === "Identifier" &&
      astNode(node.object)?.name === "Bun"
    ) {
      const property = astNode(node.property);
      const name = node.computed ? property?.value : property?.name;

      if (
        name === "file" ||
        name === "spawn" ||
        name === "spawnSync" ||
        (node.computed && typeof name !== "string")
      )
        opaque = true;
    }

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
      if (!addLiteral(node.source)) {
        const targets = configurationTargets(node);

        if (targets) for (const target of targets) dynamicTargets.add(target);
        else unresolvedExpressions.add("import()");
      }
    } else if (
      nodeType === "CallExpression" &&
      typeof node.callee === "object" &&
      node.callee !== null
    ) {
      const callee = node.callee as Record<string, unknown>;
      const args = Array.isArray(node.arguments) ? node.arguments : [];

      if (moduleLoading(node)) unresolvedExpressions.add("require()");

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
  opaque ||=
    unresolvedExpressions.size > 0 ||
    [...specifiers].some((specifier) =>
      [
        "node:fs",
        "fs",
        "node:fs/promises",
        "fs/promises",
        "node:child_process",
        "child_process",
        "node:module",
        "module",
      ].includes(specifier),
    );
  return {
    specifiers: [...specifiers],
    issue,
    issueKind: "opaque",
    dynamicTargets: [...dynamicTargets],
    opaque,
  };
}

interface BuildConfig {
  readonly compilerOptions: Record<string, unknown>;
  readonly record: Record<string, unknown>;
  readonly hasFiles: boolean;
}

// Relative emitted imports require the package's actual tsc build identity.
// Unsupported configurations remain unresolved rather than guessing from dist paths.
function emittedSourceIndex(snapshot: SourceSnapshot): ReadonlyMap<string, ReadonlySet<string>> {
  const outputs = new Map<string, Set<string>>();
  const readConfig = (path: string, seen: Set<string>): BuildConfig | undefined => {
    if (seen.has(path)) return undefined;
    seen.add(path);

    const content = snapshot.jsonFiles.get(path);

    if (content === undefined) return undefined;
    let record: Record<string, unknown>;

    try {
      record = asRecord(JSON.parse(content), path);
    } catch {
      return undefined;
    }

    let inherited: Record<string, unknown> = {};
    let hasFiles = record.files !== undefined;

    if (record.extends !== undefined) {
      if (typeof record.extends !== "string" || !record.extends.startsWith(".")) return undefined;
      let parent = posix.normalize(posix.join(posix.dirname(path), record.extends));

      if (!posix.extname(parent)) parent += ".json";

      if (parent.startsWith("../") || parent.startsWith("/")) return undefined;
      const config = readConfig(parent, seen);

      if (!config) return undefined;
      inherited = config.compilerOptions;
      hasFiles ||= config.hasFiles;
    }

    if (
      typeof record.compilerOptions !== "object" ||
      record.compilerOptions === null ||
      Array.isArray(record.compilerOptions)
    )
      return undefined;
    return { record, compilerOptions: { ...inherited, ...record.compilerOptions }, hasFiles };
  };

  for (const [manifestPath, content] of snapshot.packageJsons) {
    let manifest: Record<string, unknown>;

    try {
      manifest = asRecord(JSON.parse(content), manifestPath);
    } catch {
      continue;
    }

    if (typeof manifest.name !== "string" || !manifest.name) continue;
    const scripts = manifest.scripts as Record<string, unknown> | undefined;
    const command = typeof scripts?.build === "string" ? scripts.build : "";
    const match = /^(?:bunx )?tsc -p ([A-Za-z0-9_./-]+\.json)$/.exec(command);

    if (!match?.[1]) continue;
    const directory = posix.dirname(manifestPath);
    const configPath = posix.normalize(posix.join(directory, match[1]));

    if (!configPath.startsWith(`${directory}/`) && directory !== ".") continue;
    const config = readConfig(configPath, new Set());

    if (!config) continue;
    const options = config.compilerOptions;
    const ownOptions = config.record.compilerOptions as Record<string, unknown>;
    // Require explicit roots: inherited path options use their declaring config's base.

    if (
      typeof ownOptions.rootDir !== "string" ||
      typeof ownOptions.outDir !== "string" ||
      options.noEmit !== false ||
      options.emitDeclarationOnly === true ||
      options.outFile !== undefined ||
      options.allowJs === true ||
      config.hasFiles ||
      !Array.isArray(config.record.include) ||
      !Array.isArray(config.record.exclude) ||
      config.record.exclude.length !== 0
    )
      continue;
    const configDirectory = posix.dirname(configPath);
    const root = posix.normalize(posix.join(configDirectory, ownOptions.rootDir));
    const out = posix.normalize(posix.join(configDirectory, ownOptions.outDir));

    if (root === out || !root.startsWith(`${directory}/`) || !out.startsWith(`${directory}/`))
      continue;
    const relativeRoot = posix.relative(configDirectory, root);
    const includes = config.record.include;

    if (
      !includes.length ||
      includes.some(
        (value) => value !== `${relativeRoot}/**/*.ts` && value !== `${relativeRoot}/**/*.tsx`,
      )
    )
      continue;

    for (const source of snapshot.sourceFiles.keys()) {
      if (!source.startsWith(`${root}/`) || source.endsWith(".d.ts")) continue;
      const extension = posix.extname(source);

      if (extension !== ".ts" && extension !== ".tsx") continue;

      if (!includes.includes(`${relativeRoot}/**/*${extension}`)) continue;
      let emitted = ".js";

      if (extension === ".tsx") {
        if (options.jsx === "preserve") emitted = ".jsx";
        else if (!["react", "react-jsx", "react-jsxdev"].includes(String(options.jsx))) continue;
      }

      const output =
        posix.join(out, posix.relative(root, source)).slice(0, -extension.length) + emitted;
      const sources = outputs.get(output) ?? new Set<string>();
      sources.add(source);

      outputs.set(output, sources);
    }
  }

  return outputs;
}

function resolveRelativeImport(
  importer: string,
  specifier: string,
  paths: ReadonlySet<string>,
  emittedSources: ReadonlyMap<string, ReadonlySet<string>>,
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

  const tracked = candidates.find((candidate) => paths.has(candidate));
  if (tracked) return tracked;
  const sources = emittedSources.get(base);
  return sources?.size === 1 ? [...sources][0] : undefined;
}

function acquireSourceGraph(snapshot: SourceSnapshot, label: string): SourceGraph {
  const nodes = new Set<string>();
  const edges: DependencyEdge[] = [];
  const incompleteDependencies: IncompleteDependency[] = [];
  const opaqueConsumers = new Set<string>();
  const packages = workspacePackageIndex(snapshot.packageJsons, snapshot.paths);
  const emittedSources = emittedSourceIndex(snapshot);
  const issues = [...snapshot.issues, ...packages.issues];

  for (const [consumer, source] of snapshot.sourceFiles) {
    nodes.add(consumer);

    const parsed = collectModuleSpecifiers(source, consumer, snapshot.paths);

    if (parsed.opaque) opaqueConsumers.add(consumer);

    for (const dependency of parsed.dynamicTargets) {
      nodes.add(dependency);

      edges.push({ consumer, dependency, revisions: [] });
    }

    if (parsed.issue) {
      incompleteDependencies.push({
        path: consumer,
        reason: `${label}: ${parsed.issue}`,
        kind: parsed.issueKind ?? "invalid",
      });
    }

    for (const specifier of parsed.specifiers) {
      let dependency = resolveRelativeImport(consumer, specifier, snapshot.paths, emittedSources);
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
          kind: "invalid",
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
    opaqueConsumers,
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
  acquire: () => SourceGraph,
  side: string,
): { readonly graph: SourceGraph; readonly reason?: string } {
  try {
    return { graph: acquire() };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      graph: {
        nodes: new Set(),
        edges: [],
        issues: [],
        incompleteDependencies: [],
        opaqueConsumers: new Set(),
      },
      reason: `Could not acquire the ${side} source dependency graph: ${detail}`,
    };
  }
}

function mergeGraphInputs(...graphs: readonly SourceGraph[]): SourceGraph {
  const nodes = new Set<string>();
  const edges = new Map<string, DependencyEdge>();
  const issues = new Set<string>();
  const incompleteDependencies: IncompleteDependency[] = [];
  const opaqueConsumers = new Set<string>();

  for (const graph of graphs) {
    for (const node of graph.nodes) nodes.add(node);

    for (const issue of graph.issues) issues.add(issue);

    incompleteDependencies.push(...graph.incompleteDependencies);

    for (const consumer of graph.opaqueConsumers) opaqueConsumers.add(consumer);

    for (const edge of graph.edges) edges.set(`${edge.consumer}\0${edge.dependency}`, edge);
  }

  return {
    nodes,
    edges: [...edges.values()],
    issues: [...issues],
    incompleteDependencies: dedupeIncompleteDependencies(incompleteDependencies),
    opaqueConsumers,
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

function combineGraphs(base: SourceGraph, head: SourceGraph): SourceDependencyGraph {
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
    opaqueConsumers: new Set([...base.opaqueConsumers, ...head.opaqueConsumers]),
  };
}

/** Return static consumer chains, including the seed itself, without revisiting cycles. */
export function traceImpacts(
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

/** Return roots and all statically resolved dependencies reachable from them. */
export function dependencyClosure(
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

/** Static consumers and dependencies preserved across the compared revisions. */
export interface SourceDependencyGraph {
  /** Tracked dependency graph paths. */
  readonly nodes: ReadonlySet<string>;
  /** Incoming edges keyed by dependency, preserving base and head. */
  readonly reverseDependencies: ReadonlyMap<string, readonly DependencyEdge[]>;
  /** Outgoing edges keyed by importing consumer. */
  readonly dependenciesByConsumer: ReadonlyMap<string, readonly DependencyEdge[]>;
  /** Unresolved dependencies, including their uncertainty classification. */
  readonly incompleteDependencies: readonly IncompleteDependency[];
  /** Modules with runtime loading, filesystem, or process capabilities. */
  readonly opaqueConsumers: ReadonlySet<string>;
}

/** Source facts shared by ordinary and golden verification selection. */
export interface SourceImpact {
  /** Resolved base commit identity. */
  readonly base: string;
  /** Resolved head commit identity; workspace dirtiness is reported separately. */
  readonly head: string;
  /** Tracked paths, including non-source inputs. */
  readonly paths: ReadonlySet<string>;
  /** Executable source paths from either snapshot. */
  readonly sourcePaths: ReadonlySet<string>;
  /** Tracked base commit text and paths. */
  readonly baseSnapshot: SourceSnapshot;
  /** Tracked workspace text and paths for the resolved head. */
  readonly headSnapshot: SourceSnapshot;
  /** Dependencies acquired from the base snapshot. */
  readonly baseGraph: SourceGraph;
  /** Dependencies acquired from tracked workspace files. */
  readonly headGraph: SourceGraph;
  /** Union of base and head dependency and uncertainty facts. */
  readonly graph: SourceDependencyGraph;
  /** Git changes, retaining both sides of removed or renamed inputs. */
  readonly changedPaths: readonly ChangedPath[];
  /** Static reverse-dependency impact chains for changed paths. */
  readonly affectedPaths: readonly PathImpact[];
  /** Fail-closed acquisition or workspace identity explanations. */
  readonly reasons: readonly string[];
}

/** Read tracked source dependencies without modifying the repository or its refs. */
export function readSourceImpact(options: {
  /** Working tree to read without modifying files, index, or refs. */
  readonly repoPath: string;
  /** Resolved base commit identity. */
  readonly base: string;
  /** Resolved head commit identity; workspace dirtiness is reported separately. */
  readonly head: string;
  /** Optional tracked supplemental dependency graph. */
  readonly graphPath?: string;
}): SourceImpact {
  const repoPath = resolve(options.repoPath);
  const base = resolveCommit(repoPath, options.base);
  const head = resolveCommit(repoPath, options.head);
  const changedPaths = parseNameStatus(
    runGit(repoPath, ["diff", "--name-status", "-z", "--no-renames", base, head, "--"]),
  );
  const baseSnapshot = parseGitTree(repoPath, base);
  const headSnapshot = readWorkspaceSnapshot(repoPath);
  const baseSource = safeAcquireSourceGraph(() => acquireSourceGraph(baseSnapshot, "base"), "base");
  const headSource = safeAcquireSourceGraph(
    () => acquireSourceGraph(headSnapshot, "workspace head"),
    "workspace head",
  );
  const baseSupplement = options.graphPath
    ? readGraph(repoPath, base, "base", options.graphPath)
    : undefined;
  const headSupplement = options.graphPath
    ? readGraph(repoPath, head, "head", options.graphPath)
    : undefined;
  const baseGraph = mergeGraphInputs(
    baseSource.graph,
    ...(baseSupplement ? [baseSupplement.graph] : []),
  );
  const headGraph = mergeGraphInputs(
    headSource.graph,
    ...(headSupplement ? [headSupplement.graph] : []),
  );
  const graph = combineGraphs(baseGraph, headGraph);
  const reasons = [
    baseSupplement?.reason,
    headSupplement?.reason,
    baseSource.reason,
    headSource.reason,
    ...baseGraph.issues.map((issue) => `Base source graph is incomplete: ${issue}`),
    ...headGraph.issues.map((issue) => `Workspace head source graph is incomplete: ${issue}`),
    ...workspaceStateReasons(repoPath, head),
  ].filter((reason): reason is string => reason !== undefined);
  return {
    base,
    head,
    baseSnapshot,
    headSnapshot,
    baseGraph,
    headGraph,
    graph,
    changedPaths,
    reasons,
    paths: new Set([...baseSnapshot.paths, ...headSnapshot.paths]),
    sourcePaths: new Set([...baseSnapshot.sourceFiles.keys(), ...headSnapshot.sourceFiles.keys()]),
    affectedPaths: changedPaths.flatMap((changed) =>
      traceImpacts(changed.path, graph.reverseDependencies),
    ),
  };
}
