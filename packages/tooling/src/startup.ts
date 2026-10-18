/** Virtual module identities used only by the browser build plugin. */
export const startupModules = Object.freeze({
  shell: "hesperia-app-shell",
  configuration: "hesperia-app-configuration",
  routes: "hesperia-app-routes",
});

/**
 * Generate an import-safe startup module with authored modules behind explicit loaders.
 * The caller chooses the mount and starts the application after importing this module.
 */
export function browserStartupSource(
  hasConfiguration: boolean,
  runtimeModule = "hesperia/runtime",
): string {
  return `import { bootstrapApplication } from ${JSON.stringify(runtimeModule)};
export async function start(mountPath: string): Promise<void> {
  await bootstrapApplication(window, {
    configuration: ${hasConfiguration ? `() => import(${JSON.stringify(startupModules.configuration)}).then(module => module.default)` : "() => ({})"},
    shell: () => import(${JSON.stringify(startupModules.shell)}).then(module => module.default),
    routes: () => import(${JSON.stringify(startupModules.routes)}).then(module => module.default),
  }, { mountPath });
}
`;
}

/** Minimal transport document; app.tsx supplies the authored HTML/head/body tree. */
export function browserStartupHtml(script: string, mountPath = "/"): string {
  const entryPath = script.startsWith("/") ? script : `/${script}`;
  const mountPrefix = mountPath === "/" ? "" : mountPath;
  const importPath = `${mountPrefix}${entryPath}`;
  return `<!doctype html>\n<html><head><meta charset="utf-8"></head><body><script type="module">import { start } from ${JSON.stringify(importPath)}; await start(${JSON.stringify(mountPath)});</script></body></html>\n`;
}
