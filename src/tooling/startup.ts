/** Virtual module identities used only by the browser build plugin. */
export const startupModules = Object.freeze({
  shell: "hesperia-app-shell",
  configuration: "hesperia-app-configuration",
  routes: "hesperia-app-routes",
});

/**
 * Generate browser startup with authored modules behind explicit loaders.
 * The bootstrap installs history tracking before evaluating those modules.
 */
export function browserStartupSource(
  hasConfiguration: boolean,
  runtimeModule = "hesperia/runtime",
): string {
  return `import { bootstrapApplication } from ${JSON.stringify(runtimeModule)};
await bootstrapApplication(window, {
  configuration: ${hasConfiguration ? `() => import(${JSON.stringify(startupModules.configuration)}).then(module => module.default)` : "() => ({})"},
  shell: () => import(${JSON.stringify(startupModules.shell)}).then(module => module.default),
  routes: () => import(${JSON.stringify(startupModules.routes)}).then(module => module.default),
});
`;
}

/** Minimal transport document; app.tsx supplies the authored HTML/head/body tree. */
export function browserStartupHtml(script: string): string {
  return `<!doctype html>\n<html><head><meta charset="utf-8"></head><body><script type="module" src="${script}"></script></body></html>\n`;
}
