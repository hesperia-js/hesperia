import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  readEditorCoverageConfig,
  splitEditorOwnerCoverage,
  writeEditorOwnerCaptureError,
  writeEditorOwnerExit,
  writeEditorOwnerSupportCoverage,
  writeEditorOwnerStart,
} from "./coverage-editor-process.ts";

const config = readEditorCoverageConfig();
const role = process.env.HESPERIA_EDITOR_COVERAGE_ROLE;

if (role !== "language-server")
  throw new Error("Editor coverage preload ran outside the server owner");

const outputs = new Map(
  config.outputs.map((output) => [canonicalPath(output.originalPath), output] as const),
);

if (outputs.size === 0)
  throw new Error("Editor language-server instrumented module graph is empty");

const exactPaths = [...outputs.values()].map((output) => output.originalPath);
const escaped = exactPaths.map((path) => path.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"));
const filter = new RegExp(`^(?:${escaped.join("|")})$`, process.platform === "win32" ? "iu" : "u");

Bun.plugin({
  name: "hesperia-editor-language-server-coverage",

  setup(build) {
    build.onLoad({ filter }, ({ path }) => {
      const output = outputs.get(canonicalPath(path));

      if (!output)
        throw new Error(`Editor coverage matched an unknown language-server module: ${path}`);

      return { contents: readFileSync(output.compiledPath, "utf8"), loader: "js" };
    });
  },
});

const start = writeEditorOwnerStart(config, "language-server");

process.once("exit", (exitCode) => {
  try {
    const raw = Reflect.get(globalThis, "__hesperiaCoverage__") as
      | Record<string, Record<string, unknown>>
      | undefined;
    const { packageCoverage, supportCoverage } = splitEditorOwnerCoverage(
      config,
      "language-server",
      raw ?? {},
    );

    writeEditorOwnerExit(config, start, exitCode, packageCoverage);

    writeEditorOwnerSupportCoverage(config, start, supportCoverage);
  } catch (error) {
    try {
      writeEditorOwnerCaptureError(config, start, error);
    } catch {}
  }
});

function canonicalPath(path: string): string {
  const absolute = resolve(path);
  return process.platform === "win32" ? absolute.toLowerCase() : absolute;
}
