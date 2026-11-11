import { appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { readSourceImpact, traceImpacts } from "./source-impact.ts";

const ordinaryRoots = [
  "compiler",
  "runtime",
  "data",
  "tooling",
  "routing",
  "editor",
  "hosting",
  "ci",
] as const;
type OrdinaryRoot = (typeof ordinaryRoots)[number];
const workspacePackages = new Set([
  "compiler",
  "hesperia",
  "tooling",
  "language-server",
  "hosting",
  "create-hesperia",
  "elysia",
  "postcss",
  "tailwind",
  "stylex",
]);
type Owners = {
  roots: readonly OrdinaryRoot[];
  browser?: boolean;
  package?: boolean;
  vscode?: boolean;
  golden?: boolean;
};

/** Inputs to the ordinary verification selector. Explicit full runs retain every gate. */
export interface VerificationOptions {
  readonly repoPath: string;
  readonly base: string;
  readonly head: string;
  readonly full?: boolean;
}

/** Conservative root-level selection, with the evidence that selected each owner. */
export interface VerificationSelection {
  readonly schemaVersion: 1;
  readonly base: string;
  readonly head: string;
  readonly full: boolean;
  readonly roots: readonly OrdinaryRoot[];
  readonly browser: boolean;
  readonly package: boolean;
  readonly vscode: boolean;
  readonly golden: boolean;
  readonly changedPaths: readonly { readonly path: string; readonly status: string }[];
  readonly reasons: readonly string[];
  readonly fallbackReasons: readonly string[];
}

function testOwner(path: string): Owners | undefined {
  const root = /^tests\/(compiler|runtime|data|tooling|routing|editor|hosting|ci)\//u.exec(
    path,
  )?.[1];

  if (root) return { roots: [root as OrdinaryRoot] };
  if (path.startsWith("tests/package/")) return { roots: [], package: true };
  if (path.startsWith("tests/browser/")) return { roots: [], browser: true };
  if (path.startsWith("editors/vscode/tests/")) return { roots: [], vscode: true };
  if (path.startsWith("golden/")) return { roots: [], golden: true };
  return undefined;
}

function productionOwner(path: string): Owners | undefined {
  const packageName = /^packages\/([^/]+)\/src\//u.exec(path)?.[1];

  if (packageName === "hesperia") {
    const root =
      path.startsWith("packages/hesperia/src/data/") ||
      path.startsWith("packages/hesperia/src/aeolia/")
        ? "data"
        : path.startsWith("packages/hesperia/src/routing/")
          ? "routing"
          : "runtime";
    return { roots: [root] };
  }
  if (packageName === "compiler") return { roots: ["compiler"] };
  if (packageName === "hosting") return { roots: ["hosting"] };
  if (packageName === "language-server") return { roots: ["editor"] };
  if (
    ["tooling", "create-hesperia", "elysia", "postcss", "tailwind", "stylex"].includes(
      packageName ?? "",
    )
  )
    return { roots: ["tooling"] };
  if (path.startsWith("editors/vscode/src/")) return { roots: ["editor"], vscode: true };
  return undefined;
}

function documentationOwner(path: string): Owners | undefined {
  if (!/\.(?:md|txt)$/iu.test(path) && !["LICENSE", "COPYING"].includes(path)) return undefined;
  if (path.startsWith("docs/")) return { roots: [] };
  const packageName = /^packages\/([^/]+)\/(?:docs\/.*|README\.md)$/u.exec(path)?.[1];
  if (packageName && workspacePackages.has(packageName)) return { roots: [], package: true };
  if (path === "editors/vscode/README.md") return { roots: [], package: true, vscode: true };
  if (path === "golden/README.md") return { roots: [] };
  if (
    ["README.md", "CONTRIBUTING.md", "LICENSE", "COPYING", "LICENSE-COMMERCIAL.md"].includes(path)
  )
    return { roots: [], package: true };
  if (["AGENTS.md", "CLAUDE.md", "AI_POLICY.md", "CODE-OF-CONDUCT.md"].includes(path))
    return { roots: [] };
  return undefined;
}

function fixtureOwner(path: string): Owners | undefined {
  return /^tests\/(?:compiler|runtime|data|tooling|routing|editor|hosting|package|browser)\/fixtures\/applications\/[^/]+\//u.test(
    path,
  )
    ? testOwner(path)
    : undefined;
}

function requiresFull(path: string): string | undefined {
  if (
    path === "package.json" ||
    path.endsWith("/package.json") ||
    /(?:^|\/)(?:bun\.lock|[^/]*lock\.json)$/u.test(path)
  )
    return `package manifest or lockfile changed: ${path}`;
  if (["tests/README.md", "docs/ci.md", "docs/ci-selection.md"].includes(path))
    return `verification policy changed: ${path}`;
  if (path.startsWith(".github/") || path.startsWith("scripts/"))
    return `verification or build support changed: ${path}`;
  if (fixtureOwner(path)) return undefined;
  if (productionOwner(path) || documentationOwner(path)) return undefined;
  if (
    /^tests\/(?:compiler|runtime|data|tooling|routing|editor|hosting|ci|package)\/.*\.test\.ts$/u.test(
      path,
    )
  )
    return undefined;
  if (
    /^tests\/browser\/.*\.spec\.ts$/u.test(path) ||
    /^editors\/vscode\/tests\/.*\.test\.ts$/u.test(path)
  )
    return undefined;
  if (path.startsWith("golden/")) return undefined;
  return `shared support, configuration, or unknown impact changed: ${path}`;
}

/** Select ordinary test roots from both revisions and conservatively owned opaque consumers. */
export function selectVerification(options: VerificationOptions): VerificationSelection {
  const roots = new Set<OrdinaryRoot>();
  const flags = { browser: false, package: false, vscode: false, golden: false };
  const reasons = new Set<string>();
  const fallback = new Set<string>();
  let base = options.base;
  let head = options.head;
  let changedPaths: VerificationSelection["changedPaths"] = [];

  const addOwners = (owner: Owners, reason: string): void => {
    for (const root of owner.roots) roots.add(root);
    for (const flag of ["browser", "package", "vscode", "golden"] as const)
      flags[flag] ||= owner[flag] === true;
    reasons.add(reason);
  };

  try {
    const impact = readSourceImpact(options);
    base = impact.base;
    head = impact.head;
    changedPaths = impact.changedPaths;
    for (const reason of impact.reasons) fallback.add(reason);
    if (!changedPaths.length) fallback.add("comparison contains no changed paths");

    for (const changed of changedPaths) {
      const full = requiresFull(changed.path);
      if (full) fallback.add(full);
      const owner =
        productionOwner(changed.path) ??
        fixtureOwner(changed.path) ??
        documentationOwner(changed.path) ??
        testOwner(changed.path);
      if (owner) addOwners(owner, `owner of ${changed.path}`);
      if (productionOwner(changed.path)) {
        // Emitted imports and built package/editor consumers are not limited to AST import edges.
        flags.browser = flags.package = flags.vscode = flags.golden = true;
      }
    }

    for (const affected of impact.affectedPaths) {
      const owner = testOwner(affected.path);
      if (owner) addOwners(owner, `dependent ${affected.dependencyChain.join(" -> ")}`);
    }

    const fixtureInputs = new Set<string>();
    for (const item of impact.graph.incompleteDependencies) {
      if (fixtureOwner(item.path)) fixtureInputs.add(item.path);
      else if (item.kind !== "opaque")
        fallback.add(`invalid source dependency graph at ${item.path}: ${item.reason}`);
    }

    const opaque = new Set([
      ...fixtureInputs,
      ...impact.graph.incompleteDependencies
        .filter((item) => item.kind === "opaque")
        .map((item) => item.path),
      ...impact.baseGraph.opaqueConsumers,
      ...impact.headGraph.opaqueConsumers,
    ]);

    // An unresolved loader may target any tracked path. Select its consumers even when no edge
    // leads back from the changed file; relying on that missing edge would discard the uncertainty.
    for (const path of opaque) {
      let owned = false;
      for (const affected of traceImpacts(path, impact.graph.reverseDependencies)) {
        const owner = testOwner(affected.path) ?? productionOwner(affected.path);
        if (owner) {
          addOwners(owner, `opaque consumer ${path} can read changed tracked inputs`);
          owned = true;
        }
      }
      if (!owned && path.startsWith("scripts/")) {
        addOwners({ roots: ["ci"] }, `verification/build script consumer ${path}`);
        owned = true;
      }
      if (!owned && path === "playwright.config.ts") {
        addOwners({ roots: [], browser: true }, `browser configuration consumer ${path}`);
        owned = true;
      }
      if (!owned) fallback.add(`opaque consumer has no verified test owner: ${path}`);
    }
  } catch (error) {
    fallback.add(
      `could not establish source impact: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (options.full) fallback.add("explicit full verification requested");
  const full = fallback.size > 0;
  return {
    schemaVersion: 1,
    base,
    head,
    full,
    roots: full ? ordinaryRoots : ordinaryRoots.filter((root) => roots.has(root)),
    browser: full || flags.browser,
    package: full || flags.package,
    vscode: full || flags.vscode,
    golden: full || flags.golden,
    changedPaths,
    reasons: [...reasons].sort(),
    fallbackReasons: [...fallback].sort(),
  };
}

function verificationOutputs(selection: VerificationSelection): string {
  return (
    Object.entries({
      all_count: String(selection.changedPaths.length),
      full: String(selection.full),
      policy: "false",
      ...Object.fromEntries(
        ordinaryRoots.map((root) => [root, String(selection.roots.includes(root))]),
      ),
      browser: String(selection.browser),
      package: String(selection.package),
      vscode: String(selection.vscode),
      golden: String(selection.golden),
      scope_complete: "true",
    })
      .map(([name, value]) => `${name}=${value}`)
      .join("\n") + "\n"
  );
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const value = (name: string) =>
    args.indexOf(name) < 0 ? undefined : args[args.indexOf(name) + 1];
  const selection = selectVerification({
    repoPath: resolve("."),
    base: value("--base") ?? "",
    head: value("--head") ?? "",
    full: args.includes("--full"),
  });
  console.log(JSON.stringify(selection));
  if (process.env.GITHUB_OUTPUT)
    appendFileSync(process.env.GITHUB_OUTPUT, verificationOutputs(selection));
}
