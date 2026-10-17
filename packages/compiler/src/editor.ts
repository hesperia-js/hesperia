/** Checker and syntax-context services consumed by the Hesperia language server. */
export { openCheckingProject } from "./checking.ts";
export type {
  CheckingSession,
  ProjectCheckingOptions,
  ProjectCheckingResult,
  VirtualModule,
} from "./checking.ts";
export type { CheckingView } from "./checking-view.ts";
export { childNamespace, namespaceForTag } from "./namespace.ts";
export type { NamespaceContext } from "./namespace.ts";
