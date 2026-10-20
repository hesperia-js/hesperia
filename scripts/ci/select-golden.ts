import {
  readRevisionFile,
  readSourceImpact,
  traceImpacts,
  dependencyClosure,
  type ChangedPath,
  type PathImpact,
  type SourceDependencyGraph,
} from "./source-impact.ts";
import { resolve } from "node:path";
import { assessGoldenReaders } from "./golden-reader-contracts.ts";

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
  readonly graph: SourceDependencyGraph;
  readonly changedPaths: readonly ChangedPath[];
  readonly releaseCandidate: boolean;
  readonly graphReadReasons: readonly string[];
  readonly readerImpacts: readonly { readonly id: string; readonly reason: string }[];
}): GoldenSelection {
  const fallbackReasons: string[] = [...input.graphReadReasons];
  const graph = input.graph;
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

  for (const impact of input.readerImpacts) {
    const reasons = impactedBehaviorReasons.get(impact.id) ?? new Set<string>();

    reasons.add(impact.reason);

    impactedBehaviorReasons.set(impact.id, reasons);
  }

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
  const impact = readSourceImpact({ repoPath, base: options.base, head: options.head, graphPath });
  const catalog = parseCatalog(readRevisionFile(repoPath, impact.head, catalogPath), catalogPath);
  const readers = assessGoldenReaders({
    impact,
    behaviors: catalog.behaviors,
    cases: catalog.cases,
  });

  return selectFromInputs({
    base: impact.base,
    head: impact.head,
    catalogPath,
    graphPath,
    catalog,
    graph: impact.graph,
    changedPaths: impact.changedPaths,
    releaseCandidate: options.releaseCandidate ?? false,
    graphReadReasons: [...impact.reasons, ...readers.fallbackReasons],
    readerImpacts: readers.affectedBehaviors,
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
