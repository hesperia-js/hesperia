import { checkOxcProject } from "./oxc-check.ts";
import { checkProject, ProjectError, readProject, type ProjectDiagnostic } from "./project.ts";

/** Check output reported in execution order, without terminal formatting. */
export type CheckReport =
  | { readonly kind: "diagnostics"; readonly items: readonly ProjectDiagnostic[] }
  | { readonly kind: "error"; readonly message: string };

/**
 * Run both project checkers, continuing after either checker fails.
 * Fixes run before compiler checking so the compiler sees the corrected sources.
 */
export async function checkApplication(
  root: string,
  options: { readonly fix: boolean; readonly report: (report: CheckReport) => void },
): Promise<{ readonly failed: boolean }> {
  let failed = false;
  const { fix, report } = options;

  const checkOxc = async (): Promise<void> => {
    try {
      const result = await checkOxcProject(root, await readProject(root), { fix });

      report({ kind: "diagnostics", items: result.diagnostics });

      failed ||= result.failed;
    } catch (error) {
      report({
        kind: "error",
        message: `Oxc checking failed: ${error instanceof Error ? error.message : String(error)}`,
      });

      failed = true;
    }
  };

  if (fix) await checkOxc();

  try {
    const diagnostics = await checkProject(root);

    report({ kind: "diagnostics", items: diagnostics });

    failed ||= diagnostics.some((item) => item.severity === "error");
  } catch (error) {
    report({ kind: "error", message: error instanceof Error ? error.message : String(error) });

    if (error instanceof ProjectError) report({ kind: "diagnostics", items: error.diagnostics });

    failed = true;
  }

  if (!fix) await checkOxc();

  return { failed };
}
