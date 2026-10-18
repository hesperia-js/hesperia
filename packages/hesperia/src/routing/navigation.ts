import type { Accessor } from "../client.ts";
import { Owner, RenderFault } from "../runtime/owner.ts";
import { installHistoryTracking, type HistoryEntry, type HistoryTracker } from "./history.ts";
import type { RouteParams } from "./manifest.ts";
import { createQueryParams, readonlyQueryParams, type ReadonlyQueryParams } from "./query.ts";
import { PageCache } from "./page-cache.ts";
import type { RouteRenderFailure, RouteRenderFailureReader } from "./navigation-outcome.ts";
import {
  installBrowserHistory,
  type BrowserHistoryAdapter,
  type BrowserHistoryEntry,
} from "./browser-history.ts";
import type { NavigationHistoryObserver } from "./navigation-api.ts";
import { RoutePresentation } from "./presentation.ts";
import type { PresentationSnapshot } from "./presentation.ts";
import { isWithinMount, normalizeMountPath } from "./navigation-url.ts";
import {
  developmentRouteId,
  installDevelopmentReloadCheck,
  requiresDevelopmentReload,
} from "./development.ts";

/** Explicit guard outcome requesting a new route target. */
export interface Redirect {
  /** Destination resolved relative to the target whose guard returned this result. */
  readonly redirect: string;
}

/** Construct a guard redirect result; no navigation starts until the router receives it. */
export function redirect(target: string): Redirect {
  return Object.freeze({ redirect: target });
}

/** Immutable route inputs supplied to one guard or departure check. */
export interface NavigationContext {
  /** A fresh URL copy; mutating it cannot alter the transaction's selected target. */
  readonly url: URL;
  /** Decoded route parameters, copied and frozen. */
  readonly params: RouteParams;
  /** Immutable query snapshot for this navigation intent. */
  readonly queryParams: ReadonlyQueryParams;
  /** Aborted when this intent is superseded or cancelled. */
  readonly signal: AbortSignal;
}

/** A client-safe referenced guard decides only admission or redirect. */
export type RouteGuard = (
  context: NavigationContext,
) => boolean | Redirect | PromiseLike<boolean | Redirect>;

/** An outgoing owner may veto the transition before any incoming tree is prepared. */
export type DepartureCheck = (context: NavigationContext) => boolean | PromiseLike<boolean>;

const departures = new WeakMap<Owner, Set<DepartureCheck>>();

/**
 * Register a component's departure interest; registration disappears with that owner.
 * @returns An idempotent function that removes this registration early.
 */
export function registerDeparture(owner: Owner, check: DepartureCheck): () => void {
  owner.assertActive();

  const checks = departures.get(owner) ?? new Set<DepartureCheck>();

  checks.add(check);

  departures.set(owner, checks);

  const remove = () => {
    checks.delete(check);
  };

  owner.onRelease(remove);

  return remove;
}

/** Inputs passed into a staged page; queryParams remains live for in-place query updates. */
export interface RouteInputs {
  /** Route parameters remain constant for the complete page lifetime. */
  readonly params: RouteParams;
  /** Explicit reactive read of the current immutable query snapshot. */
  readonly queryParams: Accessor<ReadonlyQueryParams>;
  /** Aborted when preparation is cancelled or the installed route is replaced or disposed. */
  readonly signal: AbortSignal;
}

/** @internal A rendering fault already presented by a route error boundary. */
export type { RouteRenderFailure, RouteRenderFailureReader } from "./navigation-outcome.ts";

/** Validated route candidate. Installation must be a synchronous authority swap. */
export interface PreparedRoute {
  /** Page and layout roots; identities retained by the next prepared route survive disposal. */
  readonly owners: readonly Owner[];
  /** Route content fault caught by a boundary, available after preparation and effects. */
  readonly renderFailure?: RouteRenderFailure;

  /**
   * Install the validated candidate, then enable its effects. Reconciliation
   * recovery may execute a fresh body after outgoing cleanup, using the inputs
   * captured during preparation. Installation must not perform asynchronous work.
   */
  install(options?: PreparedRouteInstallOptions): void;

  /**
   * Temporarily remove this route from reactive delivery while preserving its
   * owners, DOM objects, bindings, and local state for a later restoration.
   * The host may keep shared owners active when they are listed in preserving.
   */
  readonly park?: (preserving?: ReadonlySet<Owner>) => void;
  /** Resume a route retained by {@link park} without executing component bodies. */
  readonly restore?: (preserving?: ReadonlySet<Owner>) => void;
  /** Prepare retained route resources for the actual current head before restore. */
  readonly prepareRestore?: (signal?: AbortSignal) => void | PromiseLike<void>;
  /** Ensure the selected candidate composition is ready before synchronous install. */
  readonly prepareInstall?: (signal?: AbortSignal) => void | PromiseLike<void>;

  /** Release owned work while retaining any shared layout owners included in preserving. */
  dispose(reason?: unknown, preserving?: ReadonlySet<Owner>): void;

  /** Document title selected for terminal commit. */
  readonly title?: string;
  /** Document language selected for terminal commit. */
  readonly language?: string;
  /** Optional focus selector; otherwise use the primary main landmark or heading. */
  readonly focusTarget?: string;
  /** Explicit position to restore after commit; ordinary navigation starts at the top. */
  readonly scroll?: readonly [number, number];
  /** Optional text delivered to the configured live announcement sink. */
  readonly announcement?: string;
}

/** Internal installation controls used by the history page cache. */
export interface PreparedRouteInstallOptions {
  /** Outgoing owners that must remain alive for cancellation or history restore. */
  readonly preserving?: ReadonlySet<Owner>;
  /** Dispose the host's current candidate before installing this route. */
  readonly disposePrevious?: boolean;
}

/** Explicit matched candidate. Server loads cannot be represented by this browser interface. */
export interface RouteCandidate {
  /** Decoded parameters from matching the immutable target URL. */
  readonly params: RouteParams;
  /** Referenced client-safe guards in root-to-leaf route order. */
  readonly guards?: readonly RouteGuard[];
  /** Prepare matched modules and exact-head resources before final guard admission. */
  readonly preload?: (signal: AbortSignal) => void | PromiseLike<void>;
  /** Release preload resources not transferred into a retained prepared route. */
  readonly release?: () => void;
  /**
   * Optionally build the intermediate loading composition after admission and
   * departure checks. It has no terminal history metadata and does not replace
   * the candidate returned by {@link prepare}.
   */
  readonly prepareLoading?: (inputs: RouteInputs) => PreparedRoute | PromiseLike<PreparedRoute>;

  /** Build detached candidate work only after admission and departure have succeeded. */
  prepare(inputs: RouteInputs): PreparedRoute | PromiseLike<PreparedRoute>;

  /** Owners being left when persistent layout ownership is narrower than the previous page roots. */
  readonly departingOwners?: readonly Owner[];
}

/** History disposition is explicit at each navigation or query update. */
export interface NavigationOptions {
  /** Push a new entry, replace the current entry, or leave the current entry untouched. */
  readonly history: "push" | "replace" | "none";
  /** Platform history state, kept separate from page route inputs. */
  readonly state?: unknown;
}

/** Terminal navigation result; denied and cancelled intents never install. */
export interface NavigationResult {
  /** Whether the candidate installed, a guard or departure check vetoed it, or its intent was cancelled. */
  readonly status: "committed" | "denied" | "cancelled";
  /** Selected destination for commit or denial; original requested destination for cancellation. */
  readonly url: string;
}

/** Browser dependencies and candidate resolver for one navigation domain. */
export interface RouterOptions {
  /** Owning browser window. */
  readonly window: Window;

  /** Match and load client declarations without executing request-time server code. */
  resolve(url: URL, signal: AbortSignal): RouteCandidate | PromiseLike<RouteCandidate>;

  /** Optional live-region announcement sink, invoked only after terminal route commit. */
  readonly announce?: (message: string) => void;
  /** Handle errors from native link-triggered navigation; programmatic navigate still rejects. */
  readonly onError?: (error: unknown) => void;
  /** Maximum number of inactive page lifetimes retained for history restoration. */
  readonly pageCacheSize?: number;
}

interface Active {
  url: string;
  controller: AbortController;
  prepared: PreparedRoute;
  query: ReturnType<typeof createQueryParams>;
  state: unknown;
  entry: HistoryEntry | undefined;
  readonly candidate: RouteCandidate;
  readonly params: RouteParams;
  readonly keys: Set<number>;
  readonly park: () => void;
  readonly restore: () => void;
  readonly dispose: (reason?: unknown) => void;
}

function snapshotParams(params: RouteParams): RouteParams {
  return Object.freeze(
    Object.fromEntries(
      Object.entries(params).map(([name, value]) => [
        name,
        Array.isArray(value) ? Object.freeze([...value]) : value,
      ]),
    ),
  );
}

function browserHistoryEntry(entry: HistoryEntry): BrowserHistoryEntry {
  return {
    key: `hesperia-${entry.trackerId}-${entry.id}`,
    index: entry.position,
    url: entry.url,
    state: entry.state,
    position: entry.position,
    history: entry,
  };
}

/** Transactional browser navigation with explicit admission, departure, installation, and terminal phases. */
export class Router {
  private readonly options: RouterOptions;
  private readonly history: HistoryTracker;
  private readonly pageCache: PageCache<number, Active>;
  private readonly presentation: RoutePresentation;
  private readonly presentationSnapshots = new Map<number, PresentationSnapshot>();
  private historyNavigation: BrowserHistoryAdapter | undefined;
  private readonly historyObservers = new Set<NavigationHistoryObserver>();
  private pending: AbortController | undefined;
  private restoreAfterCancellation: AbortController | undefined;
  private active: Active | undefined;
  private disposed = false;
  private navigationRevision = 0;
  private readonly listeners = new Set<() => void>();

  /** Construct a router; the initial route is installed through navigate with replace history. */
  constructor(options: RouterOptions) {
    this.options = options;
    const limit = options.pageCacheSize ?? 5;

    if (!Number.isSafeInteger(limit) || limit < 0)
      throw new RenderFault(
        "navigation-cache",
        "pageCacheSize must be a non-negative safe integer",
      );

    this.pageCache = new PageCache(limit);
    this.history = installHistoryTracking(options.window);
    this.presentation = new RoutePresentation(options.window, options.announce);
    const removeHistoryObserver = this.history.observeNativeWrites((entry, disposition) => {
      if (this.disposed) return;

      if (this.active) {
        const activeUrl = new URL(this.active.url);
        const entryUrl = new URL(entry.url);

        if (activeUrl.origin === entryUrl.origin && activeUrl.pathname === entryUrl.pathname) {
          this.active.url = entry.url;
          this.active.state = entry.state;
          this.active.entry = entry;

          this.active.keys.add(entry.id);
        }
      }

      this.notifyHistoryCommitted(entry, disposition, false);
    });

    this.listeners.add(removeHistoryObserver);

    const invalidRoutes = new Set<string>();
    let invalidShared = false;

    const matchesInvalidRoute = (url: URL): boolean => {
      const routeId = developmentRouteId(this, url);
      return (
        url.origin === options.window.location.origin &&
        routeId !== undefined &&
        (invalidShared || invalidRoutes.has(routeId))
      );
    };

    this.listeners.add(installDevelopmentReloadCheck(options.window, matchesInvalidRoute));

    const sourceRemoval = (event: Event): void => {
      const detail = (event as CustomEvent<unknown>).detail;

      if (
        typeof detail !== "object" ||
        detail === null ||
        !("routeIds" in detail) ||
        !("reloadAll" in detail) ||
        !Array.isArray(detail.routeIds) ||
        detail.routeIds.some((id) => typeof id !== "string") ||
        typeof detail.reloadAll !== "boolean"
      )
        return;

      for (const id of detail.routeIds) invalidRoutes.add(id);

      invalidShared ||= detail.reloadAll;

      this.pageCache.deleteMatching(
        (page) => matchesInvalidRoute(new URL(page.url)),
        new RenderFault(
          "development-dependency-removed",
          "A development source dependency was removed",
        ),
      );

      if (this.active && matchesInvalidRoute(new URL(this.active.url))) {
        const request = new (
          options.window as Window & { CustomEvent: typeof CustomEvent }
        ).CustomEvent("hesperia:dev-hard-reload", {
          cancelable: true,
          detail: { sourceRemoval: true },
        });

        if (options.window.dispatchEvent(request)) options.window.location.reload();
      }
    };

    options.window.addEventListener("hesperia:dev-source-removal", sourceRemoval);

    this.listeners.add(() =>
      options.window.removeEventListener("hesperia:dev-source-removal", sourceRemoval),
    );
  }

  /** Latest committed URL; pending target URLs never replace this value. */
  get url(): string {
    return this.active?.url ?? this.options.window.location.href;
  }

  /** Author-supplied state from the latest committed history entry. */
  get state(): unknown {
    if (this.active) return this.active.state;

    const entry = this.history.read();
    return entry ? entry.state : this.options.window.history.state;
  }

  /**
   * Start a route transition, even when only query parameters differ. A hash-only
   * target keeps the active page lifetime and native nodes, runs its guards, and
   * applies the fragment's terminal focus and scroll behavior without departure
   * checks or route preparation.
   * A newer intent cancels pending work without waiting for its outstanding promises.
   * @returns The committed, denied, or cancelled outcome. Unexpected preparation, callback,
   * or platform errors reject the promise; an outgoing cleanup error can reject after commit.
   */
  async navigate(target: string | URL, options: NavigationOptions): Promise<NavigationResult> {
    return this.navigateCore(target, options);
  }

  /**
   * @internal Run a navigation commit or an admission-only document reload check.
   * The latter returns admission status without invoking `onCommit`; `onAdmitted` performs the
   * admitted browser reload synchronously before the router transaction releases its authority.
   */
  navigateWithCommit(
    target: string | URL,
    options: NavigationOptions,
    onCommit: (entry: BrowserHistoryEntry, readRenderFailure: RouteRenderFailureReader) => void,
    reloadAdmission?: {
      readonly applicationOwner?: Owner;
      readonly signal?: AbortSignal;
      readonly onAdmitted?: () => void;
    },
  ): Promise<NavigationResult> {
    return this.navigateCore(
      target,
      options,
      undefined,
      reloadAdmission?.signal,
      new Set(),
      undefined,
      (entry, readRenderFailure) =>
        onCommit(browserHistoryEntry(entry), readRenderFailure ?? (() => undefined)),
      options.history === "none",
      reloadAdmission,
    );
  }

  private async navigateCore(
    target: string | URL,
    options: NavigationOptions,
    historyOverride?: {
      readonly url: string;
      readonly entry: HistoryEntry | undefined;
      readonly state: unknown;
    },
    externalSignal?: AbortSignal,
    redirectTrail = new Set<string>(),
    deferPresentation?: (commit: () => void, readRenderFailure: RouteRenderFailureReader) => void,
    onHistoryCommit?: (entry: HistoryEntry, readRenderFailure?: RouteRenderFailureReader) => void,
    reload = false,
    reloadAdmission?: {
      readonly applicationOwner?: Owner;
      readonly signal?: AbortSignal;
      readonly onAdmitted?: () => void;
    },
  ): Promise<NavigationResult> {
    if (this.disposed) throw new RenderFault("disposed", "The router was disposed");

    this.restoreAfterCancellation = undefined;
    const revision = ++this.navigationRevision;
    const url = new URL(String(target), this.url);

    if (url.origin !== this.options.window.location.origin)
      throw new RenderFault("navigation-origin", "This router handles only same-origin navigation");

    if (!reload && !reloadAdmission && requiresDevelopmentReload(this.options.window, url)) {
      const detail: {
        sourceRemoval: true;
        target: string;
        history: NavigationOptions["history"];
        result?: { readonly committed: Promise<unknown> };
      } = { sourceRemoval: true, target: url.href, history: options.history };
      const request = new (
        this.options.window as Window & { CustomEvent: typeof CustomEvent }
      ).CustomEvent("hesperia:dev-hard-reload", {
        cancelable: true,
        detail,
      });

      if (this.options.window.dispatchEvent(request)) {
        if (url.href === this.options.window.location.href) this.options.window.location.reload();
        else this.options.window.location.assign(url.href);
      }

      if (detail.result) await detail.result.committed;

      return { status: "committed", url: url.href };
    }

    const override = historyOverride?.url === url.href ? historyOverride : undefined;
    const state = override
      ? override.state
      : Object.prototype.hasOwnProperty.call(options, "state")
        ? options.state
        : null;
    const history = { history: options.history, state: structuredClone(state) };

    this.pending?.abort(
      new RenderFault("navigation-superseded", "A newer navigation superseded this intent"),
    );

    const controller = new AbortController();
    const abortFromExternal = externalSignal
      ? () =>
          controller.abort(
            externalSignal.reason ??
              new RenderFault("navigation-superseded", "Browser traversal superseded"),
          )
      : undefined;

    if (externalSignal?.aborted) abortFromExternal?.();
    else externalSignal?.addEventListener("abort", abortFromExternal!, { once: true });

    this.pending = controller;
    let prepared: PreparedRoute | undefined;
    let loadingPrepared: PreparedRoute | undefined;
    let loadingInstalled = false;
    let parkedOutgoing: Active | undefined;
    let installed = false;
    let departureAdmitted = false;
    let candidateResources: RouteCandidate | undefined;
    let resolveCancelled!: () => void;
    const cancellation = new Promise<void>((resolve) => {
      resolveCancelled = resolve;
    });

    if (controller.signal.aborted) resolveCancelled();
    else controller.signal.addEventListener("abort", resolveCancelled, { once: true });

    const assertCurrent = () => {
      if (controller.signal.aborted || this.pending !== controller) throw controller.signal.reason;
    };

    const wait = async <T>(value: T | PromiseLike<T>): Promise<T> => {
      const outcome = await Promise.race([
        Promise.resolve(value).then((value) => ({ value })),
        cancellation.then(() => ({ cancelled: true as const })),
      ]);

      if (!installed) assertCurrent();

      return (outcome as { value: T }).value;
    };

    const present = (
      commit: () => void,
      readRenderFailure: RouteRenderFailureReader = () => undefined,
    ): void => {
      const guarded = () => {
        if (this.disposed || this.navigationRevision !== revision) return;

        commit();
      };

      if (deferPresentation) deferPresentation(guarded, readRenderFailure);
      else guarded();
    };

    try {
      if (reloadAdmission) {
        assertCurrent();

        const currentUrl = new URL(this.options.window.location.href);
        const contextParams = this.active?.params ?? snapshotParams({});
        const queryParams = readonlyQueryParams(currentUrl.search);

        const context = () =>
          Object.freeze({
            url: new URL(currentUrl.href),
            params: contextParams,
            queryParams,
            signal: controller.signal,
          });

        const checks = new Set<DepartureCheck>();

        const collect = (owner: Owner) => {
          if (owner.state !== "mounted") return;

          for (const check of departures.get(owner) ?? []) checks.add(check);

          for (const child of owner.children) collect(child);
        };

        const reloadOwners = [
          ...(reloadAdmission.applicationOwner ? [reloadAdmission.applicationOwner] : []),
          ...(this.active?.prepared.owners ?? []),
        ];

        for (const owner of reloadOwners) collect(owner);

        const outcomes = await wait(
          Promise.allSettled(
            [...checks].map(async (check) => {
              const decision = await check(context());

              if (decision !== true && decision !== false)
                throw new RenderFault(
                  "navigation-departure",
                  "A departure check must allow or veto",
                );

              return decision;
            }),
          ),
        );

        assertCurrent();

        const failure = outcomes.find((outcome) => outcome.status === "rejected");

        if (failure?.status === "rejected") throw failure.reason;

        if (outcomes.some((outcome) => outcome.status === "fulfilled" && !outcome.value))
          return { status: "denied", url: currentUrl.href };

        reloadAdmission.onAdmitted?.();

        departureAdmitted = true;
        return { status: "committed", url: currentUrl.href };
      }

      const interaction = this.presentation.begin();
      const destinationEntry =
        options.history === "none"
          ? override
            ? override.entry
            : this.history.read(url.href)
          : undefined;
      const activeUrl = this.active ? new URL(this.active.url) : undefined;
      const fragmentOnly =
        this.active !== undefined &&
        activeUrl !== undefined &&
        activeUrl.origin === url.origin &&
        activeUrl.pathname === url.pathname &&
        activeUrl.search === url.search &&
        activeUrl.hash !== url.hash;
      const queryOnly =
        this.active !== undefined &&
        activeUrl !== undefined &&
        activeUrl.origin === url.origin &&
        activeUrl.pathname === url.pathname &&
        activeUrl.search !== url.search &&
        activeUrl.hash === url.hash;
      const activeAlias = reload
        ? undefined
        : ((destinationEntry &&
          destinationEntry.url === url.href &&
          this.active?.keys.has(destinationEntry.id) &&
          new URL(this.active.url).pathname === url.pathname
            ? this.active
            : undefined) ??
          (!destinationEntry && (fragmentOnly || queryOnly) ? this.active : undefined));

      if (activeAlias && (destinationEntry || fragmentOnly || queryOnly)) {
        const previousEntry = activeAlias.entry;

        if (previousEntry)
          this.presentationSnapshots.set(previousEntry.id, this.presentation.capture());

        const params = activeAlias.params;
        const querySnapshot = readonlyQueryParams(url.search);

        const context = () =>
          Object.freeze({
            url: new URL(url.href),
            params,
            queryParams: querySnapshot,
            signal: controller.signal,
          });

        for (const guard of activeAlias.candidate.guards ?? []) {
          const decision = await wait(guard(context()));

          if (decision === false) return { status: "denied", url: url.href };

          if (decision !== true) {
            if (!decision || typeof decision.redirect !== "string")
              throw new RenderFault(
                "navigation-guard",
                "A guard must allow, deny, or return a redirect",
              );

            const redirected = new URL(decision.redirect, url.href);

            if (redirected.origin !== url.origin)
              throw new RenderFault(
                "navigation-origin",
                "A client route redirect must remain in this navigation domain",
              );

            if (redirectTrail.has(url.href))
              throw new RenderFault(
                "navigation-redirect-cycle",
                "Route guards formed a redirect cycle",
              );

            redirectTrail.add(url.href);

            return this.navigateCore(
              redirected,
              (fragmentOnly || queryOnly) && options.history !== "none"
                ? { history: options.history, state: history.state }
                : { history: "none", state: activeAlias.state },
              undefined,
              externalSignal,
              redirectTrail,
              deferPresentation,
              onHistoryCommit,
            );
          }
        }

        activeAlias.query.update(url.search);

        const inPlace = fragmentOnly || queryOnly;
        const nextEntry =
          inPlace && options.history !== "none"
            ? this.createHistoryEntry(url.href, history.state, history.history)
            : destinationEntry;
        const appliedEntry =
          inPlace && options.history !== "none" ? this.applyHistory(history, nextEntry) : nextEntry;
        activeAlias.url = url.href;
        activeAlias.state = appliedEntry ? appliedEntry.state : history.state;
        activeAlias.entry = appliedEntry;

        if (appliedEntry) activeAlias.keys.add(appliedEntry.id);

        this.active = activeAlias;
        this.pending = undefined;
        const fragmentTarget = fragmentOnly && url.hash !== "" && deferPresentation === undefined;
        const terminalRoute = fragmentTarget
          ? { ...activeAlias.prepared, focusTarget: undefined, scroll: undefined }
          : activeAlias.prepared;

        const readRenderFailure = () => activeAlias.prepared.renderFailure;

        if (fragmentOnly || destinationEntry !== undefined)
          present(
            () =>
              this.presentation.commit(
                terminalRoute,
                url.href,
                interaction,
                appliedEntry ? this.presentationSnapshots.get(appliedEntry.id) : undefined,
              ),
            readRenderFailure,
          );

        if (appliedEntry) {
          this.notifyHistoryCommitted(
            appliedEntry,
            history.history,
            destinationEntry === undefined,
          );

          onHistoryCommit?.(appliedEntry, readRenderFailure);
        }

        return { status: "committed", url: url.href };
      }

      const cached =
        destinationEntry && destinationEntry.url === url.href
          ? this.pageCache.get(destinationEntry.id)
          : undefined;

      if (cached) {
        const params = cached.params;
        const querySnapshot = readonlyQueryParams(url.search);

        const context = () =>
          Object.freeze({
            url: new URL(url.href),
            params,
            queryParams: querySnapshot,
            signal: controller.signal,
          });

        for (const guard of cached.candidate.guards ?? []) {
          const decision = await wait(guard(context()));

          if (decision === false) return { status: "denied", url: url.href };

          if (decision !== true) {
            if (!decision || typeof decision.redirect !== "string")
              throw new RenderFault(
                "navigation-guard",
                "A guard must allow, deny, or return a redirect",
              );

            const redirected = new URL(decision.redirect, url.href);

            if (redirected.origin !== url.origin)
              throw new RenderFault(
                "navigation-origin",
                "A client route redirect must remain in this navigation domain",
              );

            if (redirectTrail.has(url.href))
              throw new RenderFault(
                "navigation-redirect-cycle",
                "Route guards formed a redirect cycle",
              );

            redirectTrail.add(url.href);

            return this.navigateCore(
              redirected,
              { history: "none", state: cached.state },
              undefined,
              externalSignal,
              redirectTrail,
              deferPresentation,
              onHistoryCommit,
            );
          }
        }

        const checks = new Set<DepartureCheck>();

        const collect = (owner: Owner) => {
          for (const check of departures.get(owner) ?? []) checks.add(check);

          for (const child of owner.children) collect(child);
        };

        const currentOwners = this.active?.prepared.owners ?? [];
        const restoredOwners = new Set(cached.prepared.owners);

        for (const owner of currentOwners) {
          if (!restoredOwners.has(owner)) collect(owner);
        }

        const permitted = await wait(
          new Promise<boolean>((resolve, reject) => {
            let remaining = checks.size;

            if (!remaining) resolve(true);

            for (const check of checks) {
              Promise.resolve()
                .then(() => check(context()))
                .then((decision) => {
                  if (decision === false) resolve(false);
                  else if (decision !== true)
                    reject(
                      new RenderFault(
                        "navigation-departure",
                        "A departure check must allow or veto",
                      ),
                    );
                  else if (--remaining === 0) resolve(true);
                }, reject);
            }
          }),
        );

        if (!permitted) return { status: "denied", url: url.href };

        await wait(cached.prepared.prepareRestore?.(controller.signal));

        const previous = this.active;
        const previousSnapshot = previous?.entry ? this.presentation.capture() : undefined;
        let parkedPrevious = false;

        if (previous && previous !== cached) {
          parkedPrevious =
            previous.prepared.park !== undefined && previous.prepared.restore !== undefined;

          if (parkedPrevious) {
            const shared = new Set(
              previous.prepared.owners.filter((owner) => cached.prepared.owners.includes(owner)),
            );

            previous.prepared.park?.(shared);
          }
        }

        try {
          cached.prepared.restore?.(new Set(previous?.prepared.owners ?? []));
        } catch (error) {
          if (parkedPrevious) {
            try {
              previous!.prepared.restore?.();
            } catch (rollbackError) {
              throw new AggregateError(
                [error, rollbackError],
                "The cached route failed to restore and the outgoing route could not be restored",
              );
            }
          }

          throw error;
        }

        // Keep the destination in cache until its restore succeeds. The outgoing
        // route remains recoverable until then, even when it will not be cached.
        this.pageCache.release(cached);

        if (previous?.entry && previousSnapshot)
          this.presentationSnapshots.set(previous.entry.id, previousSnapshot);

        if (previous && previous !== cached) {
          const preserve =
            this.pageCache.limit > 0 &&
            parkedPrevious &&
            previous.prepared.park !== undefined &&
            previous.prepared.restore !== undefined;

          if (!preserve) {
            previous.controller.abort(
              new RenderFault("navigation-replaced", "The route was replaced"),
            );

            previous.prepared.dispose(previous.controller.signal.reason);
          }

          if (preserve && previous.entry) {
            this.pageCache.add(previous.entry.id, previous);

            for (const key of previous.keys) this.pageCache.alias(key, previous);
          }
        }

        cached.query.update(url.search);

        cached.url = url.href;
        cached.state = destinationEntry!.state;
        cached.entry = destinationEntry!;
        this.active = cached;
        this.pending = undefined;

        present(
          () =>
            this.presentation.commit(
              cached.prepared,
              url.href,
              interaction,
              this.presentationSnapshots.get(destinationEntry!.id),
            ),
          () => cached.prepared.renderFailure,
        );

        return { status: "committed", url: url.href };
      }

      const redirects = redirectTrail;
      let selected = url.href;
      let candidate!: RouteCandidate;
      let params!: RouteParams;
      let context!: () => NavigationContext;

      while (true) {
        if (redirects.has(selected))
          throw new RenderFault(
            "navigation-redirect-cycle",
            "Route guards formed a redirect cycle",
          );

        redirects.add(selected);

        candidate = await wait(this.options.resolve(new URL(selected), controller.signal));
        candidateResources = candidate;

        await wait(candidate.preload?.(controller.signal));

        params = snapshotParams(candidate.params);
        const query = readonlyQueryParams(new URL(selected).search);
        context = () =>
          Object.freeze({
            url: new URL(selected),
            params,
            queryParams: query,
            signal: controller.signal,
          });
        let redirected: string | undefined;
        const guards = [...(candidate.guards ?? [])];

        for (const guard of guards) {
          const decision = await wait(guard(context()));

          if (decision === false) return { status: "denied", url: selected };

          if (decision === true) continue;

          if (!decision || typeof decision.redirect !== "string")
            throw new RenderFault(
              "navigation-guard",
              "A guard must allow, deny, or return a redirect",
            );

          const next = new URL(decision.redirect, selected);

          if (next.origin !== url.origin)
            throw new RenderFault(
              "navigation-origin",
              "A client route redirect must remain in this navigation domain",
            );

          redirected = next.href;
          break;
        }

        if (!redirected) break;

        candidate.release?.();

        candidateResources = undefined;
        selected = redirected;
      }

      const checks = new Set<DepartureCheck>();

      const collect = (owner: Owner) => {
        for (const check of departures.get(owner) ?? []) checks.add(check);

        for (const child of owner.children) collect(child);
      };

      for (const owner of candidate.departingOwners ?? this.active?.prepared.owners ?? [])
        collect(owner);

      const permitted = await wait(
        new Promise<boolean>((resolve, reject) => {
          let remaining = checks.size;

          if (!remaining) resolve(true);

          for (const check of checks) {
            Promise.resolve()
              .then(() => check(context()))
              .then((decision) => {
                if (decision === false) resolve(false);
                else if (decision !== true)
                  reject(
                    new RenderFault("navigation-departure", "A departure check must allow or veto"),
                  );
                else if (--remaining === 0) resolve(true);
              }, reject);
          }
        }),
      );

      if (!permitted) return { status: "denied", url: selected };

      const outgoingSnapshot = this.active ? this.presentation.capture() : undefined;
      let queryOwners: readonly Owner[] = [];
      const query = createQueryParams(new URL(selected).search, controller.signal, () =>
        queryOwners.some((owner) => owner.state === "cleaning"),
      );

      if (candidate.prepareLoading) {
        loadingPrepared = await wait(
          Promise.resolve(
            candidate.prepareLoading(
              Object.freeze({ params, queryParams: query.read, signal: controller.signal }),
            ),
          ),
        );
        const outgoing = this.active;
        parkedOutgoing = outgoing;
        const shared = outgoing
          ? new Set(
              outgoing.prepared.owners.filter((owner) => loadingPrepared!.owners.includes(owner)),
            )
          : undefined;

        outgoing?.prepared.park?.(shared);

        try {
          loadingPrepared.install(outgoing ? { preserving: shared } : undefined);

          loadingInstalled = true;
        } catch (error) {
          outgoing?.prepared.restore?.();

          throw error;
        }
      }

      const preparation = Promise.resolve(
        candidate.prepare(
          Object.freeze({ params, queryParams: query.read, signal: controller.signal }),
        ),
      );

      void preparation.then(
        (result) => {
          queryOwners = result.owners;

          if (controller.signal.aborted) result.dispose(controller.signal.reason);
        },
        () => undefined,
      );

      prepared = await wait(preparation);

      assertCurrent();

      const committed = prepared;

      if (committed.focusTarget) this.options.window.document.querySelector(committed.focusTarget);

      const previous = this.active;
      const destinationOverride = override && selected === url.href ? override : undefined;
      const committedEntry = destinationOverride
        ? destinationOverride.entry
        : this.createHistoryEntry(selected, history.state, history.history);
      const replacingCurrent =
        (history.history === "replace" || reload) &&
        previous?.entry !== undefined &&
        committedEntry?.id === previous.entry.id;
      const retainedPreviousKeys = previous
        ? [...previous.keys].filter((key) => !replacingCurrent || key !== committedEntry?.id)
        : [];

      if (replacingCurrent && previous && committedEntry) previous.keys.delete(committedEntry.id);

      const preservePrevious =
        this.pageCache.limit > 0 &&
        previous?.entry !== undefined &&
        previous.prepared.park !== undefined &&
        previous.prepared.restore !== undefined &&
        retainedPreviousKeys.length > 0;

      if (previous?.entry && outgoingSnapshot)
        this.presentationSnapshots.set(previous.entry.id, outgoingSnapshot);

      if (preservePrevious && previous) {
        parkedOutgoing = previous;

        previous.prepared.park?.(
          new Set(previous.prepared.owners.filter((owner) => committed.owners.includes(owner))),
        );
      }

      await wait(committed.prepareInstall?.(controller.signal));

      committed.install(
        preservePrevious && previous
          ? {
              preserving: new Set(
                previous.prepared.owners.filter((owner) => committed.owners.includes(owner)),
              ),
              disposePrevious: loadingInstalled,
            }
          : undefined,
      );

      installed = true;
      parkedOutgoing = undefined;
      const nextActive: Active = {
        url: selected,
        controller,
        prepared: committed,
        query,
        state: committedEntry
          ? committedEntry.state
          : destinationOverride
            ? destinationOverride.state
            : history.state,
        entry: committedEntry,
        candidate,
        params,
        keys: new Set(committedEntry ? [committedEntry.id] : []),
        park: () => committed.park?.(),
        restore: () => committed.restore?.(),
        dispose: (reason) => {
          controller.abort(reason);

          committed.dispose(reason);
        },
      };
      this.active = nextActive;
      this.pending = undefined;
      let cleanupError: unknown;

      if (previous) {
        if (preservePrevious && previous.entry) {
          try {
            const [first, ...aliases] = retainedPreviousKeys;

            this.pageCache.add(first!, previous);

            for (const key of aliases) this.pageCache.alias(key, previous);
          } catch (error) {
            cleanupError = error;
          }
        } else {
          previous.controller.abort(
            new RenderFault("navigation-replaced", "The route was replaced"),
          );

          try {
            previous.prepared.dispose(previous.controller.signal.reason, new Set(committed.owners));
          } catch (error) {
            cleanupError = error;
          }
        }
      }

      const appliedEntry = destinationOverride
        ? committedEntry
        : this.applyHistory(history, committedEntry);

      if (appliedEntry && this.active) {
        this.active.entry = appliedEntry;
        this.active.state = appliedEntry.state;
      }

      const restoringHistory =
        destinationOverride !== undefined ||
        (options.history === "none" && this.options.window.location.href === selected);
      const restoration =
        restoringHistory && committedEntry
          ? this.presentationSnapshots.get(committedEntry.id)
          : undefined;

      const readRenderFailure = () => committed.renderFailure;

      present(
        () => this.presentation.commit(committed, selected, interaction, restoration),
        readRenderFailure,
      );

      if (appliedEntry) {
        this.notifyHistoryCommitted(
          appliedEntry,
          history.history,
          destinationOverride === undefined,
        );

        onHistoryCommit?.(appliedEntry, readRenderFailure);
      }

      if (cleanupError !== undefined) throw cleanupError;

      return { status: "committed", url: selected };
    } catch (error) {
      if (controller.signal.aborted && !installed) return { status: "cancelled", url: url.href };

      throw error;
    } finally {
      const shouldRestoreAfterCancellation = this.restoreAfterCancellation === controller;
      const stillCurrent =
        !this.disposed &&
        (shouldRestoreAfterCancellation ||
          (this.pending === controller && this.navigationRevision === revision));

      if (shouldRestoreAfterCancellation) this.restoreAfterCancellation = undefined;

      controller.signal.removeEventListener("abort", resolveCancelled);

      if (abortFromExternal) externalSignal?.removeEventListener("abort", abortFromExternal);

      candidateResources?.release?.();

      if (this.pending === controller) this.pending = undefined;

      if (!installed && !departureAdmitted) {
        controller.abort(new RenderFault("navigation-cancelled", "The candidate did not commit"));

        prepared?.dispose(controller.signal.reason);

        if (loadingInstalled) {
          loadingPrepared?.dispose(controller.signal.reason);
        }

        // A superseded transaction may have parked a route that is no longer
        // active. Restoring it after the newer commit resumes observers against
        // detached DOM ranges and can move nodes through a null parent.
        if (stillCurrent) parkedOutgoing?.prepared.restore?.();
      }
    }
  }

  private async navigateFromHistory(
    entry: BrowserHistoryEntry,
    signal: AbortSignal,
  ): Promise<{
    status: "committed" | "denied" | "cancelled";
    url: string;
    afterCommit?: () => void;
    readRenderFailure?: RouteRenderFailureReader;
  }> {
    if (signal.aborted) return { status: "cancelled", url: entry.url };

    const tracked =
      entry.history ??
      this.history.read(entry.url, entry.state) ??
      (entry.key.startsWith("hesperia-") ? this.history.read(entry.url) : undefined);
    const override = {
      url: entry.url,
      entry: tracked,
      state: tracked ? tracked.state : entry.state,
    };
    let afterCommit: (() => void) | undefined;
    let readRenderFailure: RouteRenderFailureReader | undefined;

    try {
      const result = await this.navigateCore(
        entry.url,
        { history: "none", state: override.state },
        override,
        signal,
        new Set<string>(),
        (commit, readFailure) => {
          afterCommit = commit;
          readRenderFailure = readFailure;
        },
      );
      return { ...result, afterCommit, readRenderFailure };
    } catch (error) {
      if (signal.aborted) return { status: "cancelled", url: entry.url };

      throw error;
    }
  }

  /** @internal Handle an admitted same-document Navigation API event. */
  async handleNavigationEvent(
    event: NavigateEvent,
    afterCommit: (commit: () => void, readRenderFailure?: RouteRenderFailureReader) => void,
  ): Promise<{
    readonly status: "committed" | "denied" | "cancelled";
    readonly url: string;
    readonly reason?: unknown;
  }> {
    const destination = event.destination;

    if (destination.url === null)
      return { status: "cancelled", url: this.options.window.location.href };

    const result = await this.navigateFromHistory(
      {
        key: destination.key,
        index: destination.index,
        url: destination.url,
        state: destination.getState(),
      },
      event.signal,
    );

    if (result.afterCommit) afterCommit(() => result.afterCommit?.(), result.readRenderFailure);

    return {
      status: result.status,
      url: result.url,
    };
  }

  /** @internal Connect the History-based Navigation facade to committed Router outcomes. */
  observeHistory(observer: NavigationHistoryObserver): () => void {
    if (this.disposed) throw new RenderFault("disposed", "The router was disposed");

    this.historyObservers.add(observer);

    const remove = () => {
      this.historyObservers.delete(observer);

      this.listeners.delete(remove);
    };

    this.listeners.add(remove);

    return remove;
  }

  private notifyHistoryCommitted(
    entry: HistoryEntry,
    disposition: "push" | "replace" | "none",
    reportRouteCommit = true,
  ): void {
    const browserEntry = browserHistoryEntry(entry);

    this.historyNavigation?.notifyCommitted(browserEntry);

    if (reportRouteCommit)
      for (const observer of this.historyObservers)
        observer.entryCommitted(browserEntry, disposition);
  }

  /** @internal Install Back/Forward handling after generated startup has committed its first route. */
  installHistoryNavigation(mountPath = "/"): () => void {
    if (this.disposed) throw new RenderFault("disposed", "The router was disposed");

    if (this.historyNavigation) return () => this.historyNavigation?.dispose();

    const normalizedMount = normalizeMountPath(mountPath);
    const adapter = installBrowserHistory({
      window: this.options.window,
      canNavigate: (entry, event) => {
        const target = new URL(entry.url, this.options.window.location.href);

        if (requiresDevelopmentReload(this.options.window, target)) return false;

        if (event.navigationType !== "traverse") return true;

        return (
          target.origin === this.options.window.location.origin &&
          isWithinMount(target.pathname, normalizedMount)
        );
      },
      readEntry: (url) => {
        const entry = this.history.read(url);
        return entry ? browserHistoryEntry(entry) : undefined;
      },
      onTraverse: (entry, signal) => this.navigateFromHistory(entry, signal),
      onTraversalAccepted: (entry) => {
        for (const observer of this.historyObservers) observer.traversalAccepted(entry);
      },
      onCommit: (entry, result) => {
        this.historyNavigation?.notifyCommitted(entry);

        for (const observer of this.historyObservers)
          observer.traversalCommitted(entry, result?.readRenderFailure);
      },
      onTraversalRejected: (entry, error) => {
        for (const observer of this.historyObservers) observer.traversalRejected(entry, error);
      },
      onError: this.options.onError,
    });
    this.historyNavigation = adapter;

    const remove = () => {
      if (this.historyNavigation === adapter) {
        this.historyNavigation = undefined;

        adapter.dispose();
      }

      this.listeners.delete(remove);
    };

    this.listeners.add(remove);

    return remove;
  }

  /**
   * Merge one query key in place, retaining page owners and applying only the requested history change.
   * A string replaces the key's values, an array preserves its supplied value order, and null removes it.
   * This cancels pending navigation and publishes a new immutable query snapshot to the active page.
   */
  updateQuery(
    name: string,
    value: string | readonly string[] | null,
    options: NavigationOptions,
  ): void {
    if (!this.active || this.disposed)
      throw new RenderFault("navigation-inactive", "Query updates require an active route");

    this.navigationRevision++;
    this.restoreAfterCancellation = this.pending;

    this.pending?.abort(
      new RenderFault("navigation-superseded", "A query update superseded the pending navigation"),
    );

    const url = new URL(this.active.url);

    url.searchParams.delete(name);

    if (typeof value === "string") url.searchParams.append(name, value);
    else if (value) for (const item of value) url.searchParams.append(name, item);

    const suppliedState = Object.prototype.hasOwnProperty.call(options, "state")
      ? options.state
      : null;

    if (this.active.entry)
      this.presentationSnapshots.set(this.active.entry.id, this.presentation.capture());

    const state = structuredClone(suppliedState);
    const entry = this.createHistoryEntry(url.href, state, options.history);

    this.applyHistory(options, entry);

    this.active.url = url.href;
    this.active.state = entry ? entry.state : state;
    this.active.entry = entry;

    if (entry) this.active.keys.add(entry.id);

    this.active.query.update(url.search);

    if (entry) this.notifyHistoryCommitted(entry, options.history);
  }

  /**
   * Intercept ordinary same-origin primary-button links while preserving native modified, download, and other-target behavior.
   * @returns An idempotent listener removal function. Disposing the router also removes the listener.
   */
  listenToLinks(mountPath = "/"): () => void {
    if (this.disposed) throw new RenderFault("disposed", "The router was disposed");

    const normalizedMount = normalizeMountPath(mountPath);
    const document = this.options.window.document;

    const listener = (event: MouseEvent) => {
      if (
        event.defaultPrevented ||
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey
      )
        return;

      const anchor = event
        .composedPath()
        .find(
          (node) =>
            typeof node === "object" &&
            node !== null &&
            "nodeType" in node &&
            node.nodeType === 1 &&
            "localName" in node &&
            node.localName === "a",
        ) as HTMLAnchorElement | undefined;

      if (!anchor || !anchor.hasAttribute("href") || anchor.hasAttribute("download")) return;

      const target =
        anchor.getAttribute("target") ??
        document.querySelector("base[target]")?.getAttribute("target");

      if (target && target.toLowerCase() !== "_self") return;

      let url: URL;

      try {
        url = new URL(anchor.getAttribute("href")!, anchor.baseURI);
      } catch {
        return;
      }

      if (
        url.origin !== this.options.window.location.origin ||
        (url.protocol !== "http:" && url.protocol !== "https:")
      )
        return;

      if (!isWithinMount(url.pathname, normalizedMount)) return;

      if (url.href === this.options.window.location.href && url.href.includes("#")) return;

      event.preventDefault();

      void this.navigate(url, { history: "push" }).catch((error: unknown) => {
        if (this.options.onError) this.options.onError(error);
        else
          queueMicrotask(() => {
            throw error;
          });
      });
    };

    document.addEventListener("click", listener);

    const remove = () => {
      document.removeEventListener("click", listener);

      this.listeners.delete(remove);
    };

    this.listeners.add(remove);

    return remove;
  }

  /** Cancel only pending navigation, preserving the committed page and its history entry. */
  cancel(reason: unknown = new RenderFault("navigation-cancelled", "Navigation cancelled")): void {
    this.navigationRevision++;
    this.restoreAfterCancellation = this.pending;

    this.pending?.abort(reason);
  }

  /** Cancel pending intent and release the committed route exactly once. */
  dispose(reason: unknown = new RenderFault("disposed", "Router disposed")): void {
    if (this.disposed) return;

    this.disposed = true;
    this.navigationRevision++;
    this.restoreAfterCancellation = undefined;

    for (const remove of this.listeners) remove();

    this.presentation.dispose();

    this.pending?.abort(reason);

    this.historyNavigation?.dispose();

    this.historyNavigation = undefined;

    this.presentationSnapshots.clear();

    this.active?.controller.abort(reason);

    const active = this.active;
    this.active = undefined;
    const cleanupErrors: unknown[] = [];

    try {
      try {
        active?.prepared.dispose(reason);
      } catch (error) {
        cleanupErrors.push(error);
      }

      try {
        this.pageCache.clear(reason);
      } catch (error) {
        cleanupErrors.push(error);
      }
    } finally {
      try {
        this.history.release();
      } catch (error) {
        cleanupErrors.push(error);
      }
    }

    if (cleanupErrors.length === 1) throw cleanupErrors[0];

    if (cleanupErrors.length > 1) throw new AggregateError(cleanupErrors, "Router disposal failed");
  }

  private createHistoryEntry(
    url: string,
    state: unknown,
    disposition: NavigationOptions["history"],
  ): HistoryEntry | undefined {
    return this.history.create(url, state, disposition);
  }

  private applyHistory(
    options: NavigationOptions,
    entry: HistoryEntry | undefined,
  ): HistoryEntry | undefined {
    if (!entry) return undefined;

    return this.history.apply(entry, options.history);
  }
}
