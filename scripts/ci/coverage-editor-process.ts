import { readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { threadId } from "node:worker_threads";

export interface EditorCoverageOutput {
  readonly originalPath: string;
  readonly compiledPath: string;
}

export interface EditorCoverageConfig {
  readonly format: "hesperia-editor-coverage-config";
  readonly version: 1;
  readonly runId: string;
  readonly repoPath: string;
  readonly outputDirectory: string;
  readonly populationFingerprint: string;
  readonly testHostPath: string;
  readonly languageServerSourcePaths: readonly string[];
  readonly outputs: readonly EditorCoverageOutput[];
  readonly supportConfigPath?: string;
  readonly verificationControl?: "kill-extension-host" | "kill-language-server";
}

export interface EditorCoverageSupportOwner {
  readonly ownerId: string;
  readonly sourcePaths: readonly string[];
}

export interface EditorCoverageSupportConfig {
  readonly format: "hesperia-editor-coverage-support-config";
  readonly version: 1;
  readonly runId: string;
  readonly populationFingerprint: string;
  readonly outputDirectory: string;
  readonly driver: EditorCoverageSupportOwner;
  readonly extensionHost: EditorCoverageSupportOwner;
  readonly languageServer: EditorCoverageSupportOwner;
}

export interface EditorOwnerStart {
  readonly format: "hesperia-editor-owner-start";
  readonly version: 1;
  readonly runId: string;
  readonly populationFingerprint: string;
  readonly ownerId: string;
  readonly role: "extension-host" | "language-server";
  readonly pid: number;
  readonly ppid: number;
  readonly execPath: string;
  readonly argv: readonly string[];
  readonly startedAt: string;
}

export interface EditorOwnerExit extends Omit<EditorOwnerStart, "format"> {
  readonly format: "hesperia-editor-owner-exit";
  readonly exitCode: number;
  readonly coverageFile: string;
  readonly exitedAt: string;
}

export interface EditorOwnerCoverage {
  readonly format: "hesperia-editor-owner-coverage";
  readonly version: 1;
  readonly runId: string;
  readonly populationFingerprint: string;
  readonly ownerId: string;
  readonly role: "extension-host" | "language-server";
  readonly pid: number;
  readonly ppid: number;
  readonly argv: readonly string[];
  readonly coverage: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === expected.length && actual.every((key) => expected.includes(key));
}

function normalizedPath(path: string): string {
  const absolute = resolve(path);
  return process.platform === "win32" ? absolute.toLowerCase() : absolute;
}

function sourcePaths(value: unknown, repoPath: string, description: string): string[] {
  if (
    !Array.isArray(value) ||
    !value.every((path) => typeof path === "string" && isAbsolute(path))
  ) {
    throw new Error(`Editor support ${description} source list is malformed`);
  }

  const paths = value.map((path) => resolve(path));
  const unique = new Set(paths.map(normalizedPath));

  if (
    unique.size !== paths.length ||
    paths.some((path) => {
      const relativePath = relative(repoPath, path);
      return relativePath === "" || relativePath === ".." || relativePath.startsWith(`..${sep}`);
    })
  ) {
    throw new Error(`Editor support ${description} sources are not unique repository paths`);
  }

  return paths;
}

export function writeEditorCoverageSupportConfig(options: {
  readonly runId: string;
  readonly populationFingerprint: string;
  readonly repoPath: string;
  readonly outputDirectory: string;
  readonly driverSources: readonly string[];
  readonly extensionHostSources: readonly string[];
  readonly languageServerSources: readonly string[];
}): string {
  const repoPath = resolve(options.repoPath);
  const outputDirectory = resolve(options.outputDirectory);

  const toAbsoluteSources = (sources: readonly string[], description: string) =>
    sourcePaths(
      sources.map((path) => resolve(repoPath, path)),
      repoPath,
      description,
    );

  const driverSources = toAbsoluteSources(options.driverSources, "driver");
  const extensionHostSources = toAbsoluteSources(options.extensionHostSources, "Extension Host");
  const languageServerSources = toAbsoluteSources(options.languageServerSources, "language-server");

  if (
    options.runId.length !== 36 ||
    !/^[a-f0-9-]{36}$/u.test(options.runId) ||
    !/^[a-f0-9]{64}$/u.test(options.populationFingerprint) ||
    !driverSources.some(
      (path) =>
        normalizedPath(path) ===
        normalizedPath(resolve(repoPath, "scripts/ci/run-editor-coverage.ts")),
    ) ||
    !driverSources.some(
      (path) =>
        normalizedPath(path) ===
        normalizedPath(resolve(repoPath, "scripts/ci/coverage-editor-process.ts")),
    ) ||
    extensionHostSources.length !== 1 ||
    normalizedPath(extensionHostSources[0]!) !==
      normalizedPath(resolve(repoPath, "scripts/ci/coverage-editor-process.ts")) ||
    languageServerSources.length !== 2 ||
    normalizedPath(languageServerSources[0]!) !==
      normalizedPath(resolve(repoPath, "scripts/ci/coverage-editor-preload.ts")) ||
    normalizedPath(languageServerSources[1]!) !==
      normalizedPath(resolve(repoPath, "scripts/ci/coverage-editor-process.ts"))
  ) {
    throw new Error("Editor support owner sources do not match the prepared current-run profiles");
  }

  const config: EditorCoverageSupportConfig = {
    format: "hesperia-editor-coverage-support-config",
    version: 1,
    runId: options.runId,
    populationFingerprint: options.populationFingerprint,
    outputDirectory,
    driver: { ownerId: "vscode-editor-driver", sourcePaths: driverSources },
    extensionHost: { ownerId: "vscode-editor-host-support", sourcePaths: extensionHostSources },
    languageServer: { ownerId: "vscode-editor-ls-support", sourcePaths: languageServerSources },
  };
  const path = resolve(outputDirectory, "editor-coverage-support.json");

  writeFileSync(path, JSON.stringify(config), { flag: "wx" });

  return path;
}

export function readEditorCoverageConfig(): EditorCoverageConfig {
  const configPath = process.env.HESPERIA_EDITOR_COVERAGE_CONFIG;

  if (!configPath) throw new Error("Editor coverage owner has no run configuration");

  const value: unknown = JSON.parse(readFileSync(configPath, "utf8"));

  if (
    isRecord(value) &&
    !hasExactKeys(value, [
      "format",
      "version",
      "runId",
      "repoPath",
      "outputDirectory",
      "populationFingerprint",
      "testHostPath",
      "languageServerSourcePaths",
      "outputs",
      ...(Object.prototype.hasOwnProperty.call(value, "supportConfigPath")
        ? ["supportConfigPath"]
        : []),
      ...(Object.prototype.hasOwnProperty.call(value, "verificationControl")
        ? ["verificationControl"]
        : []),
    ])
  ) {
    throw new Error("Editor coverage run configuration contains missing or unexpected fields");
  }

  if (
    !isRecord(value) ||
    value.format !== "hesperia-editor-coverage-config" ||
    value.version !== 1 ||
    typeof value.runId !== "string" ||
    !/^[a-f0-9-]{36}$/u.test(value.runId) ||
    typeof value.repoPath !== "string" ||
    typeof value.outputDirectory !== "string" ||
    typeof value.populationFingerprint !== "string" ||
    !/^[a-f0-9]{64}$/u.test(value.populationFingerprint) ||
    typeof value.testHostPath !== "string" ||
    (value.supportConfigPath !== undefined &&
      (typeof value.supportConfigPath !== "string" || !isAbsolute(value.supportConfigPath))) ||
    (value.verificationControl !== undefined &&
      value.verificationControl !== "kill-extension-host" &&
      value.verificationControl !== "kill-language-server") ||
    !Array.isArray(value.languageServerSourcePaths) ||
    !value.languageServerSourcePaths.every((path) => typeof path === "string") ||
    !Array.isArray(value.outputs) ||
    !value.outputs.every(
      (output) =>
        isRecord(output) &&
        hasExactKeys(output, ["originalPath", "compiledPath"]) &&
        typeof output.originalPath === "string" &&
        typeof output.compiledPath === "string",
    )
  ) {
    throw new Error("Editor coverage run configuration is malformed");
  }

  const repoPath = resolve(value.repoPath);
  const languageServerSourcePaths = value.languageServerSourcePaths.map((path) => resolve(path));
  const uniqueSourcePaths = new Set(
    languageServerSourcePaths.map((path) =>
      process.platform === "win32" ? path.toLowerCase() : path,
    ),
  );

  if (
    uniqueSourcePaths.size !== languageServerSourcePaths.length ||
    value.languageServerSourcePaths.some((path) => !isAbsolute(path)) ||
    languageServerSourcePaths.some((path) => {
      const relativePath = relative(repoPath, path);
      return relativePath === ".." || relativePath.startsWith(`..${sep}`) || relativePath === "";
    })
  ) {
    throw new Error(
      "Editor language-server source admission is not a unique absolute path set inside the repository",
    );
  }

  const testHostPath = resolve(value.testHostPath);
  const expectedTestHostPath = resolve(
    repoPath,
    ".hesperia",
    "coverage",
    "editor-builds",
    value.runId,
    "vscode-extension",
    "dist",
    "test-host.cjs",
  );

  const canonical = (path: string) => (process.platform === "win32" ? path.toLowerCase() : path);

  if (canonical(testHostPath) !== canonical(expectedTestHostPath)) {
    throw new Error(
      "Editor test assertions path does not belong to the current prepared capture run",
    );
  }

  const outputDirectory = resolve(value.outputDirectory);
  const supportConfigPath =
    value.supportConfigPath === undefined ? undefined : resolve(value.supportConfigPath);

  if (
    supportConfigPath !== undefined &&
    canonical(supportConfigPath) !==
      canonical(resolve(outputDirectory, "editor-coverage-support.json"))
  ) {
    throw new Error("Editor support configuration path does not belong to the current run");
  }

  return {
    ...(value as unknown as EditorCoverageConfig),
    repoPath,
    outputDirectory,
    testHostPath,
    languageServerSourcePaths,
    ...(supportConfigPath ? { supportConfigPath } : {}),
  };
}

export function readEditorCoverageSupportConfig(
  config: EditorCoverageConfig = readEditorCoverageConfig(),
): EditorCoverageSupportConfig | undefined {
  if (!config.supportConfigPath) return undefined;

  const value: unknown = JSON.parse(readFileSync(config.supportConfigPath, "utf8"));

  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "format",
      "version",
      "runId",
      "populationFingerprint",
      "outputDirectory",
      "driver",
      "extensionHost",
      "languageServer",
    ])
  ) {
    throw new Error("Editor support configuration contains missing or unexpected fields");
  }

  const repoPath = resolve(config.repoPath);

  const readOwner = (
    owner: unknown,
    role: string,
    expectedOwnerId: string,
  ): EditorCoverageSupportOwner => {
    if (
      !isRecord(owner) ||
      !hasExactKeys(owner, ["ownerId", "sourcePaths"]) ||
      owner.ownerId !== expectedOwnerId
    ) {
      throw new Error(`Editor support ${role} configuration is malformed`);
    }

    return {
      ownerId: expectedOwnerId,
      sourcePaths: sourcePaths(owner.sourcePaths, repoPath, role),
    };
  };

  if (
    value.format !== "hesperia-editor-coverage-support-config" ||
    value.version !== 1 ||
    value.runId !== config.runId ||
    value.populationFingerprint !== config.populationFingerprint ||
    typeof value.outputDirectory !== "string" ||
    normalizedPath(value.outputDirectory) !== normalizedPath(config.outputDirectory)
  ) {
    throw new Error("Editor support configuration does not match the current run");
  }

  const result: EditorCoverageSupportConfig = {
    format: "hesperia-editor-coverage-support-config",
    version: 1,
    runId: config.runId,
    populationFingerprint: config.populationFingerprint,
    outputDirectory: config.outputDirectory,
    driver: readOwner(value.driver, "driver", "vscode-editor-driver"),
    extensionHost: readOwner(value.extensionHost, "Extension Host", "vscode-editor-host-support"),
    languageServer: readOwner(value.languageServer, "language-server", "vscode-editor-ls-support"),
  };

  const exactPaths = (owner: EditorCoverageSupportOwner, expected: readonly string[]) =>
    owner.sourcePaths.length === expected.length &&
    owner.sourcePaths.every(
      (path, index) => normalizedPath(path) === normalizedPath(resolve(repoPath, expected[index]!)),
    );

  if (
    !exactPaths(result.driver, [
      "scripts/ci/run-editor-coverage.ts",
      "scripts/ci/coverage-owner-launcher.ts",
      "scripts/ci/coverage-collector.ts",
      "scripts/ci/coverage-inventory.ts",
      "scripts/ci/coverage-worker-build.ts",
      "scripts/ci/coverage-editor-process.ts",
    ]) ||
    !exactPaths(result.extensionHost, ["scripts/ci/coverage-editor-process.ts"]) ||
    !exactPaths(result.languageServer, [
      "scripts/ci/coverage-editor-preload.ts",
      "scripts/ci/coverage-editor-process.ts",
    ])
  ) {
    throw new Error("Editor support source allowlists do not match the current prepared profiles");
  }

  return result;
}

export function splitEditorOwnerCoverage(
  config: EditorCoverageConfig,
  role: EditorOwnerStart["role"],
  coverage: Record<string, Record<string, unknown>>,
): {
  readonly packageCoverage: Record<string, Record<string, unknown>>;
  readonly supportCoverage: Record<string, Record<string, unknown>>;
} {
  const supportConfig = readEditorCoverageSupportConfig(config);

  if (!supportConfig) {
    if (role === "language-server") {
      const allowed = new Set(config.languageServerSourcePaths.map(normalizedPath));

      for (const path of Object.keys(coverage)) {
        if (!allowed.has(normalizedPath(path))) {
          throw new Error(`Language-server process recorded an unseeded authored source: ${path}`);
        }
      }
    }

    return { packageCoverage: coverage, supportCoverage: {} };
  }

  const support =
    role === "extension-host" ? supportConfig.extensionHost : supportConfig.languageServer;
  const supportPaths = new Set(support.sourcePaths.map(normalizedPath));
  const packagePaths =
    role === "language-server"
      ? new Set(config.languageServerSourcePaths.map(normalizedPath))
      : undefined;
  const packageCoverage: Record<string, Record<string, unknown>> = {};
  const supportCoverage: Record<string, Record<string, unknown>> = {};

  for (const [path, value] of Object.entries(coverage)) {
    const canonical = normalizedPath(path);

    if (supportPaths.has(canonical)) supportCoverage[path] = value;
    else if (packagePaths && !packagePaths.has(canonical)) {
      throw new Error(`Language-server process recorded an unseeded authored source: ${path}`);
    } else packageCoverage[path] = value;
  }

  return { packageCoverage, supportCoverage };
}

export function writeEditorOwnerSupportCoverage(
  config: EditorCoverageConfig,
  start: EditorOwnerStart,
  coverage: Record<string, Record<string, unknown>>,
): void {
  const supportConfig = readEditorCoverageSupportConfig(config);

  if (!supportConfig) return;

  const support =
    start.role === "extension-host" ? supportConfig.extensionHost : supportConfig.languageServer;
  const allowed = new Set(support.sourcePaths.map(normalizedPath));
  const keys = Object.keys(coverage);

  if (
    keys.length !== allowed.size ||
    keys.some((path) => !allowed.has(normalizedPath(path))) ||
    keys.some((path) => {
      const record = coverage[path];
      return (
        !isRecord(record) ||
        typeof record.path !== "string" ||
        normalizedPath(record.path) !== normalizedPath(path)
      );
    })
  ) {
    throw new Error(
      `Actual ${start.role} support coverage does not match its prepared source allowlist`,
    );
  }

  const raw = {
    format: "hesperia-editor-owner-support-coverage",
    version: 1,
    runId: config.runId,
    populationFingerprint: config.populationFingerprint,
    ownerId: support.ownerId,
    role: start.role,
    pid: start.pid,
    ppid: start.ppid,
    execPath: start.execPath,
    argv: start.argv,
    threadId,
    startedAt: start.startedAt,
    exitedAt: new Date().toISOString(),
    coverage,
  };

  writeFileSync(
    resolve(config.outputDirectory, `${start.role}-support-coverage.json`),
    JSON.stringify(raw),
    { flag: "wx" },
  );
}

export function writeEditorOwnerStart(
  config: EditorCoverageConfig,
  role: EditorOwnerStart["role"],
): EditorOwnerStart {
  const ownerId = `vscode-${role}-${config.runId}`;
  const receipt: EditorOwnerStart = {
    format: "hesperia-editor-owner-start",
    version: 1,
    runId: config.runId,
    populationFingerprint: config.populationFingerprint,
    ownerId,
    role,
    pid: process.pid,
    ppid: process.ppid,
    execPath: process.execPath,
    argv: process.argv,
    startedAt: new Date().toISOString(),
  };

  writeFileSync(resolve(config.outputDirectory, `${role}-start.json`), JSON.stringify(receipt), {
    flag: "wx",
  });

  return receipt;
}

export function writeEditorOwnerExit(
  config: EditorCoverageConfig,
  start: EditorOwnerStart,
  exitCode: number,
  coverage: Record<string, unknown>,
): void {
  const coverageFile = `${start.role}-coverage.json`;
  const raw: EditorOwnerCoverage = {
    format: "hesperia-editor-owner-coverage",
    version: 1,
    runId: config.runId,
    populationFingerprint: config.populationFingerprint,
    ownerId: start.ownerId,
    role: start.role,
    pid: start.pid,
    ppid: start.ppid,
    argv: start.argv,
    coverage,
  };

  writeFileSync(resolve(config.outputDirectory, coverageFile), JSON.stringify(raw), { flag: "wx" });

  const receipt: EditorOwnerExit = {
    ...start,
    format: "hesperia-editor-owner-exit",
    exitCode,
    coverageFile,
    exitedAt: new Date().toISOString(),
  };

  writeFileSync(
    resolve(config.outputDirectory, `${start.role}-exit.json`),
    JSON.stringify(receipt),
    {
      flag: "wx",
    },
  );
}

export function writeEditorOwnerCaptureError(
  config: EditorCoverageConfig,
  start: EditorOwnerStart,
  error: unknown,
): void {
  writeFileSync(
    resolve(config.outputDirectory, `${start.role}-capture-error.json`),
    JSON.stringify({
      format: "hesperia-editor-owner-capture-error",
      runId: config.runId,
      ownerId: start.ownerId,
      pid: start.pid,
      error: error instanceof Error ? error.message : String(error),
    }),
    { flag: "wx" },
  );
}
