/** Compiler services consumed by the Hesperia tooling package. */
export { analyzeBrowserCapabilities } from "./capability-analysis.ts";
export type { CapabilityDiagnostic } from "./capability-analysis.ts";
export { analyzeModule, emitAnalysis } from "./compilation.ts";
export type { CompileOptions, CompileResult, ModuleAnalysis } from "./compilation.ts";
export type { CompilerDiagnostic } from "./ir.ts";
export { checkProjectModules, openCheckingProject } from "./checking.ts";
export type {
  CheckingSession,
  ProjectCheckingOptions,
  ProjectCheckingResult,
  VirtualModule,
} from "./checking.ts";
export { ModuleResolver } from "./module-resolution.ts";
export type {
  BrowserResolutionOverrides,
  ProjectResolutionOverrides,
} from "./module-resolution.ts";
export { compileProjectModules, emitCheckingSession } from "./project-compilation.ts";
export type { ProjectCompilation } from "./project-compilation.ts";
export { runtimeKeyRegistry } from "./runtime-keys.ts";
export { scanRouteFiles } from "./scanner.ts";
export { generatePageDeclarations, PAGE_DECLARATION_MARKER } from "./page-types.ts";
export {
  analyzeRouteModule,
  extractBindingClosure,
  type RouteDiagnostic,
  type RouteSourceModule,
} from "./route-analysis.ts";
export { emitRouteGuardArtifact } from "./route-emission.ts";
