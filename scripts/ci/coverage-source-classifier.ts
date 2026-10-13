import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createInstrumenter } = require("istanbul-lib-instrument") as {
  createInstrumenter(options: Record<string, unknown>): SourceInstrumenter;
};

interface SourceInstrumenter {
  instrumentSync(source: string, filename: string): string;

  lastFileCoverage(): {
    statementMap: Record<string, unknown>;
    fnMap: Record<string, unknown>;
    branchMap: Record<string, unknown>;
  };
}

export function coverageSourceHasExecutableStatements(filename: string, source: string): boolean {
  const parserPlugins = filename.toLowerCase().endsWith(".tsx")
    ? ["typescript", "jsx"]
    : ["typescript"];
  const instrumenter = createInstrumenter({
    coverageVariable: "__hesperiaCoverage__",
    coverageGlobalScope: "globalThis",
    coverageGlobalScopeFunc: false,
    esModules: true,
    produceSourceMap: true,
    parserPlugins,
  });

  instrumenter.instrumentSync(source, filename);

  const coverage = instrumenter.lastFileCoverage();
  return (
    Object.keys(coverage.statementMap).length > 0 ||
    Object.keys(coverage.fnMap).length > 0 ||
    Object.keys(coverage.branchMap).length > 0
  );
}
