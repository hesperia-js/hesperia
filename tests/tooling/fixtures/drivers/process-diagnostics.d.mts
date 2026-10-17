/**
 * Starts a bounded journal for this process. Writes and disposal are synchronous
 * and best-effort. Keep the returned observer alive through browser cleanup.
 */
export declare function startProcessDiagnostics(options: { directory: string; label: string }): {
  mark(kind: string, detail?: unknown): void;
  dispose(): void;
};
