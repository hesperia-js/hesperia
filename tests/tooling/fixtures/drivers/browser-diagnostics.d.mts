import type { Page } from "playwright";

export declare function startBrowserDiagnostics(
  page: Page,
  options: { directory: string; label: string },
): Promise<{
  mark(step: string, detail?: unknown): void;
  capture(error: unknown): Promise<void>;
  dispose(): Promise<void>;
}>;
