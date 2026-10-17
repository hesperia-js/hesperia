type NativeNavigationWindow = {
  readonly navigation?: Navigation;
  readonly NavigationPrecommitController?: unknown;
  readonly NavigateEvent?: { readonly prototype?: { readonly intercept?: unknown } };
};

/** Read-only feature check for the async admission hook required by Hesperia. */
export function supportsNativeNavigation(window: Window): boolean {
  const candidate = window as unknown as NativeNavigationWindow;
  return (
    candidate.navigation !== undefined &&
    typeof candidate.NavigateEvent?.prototype?.intercept === "function" &&
    typeof candidate.NavigationPrecommitController === "function"
  );
}

/** Return the native API only when its async-admission contract is available. */
export function nativeNavigationFor(window: Window): Navigation | undefined {
  if (!supportsNativeNavigation(window)) return undefined;

  return (window as unknown as NativeNavigationWindow).navigation;
}

/** A partial Navigation API is not an async-admission authority. */
export function hasNavigationObject(window: Window): boolean {
  return (window as unknown as NativeNavigationWindow).navigation !== undefined;
}
