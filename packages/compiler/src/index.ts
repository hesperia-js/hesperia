export { compile } from "./project-compilation.ts";
export type { CompileOptions, CompileResult } from "./compilation.ts";
export { checkProjectModules, checkVirtualModule } from "./checking.ts";
export type {
  CheckedModule,
  CapturedCheckingInput,
  ProjectCheckingOptions,
  ProjectCheckingResult,
  VirtualModule,
} from "./checking.ts";
export type {
  BrowserResolutionOverrides,
  ProjectResolutionOverrides,
} from "./module-resolution.ts";
export { canonicalDebugSidecar, encodeCanonicalModule, HESPERIA_IR_VERSION } from "./ir.ts";
export { resolveCanonicalModule } from "./resolve.ts";
export type * from "./ir.ts";
export type { ModuleSemantics } from "./semantics.ts";
export { analyzeRouteModule } from "./route-analysis.ts";
export { analyzeBrowserCapabilities } from "./capability-analysis.ts";
export type { CapabilityDiagnostic, CapabilitySourceModule } from "./capability-analysis.ts";
export { generatePageDeclarations, PAGE_DECLARATION_MARKER } from "./page-types.ts";
export type { PageDeclarationOptions, PageDeclarations } from "./page-types.ts";
export type {
  RouteAnalysisOptions,
  RouteAnalysisResult,
  RouteGuardArtifact,
  RouteGuardModule,
  RouteDiagnostic,
  RouteSourceModule,
} from "./route-analysis.ts";
