import type { Page } from "playwright";

/** Observe the exact document request without changing navigation deadlines. */
export declare function installDocumentNavigationDiagnostics(
  page: Page,
  diagnostics: { mark(step: string, detail?: unknown): void },
  targetURL: string,
): Promise<() => void>;
