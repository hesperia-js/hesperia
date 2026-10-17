import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  realpathSync,
  readFileSync,
  readdirSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { parseSync } from "oxc-parser";
import {
  seedCoverageSources,
  type CoverageFile,
  type CoveragePopulation,
  type PreparedCoverageSource,
} from "./coverage-collector.ts";

const defaultCoveragePackages = ["tooling", "compiler", "hosting"] as const;
const coveragePackages = [
  ...defaultCoveragePackages,
  "elysia",
  "hesperia",
  "language-server",
] as const;

export interface WorkerCoverageOutput {
  readonly originalPath: string;
  readonly compiledPath: string;
}

export interface WorkerCoverageSourceOutput {
  readonly originalPath: string;
  readonly preparedPath: string;
}

export interface WorkerCoverageBuildSubstitution {
  readonly originalPath: string;
  readonly path: string;
  readonly realPath: string;
  readonly compiledPath?: string;
}

export interface WorkerCoverageBuildRecord {
  readonly kind: "fixture" | "project" | "route-guard";
  readonly entrypoints: readonly string[];
  readonly substitutions: readonly WorkerCoverageBuildSubstitution[];
}

export interface WorkerCoverageFixtureBuildOptions<T> {
  readonly buildDirectory: string;
  readonly repoPath: string;
  readonly packageNames: readonly string[];
  readonly outputs: readonly WorkerCoverageOutput[];
  readonly expectedEntrypoints: readonly (readonly string[])[];
  readonly requiredSourcePaths: readonly string[];
  readonly build: () => Promise<T>;
}

function canonicalPath(path: string): string {
  const absolute = resolve(path);
  return process.platform === "win32" ? absolute.toLowerCase() : absolute;
}

function coverageCompilerEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { ...process.env };
  delete environment.BUN_OPTIONS;
  delete environment.NODE_OPTIONS;

  for (const key of Object.keys(environment)) {
    if (
      key.startsWith("HESPERIA_COVERAGE_") ||
      key.startsWith("HESPERIA_BROWSER_COVERAGE_") ||
      key.startsWith("HESPERIA_EDITOR_COVERAGE_")
    ) {
      delete environment[key];
    }
  }

  return environment;
}

function filesBelow(directory: string, extension: string): string[] {
  if (!existsSync(directory)) return [];

  const files: string[] = [];

  const visit = (current: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);

      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && path.endsWith(extension)) files.push(path);
    }
  };

  visit(directory);

  return files.sort();
}

function declarationShape(path: string, source: string): string {
  const parsed = parseSync(path, source, { lang: "ts", sourceType: "module" });

  if (parsed.errors.length > 0) {
    throw new Error(
      `Unable to parse emitted declaration ${path}: ${parsed.errors.map((error) => error.message).join("; ")}`,
    );
  }

  const isFunctionType = (value: unknown): boolean =>
    value !== null &&
    typeof value === "object" &&
    "type" in value &&
    value.type === "TSFunctionType";

  const stripPositions = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(stripPositions);

    if (value === null || typeof value !== "object") return value;

    if (
      "type" in value &&
      value.type === "TSParenthesizedType" &&
      "typeAnnotation" in value &&
      isFunctionType(value.typeAnnotation)
    ) {
      return stripPositions(value.typeAnnotation);
    }

    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => key !== "start" && key !== "end")
        .map(([key, item]) => [key, stripPositions(item)]),
    );
  };

  const directives = source
    .split(/\r?\n/u)
    .filter((line) => /^\s*\/\/\//u.test(line))
    .map((line) => line.trim());
  return JSON.stringify({
    syntax: stripPositions(parsed.program),
    directives,
  });
}

function moduleSpecifierGraph(path: string, source: string): string {
  const parsed = parseSync(path, source, { lang: "js", sourceType: "module" });

  if (parsed.errors.length > 0) {
    throw new Error(
      `Unable to parse emitted module ${path}: ${parsed.errors.map((error) => error.message).join("; ")}`,
    );
  }

  const edges: { kind: string; source: string }[] = [];

  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const entry of value) visit(entry);

      return;
    }

    if (value === null || typeof value !== "object") return;

    const node = value as Record<string, unknown>;

    if (
      (node.type === "ImportDeclaration" ||
        node.type === "ExportNamedDeclaration" ||
        node.type === "ExportAllDeclaration") &&
      node.source !== null &&
      typeof node.source === "object"
    ) {
      const specifier = (node.source as Record<string, unknown>).value;

      if (typeof specifier !== "string") throw new Error(`Non-literal module specifier in ${path}`);

      edges.push({ kind: String(node.type), source: specifier });
    } else if (
      node.type === "ImportExpression" &&
      node.source !== null &&
      typeof node.source === "object"
    ) {
      const specifier = (node.source as Record<string, unknown>).value;

      if (typeof specifier !== "string") throw new Error(`Non-literal dynamic import in ${path}`);

      edges.push({ kind: "ImportExpression", source: specifier });
    }

    for (const [key, child] of Object.entries(node)) {
      if (key !== "parent" && key !== "comments" && key !== "tokens") visit(child);
    }
  };

  visit(parsed.program);

  return JSON.stringify(edges);
}

function linkPackageDependencies(packagePath: string, destination: string): void {
  const source = join(packagePath, "node_modules");

  if (!existsSync(source)) return;

  mkdirSync(destination, { recursive: true });

  for (const entry of readdirSync(source, { withFileTypes: true })) {
    if (entry.name === ".bin") continue;

    const sourcePath = join(source, entry.name);
    const destinationPath = join(destination, entry.name);

    if (entry.isDirectory()) {
      mkdirSync(destinationPath, { recursive: true });

      for (const child of readdirSync(sourcePath, { withFileTypes: true })) {
        const childPath = join(sourcePath, child.name);

        symlinkSync(
          realpathSync(childPath),
          join(destinationPath, child.name),
          process.platform === "win32" ? "junction" : "dir",
        );
      }

      continue;
    }

    symlinkSync(
      realpathSync(sourcePath),
      destinationPath,
      process.platform === "win32" ? "junction" : "dir",
    );
  }
}

export async function buildCoverageWorkerGraph(options: {
  readonly repoPath: string;
  readonly directory: string;
  readonly sources: readonly string[];
  readonly packages?: readonly (typeof coveragePackages)[number][];
  readonly additionalSeededSources?: readonly string[];
  readonly exposePreparedSourcePaths?: readonly string[];
}): Promise<{
  readonly outputs: readonly WorkerCoverageOutput[];
  readonly seedCoverage: Record<string, CoverageFile>;
  readonly canonicalSeedCoverage: Record<string, CoverageFile>;
  readonly sourcePaths: readonly string[];
  readonly sourceOutputs: readonly WorkerCoverageSourceOutput[];
  readonly sourcePopulation: CoveragePopulation;
  readonly preparedCoverageSources?: readonly PreparedCoverageSource[];
}> {
  const repoPath = resolve(options.repoPath);
  const directory = resolve(options.directory);
  const relativeDirectory = relative(repoPath, directory);

  if (
    relativeDirectory === ".." ||
    relativeDirectory.startsWith(`..${sep}`) ||
    relativeDirectory === ""
  ) {
    throw new Error("Coverage worker build directory must be a child of the repository");
  }

  mkdirSync(directory, { recursive: true });

  const packageNames = options.packages ?? defaultCoveragePackages;

  if (
    packageNames.length === 0 ||
    new Set(packageNames).size !== packageNames.length ||
    packageNames.some((name) => !coveragePackages.includes(name))
  ) {
    throw new Error("Coverage graph package selection is empty, duplicated, or unsupported");
  }

  const packageSources = options.sources.filter((source) =>
    packageNames.some((name) => source.startsWith(`packages/${name}/src/`)),
  );

  if (packageSources.length === 0) throw new Error("Coverage worker source graph is empty");

  const additionalSeededSources = options.additionalSeededSources ?? [];
  const additionalSeededSourceSet = new Set(additionalSeededSources);

  if (
    additionalSeededSourceSet.size !== additionalSeededSources.length ||
    additionalSeededSources.some((source) => !options.sources.includes(source))
  ) {
    throw new Error("Coverage worker additional seed selection is duplicated or unknown");
  }

  const seeded = await seedCoverageSources(options.sources, repoPath);
  const preparedByRelativePath = new Map(
    seeded.prepared.map((item) => [item.relativePath, item] as const),
  );
  const additionalPreparedSources = additionalSeededSources.map((source) => {
    const item = preparedByRelativePath.get(source);

    if (!item) {
      throw new Error(`Coverage worker additional seed source was not prepared: ${source}`);
    }

    return item;
  });
  const packageSourceSet = new Set(packageSources);
  const exposePreparedSourcePaths = options.exposePreparedSourcePaths;

  if (
    exposePreparedSourcePaths !== undefined &&
    (new Set(exposePreparedSourcePaths).size !== exposePreparedSourcePaths.length ||
      exposePreparedSourcePaths.some((source) => !packageSourceSet.has(source)))
  ) {
    throw new Error(
      "Coverage worker prepared-source exposure is duplicated or outside its package graph",
    );
  }

  const preparedSources = seeded.prepared.filter((item) => packageSourceSet.has(item.relativePath));
  const ownerPreparedSources = [
    ...preparedSources,
    ...additionalPreparedSources.filter((item) => !packageSourceSet.has(item.relativePath)),
  ];
  const ownerSourcePaths = [
    ...packageSources,
    ...additionalSeededSources.filter((source) => !packageSourceSet.has(source)),
  ];
  const prepared = new Map(
    preparedSources.map((item) => [canonicalPath(item.path), item] as const),
  );
  const preparedCoverageSources = exposePreparedSourcePaths?.map((source) => {
    const item = preparedSources.find((preparedSource) => preparedSource.relativePath === source);

    if (!item)
      throw new Error(`Coverage worker prepared-source exposure is not prepared: ${source}`);

    return item;
  });
  const seedCoverage: Record<string, CoverageFile> = Object.fromEntries(
    ownerPreparedSources.map((item) => [item.path, item.seed]),
  );
  const outputs: WorkerCoverageOutput[] = [];
  const sourceOutputs: WorkerCoverageSourceOutput[] = [];
  const compilerEnvironment = coverageCompilerEnvironment();

  for (const packageName of packageNames) {
    const packagePath = join(repoPath, "packages", packageName);
    const packageSources = new Set(
      [...prepared.values()]
        .filter((item) => item.relativePath.startsWith(`packages/${packageName}/src/`))
        .map((item) => canonicalPath(item.path)),
    );

    if (packageSources.size === 0) continue;

    const buildDirectory = join(directory, "packages", packageName);
    const sourceDirectory = join(buildDirectory, "src");
    const outDirectory = join(buildDirectory, "dist");

    mkdirSync(sourceDirectory, { recursive: true });

    const dependencyDirectory = join(buildDirectory, "node_modules");

    if (!existsSync(dependencyDirectory)) {
      linkPackageDependencies(packagePath, dependencyDirectory);
    }

    for (const sourcePath of packageSources) {
      const item = prepared.get(sourcePath)!;
      const relativeSource = relative(join(packagePath, "src"), item.path);

      if (relativeSource === ".." || relativeSource.startsWith(`..${sep}`)) {
        throw new Error(`Coverage worker source escaped package ${packageName}: ${item.path}`);
      }

      const destination = join(sourceDirectory, relativeSource);

      mkdirSync(dirname(destination), { recursive: true });

      writeFileSync(destination, item.instrumentedCode);

      if (packageName === "elysia") {
        sourceOutputs.push({
          originalPath: resolve(item.path),
          preparedPath: resolve(destination),
        });
      }
    }

    const authoredSourceDirectory = join(packagePath, "src");

    for (const declarationPath of filesBelow(authoredSourceDirectory, ".d.ts")) {
      const relativeDeclaration = relative(authoredSourceDirectory, declarationPath);
      const destination = join(sourceDirectory, relativeDeclaration);

      mkdirSync(dirname(destination), { recursive: true });

      writeFileSync(destination, readFileSync(declarationPath));
    }

    const configPath = join(buildDirectory, "tsconfig.json");

    writeFileSync(
      configPath,
      JSON.stringify(
        {
          extends: join(packagePath, "tsconfig.build.json"),
          compilerOptions: {
            noEmit: false,
            noEmitOnError: true,
            declaration: false,
            declarationMap: false,
            sourceMap: false,
            inlineSourceMap: false,
            rootDir: "./src",
            outDir: "./dist",
          },
          include: ["src/**/*.ts", "src/**/*.tsx"],
          exclude: [],
        },
        null,
        2,
      ),
    );

    const instrumentedDeclarationDirectory = join(buildDirectory, "instrumented-declarations");

    if (packageName !== "hesperia" && packageName !== "language-server")
      mkdirSync(instrumentedDeclarationDirectory, { recursive: true });

    if (packageName !== "hesperia" && packageName !== "language-server") {
      const compiler = spawnSync(
        process.execPath,
        [
          "x",
          "tsc",
          "-p",
          configPath,
          "--pretty",
          "false",
          "--declaration",
          "--emitDeclarationOnly",
          "--outDir",
          instrumentedDeclarationDirectory,
        ],
        {
          cwd: repoPath,
          encoding: "utf8",
          maxBuffer: 16 * 1024 * 1024,
          env: compilerEnvironment,
        },
      );

      if (compiler.error) throw compiler.error;

      if (compiler.status !== 0) {
        throw new Error(
          `Coverage worker strict declaration build failed for ${packageName} (exit ${compiler.status}):\n${compiler.stdout}\n${compiler.stderr}`,
        );
      }
    }

    const currentDist = join(packagePath, "dist");
    const declarationDirectory = join(buildDirectory, "declarations");

    mkdirSync(declarationDirectory, { recursive: true });

    const declarationBuild = spawnSync(
      process.execPath,
      [
        "x",
        "tsc",
        "-p",
        join(packagePath, "tsconfig.build.json"),
        "--pretty",
        "false",
        "--emitDeclarationOnly",
        "--outDir",
        declarationDirectory,
      ],
      {
        cwd: repoPath,
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
        env: compilerEnvironment,
      },
    );

    if (declarationBuild.error) throw declarationBuild.error;

    if (declarationBuild.status !== 0) {
      throw new Error(
        `Authored declaration verification failed for ${packageName} (exit ${declarationBuild.status}):\n${declarationBuild.stdout}\n${declarationBuild.stderr}`,
      );
    }

    const currentDeclarations = filesBelow(currentDist, ".d.ts");
    const emittedDeclarations = filesBelow(declarationDirectory, ".d.ts");
    const instrumentedDeclarations =
      packageName === "hesperia" || packageName === "language-server"
        ? []
        : filesBelow(instrumentedDeclarationDirectory, ".d.ts");
    const relativeCurrent = currentDeclarations.map((path) =>
      relative(currentDist, path).split(sep).join("/"),
    );
    const relativeEmitted = emittedDeclarations.map((path) =>
      relative(declarationDirectory, path).split(sep).join("/"),
    );
    const relativeInstrumented = instrumentedDeclarations.map((path) =>
      relative(instrumentedDeclarationDirectory, path).split(sep).join("/"),
    );

    if (
      relativeCurrent.length !== relativeEmitted.length ||
      relativeCurrent.some(
        (path) =>
          !relativeEmitted.includes(path) ||
          (packageName !== "hesperia" &&
            packageName !== "language-server" &&
            !relativeInstrumented.includes(path)),
      ) ||
      (packageName !== "hesperia" &&
        packageName !== "language-server" &&
        relativeCurrent.length !== relativeInstrumented.length)
    ) {
      throw new Error(`Coverage worker declaration inventory changed for ${packageName}`);
    }

    for (const relativeDeclaration of relativeEmitted) {
      const generated = readFileSync(join(declarationDirectory, relativeDeclaration));
      const current = readFileSync(join(currentDist, relativeDeclaration));

      if (!generated.equals(current)) {
        throw new Error(
          `Coverage worker changed published declarations for ${packageName}/${relativeDeclaration}`,
        );
      }

      if (packageName !== "hesperia" && packageName !== "language-server") {
        const instrumented = readFileSync(
          join(instrumentedDeclarationDirectory, relativeDeclaration),
          "utf8",
        );

        if (
          declarationShape(relativeDeclaration, generated.toString("utf8")) !==
          declarationShape(relativeDeclaration, instrumented)
        ) {
          throw new Error(
            `Coverage instrumentation changed declaration syntax or directives for ${packageName}/${relativeDeclaration}`,
          );
        }
      }
    }

    const runtimeArgs =
      packageName === "hesperia" || packageName === "language-server"
        ? ["x", "tsc", "-p", configPath, "--noCheck", "--pretty", "false"]
        : ["x", "tsc", "-p", configPath, "--pretty", "false"];
    const runtimeBuild = spawnSync(process.execPath, runtimeArgs, {
      cwd: repoPath,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      env: compilerEnvironment,
    });

    if (runtimeBuild.error) throw runtimeBuild.error;

    if (runtimeBuild.status !== 0) {
      throw new Error(
        `Coverage worker ${packageName === "hesperia" || packageName === "language-server" ? "noCheck instrumented JavaScript emit" : "strict instrumented JavaScript emit"} failed for ${packageName} (exit ${runtimeBuild.status}):\n${runtimeBuild.stdout}\n${runtimeBuild.stderr}`,
      );
    }

    const outputJs = filesBelow(outDirectory, ".js");
    const currentJs = filesBelow(currentDist, ".js");
    const relativeOutputs = outputJs.map((path) =>
      relative(outDirectory, path).split(sep).join("/"),
    );
    const relativeCurrentJs = currentJs.map((path) =>
      relative(currentDist, path).split(sep).join("/"),
    );

    if (
      outputJs.length === 0 ||
      outputJs.length !== currentJs.length ||
      relativeOutputs.some((path) => !relativeCurrentJs.includes(path))
    ) {
      throw new Error(`Coverage worker JavaScript inventory changed for ${packageName}`);
    }

    for (let index = 0; index < outputJs.length; index += 1) {
      const compiledPath = outputJs[index]!;
      const relativeOutput = relative(outDirectory, compiledPath);
      const originalPath = join(currentDist, relativeOutput);

      if (
        packageName === "elysia" ||
        packageName === "hesperia" ||
        packageName === "language-server"
      ) {
        const emittedGraph = moduleSpecifierGraph(compiledPath, readFileSync(compiledPath, "utf8"));
        const currentGraph = moduleSpecifierGraph(originalPath, readFileSync(originalPath, "utf8"));

        if (emittedGraph !== currentGraph) {
          throw new Error(
            `Coverage instrumentation changed module import/export graph for ${packageName}/${relativeOutputs[index]}`,
          );
        }
      }

      outputs.push({ originalPath: resolve(originalPath), compiledPath: resolve(compiledPath) });
    }
  }

  if (outputs.length === 0) throw new Error("Coverage worker emitted no JavaScript modules");

  writeFileSync(
    join(directory, "worker-seed-template.json"),
    JSON.stringify({
      seedCoverage,
      sourcePaths: ownerSourcePaths,
      sourceOutputs,
      sourcePopulation: seeded.population,
    }),
  );

  writeFileSync(join(directory, "worker-output-map.json"), JSON.stringify(outputs));

  return {
    outputs,
    seedCoverage,
    canonicalSeedCoverage: seeded.coverage,
    sourcePaths: ownerSourcePaths,
    sourceOutputs,
    sourcePopulation: seeded.population,
    ...(preparedCoverageSources === undefined ? {} : { preparedCoverageSources }),
  };
}

/** Run each project-scoped bundle with the exact dist-to-instrumented map prepared for its owner. */
export async function withCoverageWorkerBuild<T>(options: {
  readonly buildDirectory: string;
  readonly repoPath: string;
  readonly projectRoot: string;
  readonly packageNames: readonly string[];
  readonly outputs: readonly WorkerCoverageOutput[];
  readonly build: () => Promise<T>;
}): Promise<{ readonly result: T; readonly builds: readonly WorkerCoverageBuildRecord[] }> {
  const repoRoot = resolve(options.repoPath);
  const buildDirectory = resolve(options.buildDirectory);
  const projectRoot = resolve(options.projectRoot);
  const packageNames = [...options.packageNames];

  if (
    packageNames.length === 0 ||
    new Set(packageNames).size !== packageNames.length ||
    packageNames.some(
      (name) => !coveragePackages.includes(name as (typeof coveragePackages)[number]),
    )
  ) {
    throw new Error("Coverage build package selection is empty, duplicated, or unsupported");
  }

  const outputs = new Map<string, WorkerCoverageOutput>();

  for (const output of options.outputs) {
    const originalPath = resolve(output.originalPath);
    const compiledPath = resolve(output.compiledPath);
    const originalRelative = relative(repoRoot, originalPath);
    const compiledRelative = relative(buildDirectory, compiledPath);
    const segments = originalRelative.split(sep);

    if (
      !existsSync(originalPath) ||
      !existsSync(compiledPath) ||
      originalRelative === ".." ||
      originalRelative.startsWith(".." + sep) ||
      segments[0] !== "packages" ||
      !packageNames.includes(segments[1] ?? "") ||
      segments[2] !== "dist" ||
      !originalPath.endsWith(".js") ||
      isAbsolute(compiledRelative) ||
      compiledRelative === ".." ||
      compiledRelative.startsWith(".." + sep) ||
      outputs.has(canonicalPath(originalPath))
    ) {
      throw new Error(
        "Coverage build output map contains an invalid or duplicate path: " + output.originalPath,
      );
    }

    outputs.set(canonicalPath(originalPath), { originalPath, compiledPath });
  }

  if (outputs.size === 0) throw new Error("Coverage build output map is empty");

  const namesPattern = packageNames
    .map((name) => name.replace(/[-/\\^$*+?.()|[\]{}]/gu, "\\$&"))
    .join("|");
  const packageDistFilter = new RegExp(
    "[\\\\/](?:packages[\\\\/](?:" +
      namesPattern +
      ")|node_modules[\\\\/](?:@hesperia[\\\\/])?(?:" +
      namesPattern +
      "))[\\\\/]dist[\\\\/].+\\.js$",
    "iu",
  );

  const loadInstrumentedOutput = (
    path: string,
    scopedSubstitutions: WorkerCoverageBuildSubstitution[],
  ) => {
    const realPath = realpathSync(path);
    const output = outputs.get(canonicalPath(path)) ?? outputs.get(canonicalPath(realPath));

    if (!output) {
      throw new Error("Coverage build matched an unmapped package dist module: " + path);
    }

    scopedSubstitutions.push({
      originalPath: output.originalPath,
      path,
      realPath,
    });

    return { contents: readFileSync(output.compiledPath, "utf8"), loader: "js" as const };
  };

  const expectedProjectEntrypoints = [
    canonicalPath(join(projectRoot, ".hesperia", "main.ts")),
    canonicalPath(join(projectRoot, ".hesperia", "route-table.ts")),
  ].sort();
  const scopedBuilds: WorkerCoverageBuildRecord[] = [];
  const originalBuild = Bun.build;
  let wrappedBuild!: typeof Bun.build;
  wrappedBuild = ((buildOptions: Parameters<typeof Bun.build>[0]) => {
    if (
      typeof buildOptions.root !== "string" ||
      canonicalPath(resolve(buildOptions.root)) !== canonicalPath(projectRoot)
    ) {
      return Reflect.apply(originalBuild, Bun, [buildOptions]);
    }

    const entrypoints = buildOptions.entrypoints;

    if (!Array.isArray(entrypoints) || !entrypoints.every((entry) => typeof entry === "string")) {
      throw new Error(
        "Coverage build encountered a project-scoped bundle without explicit entrypoints",
      );
    }

    const isRouteGuardBuild =
      entrypoints.length === 1 && entrypoints[0]!.startsWith("hesperia-route-entry:");
    const normalizedEntrypoints = entrypoints
      .map((entry) => canonicalPath(resolve(projectRoot, entry)))
      .sort();
    const isProjectBuild =
      normalizedEntrypoints.length === expectedProjectEntrypoints.length &&
      normalizedEntrypoints.every((entry, index) => entry === expectedProjectEntrypoints[index]);

    if (!isProjectBuild && !isRouteGuardBuild) {
      throw new Error("Coverage build encountered an unsupported project-scoped bundle");
    }

    const kind = isProjectBuild ? "project" : "route-guard";
    const scopedSubstitutions: WorkerCoverageBuildSubstitution[] = [];
    const plugin: Bun.BunPlugin = {
      name: "hesperia-coverage-worker-build-map",

      setup(build) {
        const onLoad = ({ path }: { path: string }) =>
          loadInstrumentedOutput(path, scopedSubstitutions);

        build.onLoad({ filter: packageDistFilter }, onLoad);

        build.onLoad({ filter: packageDistFilter, namespace: "hesperia-resolved" }, onLoad);
      },
    };
    const promise = Reflect.apply(originalBuild, Bun, [
      { ...buildOptions, plugins: [plugin, ...(buildOptions.plugins ?? [])] },
    ]) as ReturnType<typeof Bun.build>;
    return promise.then((result) => {
      scopedBuilds.push({
        kind,
        entrypoints: [...entrypoints],
        substitutions: scopedSubstitutions,
      });

      return result;
    });
  }) as typeof Bun.build;

  if (!Reflect.set(Bun, "build", wrappedBuild) || Bun.build !== wrappedBuild) {
    throw new Error("Coverage build could not install its project-scoped Bun.build wrapper");
  }

  let operationFailed = false;
  let operationError: unknown;
  let result!: T;
  let restorationFailed = false;
  let restorationError: unknown;

  try {
    result = await options.build();
    const projectBuildCount = scopedBuilds.filter((build) => build.kind === "project").length;

    if (projectBuildCount !== 1) {
      throw new Error(
        "Coverage build expected one main project bundle, received " + projectBuildCount,
      );
    }

    if (
      !scopedBuilds.some((build) =>
        build.substitutions.some((item) =>
          item.originalPath.includes(sep + "packages" + sep + "hesperia" + sep + "dist" + sep),
        ),
      )
    ) {
      throw new Error("Coverage build did not substitute a Hesperia dist module");
    }
  } catch (error) {
    operationFailed = true;
    operationError = error;
  } finally {
    let wrapperWasCurrent = false;

    try {
      wrapperWasCurrent = Bun.build === wrappedBuild;
    } catch (error) {
      restorationFailed = true;
      restorationError = error;
    }

    let restored = false;

    try {
      restored = Reflect.set(Bun, "build", originalBuild);
    } catch (error) {
      restorationFailed = true;
      restorationError ??= error;
    }

    let originalWasRestored = false;

    try {
      originalWasRestored = Bun.build === originalBuild;
    } catch (error) {
      restorationFailed = true;
      restorationError ??= error;
    }

    if (!wrapperWasCurrent || !restored || !originalWasRestored) {
      restorationFailed = true;
      restorationError ??= new Error(
        "Coverage build could not restore Bun.build after its scoped build",
      );
    }
  }

  if (operationFailed && restorationFailed) {
    throw new AggregateError(
      [operationError, restorationError],
      "Coverage build and restoration failed",
    );
  }

  if (operationFailed) throw operationError;

  if (restorationFailed) throw restorationError;

  return { result, builds: scopedBuilds };
}

/** Substitute authored fixture imports with this run's already-instrumented package graph. */
export async function withCoverageWorkerFixtureBuild<T>(
  options: WorkerCoverageFixtureBuildOptions<T>,
): Promise<{ readonly result: T; readonly builds: readonly WorkerCoverageBuildRecord[] }> {
  const repoRoot = resolve(options.repoPath);
  const buildDirectory = resolve(options.buildDirectory);
  const packageNames = [...options.packageNames];

  if (
    packageNames.length === 0 ||
    new Set(packageNames).size !== packageNames.length ||
    packageNames.some(
      (name) => !coveragePackages.includes(name as (typeof coveragePackages)[number]),
    )
  ) {
    throw new Error("Fixture coverage package selection is empty, duplicated, or unsupported");
  }

  if (
    options.expectedEntrypoints.length === 0 ||
    options.expectedEntrypoints.some((entries) => entries.length === 0)
  ) {
    throw new Error("Fixture coverage build requires exact entrypoint sets");
  }

  const outputs = new Map<string, WorkerCoverageOutput>();

  for (const output of options.outputs) {
    const originalPath = resolve(output.originalPath);
    const compiledPath = resolve(output.compiledPath);
    const originalRelative = relative(repoRoot, originalPath);
    const compiledRelative = relative(buildDirectory, compiledPath);
    const segments = originalRelative.split(sep);

    if (
      !existsSync(originalPath) ||
      !existsSync(compiledPath) ||
      originalRelative === ".." ||
      originalRelative.startsWith(".." + sep) ||
      segments[0] !== "packages" ||
      !packageNames.includes(segments[1] ?? "") ||
      segments[2] !== "dist" ||
      !originalPath.endsWith(".js") ||
      isAbsolute(compiledRelative) ||
      compiledRelative === ".." ||
      compiledRelative.startsWith(".." + sep) ||
      outputs.has(canonicalPath(originalPath))
    ) {
      throw new Error(
        "Fixture coverage output map contains an invalid or duplicate path: " + output.originalPath,
      );
    }

    outputs.set(canonicalPath(originalPath), { originalPath, compiledPath });
  }

  if (outputs.size === 0) throw new Error("Fixture coverage output map is empty");

  const expectedBuilds = options.expectedEntrypoints.map((entrypoints) => {
    const normalized = entrypoints.map((entry) => canonicalPath(resolve(entry))).sort();

    if (new Set(normalized).size !== normalized.length) {
      throw new Error("Fixture coverage entrypoint set contains duplicates");
    }

    return JSON.stringify(normalized);
  });

  if (new Set(expectedBuilds).size !== expectedBuilds.length) {
    throw new Error("Fixture coverage entrypoint sets contain duplicates");
  }

  const requiredSources = new Set(
    options.requiredSourcePaths.map((source) => {
      const path = resolve(repoRoot, source);
      const sourceRelative = relative(repoRoot, path);

      if (sourceRelative === ".." || sourceRelative.startsWith(".." + sep)) {
        throw new Error("Required fixture coverage source escaped the repository: " + source);
      }

      return canonicalPath(path);
    }),
  );

  if (requiredSources.size !== options.requiredSourcePaths.length) {
    throw new Error("Required fixture coverage sources contain duplicates");
  }

  const namesPattern = packageNames
    .map((name) => name.replace(/[-/\\^$*+?.()|[\]{}]/gu, "\\$&"))
    .join("|");
  const packageSourceFilter =
    /[\\/](?:packages[\\/][^\\/]+|node_modules[\\/]@hesperia[\\/][^\\/]+)[\\/]src[\\/].+\.(?:tsx?|mtsx?|ctsx?)$/iu;
  const packageDistFilter = new RegExp(
    "[\\\\/](?:packages[\\\\/][^\\\\/]+|node_modules[\\\\/](?:@hesperia[\\\\/][^\\\\/]+|(?:" +
      namesPattern +
      ")))[\\\\/]dist[\\\\/].+\\.js$",
    "iu",
  );
  const scopedBuilds: WorkerCoverageBuildRecord[] = [];
  const attemptedEntrypoints: string[][] = [];
  const originalBuild = Bun.build;

  const sourceToOutput = (path: string) => {
    const realPath = realpathSync(path);
    const sourceRelative = relative(repoRoot, realPath);
    const segments = sourceRelative.split(sep);
    const extension = extname(realPath).toLowerCase();
    const compiledExtension = extension === ".mts" ? ".mjs" : extension === ".cts" ? ".cjs" : ".js";

    if (
      segments[0] !== "packages" ||
      !packageNames.includes(segments[1] ?? "") ||
      segments[2] !== "src" ||
      ![".ts", ".tsx", ".mts", ".cts"].includes(extension)
    ) {
      throw new Error("Fixture coverage encountered an unsupported authored source: " + path);
    }

    const outputPath = resolve(
      repoRoot,
      "packages",
      segments[1]!,
      "dist",
      segments.slice(3).join(sep).slice(0, -extension.length) + compiledExtension,
    );
    const output = outputs.get(canonicalPath(outputPath));

    if (!output) {
      throw new Error("Fixture coverage source has no instrumented output mapping: " + realPath);
    }

    return { output, realPath };
  };

  const wrappedBuild = ((buildOptions: Parameters<typeof Bun.build>[0]) => {
    const entrypoints = buildOptions.entrypoints;

    if (!Array.isArray(entrypoints) || !entrypoints.every((entry) => typeof entry === "string")) {
      throw new Error("Fixture coverage build lacks explicit entrypoints");
    }

    const normalizedEntrypoints = entrypoints.map((entry) => canonicalPath(resolve(entry))).sort();
    const entrypointKey = JSON.stringify(normalizedEntrypoints);

    attemptedEntrypoints.push(normalizedEntrypoints);

    if (!expectedBuilds.includes(entrypointKey)) {
      throw new Error(
        "Fixture coverage encountered an unapproved entrypoint set: " + entrypoints.join(", "),
      );
    }

    if (
      scopedBuilds.some(
        (build) => JSON.stringify(build.entrypoints.map(canonicalPath).sort()) === entrypointKey,
      )
    ) {
      throw new Error("Fixture coverage entrypoint set was built more than once");
    }

    const substitutions: WorkerCoverageBuildSubstitution[] = [];

    const loadOutput = (path: string) => {
      const realPath = realpathSync(path);
      const output = outputs.get(canonicalPath(path)) ?? outputs.get(canonicalPath(realPath));

      if (!output) {
        throw new Error("Fixture coverage encountered an unmapped package dist module: " + path);
      }

      substitutions.push({
        originalPath: output.originalPath,
        path,
        realPath,
        compiledPath: output.compiledPath,
      });

      return { contents: readFileSync(output.compiledPath, "utf8"), loader: "js" as const };
    };

    const loadSource = (path: string) => {
      const { output, realPath } = sourceToOutput(path);

      substitutions.push({
        originalPath: realPath,
        path,
        realPath,
        compiledPath: output.compiledPath,
      });

      return {
        contents: readFileSync(output.compiledPath, "utf8"),
        loader: "js" as const,
        resolveDir: dirname(output.compiledPath),
      };
    };

    const plugin: Bun.BunPlugin = {
      name: "hesperia-coverage-fixture-source-map",

      setup(build) {
        build.onLoad({ filter: packageSourceFilter }, ({ path }) => loadSource(path));

        build.onLoad({ filter: packageDistFilter }, ({ path }) => loadOutput(path));

        build.onLoad({ filter: packageDistFilter, namespace: "hesperia-resolved" }, ({ path }) =>
          loadOutput(path),
        );
      },
    };
    const promise = Reflect.apply(originalBuild, Bun, [
      { ...buildOptions, plugins: [plugin, ...(buildOptions.plugins ?? [])] },
    ]) as ReturnType<typeof Bun.build>;
    return promise.then((result) => {
      scopedBuilds.push({ kind: "fixture", entrypoints: [...entrypoints], substitutions });

      return result;
    });
  }) as typeof Bun.build;

  if (!Reflect.set(Bun, "build", wrappedBuild) || Bun.build !== wrappedBuild) {
    throw new Error("Fixture coverage could not install its scoped Bun.build wrapper");
  }

  let operationFailed = false;
  let operationError: unknown;
  let result!: T;
  let restorationError: unknown;

  try {
    result = await options.build();
    const actualBuilds = scopedBuilds.map((build) =>
      JSON.stringify(build.entrypoints.map((entry) => canonicalPath(resolve(entry))).sort()),
    );

    if (
      scopedBuilds.length !== expectedBuilds.length ||
      new Set(actualBuilds).size !== expectedBuilds.length ||
      expectedBuilds.some((expected) => !actualBuilds.includes(expected))
    ) {
      throw new Error(
        "Fixture coverage did not build every exact approved entrypoint set: " +
          JSON.stringify({
            expected: expectedBuilds.map((build) => JSON.parse(build)),
            attempted: attemptedEntrypoints,
            successful: scopedBuilds.map((build) => build.entrypoints.map(canonicalPath).sort()),
          }),
      );
    }

    for (const source of requiredSources) {
      if (
        !scopedBuilds.some((build) =>
          build.substitutions.some(
            (substitution) => canonicalPath(substitution.originalPath) === source,
          ),
        )
      ) {
        throw new Error("Fixture coverage omitted required authored substitution: " + source);
      }
    }

    const hesperiaSourcePrefix = canonicalPath(join(repoRoot, "packages", "hesperia", "src")) + sep;
    const hesperiaDistPrefix = canonicalPath(join(repoRoot, "packages", "hesperia", "dist")) + sep;
    const hasMappedHesperiaSubstitution = scopedBuilds.some((build) =>
      build.substitutions.some((substitution) => {
        const originalPath = canonicalPath(substitution.originalPath);
        let output: WorkerCoverageOutput | undefined;

        try {
          output = originalPath.startsWith(hesperiaSourcePrefix)
            ? sourceToOutput(substitution.originalPath).output
            : outputs.get(originalPath);
        } catch {
          return false;
        }

        return (
          output !== undefined &&
          canonicalPath(output.originalPath).startsWith(hesperiaDistPrefix) &&
          typeof substitution.compiledPath === "string" &&
          canonicalPath(substitution.compiledPath) === canonicalPath(output.compiledPath)
        );
      }),
    );

    if (!hasMappedHesperiaSubstitution) {
      throw new Error("Fixture coverage did not substitute a Hesperia source module");
    }
  } catch (error) {
    operationFailed = true;
    operationError = error;
  } finally {
    let wrapperWasCurrent = false;

    try {
      wrapperWasCurrent = Bun.build === wrappedBuild;
    } catch (error) {
      restorationError = error;
    }

    let restored = false;

    try {
      restored = Reflect.set(Bun, "build", originalBuild);
    } catch (error) {
      restorationError ??= error;
    }

    let originalWasRestored = false;

    try {
      originalWasRestored = Bun.build === originalBuild;
    } catch (error) {
      restorationError ??= error;
    }

    if (!wrapperWasCurrent || !restored || !originalWasRestored) {
      restorationError ??= new Error("Fixture coverage could not restore Bun.build");
    }
  }

  if (operationFailed && restorationError) {
    throw new AggregateError(
      [operationError, restorationError],
      "Fixture coverage build and restoration failed",
    );
  }

  if (operationFailed) throw operationError;

  if (restorationError) throw restorationError;

  return { result, builds: scopedBuilds };
}
