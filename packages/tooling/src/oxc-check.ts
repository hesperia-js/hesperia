import { createRequire } from "node:module";
import { access, readdir, readFile } from "node:fs/promises";
import { dirname, extname, isAbsolute, join, resolve } from "node:path";
import { PAGE_DECLARATION_MARKER } from "@hesperia/compiler/tooling";
import { readProject, type ProjectDiagnostic } from "./project.ts";
import { isMissingFile } from "./utils.ts";

const require = createRequire(import.meta.url);
const codeExtensions = new Set([".cjs", ".cts", ".js", ".jsx", ".mjs", ".mts", ".ts", ".tsx"]);
const styleExtensions = new Set([".css"]);
const formatExtensions = new Set([
  ...codeExtensions,
  ".json",
  ".json5",
  ".jsonc",
  ...styleExtensions,
]);

interface OxcProjectFiles {
  readonly lint: readonly string[];
  readonly format: readonly string[];
}

export interface OxcProjectCheck {
  readonly diagnostics: readonly ProjectDiagnostic[];
  readonly failed: boolean;
}

interface ToolOutput {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

type ToolBatchResult =
  | { readonly files: readonly string[]; readonly output: ToolOutput }
  | { readonly files: readonly string[]; readonly error: unknown };

const maxWindowsCommandLineLength = 30_000;

function isExcluded(filename: string): boolean {
  return filename
    .split(/[\\/]/u)
    .some((part) => part.toLowerCase() === "node_modules" || part.toLowerCase() === ".hesperia");
}

function normalized(filename: string): string {
  const path = resolve(filename).replaceAll("\\", "/");
  return process.platform === "win32" ? path.toLowerCase() : path;
}

function toolDiagnostic(
  root: string,
  tool: "oxlint" | "oxfmt",
  message: string,
): ProjectDiagnostic {
  return {
    filename: root,
    code: tool === "oxlint" ? "OXLINT" : "OXFMT",
    severity: "error",
    message: `${tool} failed: ${message.trim() || "unknown tool failure"}`,
  };
}

function isConfigurationFile(name: string): boolean {
  return (
    name === "app.config.ts" ||
    name === "hesperia.config.ts" ||
    name === "hesperia.config.json" ||
    name === "package.json" ||
    name === "jsconfig.json" ||
    /^tsconfig(?:\..+)?\.jsonc?$/iu.test(name) ||
    /^\.?oxlintrc(?:\..+)?$/iu.test(name) ||
    /^oxlint\.config\..+$/iu.test(name) ||
    /^\.?oxfmtrc(?:\..+)?$/iu.test(name) ||
    /^oxfmt\.config\..+$/iu.test(name)
  );
}

function skipCssComment(source: string, start: number): number {
  const end = source.indexOf("*/", start + 2);
  return end < 0 ? source.length : end + 2;
}

function skipCssString(source: string, start: number): number {
  const quote = source[start];

  for (let index = start + 1; index < source.length; index += 1) {
    const character = source[index]!;

    if (character === "\\") {
      index += 1;
    } else if (character === quote) {
      return index + 1;
    } else if (character === "\n" || character === "\r" || character === "\f") {
      return index;
    }
  }

  return source.length;
}

function cssImportRequests(source: string): string[] {
  const pattern =
    /^@import\s+(?:url\(\s*(?:"([^"]+)"|'([^']+)'|([^)\s]+))\s*\)|"([^"]+)"|'([^']+)')/iu;
  const requests: string[] = [];
  let index = 0;
  let blockDepth = 0;

  while (index < source.length) {
    if (source.startsWith("/*", index)) {
      index = skipCssComment(source, index);
      continue;
    }

    const character = source[index]!;

    if (character === "'" || character === '"') {
      index = skipCssString(source, index);
      continue;
    }

    if (character === "{") blockDepth += 1;
    else if (character === "}") blockDepth = Math.max(0, blockDepth - 1);

    if (
      blockDepth === 0 &&
      source.slice(index, index + "@import".length).toLowerCase() === "@import" &&
      !/[-_a-z\d]/iu.test(source[index + "@import".length] ?? "")
    ) {
      const imported = pattern.exec(source.slice(index));
      const request =
        imported?.[1] ?? imported?.[2] ?? imported?.[3] ?? imported?.[4] ?? imported?.[5];

      if (request) requests.push(request);

      index += imported?.[0].length ?? "@import".length;
    } else {
      index += 1;
    }
  }

  return requests;
}

/** Collect authored compiler inputs and their local imports without scanning generated folders. */
async function collectOxcProjectFiles(
  root: string,
  sources: ReadonlyMap<string, string>,
): Promise<OxcProjectFiles> {
  root = resolve(root);
  const lint = new Map<string, string>();
  const format = new Map<string, string>();
  const scanned = new Set<string>();
  const pending: Array<{ filename: string; source: string }> = [];
  const transpiler = new Bun.Transpiler({ loader: "tsx" });

  function isGeneratedPageTypes(filename: string, source: string): boolean {
    return (
      normalized(filename) === normalized(resolve(root, "hesperia.d.ts")) &&
      source.startsWith(PAGE_DECLARATION_MARKER)
    );
  }

  function addCode(filename: string, source?: string): void {
    const path = resolve(filename);

    if (isExcluded(path) || !codeExtensions.has(extname(path).toLowerCase())) return;

    if (source !== undefined && isGeneratedPageTypes(path, source)) return;

    const key = normalized(path);

    lint.set(key, path);

    format.set(key, path);

    if (source !== undefined && !scanned.has(key)) {
      scanned.add(key);

      pending.push({ filename: path, source });
    }
  }

  async function addStyle(filename: string): Promise<void> {
    const path = resolve(filename);

    if (isExcluded(path) || !styleExtensions.has(extname(path).toLowerCase())) return;

    const key = normalized(path);

    if (format.has(key)) return;

    format.set(key, path);

    let source: string;

    try {
      source = await readFile(path, "utf8");
    } catch {
      return;
    }

    for (const request of cssImportRequests(source)) {
      if (!request || (!request.startsWith(".") && !request.startsWith("/"))) continue;

      try {
        const dependency = Bun.resolveSync(request, dirname(path));

        await addStyle(dependency);
      } catch {
        // The Hesperia build reports unresolved CSS imports with authored locations.
      }
    }
  }

  async function addDiscovered(filename: string): Promise<void> {
    const path = resolve(filename);

    if (isExcluded(path)) return;

    const extension = extname(path).toLowerCase();

    if (codeExtensions.has(extension)) {
      const key = normalized(path);

      if (!lint.has(key)) {
        try {
          const source = await readFile(path, "utf8");

          addCode(path, source);
        } catch {
          // Unresolved or unreadable project imports remain the compiler's diagnostic.
        }
      }
    } else if (styleExtensions.has(extension)) await addStyle(path);
    else if (formatExtensions.has(extension)) format.set(normalized(path), path);
  }

  for (const [filename, source] of sources) addCode(filename, source);

  async function visitSourceDirectory(directory: string): Promise<void> {
    let entries;

    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (isMissingFile(error)) return;

      throw error;
    }

    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const filename = resolve(directory, entry.name);

      if (entry.isDirectory()) {
        if (!isExcluded(filename)) await visitSourceDirectory(filename);
      } else if (entry.isFile()) {
        const extension = extname(entry.name).toLowerCase();

        if (codeExtensions.has(extension)) {
          try {
            addCode(filename, await readFile(filename, "utf8"));
          } catch {
            // The compiler reports unreadable sources through its normal project pass.
          }
        } else if (styleExtensions.has(extension)) await addStyle(filename);
      }
    }
  }

  await visitSourceDirectory(resolve(root, "src"));

  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isFile() || !isConfigurationFile(entry.name)) continue;

    const filename = resolve(root, entry.name);

    if (isExcluded(filename)) continue;

    const extension = extname(filename).toLowerCase();

    if (!formatExtensions.has(extension)) continue;

    format.set(normalized(filename), filename);

    if (codeExtensions.has(extension)) {
      try {
        addCode(filename, await readFile(filename, "utf8"));
      } catch {
        // The project configuration loader reports unreadable configuration files.
      }
    }
  }

  for (let index = 0; index < pending.length; index += 1) {
    const { filename, source } = pending[index]!;
    let requests: ReturnType<typeof transpiler.scanImports>;

    try {
      requests = transpiler.scanImports(source);
    } catch {
      continue;
    }

    for (const request of requests) {
      if (!request.path.startsWith(".")) continue;

      try {
        await addDiscovered(Bun.resolveSync(request.path, dirname(filename)));
      } catch {
        // Package imports, unresolved modules, and compiler-managed inputs are handled elsewhere.
      }
    }
  }

  return {
    lint: [...lint.values()].sort((left, right) => left.localeCompare(right)),
    format: [...format.values()].sort((left, right) => left.localeCompare(right)),
  };
}

function binaryPath(packageName: string, executableName: string): string {
  const entry = require.resolve(packageName);
  return resolve(dirname(dirname(entry)), "bin", executableName);
}

async function runTool(
  root: string,
  packageName: string,
  executableName: string,
  args: readonly string[],
): Promise<ToolOutput> {
  const child = Bun.spawn([process.execPath, binaryPath(packageName, executableName), ...args], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code, stdout, stderr };
}

function estimateWindowsArgumentLength(argument: string): number {
  return argument.length * 2 + 3;
}

function splitToolFileBatches(
  commandPrefix: readonly string[],
  files: readonly string[],
): string[][] {
  if (!files.length) return [];

  if (process.platform !== "win32") return [[...files]];

  const prefixLength = commandPrefix.reduce(
    (length, argument) => length + estimateWindowsArgumentLength(argument),
    1,
  );
  const batches: string[][] = [];
  let batch: string[] = [];
  let commandLength = prefixLength;

  for (const filename of files) {
    const argumentLength = estimateWindowsArgumentLength(filename);

    if (batch.length && commandLength + argumentLength > maxWindowsCommandLineLength) {
      batches.push(batch);

      batch = [];
      commandLength = prefixLength;
    }

    batch.push(filename);

    commandLength += argumentLength;
  }

  if (batch.length) batches.push(batch);

  return batches;
}

async function runToolBatches(
  root: string,
  packageName: string,
  executableName: string,
  args: readonly string[],
  files: readonly string[],
): Promise<ToolBatchResult[]> {
  const executablePath = binaryPath(packageName, executableName);
  const batches = splitToolFileBatches([process.execPath, executablePath, ...args], files);
  const results: ToolBatchResult[] = [];

  for (const batch of batches) {
    try {
      results.push({
        files: batch,
        output: await runTool(root, packageName, executableName, [...args, ...batch]),
      });
    } catch (error) {
      results.push({ files: batch, error });
    }
  }

  return results;
}

function parseOxlint(root: string, output: ToolOutput): ProjectDiagnostic[] {
  let value: {
    diagnostics?: readonly {
      code?: string;
      filename?: string;
      help?: string;
      labels?: readonly { span?: { offset?: number; length?: number } }[];
      message?: string;
      severity?: string;
    }[];
  };

  try {
    value = JSON.parse(output.stdout) as typeof value;
  } catch {
    if (output.code === 1 && /no files found to lint/iu.test(`${output.stdout}\n${output.stderr}`))
      return [];

    throw new Error(output.stderr.trim() || output.stdout.trim() || `exit ${output.code}`);
  }

  return (value.diagnostics ?? []).map((item) => {
    const sourceSpan = item.labels?.find((label) => label.span)?.span;
    const start = sourceSpan?.offset;
    const length = sourceSpan?.length;
    const filename = item.filename ? resolve(root, item.filename) : resolve(root, ".");
    return {
      filename,
      code: item.code ?? "OXLINT",
      severity:
        item.severity === "warning" ? "warning" : item.severity === "advice" ? "info" : "error",
      message: item.help
        ? `${item.message ?? "Lint issue"} ${item.help}`
        : (item.message ?? "Lint issue"),
      ...(start !== undefined && length !== undefined
        ? { span: { start, end: start + length } }
        : {}),
    };
  });
}

function parseOxfmt(
  root: string,
  files: readonly string[],
  output: ToolOutput,
): ProjectDiagnostic[] {
  if (output.code === 0) return [];

  const changedPaths = new Set<string>();

  for (const line of output.stdout.split(/\r?\n/u)) {
    const listed = line.trim().replace(/^(?:would format|would reformat|formatted):\s*/iu, "");

    if (!listed) continue;

    changedPaths.add(normalized(isAbsolute(listed) ? listed : resolve(root, listed)));
  }

  const changed = files.filter((filename) => changedPaths.has(normalized(filename)));

  if (changed.length)
    return changed.map((filename) => ({
      filename,
      code: "OXFMT",
      severity: "error",
      message: "File is not formatted.",
    }));

  if (
    /expected at least one target file|all matched files may have been excluded by ignore rules/iu.test(
      `${output.stdout}\n${output.stderr}`,
    )
  )
    return [];

  return [toolDiagnostic(root, "oxfmt", output.stderr || output.stdout || `exit ${output.code}`)];
}

function oxfmtArguments(mode: "check" | "fix"): string[] {
  return mode === "check" ? ["--list-different"] : ["--write"];
}

async function oxlintArguments(root: string, fix: boolean): Promise<string[]> {
  const args = [...(fix ? ["--fix"] : []), "--format=json"];

  try {
    const ignorePath = join(root, ".eslintignore");

    await access(ignorePath);

    args.push(`--ignore-path=${ignorePath}`);
  } catch {
    // Oxlint's normal project config still supplies its own ignore rules.
  }

  return args;
}

/** Run configured Oxc checks, optionally applying only Oxfmt writes and Oxlint safe fixes. */
export async function checkOxcProject(
  root: string,
  sources: ReadonlyMap<string, string>,
  options: { readonly fix?: boolean } = {},
): Promise<OxcProjectCheck> {
  root = resolve(root);
  let files = await collectOxcProjectFiles(root, sources);
  const diagnostics: ProjectDiagnostic[] = [];
  let failed = false;

  if (options.fix) {
    const fixTools = [
      {
        tool: "oxfmt" as const,
        packageName: "oxfmt",
        executable: "oxfmt",
        args: oxfmtArguments("fix"),
        files: files.format,
      },
      {
        tool: "oxlint" as const,
        packageName: "oxlint",
        executable: "oxlint",
        args: await oxlintArguments(root, true),
        files: files.lint,
      },
    ];

    for (const { tool, packageName, executable, args, files: toolFiles } of fixTools) {
      if (!toolFiles.length) continue;

      try {
        const batches = await runToolBatches(root, packageName, executable, args, toolFiles);

        for (const result of batches) {
          if ("error" in result) {
            diagnostics.push(
              toolDiagnostic(
                root,
                tool,
                result.error instanceof Error ? result.error.message : String(result.error),
              ),
            );

            failed = true;
            continue;
          }

          const noTargets =
            /expected at least one target file|all matched files may have been excluded by ignore rules|no files found to lint/iu.test(
              `${result.output.stdout}\n${result.output.stderr}`,
            );

          if (result.output.code > 1 && !noTargets) {
            diagnostics.push(
              toolDiagnostic(
                root,
                tool,
                result.output.stderr || result.output.stdout || `exit ${result.output.code}`,
              ),
            );

            failed = true;
          }
        }
      } catch (error) {
        diagnostics.push(
          toolDiagnostic(root, tool, error instanceof Error ? error.message : String(error)),
        );

        failed = true;
      }
    }

    // Fixes may change import edges, so the final Oxc pass uses the new project snapshot.
    files = await collectOxcProjectFiles(root, await readProject(root));
  }

  const checks = await Promise.allSettled([
    files.lint.length
      ? oxlintArguments(root, false).then((args) =>
          runToolBatches(root, "oxlint", "oxlint", args, files.lint),
        )
      : Promise.resolve([] as ToolBatchResult[]),
    files.format.length
      ? runToolBatches(root, "oxfmt", "oxfmt", oxfmtArguments("check"), files.format)
      : Promise.resolve([] as ToolBatchResult[]),
  ]);

  const [lint, format] = checks;

  if (lint.status === "rejected") {
    diagnostics.push(
      toolDiagnostic(
        root,
        "oxlint",
        lint.reason instanceof Error ? lint.reason.message : String(lint.reason),
      ),
    );

    failed = true;
  } else if (files.lint.length) {
    for (const result of lint.value) {
      if ("error" in result) {
        diagnostics.push(
          toolDiagnostic(
            root,
            "oxlint",
            result.error instanceof Error ? result.error.message : String(result.error),
          ),
        );

        failed = true;
        continue;
      }

      try {
        diagnostics.push(...parseOxlint(root, result.output));

        if (result.output.code !== 0 && !/no files found to lint/iu.test(result.output.stdout))
          failed = true;
      } catch (error) {
        diagnostics.push(
          toolDiagnostic(root, "oxlint", error instanceof Error ? error.message : String(error)),
        );

        failed = true;
      }
    }
  }

  if (format.status === "rejected") {
    diagnostics.push(
      toolDiagnostic(
        root,
        "oxfmt",
        format.reason instanceof Error ? format.reason.message : String(format.reason),
      ),
    );

    failed = true;
  } else {
    for (const result of format.value) {
      if ("error" in result) {
        diagnostics.push(
          toolDiagnostic(
            root,
            "oxfmt",
            result.error instanceof Error ? result.error.message : String(result.error),
          ),
        );

        failed = true;
        continue;
      }

      const formatDiagnostics = parseOxfmt(root, result.files, result.output);

      diagnostics.push(...formatDiagnostics);

      if (result.output.code !== 0 && !formatDiagnostics.length) {
        if (
          !/expected at least one target file|all matched files may have been excluded by ignore rules/iu.test(
            `${result.output.stdout}\n${result.output.stderr}`,
          )
        )
          failed = true;
      }
    }
  }

  if (diagnostics.some((item) => item.severity === "error")) failed = true;

  return { diagnostics, failed };
}
