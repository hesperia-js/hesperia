import { signal } from "aeolia";
import {
  dynamic,
  canPublishComponentExcept,
  defineComponent,
  instantiateComponent,
  prepareComponent,
  publishComponent,
  type CallerProps,
  type Component,
  type ComponentInstance,
  type PreparedComponent,
} from "../runtime/components.ts";
import { child, component, prepareTree, type Rendered, type RuntimeRoot } from "../runtime/dom.ts";
import { asyncBoundary } from "../runtime/async.ts";
import { errorBoundary } from "../runtime/error-boundary.ts";
import { Owner, RenderFault, reportFault } from "../runtime/owner.ts";
import type { PreparedRoute, PreparedRouteInstallOptions, RouteInputs } from "./navigation.ts";

/** Internal component declaration paired with the scanner node that owns it. */
export interface RouteHostModule {
  /** Stable scanner node identity. */
  readonly node: object;
  /** Compiled browser component definition. */
  readonly definition: Component<unknown>;
  /** Nearest conventional error view, if this layer owns one. */
  readonly error?: Component<unknown>;
  /** Implicit waiting view for a filesystem page with asynchronous descendants. */
  readonly loading?: Component<unknown>;
  /** Map route inputs into the declaration's caller props. */
  readonly props?: (inputs: RouteInputs) => Record<string, unknown>;
}

/** One internal filesystem match assembled for a route-host transaction. */
export interface RouteHostRoute {
  /** Layout declarations in root-to-leaf order. */
  readonly layouts: readonly RouteHostModule[];
  /** Leaf page declaration. */
  readonly page: RouteHostModule;
  /** Inputs captured by the Router for this candidate. */
  readonly inputs: RouteInputs;
}

interface PreparedPart {
  readonly owner: Owner;
  readonly instance: ComponentInstance;
  readonly tree: Pick<ReturnType<typeof prepareTree>, "fragment">;
  readonly children?: DocumentFragment;
  /** Actual content lifetime used for descendant route ownership. */
  readonly contentOwner: Owner;
  readonly handledFailure: boolean;
  /** Mutable marker shared with the retained route entry after preparation. */
  readonly failureState: { handled: boolean };
  readonly ready?: Promise<void>;
}

/** Structural owner for a conventional error boundary without a layout file. */
export const boundarySlot = defineComponent<{ children: Rendered }>(
  (owner, props) => child(owner, props.children),
  { props: { children: { kind: "value", optional: false } } },
);

interface Layer extends PreparedPart {
  readonly module: RouteHostModule;
}

interface Candidate {
  readonly route: RouteHostRoute;
  common: readonly Layer[];
  commonProps: readonly PreparedComponent[];
  layerProps: readonly PreparedComponent[];
  layers: Layer[];
  childValues: readonly DocumentFragment[];
  page?: PreparedPart;
  staged: Owner[];
  root: DocumentFragment;
  readonly abort: () => void;
  build?: () => void;
  readonly recovery: boolean;
  ready?: Promise<void>;
  installed: boolean;
  parked: boolean;
  parkedParent: Owner | null | undefined;
  parkedRoot: Owner | undefined;
  disposed: boolean;
  park?: (preserving?: ReadonlySet<Owner>) => void;
  restore?: (preserving?: ReadonlySet<Owner>) => void;
}

function moduleProps(
  module: RouteHostModule,
  inputs: RouteInputs,
  children?: DocumentFragment,
): CallerProps<unknown> {
  const props = { ...module.props?.(inputs) };
  if (children !== undefined) props.children = dynamic(() => children);
  return props as CallerProps<unknown>;
}

function preparedWithChildren(
  prepared: PreparedComponent,
  children: DocumentFragment,
): PreparedComponent {
  const entries = prepared.entries.map(([name, value]) =>
    name === "children"
      ? Object.freeze([name, children] as const)
      : Object.freeze([name, value] as const),
  );
  return {
    definition: prepared.definition,
    entries: Object.freeze(entries),
    schema: prepared.schema,
  };
}

/**
 * Give a filesystem page with +loading a real component lifetime. The
 * generated wrapper owns the waiting boundary while its region owns the page
 * occurrence, so route prop publication still reaches the retained wrapper
 * without executing the page body a second time.
 */
function asyncRouteDefinition(
  prepared: PreparedComponent,
  loading: Component<unknown>,
  onReady: (ready: Promise<void>) => void,
): Component<unknown> {
  const schema = Object.fromEntries(prepared.schema);
  return defineComponent(
    (owner, props) => {
      const incoming = Object.fromEntries(
        prepared.entries.map(([name]) => {
          const value = (props as Record<string, unknown>)[name];
          const slot = prepared.schema.get(name);
          return [
            name,
            slot?.kind === "value" && typeof value === "function"
              ? dynamic(() => (value as () => unknown)())
              : value,
          ];
        }),
      );
      return asyncBoundary(
        owner,
        "filesystem-loading",
        (loadingOwner) => {
          const loadingInstance = instantiateComponent(
            loadingOwner,
            prepareComponent(loading, {} as never),
          );
          if (loadingInstance.output instanceof Promise) {
            void loadingInstance.output.catch(() => undefined);
            throw new RenderFault(
              "route-async",
              "Filesystem loading views cannot be async without an enclosing boundary",
            );
          }
          return loadingInstance.output;
        },
        (contentOwner) =>
          component(contentOwner, prepared.definition, incoming as never, "filesystem-page"),
        onReady,
      );
    },
    { props: schema },
  );
}

function instantiatePart(
  owner: Owner,
  prepared: PreparedComponent,
  children?: DocumentFragment,
  module?: RouteHostModule,
): PreparedPart {
  let instance!: ComponentInstance;
  let contentOwner = owner;
  let handledFailure = false;
  const failureState = { handled: false };
  let ready: Promise<void> | undefined;
  const activePrepared = module?.loading
    ? prepareComponent(
        asyncRouteDefinition(prepared, module.loading, (value) => {
          ready = value;
        }),
        Object.fromEntries(prepared.entries) as never,
      )
    : prepared;
  const incoming = () =>
    children === undefined ? activePrepared : preparedWithChildren(activePrepared, children);
  const content = (nextOwner: Owner): Rendered => {
    contentOwner = nextOwner;
    nextOwner.deferStructural = owner.deferStructural;
    instance = instantiateComponent(nextOwner, incoming());
    if (instance.output instanceof Promise) {
      void instance.output.catch(() => undefined);
      throw new RenderFault(
        "route-async",
        "Filesystem route components need an async boundary before route-host preparation",
      );
    }
    return instance.output;
  };
  const body = content;
  const output = module?.error
    ? errorBoundary(
        owner,
        "filesystem-error",
        (viewOwner, readError) => {
          const fallback = instantiateComponent(
            viewOwner,
            prepareComponent(module.error!, { error: readError() } as never),
          );
          if (fallback.output instanceof Promise) {
            void fallback.output.catch(() => undefined);
            throw new RenderFault(
              "route-async",
              "Filesystem error views cannot be async without an enclosing boundary",
            );
          }
          return fallback.output;
        },
        body,
        () => {
          handledFailure = true;
          failureState.handled = true;
        },
      )
    : body(owner);
  if (owner.state === "destroyed" || owner.state === "cleaning") {
    return {
      owner,
      tree: { fragment: runtimeDocument(owner) },
      instance,
      children,
      contentOwner,
      handledFailure: true,
      failureState: { handled: true },
      ready,
    };
  }
  const tree = prepareTree(owner, () => output);
  return { owner, tree, instance, children, contentOwner, handledFailure, failureState, ready };
}

function runtimeDocument(owner: Owner): DocumentFragment {
  return owner.context.document.createDocumentFragment();
}

function ownerIdentity(kind: "layout" | "page", index: number): string {
  return `route-${kind}:${index}`;
}

/** Internal persistent filesystem composition host used by Router candidates. */
export interface RouteHost {
  /** Stable outlet fragment containing the host's comment range. */
  readonly outlet: DocumentFragment;
  /** Stage a route while the current composition remains connected and active. */
  prepare(route: RouteHostRoute): PreparedRoute;
  /**
   * Owners whose departure checks should run for a proposed layout chain.
   * Retained common layouts are excluded; their descendants remain eligible.
   */
  departingOwners(layouts: readonly RouteHostModule[]): readonly Owner[];
  /** Release the active composition without disposing the caller-owned runtime root. */
  dispose(reason?: unknown): void;
}

/**
 * Create a route composition host over one mounted runtime root.
 *
 * Preparation creates owners and DOM in detached fragments. A candidate owns
 * only its new suffix and page; common layout owners remain active until the
 * candidate commits. If a retained instance fails its publication check,
 * preparation captures the replacement inputs but defers that suffix's body
 * until installation. Installation first disposes the old suffix (thereby
 * running outgoing cleanup before its nodes leave the document), then builds
 * the deferred replacement, publishes the new outlet value, commits the staged
 * owners, and finally enables effects.
 * Filesystem loading/error assembly wraps asynchronous page occurrences before
 * this host installs them; its internal readiness handle keeps terminal route
 * publication behind the boundary while the loading composition is visible.
 */
export function createRouteHost(runtime: RuntimeRoot, target: Node): RouteHost {
  const hostOwner = new Owner(runtime.context, runtime.owner, "route-host");
  const rootOutput = signal<Rendered>(null);
  const rootFragment = child(hostOwner, () => rootOutput.get());
  let connected = false;
  // Install the tracked outlet before the shell is mounted. A startup shell may
  // consume this fragment into its own detached tree; the comment range keeps
  // routing output stable when that tree is later installed.
  const outletStart = rootFragment.firstChild;
  target.appendChild(rootFragment);
  connected = outletStart !== null && outletStart !== undefined && outletStart.parentNode !== null;
  let active: Candidate | undefined;
  let disposed = false;
  let revision = 0;
  const candidates = new Set<Candidate>();
  hostOwner.onRelease(() => {
    disposed = true;
    for (const candidate of candidates) {
      candidate.abort();
      candidate.disposed = true;
    }
    candidates.clear();
    active = undefined;
  });

  const disposeStaged = (candidate: Candidate, reason: unknown): void => {
    const root = candidate.staged[0];
    if (root) root.dispose(reason);
  };

  const disposeInstalled = (candidate: Candidate, reason: unknown, firstLayer = 0): void => {
    if (candidate.parked && candidate.parkedRoot) {
      candidate.parkedRoot.dispose(reason);
      return;
    }
    const root = candidate.layers[firstLayer]?.owner ?? candidate.page?.owner;
    if (!root) return;
    root.dispose(reason);
  };

  const disposeCandidate = (candidate: Candidate, reason: unknown): void => {
    if (candidate.disposed) return;
    candidate.disposed = true;
    candidate.abort();
    candidates.delete(candidate);
    if (candidate.installed) {
      disposeInstalled(candidate, reason);
      if (active === candidate) {
        active = undefined;
        revision++;
      }
      return;
    }
    disposeStaged(candidate, reason);
  };

  const departingOwners = (layouts: readonly RouteHostModule[]): readonly Owner[] => {
    if (!active) return [];
    let common = 0;
    while (
      common < layouts.length &&
      common < active.layers.length &&
      layouts[common]!.node === active.layers[common]!.module.node &&
      layouts[common]!.definition === active.layers[common]!.module.definition
    )
      common++;
    return Object.freeze(
      [active.layers[common]?.owner ?? active.page?.owner].filter(Boolean) as Owner[],
    );
  };

  const prepare = (route: RouteHostRoute): PreparedRoute => {
    if (disposed || hostOwner.state === "cleaning" || hostOwner.state === "destroyed")
      throw new RenderFault("disposed", "The route host runtime has been disposed");
    if (route.inputs.signal.aborted) throw route.inputs.signal.reason;
    const previous = active;
    const preparedRevision = revision;
    const identityCommon: Layer[] = [];
    const failedLayer =
      previous?.layers.findIndex(
        (layer) =>
          layer.failureState.handled ||
          layer.owner.state === "cleaning" ||
          layer.owner.state === "destroyed",
      ) ?? -1;
    for (let index = 0; index < route.layouts.length; index++) {
      if (index >= failedLayer && failedLayer >= 0) break;
      const old = previous?.layers[index];
      const next = route.layouts[index];
      if (
        !old ||
        !next ||
        old.instance.owner.state === "cleaning" ||
        old.instance.owner.state === "destroyed" ||
        old.module.node !== next.node ||
        old.module.definition !== next.definition ||
        old.module.error !== next.error
      )
        break;
      identityCommon.push({ ...old, module: next });
    }
    const emptyChildren = runtime.context.document.createDocumentFragment();
    const layoutPrepared = route.layouts.map((module) =>
      prepareComponent(module.definition, moduleProps(module, route.inputs, emptyChildren)),
    );
    const pagePrepared = prepareComponent(
      route.page.definition,
      moduleProps(route.page, route.inputs),
    );
    let commonCount = identityCommon.length;
    for (let index = 0; index < identityCommon.length; index++) {
      if (
        !canPublishComponentExcept(
          identityCommon[index]!.instance,
          layoutPrepared[index]!,
          new Set(["children"]),
        )
      ) {
        commonCount = index;
        break;
      }
    }
    const common = identityCommon.slice(0, commonCount);
    const suffixModules = route.layouts.slice(commonCount);
    const staged: Owner[] = [];
    try {
      let page: PreparedPart | undefined;
      let childValue = runtime.context.document.createDocumentFragment();
      let suffixLayers: Layer[] = [];
      let built = false;
      let abort: () => void = () => undefined;
      const candidate: Candidate = {
        route,
        common,
        commonProps: [],
        layerProps: [],
        layers: [...common],
        childValues: [],
        page: undefined,
        staged,
        root: childValue,
        abort: () => abort(),
        recovery: commonCount < identityCommon.length,
        installed: false,
        parked: false,
        parkedParent: undefined,
        parkedRoot: undefined,
        disposed: false,
      };
      const build = (): void => {
        if (built) return;
        // Materialize component bodies from the retained parent boundary toward
        // the page. DOM fragments are assembled afterwards, so a failing layout
        // body cannot execute or commit an invisible descendant page body.
        const suffixChildOutlets: DocumentFragment[] = [];
        const suffixParts: PreparedPart[] = [];
        let parent = common.at(-1)?.contentOwner ?? common.at(-1)?.owner ?? hostOwner;
        let parentHandledFailure = common.at(-1)?.handledFailure ?? false;
        for (let index = 0; index < suffixModules.length; index++) {
          if (parentHandledFailure) break;
          const owner = new Owner(
            runtime.context,
            parent,
            ownerIdentity("layout", common.length + index),
          );
          owner.deferStructural = true;
          staged.push(owner);
          const childOutlet = runtime.context.document.createDocumentFragment();
          const moduleIndex = commonCount + index;
          const part = instantiatePart(
            owner,
            layoutPrepared[moduleIndex]!,
            childOutlet,
            suffixModules[index],
          );
          if (part.owner.state === "destroyed" || part.owner.state === "cleaning") {
            parentHandledFailure = true;
            break;
          }
          suffixChildOutlets.push(childOutlet);
          suffixParts.push(part);
          parent = part.contentOwner;
          parentHandledFailure = part.handledFailure;
        }
        if (!parentHandledFailure) {
          const pageOwner = new Owner(
            runtime.context,
            parent,
            ownerIdentity("page", route.layouts.length),
          );
          staged.push(pageOwner);
          if (staged[0]) staged[0].commitDeferred = true;
          try {
            page = instantiatePart(pageOwner, pagePrepared, undefined, route.page);
          } catch (error) {
            // A page is allocated beneath the preceding layout's boundary
            // content owner. Route preparation itself is outside that helper, so
            // forward a body fault through the actual owner chain before deciding
            // whether the candidate can continue with the boundary's fallback.
            reportFault(pageOwner, error);
            pageOwner.dispose(error);
            page = undefined;
          }
        }
        childValue = page?.tree.fragment ?? runtime.context.document.createDocumentFragment();
        if (suffixParts.length) {
          for (let index = suffixParts.length - 1; index >= 0; index--) {
            const part = suffixParts[index]!;
            suffixChildOutlets[index]!.appendChild(childValue);
            childValue = part.tree.fragment;
          }
        }
        suffixLayers = suffixParts.map((part, index) => ({
          ...part,
          module: suffixModules[index]!,
        }));
        const suffixChildValues = suffixChildOutlets;
        candidate.layers = [...common, ...suffixLayers];
        candidate.page = page;
        candidate.ready = page?.ready;
        candidate.root = childValue;
        const commonChildValues = common.map((_, index) =>
          index === common.length - 1
            ? childValue
            : (previous?.childValues[index] ?? runtime.context.document.createDocumentFragment()),
        );
        candidate.childValues = [...commonChildValues, ...suffixChildValues];
        candidate.layerProps = route.layouts.map((_, index) =>
          preparedWithChildren(layoutPrepared[index]!, candidate.childValues[index]!),
        );
        candidate.commonProps = common.map((layer, index) => {
          return preparedWithChildren(layoutPrepared[index]!, candidate.childValues[index]!);
        });
        built = true;
      };
      candidate.build = build;
      if (commonCount === identityCommon.length) build();
      else {
        candidate.commonProps = common.map((_, index) =>
          preparedWithChildren(
            layoutPrepared[index]!,
            previous?.childValues[index] ?? runtime.context.document.createDocumentFragment(),
          ),
        );
      }
      const onAbort = () => disposeCandidate(candidate, route.inputs.signal.reason);
      candidates.add(candidate);
      route.inputs.signal.addEventListener("abort", onAbort, { once: true });
      abort = () => route.inputs.signal.removeEventListener("abort", onAbort);
      if (route.inputs.signal.aborted) onAbort();

      const routeRoot = (): Owner | undefined =>
        candidate.layers[common.length]?.owner ?? candidate.page?.owner;
      const reparent = (owner: Owner, parent: Owner): void => {
        owner.reparent(parent);
      };
      candidate.park = (preserving) => {
        if (!candidate.installed || candidate.parked || candidate.disposed) return;
        const retained = preserving ?? new Set<Owner>();
        const root =
          candidate.layers.find((layer) => !retained.has(layer.owner))?.owner ??
          candidate.page?.owner ??
          routeRoot();
        if (!root) return;
        candidate.parkedParent = root.parent;
        root.suspend();
        if (root.parent !== hostOwner) reparent(root, hostOwner);
        candidate.parkedRoot = root;
        candidate.parked = true;
      };
      candidate.restore = () => {
        if (!candidate.installed || !candidate.parked || candidate.disposed) return;
        const root = candidate.parkedRoot ?? routeRoot();
        if (!root) return;
        const parent =
          candidate.parkedParent && candidate.parkedParent.state !== "destroyed"
            ? candidate.parkedParent
            : hostOwner;
        const detached: Array<readonly [Owner, Owner]> = [];
        const suspendedAncestors: Owner[] = [];
        if (root.parent !== parent && root.parent) reparent(root, hostOwner);
        let ancestor: Owner | null = parent;
        while (ancestor && ancestor.state === "suspended") {
          suspendedAncestors.push(ancestor);
          for (const child of ancestor.children.slice()) {
            if (child.state === "suspended" && child !== root) {
              reparent(child, hostOwner);
              detached.push([child, ancestor]);
            }
          }
          const prior: Owner | null = ancestor.parent;
          if (prior && prior.state === "suspended") {
            reparent(ancestor, hostOwner);
            detached.push([ancestor, prior]);
          }
          ancestor = prior;
        }
        for (let index = 0; index < candidate.layers.length; index++) {
          const layer = candidate.layers[index]!;
          const props = candidate.layerProps[index];
          if (props && layer.owner.state !== "destroyed")
            runtime.context.scheduler.reconcile(() => publishComponent(layer.instance, props));
        }
        if (candidate.common.length) {
          for (let index = 0; index < candidate.common.length; index++) {
            const layer = candidate.common[index]!;
            runtime.context.scheduler.reconcile(() => {
              publishComponent(layer.instance, candidate.commonProps[index]!);
            });
          }
        } else {
          rootOutput.set(candidate.root);
        }
        runtime.context.scheduler.flush();

        // Publish the retained native range while every suspended owner is
        // still paused. Rebinding before this point would inspect a detached
        // target and turn a cache restore into a false binding fault.
        for (const item of suspendedAncestors.slice().reverse()) item.resume();
        for (const [owner, prior] of detached.slice().reverse()) {
          if (owner.state === "suspended" && prior.state === "mounted") reparent(owner, prior);
        }
        if (root.parent !== parent) reparent(root, parent);
        if (root.state === "suspended") root.resume();
        candidate.parked = false;
        candidate.parkedRoot = undefined;
        active = candidate;
        revision++;
        runtime.context.scheduler.requestEffects();
      };

      const prepared: PreparedRoute & { readonly ready?: Promise<void> } = {
        get ready(): Promise<void> | undefined {
          return candidate.ready;
        },
        get owners(): readonly Owner[] {
          return Object.freeze([...common.map((layer) => layer.owner), ...staged]);
        },
        install(_options?: PreparedRouteInstallOptions) {
          if (disposed || hostOwner.state === "cleaning" || hostOwner.state === "destroyed")
            throw new RenderFault("disposed", "The route host runtime has been disposed");
          if (candidate.disposed)
            throw new RenderFault("disposed", "The route candidate was disposed");
          if (candidate.installed || revision !== preparedRevision)
            throw new RenderFault("route-stale", "The route candidate is no longer current");
          const failedCommonIndex = common.findIndex((layer) => layer.failureState.handled);
          if (failedCommonIndex >= 0) {
            const retainedCount = failedCommonIndex + 1;
            candidate.common = common.slice(0, retainedCount);
            candidate.layers = candidate.layers.slice(0, retainedCount);
            candidate.commonProps = candidate.commonProps.slice(0, retainedCount);
            candidate.layerProps = candidate.layerProps.slice(0, retainedCount);
            candidate.childValues = candidate.childValues.slice(0, retainedCount);
          }
          const validationCommon =
            failedCommonIndex >= 0
              ? candidate.common.slice(0, failedCommonIndex)
              : candidate.common;
          const invalid = validationCommon.findIndex(
            (layer, index) =>
              !canPublishComponentExcept(
                layer.instance,
                candidate.commonProps[index]!,
                new Set(["children"]),
              ),
          );
          if (invalid >= 0) {
            const error = new RenderFault(
              "route-props",
              `A retained route component at layer ${invalid} can no longer accept its captured props snapshot`,
            );
            disposeCandidate(candidate, error);
            throw error;
          }
          if (candidate.recovery)
            runtime.context.scheduler.requestRecreation(
              previous?.layers[candidate.common.length]?.owner ??
                previous?.page?.owner ??
                hostOwner,
            );
          if (!connected) {
            target.appendChild(rootFragment);
            connected = true;
          }
          if (previous && !previous.disposed) {
            previous.abort();
            if (_options?.preserving && !_options.disposePrevious)
              previous.park?.(_options.preserving);
            else {
              const retainedOutgoing = previous.layers[candidate.common.length]?.owner;
              const outgoing =
                retainedOutgoing &&
                retainedOutgoing.state !== "destroyed" &&
                retainedOutgoing.state !== "cleaning"
                  ? retainedOutgoing
                  : previous.page?.owner;
              if (!outgoing)
                throw new RenderFault("route-invalid", "The active route has no root owner");
              outgoing.dispose(new RenderFault("route-replaced", "The route was replaced"));
              previous.disposed = true;
              candidates.delete(previous);
            }
          }
          try {
            candidate.build?.();
          } catch (error) {
            candidate.abort();
            candidate.disposed = true;
            candidates.delete(candidate);
            if (active === previous) {
              active = undefined;
              revision++;
            }
            disposeStaged(candidate, error);
            throw error;
          }
          if (candidate.common.length) {
            if (failedCommonIndex < 0)
              for (let index = 0; index < candidate.common.length; index++) {
                const layer = candidate.common[index]!;
                runtime.context.scheduler.reconcile(() =>
                  publishComponent(layer.instance, candidate.commonProps[index]!),
                );
              }
          } else {
            rootOutput.set(candidate.root);
          }
          // A page can finish through an enclosing route error boundary before
          // its terminal candidate installs. The boundary has already replaced
          // the visible tree, so retain the last live layout owner as the
          // candidate root rather than treating the handled page teardown as a
          // malformed route.
          const first =
            candidate.layers[candidate.common.length]?.owner ??
            (candidate.page?.owner.state === "destroyed" ||
            candidate.page?.owner.state === "cleaning"
              ? candidate.layers
                  .slice()
                  .reverse()
                  .find(
                    (layer) =>
                      layer.owner.state !== "destroyed" && layer.owner.state !== "cleaning",
                  )?.owner
              : candidate.page?.owner);
          if (!first)
            throw new RenderFault("route-invalid", "The route candidate has no root owner");
          first.commitDeferred = false;
          if (hostOwner.state === "building") hostOwner.commit();
          else if (first.state === "building") first.commit();
          candidate.installed = true;
          active = candidate;
          revision++;
          runtime.context.scheduler.flush();
          runtime.context.scheduler.requestEffects();
        },
        park: candidate.park,
        restore: candidate.restore,
        dispose(reason, preserving) {
          if (candidate.disposed) return;
          if (candidate.installed && preserving) {
            candidate.abort();
            const retained = new Set(preserving);
            const first = candidate.layers.findIndex((layer) => !retained.has(layer.owner));
            if (first >= 0) disposeInstalled(candidate, reason, first);
            else if (candidate.page && !retained.has(candidate.page.owner))
              candidate.page.owner.dispose(reason);
            candidate.disposed = true;
            candidates.delete(candidate);
            if (active === candidate) {
              active = undefined;
              revision++;
            }
            return;
          }
          disposeCandidate(
            candidate,
            reason ?? new RenderFault("cancelled", "Route candidate disposed"),
          );
        },
      };
      return prepared;
    } catch (error) {
      staged[0]!.dispose(error);
      throw error;
    }
  };

  return {
    outlet: rootFragment,
    prepare,
    departingOwners,
    dispose(reason = new RenderFault("disposed", "Route host disposed")) {
      if (disposed) return;
      disposed = true;
      if (active) disposeCandidate(active, reason);
      active = undefined;
      hostOwner.dispose(reason);
    },
  };
}
