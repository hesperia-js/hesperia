import { RenderFault } from "./runtime/owner.ts";
import { navigationForCurrentWindow } from "./routing/navigation-api.ts";
import type { DepartureCheck } from "./routing/navigation.ts";

/**
 * Entry-valued completion promises returned by the Navigation API. For same-document routing,
 * `committed` follows the URL/history commit and `finished` follows route rendering, CSS and initial
 * effects. A non-intercepted cross-document navigation can leave both promises pending in the
 * outgoing document.
 */
export interface RequiredNavigationResult {
  /** Resolves with the entry after the browser commits its URL and history change. */
  readonly committed: Promise<NavigationHistoryEntry>;
  /** Resolves with the entry after routed rendering, CSS and initial effects settle. */
  readonly finished: Promise<NavigationHistoryEntry>;
}

/** Navigation surface bound to the routed application in the current Window. */
export type HesperiaNavigation = Omit<
  globalThis.Navigation,
  "navigate" | "reload" | "traverseTo" | "back" | "forward"
> & {
  /** Resolve an application route to its browser-facing mounted URL. */
  href(destination: string | URL): string;

  /** Navigate to a route, applying Hesperia's mount-prefix rules. */
  navigate(
    destination: string | URL,
    options?: NavigationNavigateOptions,
  ): RequiredNavigationResult;

  /**
   * Await mounted shell, layout and page departure checks, then reload the whole document if they
   * allow it. A veto rejects the result with AbortError and preserves the document and state without
   * a reload event. Browser F5 remains browser-owned and does not run these checks; successful
   * non-intercepted cross-document result promises may remain pending as the outgoing document unloads.
   */
  reload(options?: NavigationReloadOptions): RequiredNavigationResult;

  /** Traverse to an entry returned by {@link HesperiaNavigation.entries}. */
  traverseTo(key: string, options?: NavigationOptions): RequiredNavigationResult;

  /** Traverse to the prior history entry. */
  back(options?: NavigationOptions): RequiredNavigationResult;

  /** Traverse to the next history entry. */
  forward(options?: NavigationOptions): RequiredNavigationResult;
};

/** Shared Navigation object for this browser module realm. */
export const navigation: HesperiaNavigation = new Proxy(new EventTarget(), {
  get(_target, property) {
    const active = navigationForCurrentWindow() as unknown as Record<PropertyKey, unknown>;
    return active[property];
  },

  set(_target, property, value) {
    const active = navigationForCurrentWindow() as unknown as Record<PropertyKey, unknown>;
    active[property] = value;
    return true;
  },

  has(_target, property) {
    const active = navigationForCurrentWindow() as unknown as Record<PropertyKey, unknown>;
    return property in active;
  },
}) as unknown as HesperiaNavigation;

/** Compiler-bound owner departure check. The compiler replaces this marker. */
export const beforeLeave: (check: DepartureCheck) => void = () => {
  throw new RenderFault(
    "compiler-required",
    "Use Hesperia's compiler to bind navigation operations to a component",
  );
};
