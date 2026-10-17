import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { CoverageFamilyId } from "./coverage-collector.ts";

export const coverageFamilies: readonly CoverageFamilyId[] = [
  "bun-tests-ordinary",
  "project-worker-owner",
  "browser-css",
  "native-editor",
];

export interface CoverageExecution {
  readonly revision: string;
  readonly runId: string;
  readonly attempt: string;
}

interface GroupManifest {
  readonly format: "hesperia-coverage-group";
  readonly version: 1;
  readonly status: "completed";
  readonly family: CoverageFamilyId;
  readonly platform: string;
  readonly runId: string;
  readonly producerRepoPath: string;
  readonly execution: CoverageExecution;
  readonly summary: Record<string, unknown>;
  readonly files: Readonly<Record<string, string>>;
  readonly supportFiles: Readonly<Record<string, string>>;
}

export function coverageExecution(): CoverageExecution {
  const revision = process.env.HESPERIA_CI_COVERAGE_REVISION;
  const runId = process.env.GITHUB_RUN_ID;
  const attempt = process.env.GITHUB_RUN_ATTEMPT;

  if (
    !revision ||
    !/^[a-f0-9]{40}$/u.test(revision) ||
    !runId ||
    !/^\d+$/u.test(runId) ||
    !attempt ||
    !/^\d+$/u.test(attempt)
  ) {
    throw new Error("Coverage groups require a source revision and workflow execution identity");
  }

  return { revision, runId, attempt };
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function runRelativeDirectory(family: CoverageFamilyId, runId: string): string {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(runId)) {
    throw new Error("Coverage group has an invalid original run identity");
  }

  const root =
    family === "native-editor"
      ? "ec"
      : family === "browser-css"
        ? "coverage/browser-css-runs"
        : "coverage/runs";
  return `${root}/${runId}`;
}

function filesIn(directory: string): string[] {
  const entries = readdirSync(directory, { withFileTypes: true });

  if (entries.length === 0 || entries.some((entry) => !entry.isFile() || entry.isSymbolicLink())) {
    throw new Error("Coverage group evidence must contain only original files");
  }

  return entries.map((entry) => entry.name).sort();
}

export function writeCoverageGroup(options: {
  readonly repoPath: string;
  readonly bundlePath: string;
  readonly family: CoverageFamilyId;
  readonly runId: string;
  readonly outputDirectory: string;
  readonly summary: Record<string, unknown>;
  readonly execution: CoverageExecution;
  readonly captureSupport: (directory: string) => void;
}): void {
  const directory = runRelativeDirectory(options.family, options.runId);
  const expected = resolve(options.repoPath, ".hesperia", directory);

  if (resolve(options.outputDirectory) !== expected) {
    throw new Error("Coverage group output escaped its original run directory");
  }

  if (!coverageFamilies.includes(options.family)) {
    throw new Error("Coverage group has an unsupported family");
  }

  const files = Object.fromEntries(
    filesIn(expected).map((name) => [name, sha256(join(expected, name))]),
  );
  mkdirSync(options.bundlePath);

  cpSync(expected, join(options.bundlePath, "evidence", directory), {
    recursive: true,
    errorOnExist: true,
    force: false,
  });

  const supportDirectory = `coverage/final-runs/${options.runId}`;
  const supportPath = resolve(options.repoPath, ".hesperia", supportDirectory);

  options.captureSupport(supportPath);

  const supportFiles = Object.fromEntries(
    filesIn(supportPath).map((name) => [name, sha256(join(supportPath, name))]),
  );

  cpSync(supportPath, join(options.bundlePath, "evidence", supportDirectory), {
    recursive: true,
    errorOnExist: true,
    force: false,
  });

  const manifest: GroupManifest = {
    format: "hesperia-coverage-group",
    version: 1,
    status: "completed",
    family: options.family,
    platform: process.platform,
    runId: options.runId,
    producerRepoPath: resolve(options.repoPath),
    execution: options.execution,
    summary: options.summary,
    files,
    supportFiles,
  };

  writeFileSync(join(options.bundlePath, "coverage-group.json"), JSON.stringify(manifest), {
    flag: "wx",
  });
}

function bundleEntries(directory: string, prefix = ""): string[] {
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const name = `${prefix}${entry.name}`;

      if (entry.isSymbolicLink() || (!entry.isFile() && !entry.isDirectory())) {
        throw new Error("Coverage group contains foreign filesystem evidence");
      }

      return entry.isDirectory()
        ? [name + "/", ...bundleEntries(join(directory, entry.name), name + "/")]
        : [name];
    })
    .sort();
}

export function readCoverageGroups(options: {
  readonly repoPath: string;
  readonly bundleRoot: string;
  readonly execution: CoverageExecution;
}): readonly {
  readonly family: CoverageFamilyId;
  readonly summary: Record<string, unknown>;
  readonly producerRepoPath: string;
  readonly outputDirectory: string;
  readonly supportDirectory: string;
}[] {
  const bundles = readdirSync(options.bundleRoot, { withFileTypes: true });

  if (
    bundles.length !== coverageFamilies.length ||
    bundles.some((entry) => !entry.isDirectory() || entry.isSymbolicLink())
  ) {
    throw new Error("Coverage aggregate requires exactly four original group bundles");
  }

  const seenFamilies = new Set<string>();
  const seenRunIds = new Set<string>();
  const admitted = bundles.map((bundle) => {
    const root = join(options.bundleRoot, bundle.name);
    const value = JSON.parse(
      readFileSync(join(root, "coverage-group.json"), "utf8"),
    ) as GroupManifest;

    if (
      value.format !== "hesperia-coverage-group" ||
      value.version !== 1 ||
      value.status !== "completed" ||
      !coverageFamilies.includes(value.family) ||
      value.platform !== process.platform ||
      typeof value.runId !== "string" ||
      typeof value.producerRepoPath !== "string" ||
      !isAbsolute(value.producerRepoPath) ||
      !value.execution ||
      value.execution.revision !== options.execution.revision ||
      value.execution.runId !== options.execution.runId ||
      value.execution.attempt !== options.execution.attempt ||
      !value.summary ||
      value.summary.status !== "completed" ||
      value.summary.runId !== value.runId ||
      !value.files ||
      typeof value.files !== "object" ||
      Array.isArray(value.files) ||
      !value.supportFiles ||
      typeof value.supportFiles !== "object" ||
      Array.isArray(value.supportFiles) ||
      seenFamilies.has(value.family) ||
      seenRunIds.has(value.runId)
    ) {
      throw new Error("Coverage group is failed, foreign, stale, or duplicated");
    }

    seenFamilies.add(value.family);

    seenRunIds.add(value.runId);

    const directory = runRelativeDirectory(value.family, value.runId);
    const supportDirectory = `coverage/final-runs/${value.runId}`;
    const inventories = [
      { directory, files: value.files },
      { directory: supportDirectory, files: value.supportFiles },
    ];
    const expectedEntries = new Set(["coverage-group.json", "evidence/"]);

    for (const inventory of inventories) {
      const evidence = join(root, "evidence", inventory.directory);
      const names = filesIn(evidence);
      const parts = inventory.directory.split("/");

      for (let index = 0; index < parts.length; index++) {
        expectedEntries.add(`evidence/${parts.slice(0, index + 1).join("/")}/`);
      }

      if (JSON.stringify(names) !== JSON.stringify(Object.keys(inventory.files).sort())) {
        throw new Error("Coverage group evidence differs from its original file inventory");
      }

      for (const name of names) {
        expectedEntries.add(`evidence/${inventory.directory}/${name}`);

        const expectedSha256 = inventory.files[name];

        if (
          !expectedSha256 ||
          !/^[a-f0-9]{64}$/u.test(expectedSha256) ||
          sha256(join(evidence, name)) !== expectedSha256
        ) {
          throw new Error(`Coverage group original evidence changed: ${name}`);
        }
      }
    }

    if (JSON.stringify(bundleEntries(root)) !== JSON.stringify([...expectedEntries].sort())) {
      throw new Error("Coverage group bundle contains foreign evidence");
    }

    const originalDirectory = resolve(value.producerRepoPath, ".hesperia", directory);

    if (
      value.summary.outputDirectory !== originalDirectory ||
      value.summary.lcovPath !== join(originalDirectory, "lcov.info")
    ) {
      throw new Error("Coverage group summary escaped its original producer directory");
    }

    return {
      family: value.family,
      summary: value.summary,
      producerRepoPath: value.producerRepoPath,
      outputDirectory: resolve(options.repoPath, ".hesperia", directory),
      evidence: join(root, "evidence", directory),
      supportDirectory: resolve(options.repoPath, ".hesperia", supportDirectory),
      supportEvidence: join(root, "evidence", supportDirectory),
    };
  });

  for (const group of admitted.flatMap((group) => [
    group,
    { outputDirectory: group.supportDirectory, evidence: group.supportEvidence },
  ])) {
    const relativeDirectory = relative(
      resolve(options.repoPath, ".hesperia"),
      group.outputDirectory,
    );

    if (
      relativeDirectory.startsWith(`..${sep}`) ||
      isAbsolute(relativeDirectory) ||
      existsSync(group.outputDirectory)
    ) {
      throw new Error("Coverage aggregate cannot replace an existing original run directory");
    }

    mkdirSync(join(group.outputDirectory, ".."), { recursive: true });

    cpSync(group.evidence, group.outputDirectory, {
      recursive: true,
      errorOnExist: true,
      force: false,
    });
  }

  return admitted;
}
