import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { threadId } from "node:worker_threads";
import {
  coverageVariable,
  createCoverageArtifact,
  writeCoverageFragment,
  type CoverageFile,
  type CoveragePopulation,
} from "./coverage-collector.ts";
import type { WorkerCoverageOutput, WorkerCoverageSourceOutput } from "./coverage-worker-build.ts";

type SpawnArrayCommand = Parameters<typeof Bun.spawn>[0];

type SpawnObjectCommand = Bun.Spawn.SpawnOptions<
  Bun.Spawn.Writable,
  Bun.Spawn.Readable,
  Bun.Spawn.Readable
> & { readonly cmd: string[] };

type SpawnCommand = SpawnArrayCommand | SpawnObjectCommand;

type SpawnOptions = Parameters<typeof Bun.spawn>[1];

type SpawnProcess = ReturnType<typeof Bun.spawn>;

interface WorkerCoverageTemplate {
  readonly seedCoverage: Record<string, CoverageFile>;
  readonly sourcePaths: readonly string[];
  readonly sourceOutputs: readonly WorkerCoverageSourceOutput[];
  readonly sourcePopulation: CoveragePopulation;
}

interface WorkerPackageCaptureReceipt {
  readonly format: "hesperia-worker-package-capture";
  readonly version: 1;
  readonly runId: string;
  readonly ownerId: string;
  readonly processId: number;
  readonly compiledModulePaths: readonly { readonly path: string; readonly realPath: string }[];
  readonly directSourcePaths: readonly { readonly path: string; readonly realPath: string }[];
  readonly buildSubstitutionPaths: readonly { readonly path: string; readonly realPath: string }[];
}

interface WorkerPackageCaptureReference {
  readonly fileName: string;
  readonly sha256: string;
}

interface WorkerInvocationReceipt {
  readonly invocationId: string;
  readonly ownerId: string;
  readonly parentPid: number;
  readonly target: string;
  readonly seedArtifact: string;
  childPid?: number;
  spawnSucceeded: boolean;
  terminationObserved: boolean;
  exitCode?: number;
  preTerminationKillCount: number;
  postTerminationKillCount: number;
  abortErrorObserved: boolean;
  abortErrorName?: string;
  packageCaptureReceipt?: WorkerPackageCaptureReference;
}

interface SupportInvocationReceipt {
  readonly invocationId: string;
  readonly parentPid: number;
  readonly executablePath: string;
  readonly executableRealPath: string;
  readonly argv: readonly string[];
  readonly processWorkingDirectory: string | null;
  readonly environmentSha256: string | null;
  readonly stdio: readonly ["pipe", "pipe", "inherit"];
  readonly signalProvided: false;
  childPid?: number;
  spawnSucceeded: boolean;
  terminationObserved: boolean;
  exitCode?: number;
  signalCode?: SpawnProcess["signalCode"];
}

interface WorkerInvocationManifest {
  readonly format: "hesperia-coverage-worker-invocations";
  readonly version: 1;
  readonly runId: string;
  readonly populationFingerprint: string;
  readonly invocations: readonly WorkerInvocationReceipt[];
  readonly supportInvocations: readonly SupportInvocationReceipt[];
  readonly uncorrelatedAbortErrors: number;
  readonly untrackedSpawnCount: number;
  readonly writeError?: string;
}

interface WorkerCaptureConfig {
  readonly repoPath: string;
  readonly runId: string;
  readonly outputDirectory: string;
  readonly template: WorkerCoverageTemplate;
  readonly outputs: readonly WorkerCoverageOutput[];
  readonly captureDirectory: string;
}

const repoPath = resolve(import.meta.dir, "../..");
const runId = process.env.HESPERIA_COVERAGE_RUN_ID;
const outputDirectory = process.env.HESPERIA_COVERAGE_OUTPUT_DIR;
const templatePath = process.env.HESPERIA_COVERAGE_WORKER_TEMPLATE;
const outputMapPath = process.env.HESPERIA_COVERAGE_WORKER_OUTPUT_MAP;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function canonicalPath(path: string): string {
  const absolute = resolve(path);
  return process.platform === "win32" ? absolute.toLowerCase() : absolute;
}

function assertChildPath(path: string, root: string, label: string): string {
  const absolute = resolve(path);
  const relativePath = relative(root, absolute);

  if (
    relativePath === "" ||
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`) ||
    resolve(root, relativePath) !== absolute
  ) {
    throw new Error(`${label} must be a child of ${root}: ${path}`);
  }

  return absolute;
}

function readConfig(): WorkerCaptureConfig {
  if (!runId || !outputDirectory || !templatePath || !outputMapPath) {
    throw new Error("Coverage worker capture is missing run inputs");
  }

  const parsedTemplate: unknown = JSON.parse(readFileSync(templatePath, "utf8"));
  const parsedOutputs: unknown = JSON.parse(readFileSync(outputMapPath, "utf8"));

  if (
    !isRecord(parsedTemplate) ||
    !isRecord(parsedTemplate.seedCoverage) ||
    !Array.isArray(parsedTemplate.sourcePaths) ||
    !Array.isArray(parsedTemplate.sourceOutputs) ||
    !isRecord(parsedTemplate.sourcePopulation) ||
    typeof parsedTemplate.sourcePopulation.fingerprint !== "string" ||
    !Array.isArray(parsedTemplate.sourcePopulation.files) ||
    !Array.isArray(parsedOutputs) ||
    parsedOutputs.length === 0
  ) {
    throw new Error("Coverage worker graph metadata is malformed");
  }

  const template = parsedTemplate as unknown as WorkerCoverageTemplate;
  const outputs = parsedOutputs as WorkerCoverageOutput[];
  const compiledDirectory = resolve(templatePath, "..");
  const seededSourcePaths = new Set(
    template.sourcePaths.map((source) =>
      canonicalPath(resolve(repoPath, source.replaceAll("/", sep))),
    ),
  );
  const sourceOutputs = template.sourceOutputs.map((output) => {
    if (
      !isRecord(output) ||
      typeof output.originalPath !== "string" ||
      typeof output.preparedPath !== "string"
    ) {
      throw new Error("Coverage worker direct-source map contains a malformed entry");
    }

    const originalPath = assertChildPath(output.originalPath, repoPath, "Coverage authored source");
    const preparedPath = assertChildPath(
      output.preparedPath,
      compiledDirectory,
      "Coverage prepared source",
    );

    if (
      !seededSourcePaths.has(canonicalPath(originalPath)) ||
      !originalPath.replaceAll("\\", "/").includes("/packages/elysia/src/") ||
      !/\.(?:tsx?|mts)$/iu.test(originalPath) ||
      !existsSync(preparedPath)
    ) {
      throw new Error(
        `Coverage worker direct-source map is outside its Elysia seed: ${originalPath}`,
      );
    }

    return { originalPath, preparedPath };
  });

  if (
    new Set(sourceOutputs.map((output) => canonicalPath(output.originalPath))).size !==
    sourceOutputs.length
  ) {
    throw new Error("Coverage worker direct-source map contains duplicate authored paths");
  }

  const normalizedOutputs = outputs.map((output) => {
    if (
      !isRecord(output) ||
      typeof output.originalPath !== "string" ||
      typeof output.compiledPath !== "string"
    ) {
      throw new Error("Coverage worker output map contains a malformed path");
    }

    const originalPath = assertChildPath(output.originalPath, repoPath, "Coverage worker original");
    const compiledPath = assertChildPath(
      output.compiledPath,
      compiledDirectory,
      "Coverage worker compiled file",
    );

    if (
      !originalPath.includes(`${sep}packages${sep}`) ||
      !originalPath.includes(`${sep}dist${sep}`)
    ) {
      throw new Error(
        `Coverage worker output is not a package dist module: ${output.originalPath}`,
      );
    }

    return { originalPath, compiledPath };
  });
  const seedPaths = Object.keys(template.seedCoverage).map(canonicalPath).sort();
  const sourcePaths = [...template.sourcePaths]
    .map((source) => canonicalPath(resolve(repoPath, source.replaceAll("/", sep))))
    .sort();

  if (
    seedPaths.length !== sourcePaths.length ||
    seedPaths.some((path, index) => path !== sourcePaths[index])
  ) {
    throw new Error("Coverage worker seed template does not match its source inventory");
  }

  return {
    repoPath,
    runId,
    outputDirectory: resolve(outputDirectory),
    template: { ...template, sourceOutputs },
    outputs: normalizedOutputs,
    captureDirectory: join(dirname(resolve(templatePath)), "captures"),
  };
}

function exactPathFilter(paths: readonly string[]): RegExp {
  const escaped = paths.map((path) => path.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"));
  return new RegExp(`^(?:${escaped.join("|")})$`, process.platform === "win32" ? "iu" : "u");
}

function installCompiledWorkerLoader(
  config: WorkerCaptureConfig,
  capture: {
    readonly compiledModulePaths: { path: string; realPath: string }[];
    readonly directSourcePaths: { path: string; realPath: string }[];
    readonly buildSubstitutionPaths: { path: string; realPath: string }[];
  },
): void {
  const outputs = new Map(
    config.outputs.map((output) => [canonicalPath(output.originalPath), output] as const),
  );
  const paths = config.outputs.map((output) => output.originalPath);

  Bun.plugin({
    name: "hesperia-coverage-compiled-project-worker",

    setup(build) {
      const loadCompiledModule = ({ path }: { path: string }) => {
        const realPath = realpathSync(path);
        const output = outputs.get(canonicalPath(path)) ?? outputs.get(canonicalPath(realPath));

        if (!output) throw new Error(`Coverage loader matched an unknown worker path: ${path}`);

        if (output.originalPath.replaceAll("\\", "/").includes("/packages/elysia/dist/")) {
          capture.compiledModulePaths.push({ path, realPath });
        }

        return { contents: readFileSync(output.compiledPath, "utf8"), loader: "js" as const };
      };

      build.onLoad({ filter: exactPathFilter(paths) }, loadCompiledModule);

      build.onLoad(
        {
          filter: /[\\/]node_modules[\\/]@hesperia[\\/]elysia[\\/]dist[\\/].+\.js$/iu,
        },
        loadCompiledModule,
      );

      const sources = new Map(
        config.template.sourceOutputs.map(
          (output) => [canonicalPath(output.originalPath), output] as const,
        ),
      );

      if (sources.size > 0) {
        build.onLoad({ filter: exactPathFilter([...sources.keys()]) }, ({ path }) => {
          const output = sources.get(canonicalPath(path));

          if (!output) throw new Error(`Coverage loader matched an unknown Elysia source: ${path}`);

          capture.directSourcePaths.push({ path, realPath: realpathSync(path) });

          return {
            contents: readFileSync(output.preparedPath, "utf8"),
            loader: path.toLowerCase().endsWith(".tsx") ? "tsx" : "ts",
          };
        });
      }
    },
  });

  const elysiaOutputs = config.outputs.filter((output) =>
    output.originalPath.replaceAll("\\", "/").includes("/packages/elysia/dist/"),
  );

  if (elysiaOutputs.length > 0) {
    const outputByPath = new Map(
      elysiaOutputs.map((output) => [canonicalPath(output.originalPath), output] as const),
    );
    const plugin: Bun.BunPlugin = {
      name: "hesperia-coverage-elysia-build",

      setup(build) {
        build.onLoad(
          {
            filter:
              /[\\/](?:packages[\\/]elysia|node_modules[\\/]@hesperia[\\/]elysia)[\\/]dist[\\/].+\.js$/iu,
          },
          ({ path }) => {
            const realPath = realpathSync(path);
            const output =
              outputByPath.get(canonicalPath(path)) ?? outputByPath.get(canonicalPath(realPath));

            if (!output) throw new Error(`Unmapped Elysia dist module in Bun.build: ${path}`);

            capture.buildSubstitutionPaths.push({ path, realPath });

            return { contents: readFileSync(output.compiledPath, "utf8"), loader: "js" };
          },
        );

        build.onLoad(
          {
            filter:
              /[\\/](?:packages[\\/]elysia|node_modules[\\/]@hesperia[\\/]elysia)[\\/]dist[\\/].+\.js$/iu,
            namespace: "hesperia-resolved",
          },
          ({ path }) => {
            const realPath = realpathSync(path);
            const output =
              outputByPath.get(canonicalPath(path)) ?? outputByPath.get(canonicalPath(realPath));

            if (!output) throw new Error(`Unmapped Elysia dist module in Bun.build: ${path}`);

            capture.buildSubstitutionPaths.push({ path, realPath });

            return { contents: readFileSync(output.compiledPath, "utf8"), loader: "js" };
          },
        );
      },
    };
    const originalBuild = Bun.build;
    const wrappedBuild = ((options: Parameters<typeof Bun.build>[0]) =>
      Reflect.apply(originalBuild, Bun, [
        { ...options, plugins: [plugin, ...(options.plugins ?? [])] },
      ])) as typeof Bun.build;

    if (!Reflect.set(Bun, "build", wrappedBuild) || Bun.build !== wrappedBuild) {
      throw new Error("Coverage worker could not wrap Bun.build for Elysia instrumentation");
    }
  }
}

function installChildCapture(ownerId: string): void {
  const config = readConfig();

  if (!/^tooling-project-worker:[a-f0-9-]{36}$/u.test(ownerId)) {
    throw new Error(`Invalid project worker coverage owner: ${ownerId}`);
  }

  const allowedSources = new Set(Object.keys(config.template.seedCoverage).map(canonicalPath));
  const workerEntrySource = resolve(
    config.repoPath,
    "packages",
    "tooling",
    "src",
    "project-worker.ts",
  );
  const workerEntrySeed = Object.entries(config.template.seedCoverage).find(
    ([path]) => canonicalPath(path) === canonicalPath(workerEntrySource),
  )?.[1];

  if (!workerEntrySeed) {
    throw new Error("Coverage worker seed template omitted tooling/src/project-worker.ts");
  }

  const capture = {
    compiledModulePaths: [] as { path: string; realPath: string }[],
    directSourcePaths: [] as { path: string; realPath: string }[],
    buildSubstitutionPaths: [] as { path: string; realPath: string }[],
  };

  installCompiledWorkerLoader(config, capture);

  process.once("exit", () => {
    try {
      const processCoverage = Reflect.get(globalThis, coverageVariable) as
        | Record<string, CoverageFile>
        | undefined;
      const coverage = processCoverage ?? {};

      for (const path of Object.keys(coverage)) {
        if (!allowedSources.has(canonicalPath(path))) {
          throw new Error(`Compiled project worker recorded an unseeded source: ${path}`);
        }
      }

      const workerEntryHit = Object.entries(coverage).find(
        ([path]) => canonicalPath(path) === canonicalPath(workerEntrySource),
      )?.[1];

      if (workerEntryHit) {
        const hasMap = workerEntryHit.inputSourceMap !== undefined;
        const hasSourceIdentity = workerEntryHit.__hesperiaInstrumentedSourceSha256 !== undefined;

        if (!hasMap && !hasSourceIdentity) {
          // process.exit() can stop the generated footer before it attaches these identity fields.
          // Copy only transform identity from the exact owner seed; preserve every runtime counter.
          workerEntryHit.inputSourceMap = workerEntrySeed.inputSourceMap;
          workerEntryHit.__hesperiaInstrumentedSourceSha256 =
            workerEntrySeed.__hesperiaInstrumentedSourceSha256;
        } else if (!hasMap || !hasSourceIdentity) {
          throw new Error("Compiled project worker entry has partial source identity metadata");
        }
      }

      const artifact = createCoverageArtifact({
        repoPath: config.repoPath,
        kind: "hits",
        runId: config.runId,
        ownerId,
        populationFingerprint: config.template.sourcePopulation.fingerprint,
        sourcePopulation: config.template.sourcePopulation,
        coverage,
      });

      writeCoverageFragment({
        directory: config.outputDirectory,
        contextId: "project-worker-hits",
        pid: process.pid,
        threadId,
        repoPath: config.repoPath,
        artifact,
        sourcePopulation: config.template.sourcePopulation,
      });

      if (config.template.sourceOutputs.length > 0) {
        const invocationId = ownerId.slice("tooling-project-worker:".length);
        const receipt: WorkerPackageCaptureReceipt = {
          format: "hesperia-worker-package-capture",
          version: 1,
          runId: config.runId,
          ownerId,
          processId: process.pid,
          compiledModulePaths: capture.compiledModulePaths,
          directSourcePaths: capture.directSourcePaths,
          buildSubstitutionPaths: capture.buildSubstitutionPaths,
        };

        mkdirSync(config.captureDirectory, { recursive: true });

        writeFileSync(
          join(config.captureDirectory, `${invocationId}.json`),
          JSON.stringify(receipt),
          {
            flag: "wx",
          },
        );
      }
    } catch (error) {
      process.stderr.write(
        `Hesperia project worker coverage capture failed: ${error instanceof Error ? error.message : String(error)}\n`,
      );

      process.exitCode = 1;
    }
  });
}

function writeWorkerSeed(
  config: WorkerCaptureConfig,
  ownerId: string,
  invocationId: string,
): string {
  const artifact = createCoverageArtifact({
    repoPath: config.repoPath,
    kind: "seed",
    runId: config.runId,
    ownerId,
    populationFingerprint: config.template.sourcePopulation.fingerprint,
    sourcePopulation: config.template.sourcePopulation,
    coverage: config.template.seedCoverage,
  });
  return writeCoverageFragment({
    directory: config.outputDirectory,
    contextId: `project-worker-seed-${invocationId}`,
    pid: process.pid,
    threadId,
    repoPath: config.repoPath,
    artifact,
    sourcePopulation: config.template.sourcePopulation,
  });
}

function argumentList(command: SpawnCommand): readonly string[] {
  return Array.isArray(command) ? command : command.cmd;
}

function expectedTypeScriptApiExecutablePath(): string {
  const platformPackage = `@typescript/typescript-${process.platform}-${process.arch}`;
  const typescriptPackageJsonPath = fileURLToPath(import.meta.resolve("typescript/package.json"));
  const require = createRequire(typescriptPackageJsonPath);
  const packageJsonPath = require.resolve(`${platformPackage}/package.json`);
  const executableName = process.platform === "win32" ? "tsc.exe" : "tsc";
  return realpathSync(join(dirname(packageJsonPath), "lib", executableName));
}

interface SupportInvocationDetails {
  readonly executablePath: string;
  readonly executableRealPath: string;
  readonly argv: readonly string[];
  readonly processWorkingDirectory: string | null;
  readonly environmentSha256: string | null;
  readonly stdio: readonly ["pipe", "pipe", "inherit"];
  readonly signalProvided: false;
}

function supportInvocationDetails(
  command: SpawnObjectCommand,
  options?: SpawnOptions,
): SupportInvocationDetails | undefined {
  if (
    options !== undefined ||
    Object.prototype.hasOwnProperty.call(command, "signal") ||
    command.signal !== undefined
  )
    return;

  const [executablePath, ...argv] = command.cmd;

  if (!executablePath || argv.length !== 5) return;

  let executableRealPath: string;

  try {
    executableRealPath = realpathSync(executablePath);

    if (
      canonicalPath(executableRealPath) !== canonicalPath(expectedTypeScriptApiExecutablePath())
    ) {
      return;
    }
  } catch {
    return;
  }

  if (
    argv[0] !== "--api" ||
    argv[1] !== "--async" ||
    argv[2] !== "--cwd" ||
    !isAbsolute(argv[3]!) ||
    ![
      "--callbacks=readFile,fileExists",
      "--callbacks=readFile,fileExists,directoryExists",
    ].includes(argv[4]!)
  ) {
    return;
  }

  if (
    command.cwd !== undefined &&
    (!isAbsolute(command.cwd) || canonicalPath(resolve(command.cwd)) !== canonicalPath(repoPath))
  )
    return;

  const stdio = command.stdio ?? [command.stdin, command.stdout, command.stderr];

  if (
    !Array.isArray(stdio) ||
    stdio.length !== 3 ||
    stdio[0] !== "pipe" ||
    stdio[1] !== "pipe" ||
    stdio[2] !== "inherit"
  ) {
    return;
  }

  const environmentSha256 =
    command.env === undefined
      ? null
      : createHash("sha256")
          .update(
            JSON.stringify(
              Object.entries(command.env).sort(([left], [right]) => left.localeCompare(right)),
            ),
          )
          .digest("hex");
  return {
    executablePath,
    executableRealPath,
    argv,
    processWorkingDirectory: command.cwd ?? null,
    environmentSha256,
    stdio: ["pipe", "pipe", "inherit"],
    signalProvided: false,
  };
}

async function installParentCapture(config: WorkerCaptureConfig): Promise<void> {
  const outputByOriginalPath = new Map(
    config.outputs.map((output) => [canonicalPath(output.originalPath), output] as const),
  );
  const workerEntry = config.outputs.find((output) =>
    output.originalPath.endsWith(`${sep}tooling${sep}dist${sep}project-worker.js`),
  );

  if (!workerEntry) throw new Error("Coverage worker graph omitted tooling/dist/project-worker.js");

  const invocations: WorkerInvocationReceipt[] = [];
  const terminationPromises: Promise<number>[] = [];
  const supportInvocations: SupportInvocationReceipt[] = [];
  const supportTerminationPromises: Promise<number>[] = [];
  const signalRecords = new WeakMap<AbortSignal, WorkerInvocationReceipt>();
  let uncorrelatedAbortErrors = 0;
  let untrackedSpawnCount = 0;
  let abortingSignal: AbortSignal | undefined;
  const receiptPath = resolve(config.outputDirectory, "worker-invocations.json");
  const originalAbort = AbortController.prototype.abort;
  AbortController.prototype.abort = function wrappedAbort(
    this: AbortController,
    reason?: Parameters<AbortController["abort"]>[0],
  ): void {
    const previous = abortingSignal;
    abortingSignal = this.signal;

    try {
      originalAbort.call(this, reason);
    } finally {
      abortingSignal = previous;
    }
  };
  const originalThrowIfAborted = AbortSignal.prototype.throwIfAborted;
  AbortSignal.prototype.throwIfAborted = function wrappedThrowIfAborted(): void {
    try {
      originalThrowIfAborted.call(this);
    } catch (error) {
      if (!(error instanceof Error) || error.name !== "AbortError") throw error;

      const previous = signalRecords.get(this);

      if (previous) {
        previous.abortErrorObserved = true;
        previous.abortErrorName = error.name;
      } else uncorrelatedAbortErrors++;

      throw error;
    }
  };

  const originalSpawn = Bun.spawn;
  const wrappedSpawn = ((command: SpawnCommand, options?: SpawnOptions): SpawnProcess => {
    const matchingOutput = argumentList(command).find((argument) => {
      if (!argument) return false;

      return outputByOriginalPath.has(canonicalPath(resolve(argument)));
    });

    if (!matchingOutput || !Array.isArray(command)) {
      if (!Array.isArray(command)) {
        const details = supportInvocationDetails(command, options);

        if (details) {
          const record: SupportInvocationReceipt = {
            invocationId: randomUUID(),
            parentPid: process.pid,
            ...details,
            spawnSucceeded: false,
            terminationObserved: false,
          };

          supportInvocations.push(record);

          const child = originalSpawn(command);
          record.spawnSucceeded = true;
          record.childPid = child.pid;

          supportTerminationPromises.push(
            child.exited.then((exitCode) => {
              record.exitCode = exitCode;
              record.signalCode = child.signalCode;
              record.terminationObserved = true;
              return exitCode;
            }),
          );

          return child;
        }
      }

      untrackedSpawnCount++;
      throw new Error("Project worker coverage encountered an untracked Bun.spawn invocation");
    }

    const target = outputByOriginalPath.get(canonicalPath(resolve(matchingOutput)))!;

    if (canonicalPath(target.originalPath) !== canonicalPath(workerEntry.originalPath)) {
      throw new Error(
        `Coverage worker capture matched an unexpected package entry: ${target.originalPath}`,
      );
    }

    const invocationId = randomUUID();
    const ownerId = `tooling-project-worker:${invocationId}`;
    const seedPath = writeWorkerSeed(config, ownerId, invocationId);
    const record: WorkerInvocationReceipt = {
      invocationId,
      ownerId,
      parentPid: process.pid,
      target: relative(config.repoPath, target.originalPath).split(sep).join("/"),
      seedArtifact: basename(seedPath),
      spawnSucceeded: false,
      terminationObserved: false,
      preTerminationKillCount: 0,
      postTerminationKillCount: 0,
      abortErrorObserved: false,
    };

    invocations.push(record);

    const environment = {
      ...process.env,
      ...options?.env,
      HESPERIA_COVERAGE_WORKER_OWNER_ID: ownerId,
    };
    const child = originalSpawn(command, { ...options, env: environment });
    record.spawnSucceeded = true;
    record.childPid = child.pid;
    const originalKill = child.kill.bind(child);

    Object.defineProperty(child, "kill", {
      configurable: true,
      value: (...args: Parameters<SpawnProcess["kill"]>) => {
        if (record.terminationObserved) record.postTerminationKillCount++;
        else {
          record.preTerminationKillCount++;

          if (abortingSignal) {
            const existing = signalRecords.get(abortingSignal);

            if (existing && existing !== record) uncorrelatedAbortErrors++;
            else signalRecords.set(abortingSignal, record);
          }
        }

        return originalKill(...args);
      },
    });

    terminationPromises.push(
      child.exited.then((exitCode) => {
        record.exitCode = exitCode;
        record.terminationObserved = true;
        const capturePath = join(config.captureDirectory, `${record.invocationId}.json`);

        if (existsSync(capturePath)) {
          const content = readFileSync(capturePath, "utf8");
          record.packageCaptureReceipt = {
            fileName: basename(capturePath),
            sha256: createHash("sha256").update(content).digest("hex"),
          };
        }

        return exitCode;
      }),
    );

    return child;
  }) as typeof Bun.spawn;

  if (!Reflect.set(Bun, "spawn", wrappedSpawn) || Bun.spawn !== wrappedSpawn) {
    throw new Error("Coverage worker could not wrap Bun.spawn");
  }

  mkdirSync(config.captureDirectory, { recursive: true });

  const { afterAll } = await import("bun:test");

  afterAll(async () => {
    await Promise.all([...terminationPromises, ...supportTerminationPromises]);

    const manifest: WorkerInvocationManifest = {
      format: "hesperia-coverage-worker-invocations",
      version: 1,
      runId: config.runId,
      populationFingerprint: config.template.sourcePopulation.fingerprint,
      invocations,
      supportInvocations,
      uncorrelatedAbortErrors,
      untrackedSpawnCount,
    };

    writeFileSync(receiptPath, JSON.stringify(manifest), { flag: "wx" });
  });
}

const workerOwnerId = process.env.HESPERIA_COVERAGE_WORKER_OWNER_ID;

if (workerOwnerId) installChildCapture(workerOwnerId);
else if (process.env.HESPERIA_COVERAGE_WORKER_CAPTURE === "1") {
  await installParentCapture(readConfig());
}
