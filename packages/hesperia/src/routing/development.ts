const matchers = new WeakMap<object, (url: URL) => string | undefined>();
const reloadChecks = new WeakMap<Window, (url: URL) => boolean>();

/** @internal Bind scanner route IDs to one filesystem router. */
export function bindDevelopmentRouteMatcher(
  router: object,
  match: (url: URL) => string | undefined,
): void {
  matchers.set(router, match);
}

/** @internal Find the scanner identity used by development dependency ownership. */
export function developmentRouteId(router: object, url: URL): string | undefined {
  return matchers.get(router)?.(url);
}

/** @internal Install the document's invalidated destination check. */
export function installDevelopmentReloadCheck(
  window: Window,
  check: (url: URL) => boolean,
): () => void {
  reloadChecks.set(window, check);

  return () => {
    if (reloadChecks.get(window) === check) reloadChecks.delete(window);
  };
}

/** @internal Invalidated development destinations must load a fresh document. */
export function requiresDevelopmentReload(window: Window, url: URL): boolean {
  return reloadChecks.get(window)?.(url) ?? false;
}
