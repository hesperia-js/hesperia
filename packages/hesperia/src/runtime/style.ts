import { RenderFault, type Owner, type OwnerStyleLifecycle } from "./owner.ts";

declare const styleIdBrand: unique symbol;
declare const styleOwnerIdBrand: unique symbol;
declare const styleEntryIdBrand: unique symbol;
declare const styleCompositionIdBrand: unique symbol;

/** Compiler identity for one logical stylesheet root. */
export type StyleId = string & { readonly [styleIdBrand]: true };

/** Compiler identity for one component definition that owns CSS directly. */
export type StyleOwnerId = string & { readonly [styleOwnerIdBrand]: true };

/** Compiler identity for one module's static CSS closure. */
export type StyleEntryId = string & { readonly [styleEntryIdBrand]: true };

/** Compiler identity for one ordered route or Document view. */
export type StyleCompositionId = string & { readonly [styleCompositionIdBrand]: true };

/** One logical stylesheet and its current emitted bytes. */
export interface StyleAsset {
  /** Stable identity across CSS-only revisions. */
  readonly id: StyleId;
  /** Changes when the emitted CSS bytes change. */
  readonly revision: string;
  /** Browser-resolvable URL of the emitted stylesheet. */
  readonly href: string;
  /** Authored native link state retained for imported-markup stylesheet roots. */
  readonly link?: {
    readonly rel: string;
    readonly media?: string;
    readonly disabled?: boolean;
    readonly title?: string;
    readonly requestAttributes?: Readonly<Record<string, string>>;
  };
}

/** Direct styles owned by one compiled component definition. */
export interface OwnerStyleBinding {
  /** Stable definition identity, not an Owner instance. */
  readonly ownerId: StyleOwnerId;
  /** Styles directly owned by this definition. */
  readonly styles: readonly StyleId[];
}

/** Ordered static CSS closure of one compiled module. */
export interface StyleEntry {
  /** Stable compiled module identity. */
  readonly entryId: StyleEntryId;
  /** Full dependency closure in first-source-encounter order. */
  readonly closure: readonly StyleId[];
}

/** Ordered CSS vector for one destination, loading, error, or Document view. */
export interface StyleComposition {
  /** Stable view identity. */
  readonly compositionId: StyleCompositionId;
  /** Referenced modules in source order. */
  readonly entries: readonly StyleEntryId[];
  /** Deduplicated cascade order merged from those entries. */
  readonly styles: readonly StyleId[];
}

/** Private compiler/build/runtime handoff for CSS assets and ownership. */
export interface CompiledStylePlan {
  /** Current emitted bytes for every logical style. */
  readonly assets: readonly StyleAsset[];
  /** Direct style references for each compiled definition. */
  readonly owners: readonly OwnerStyleBinding[];
  /** Ordered module closures. */
  readonly entries: readonly StyleEntry[];
  /** Ordered view vectors. */
  readonly compositions: readonly StyleComposition[];
}

/** A retained, inactive module or composition preparation. */
export interface StyleEntryLease {
  /** Release this caller's preparation reference. Idempotent. */
  release(): void;
}

/** A prepared cascade vector that can be selected by one mounted root. */
export interface PreparedStyleGroupLease extends StyleEntryLease {
  /** Select the ready vector for this independent mounted root synchronously. */
  activate(rootOwner: Owner): void;
}

/** A loaded CSS revision staged for synchronous publication. */
export interface PreparedStyleRevision extends StyleEntryLease {
  /** Replace this runtime's current CSS bytes without replacing live DOM. */
  publish(): void;
}

/** Direct target preparation with a synchronous readiness branch. */
export interface TargetEntryPreparation extends PreparedStyleGroupLease {
  /** True only when this exact target-head group is already ready on return. */
  readonly ready: boolean;
  /** Resolve when the target-head links load; reject with the required CSS fault. */
  readonly settled: Promise<void>;
}

/** Private generated-module seam for the runtime's stylesheet engine. */
export interface InternalStyleRuntime {
  /** Associate a compiled component function with its entry and optional Document view. */
  bindEntry(
    definition: Function,
    entryId: StyleEntryId,
    documentCompositionId?: StyleCompositionId,
  ): void;

  /** Prepare a complete module closure without activating its sheets. */
  preloadEntry(entryId: StyleEntryId, head: HTMLHeadElement): Promise<PreparedStyleGroupLease>;

  /** Acquire a module closure in a direct mount's actual head. */
  prepareDirectTarget(entryId: StyleEntryId, head: HTMLHeadElement): TargetEntryPreparation;

  /** Prepare an ordered route or Document vector in its installed head. */
  prepareInstalledHead(
    compositionId: StyleCompositionId,
    head: HTMLHeadElement,
    signal?: AbortSignal,
  ): Promise<PreparedStyleGroupLease>;

  /** Bind a generated component definition's direct styles to its actual Owner. */
  bindStyles(owner: Owner, ownerId: StyleOwnerId): void;

  /** Stage a CSS-only revision for every retained vector in this head. */
  prepareRevision(
    next: CompiledStylePlan,
    head: HTMLHeadElement,
    signal?: AbortSignal,
  ): Promise<PreparedStyleRevision>;
}

interface NormalizedPlan {
  readonly assets: Map<StyleId, StyleAsset>;
  readonly owners: Map<StyleOwnerId, readonly StyleId[]>;
  readonly entries: Map<StyleEntryId, readonly StyleId[]>;
  readonly compositions: Map<StyleCompositionId, StyleComposition>;
}

type GroupStatus = "loading" | "ready" | "failed" | "cancelled";

interface PhysicalStyleGroup {
  readonly head: HTMLHeadElement;
  readonly key: string;
  readonly styles: readonly StyleAsset[];
  readonly links: readonly HTMLLinkElement[];
  readonly enabled: Map<StyleId, boolean>;
  readonly activeRefs: Map<StyleId, number>;
  readonly selectedRoots: Map<Owner, RuntimeState>;
  readonly leases: Set<LeaseRecord>;
  ready: Promise<void>;
  status: GroupStatus;
  failure: unknown;
  retained: number;

  resolveReady(): void;

  rejectReady(error: unknown): void;
}

interface LeaseRecord {
  readonly state: RuntimeState;
  readonly role: "preload" | "direct" | "composition" | "revision";
  group: PhysicalStyleGroup;
  released: boolean;
}

interface OwnerBindingRecord {
  readonly owner: Owner;
  readonly ownerId: string;
  readonly root: Owner;
  readonly styles: readonly StyleId[];
  active: boolean;
}

interface RootSelection {
  readonly root: Owner;
  readonly refs: Map<StyleId, number>;
  group: PhysicalStyleGroup;
}

interface RevisionAttempt {
  readonly id: number;
  readonly state: RuntimeState;
  readonly head: HTMLHeadElement;
  readonly next: NormalizedPlan;
  readonly baseVersion: number;
  readonly staged: Map<string, PhysicalStyleGroup>;
  readonly stagedLeases: LeaseRecord[];
  readonly signal?: AbortSignal;
  abortListener?: () => void;
  readonly cancelled: Promise<never>;

  rejectCancelled(error: unknown): void;

  active: boolean;
  published: boolean;
  cancelReason?: unknown;

  cancel(error: unknown): void;
}

interface RuntimeState extends OwnerStyleLifecycle {
  plan: NormalizedPlan;
  version: number;
  revisionAttemptId: number;
  readonly leases: Set<LeaseRecord>;
  readonly owners: Map<Owner, OwnerBindingRecord>;
  readonly selections: Map<Owner, RootSelection>;
  readonly releaseBoundRoots: WeakSet<Owner>;
  readonly revisions: Set<RevisionAttempt>;
}

interface EntryMountBinding {
  readonly runtime: InternalStyleRuntime;
  readonly entryId: StyleEntryId;
  readonly documentCompositionId?: StyleCompositionId;
}

const physicalGroups = new WeakMap<HTMLHeadElement, Map<string, PhysicalStyleGroup>>();
const physicalHeads = new WeakMap<Document, Set<HTMLHeadElement>>();
const entryMountBindings = new WeakMap<Function, EntryMountBinding>();
const selectedRootRuntimes = new WeakMap<Owner, RuntimeState>();

function isCurrentHead(head: HTMLHeadElement): boolean {
  return head.ownerDocument.head === head;
}

function findRoot(owner: Owner): Owner {
  let root = owner;

  while (root.parent) root = root.parent;

  return root;
}

function includesOwner(owner: Owner, root: Owner): boolean {
  for (let current: Owner | null = owner; current; current = current.parent) {
    if (current === root) return true;
  }

  return false;
}

function sameStringArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}

function normalizePlan(plan: CompiledStylePlan): NormalizedPlan {
  const assets = new Map<StyleId, StyleAsset>();

  for (const asset of plan.assets) {
    if (!asset.id || !asset.revision || !asset.href)
      throw new RenderFault("style-plan", "Every stylesheet needs an id, revision, and URL");

    if (assets.has(asset.id))
      throw new RenderFault("style-plan", `Duplicate stylesheet id ${asset.id}`);

    assets.set(asset.id, Object.freeze({ ...asset }));
  }

  const owners = new Map<StyleOwnerId, readonly StyleId[]>();

  for (const binding of plan.owners) {
    if (owners.has(binding.ownerId))
      throw new RenderFault("style-plan", `Duplicate stylesheet owner ${binding.ownerId}`);

    const styles = [...binding.styles];

    if (new Set(styles).size !== styles.length)
      throw new RenderFault("style-plan", `Owner ${binding.ownerId} repeats a stylesheet`);

    for (const id of styles) {
      if (!assets.has(id))
        throw new RenderFault(
          "style-plan",
          `Owner ${binding.ownerId} references unknown style ${id}`,
        );
    }

    owners.set(binding.ownerId, Object.freeze(styles));
  }

  const entries = new Map<StyleEntryId, readonly StyleId[]>();

  for (const entry of plan.entries) {
    if (entries.has(entry.entryId))
      throw new RenderFault("style-plan", `Duplicate stylesheet entry ${entry.entryId}`);

    const closure = [...entry.closure];

    if (new Set(closure).size !== closure.length)
      throw new RenderFault("style-plan", `Entry ${entry.entryId} repeats a stylesheet`);

    for (const id of closure) {
      if (!assets.has(id))
        throw new RenderFault(
          "style-plan",
          `Entry ${entry.entryId} references unknown style ${id}`,
        );
    }

    entries.set(entry.entryId, Object.freeze(closure));
  }

  const compositions = new Map<StyleCompositionId, StyleComposition>();

  for (const composition of plan.compositions) {
    if (compositions.has(composition.compositionId))
      throw new RenderFault(
        "style-plan",
        `Duplicate stylesheet composition ${composition.compositionId}`,
      );

    const merged: StyleId[] = [];
    const seen = new Set<StyleId>();

    for (const entryId of composition.entries) {
      const closure = entries.get(entryId);

      if (!closure)
        throw new RenderFault(
          "style-plan",
          `Composition ${composition.compositionId} references unknown entry ${entryId}`,
        );

      for (const id of closure) {
        if (seen.has(id)) continue;

        seen.add(id);

        merged.push(id);
      }
    }

    if (!sameStringArray(merged, composition.styles))
      throw new RenderFault(
        "style-plan",
        `Composition ${composition.compositionId} does not match its ordered entry closures`,
      );

    compositions.set(
      composition.compositionId,
      Object.freeze({
        compositionId: composition.compositionId,
        entries: Object.freeze([...composition.entries]),
        styles: Object.freeze([...composition.styles]),
      }),
    );
  }

  return { assets, owners, entries, compositions };
}

function physicalKey(styles: readonly StyleAsset[]): string {
  return JSON.stringify(styles.map(({ id, revision, href, link }) => [id, revision, href, link]));
}

function linkLoad(link: HTMLLinkElement, asset: StyleAsset): Promise<void> {
  return new Promise((resolve, reject) => {
    const clean = (): void => {
      link.removeEventListener("load", loaded);

      link.removeEventListener("error", failed);
    };

    const loaded = (): void => {
      clean();

      if (!link.sheet) {
        reject(
          new RenderFault(
            "stylesheet-load",
            `Stylesheet ${asset.href} loaded without a usable CSSStyleSheet`,
          ),
        );
      } else resolve();
    };

    const failed = (): void => {
      clean();

      reject(new RenderFault("stylesheet-load", `Stylesheet ${asset.href} failed to load`));
    };

    link.addEventListener("load", loaded, { once: true });

    link.addEventListener("error", failed, { once: true });
  });
}

function registryFor(head: HTMLHeadElement): Map<string, PhysicalStyleGroup> {
  let heads = physicalHeads.get(head.ownerDocument);

  if (!heads) {
    heads = new Set();

    physicalHeads.set(head.ownerDocument, heads);
  }

  heads.add(head);

  let groups = physicalGroups.get(head);

  if (!groups) {
    groups = new Map();

    physicalGroups.set(head, groups);
  }

  return groups;
}

function createPhysicalGroup(
  head: HTMLHeadElement,
  styles: readonly StyleAsset[],
): PhysicalStyleGroup {
  const key = physicalKey(styles);

  const registry = registryFor(head);

  const existing = registry.get(key);

  if (existing && existing.status !== "failed" && existing.status !== "cancelled") return existing;

  let resolveReady!: () => void;
  let rejectReady!: (error: unknown) => void;

  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });

  void ready.catch(() => undefined);

  const links = styles.map(() => head.ownerDocument.createElement("link"));

  const group: PhysicalStyleGroup = {
    head,
    key,
    styles: Object.freeze([...styles]),
    links: Object.freeze(links),
    enabled: new Map(styles.map(({ id }) => [id, false])),
    activeRefs: new Map(),
    selectedRoots: new Map(),
    leases: new Set(),
    ready,
    status: styles.length === 0 ? "ready" : "loading",
    failure: undefined,
    retained: 0,
    resolveReady,
    rejectReady,
  };

  registry.set(key, group);

  if (!styles.length) {
    resolveReady();

    return group;
  }

  const loads = links.map((link, index) => {
    const asset = styles[index]!;

    link.rel = asset.link?.rel ?? "stylesheet";

    for (const [name, value] of Object.entries(asset.link?.requestAttributes ?? {}))
      link.setAttribute(name, value);

    if (asset.link?.title !== undefined) link.title = asset.link.title;

    link.media = "not all";

    link.setAttribute("data-hesperia-style-id", asset.id);

    link.setAttribute("data-hesperia-style-revision", asset.revision);

    link.href = asset.href;

    const loaded = linkLoad(link, asset);

    head.appendChild(link);

    return loaded;
  });

  void Promise.all(loads).then(
    () => {
      if (group.status !== "loading") return;

      for (const [index, asset] of styles.entries())
        if (asset.link?.disabled) links[index]!.disabled = true;

      group.status = "ready";

      group.resolveReady();
    },
    (error: unknown) => {
      if (group.status !== "loading") return;

      group.status = "failed";
      group.failure = error;

      group.rejectReady(error);

      removePhysicalGroup(group);
    },
  );

  return group;
}

function removePhysicalGroup(group: PhysicalStyleGroup): void {
  const registry = physicalGroups.get(group.head);

  if (registry?.get(group.key) === group) {
    registry.delete(group.key);

    if (!registry.size) physicalGroups.delete(group.head);
  }

  for (const link of group.links) link.parentNode?.removeChild(link);
}

function maybeCollectGroup(group: PhysicalStyleGroup): void {
  if (group.retained || group.selectedRoots.size) return;

  if ([...group.activeRefs.values()].some((count) => count > 0)) return;

  if (group.status === "loading") {
    group.status = "cancelled";

    group.failure = new RenderFault("stylesheet-cancelled", "Stylesheet preparation was released");

    group.rejectReady(group.failure);
  }

  removePhysicalGroup(group);
}

function groupFor(
  state: RuntimeState,
  head: HTMLHeadElement,
  ids: readonly StyleId[],
  plan = state.plan,
): PhysicalStyleGroup {
  if (!isCurrentHead(head))
    throw new RenderFault(
      "style-head-replaced",
      "Stylesheets require the target Document's current head",
    );

  retireDisconnectedHeads(head.ownerDocument, head);

  const styles = ids.map((id) => {
    const asset = plan.assets.get(id);

    if (!asset) throw new RenderFault("style-plan", `Unknown stylesheet ${id}`);

    return asset;
  });

  return createPhysicalGroup(head, styles);
}

function retainGroup(
  state: RuntimeState,
  group: PhysicalStyleGroup,
  role: LeaseRecord["role"],
): LeaseRecord {
  group.retained++;

  const record: LeaseRecord = { state, role, group, released: false };

  state.leases.add(record);

  group.leases.add(record);

  return record;
}

function releaseRecord(record: LeaseRecord): void {
  if (record.released) return;

  record.released = true;

  record.state.leases.delete(record);

  const { group } = record;

  group.leases.delete(record);

  if (group.retained > 0) group.retained--;

  maybeCollectGroup(group);
}

function setLinkEnabled(group: PhysicalStyleGroup, style: StyleId, enabled: boolean): void {
  const index = group.styles.findIndex((asset) => asset.id === style);

  if (index < 0) throw new RenderFault("style-vector", `Style ${style} is absent from its group`);

  if (group.enabled.get(style) === enabled) return;

  const link = group.links[index]!;
  const sheet = link.sheet;
  const asset = group.styles[index]!;

  if (
    (!sheet && !asset.link?.disabled) ||
    link.parentNode !== group.head ||
    group.status !== "ready"
  ) {
    throw new RenderFault(
      "stylesheet-readiness",
      `Stylesheet ${style} is not ready in its target head`,
    );
  }

  const media = enabled ? (asset.link?.media ?? "all") : "not all";

  if (sheet) sheet.media.mediaText = media;
  else link.media = media;

  group.enabled.set(style, enabled);
}

function changeActiveRefs(
  group: PhysicalStyleGroup,
  refs: ReadonlyMap<StyleId, number>,
  delta: 1 | -1,
  deferMedia = false,
): void {
  for (const [style, amount] of refs) {
    if (amount === 0) continue;

    if (!group.enabled.has(style))
      throw new RenderFault(
        "style-vector",
        `Active owner requires style ${style} outside its vector`,
      );

    const before = group.activeRefs.get(style) ?? 0;

    const after = before + delta * amount;

    if (after < 0)
      throw new RenderFault("style-refcount", `Style ${style} reference count became negative`);

    if (after) group.activeRefs.set(style, after);
    else group.activeRefs.delete(style);

    if (!deferMedia && (before === 0) !== (after === 0)) setLinkEnabled(group, style, after > 0);
  }
}

function refsForOwner(styles: readonly StyleId[]): Map<StyleId, number> {
  return new Map(styles.map((id) => [id, 1]));
}

function refsForRoot(
  state: RuntimeState,
  root: Owner,
  group: PhysicalStyleGroup,
): Map<StyleId, number> {
  const available = new Set(group.styles.map(({ id }) => id));

  const refs = new Map<StyleId, number>();

  for (const binding of state.owners.values()) {
    if (!binding.active || !includesOwner(binding.owner, root)) continue;

    for (const id of binding.styles) {
      if (!available.has(id)) {
        throw new RenderFault(
          "style-vector",
          `Active Owner ${binding.ownerId} requires ${id}, absent from its prepared vector`,
        );
      }

      refs.set(id, (refs.get(id) ?? 0) + 1);
    }
  }

  return refs;
}

function updateOwnerRefs(state: RuntimeState, binding: OwnerBindingRecord, delta: 1 | -1): void {
  const selection = state.selections.get(binding.root);

  if (!selection || !binding.styles.length) return;

  changeActiveRefs(selection.group, refsForOwner(binding.styles), delta);

  for (const id of binding.styles) {
    const count = selection.refs.get(id) ?? 0;

    const next = count + delta;

    if (next < 0) throw new RenderFault("style-refcount", `Owner style ${id} was released twice`);

    if (next) selection.refs.set(id, next);
    else selection.refs.delete(id);
  }
}

function deactivateRoot(state: RuntimeState, root: Owner, deferMedia = false): void {
  const selection = state.selections.get(root);

  if (!selection) return;

  state.selections.delete(root);

  selectedRootRuntimes.delete(root);

  changeActiveRefs(
    selection.group,
    selection.refs,
    -1,
    deferMedia || !isCurrentHead(selection.group.head),
  );

  selection.group.selectedRoots.delete(root);

  maybeCollectGroup(selection.group);
}

function retireDisconnectedHeads(document: Document, currentHead: HTMLHeadElement): void {
  const heads = physicalHeads.get(document);

  if (!heads) return;

  for (const head of heads) {
    if (head === currentHead || isCurrentHead(head)) continue;

    heads.delete(head);

    const registry = physicalGroups.get(head);

    if (!registry) continue;

    const groups = [...registry.values()];
    const attempts = new Set<RevisionAttempt>();

    for (const group of groups) {
      for (const lease of group.leases) {
        for (const attempt of lease.state.revisions) {
          if (attempt.head === head) attempts.add(attempt);
        }
      }
    }

    const reason = new RenderFault(
      "style-head-replaced",
      "A stylesheet head was replaced before its resources were released",
    );

    for (const attempt of attempts) attempt.cancel(reason);

    for (const group of groups) {
      for (const [root, state] of group.selectedRoots) deactivateRoot(state, root, true);

      for (const lease of group.leases) releaseRecord(lease);

      maybeCollectGroup(group);
    }

    physicalGroups.delete(head);
  }

  if (!heads.size) physicalHeads.delete(document);
}

function activateGroup(state: RuntimeState, group: PhysicalStyleGroup, rootOwner: Owner): void {
  rootOwner.assertActive();

  if (rootOwner.parent) {
    throw new RenderFault(
      "style-root",
      "A stylesheet group must be selected by a mounted root Owner",
    );
  }

  if (group.status !== "ready" || !isCurrentHead(group.head)) {
    throw new RenderFault(
      "stylesheet-readiness",
      "A stylesheet group can be activated only after it is ready in the current head",
    );
  }

  for (let index = 0; index < group.links.length; index++) {
    const link = group.links[index]!;

    if (
      link.parentNode !== group.head ||
      (index > 0 && group.links[index - 1]!.nextSibling !== link)
    ) {
      throw new RenderFault(
        "stylesheet-position",
        "A loaded stylesheet group left its head positions",
      );
    }
  }

  const selectedRuntime = selectedRootRuntimes.get(rootOwner);

  if (selectedRuntime && selectedRuntime !== state) {
    throw new RenderFault(
      "style-runtime-root",
      "One mounted root cannot select groups from two compiled style plans",
    );
  }

  const refs = refsForRoot(state, rootOwner, group);

  const current = state.selections.get(rootOwner);

  if (current?.group === group) {
    for (const [id, count] of current.refs) {
      const next = refs.get(id) ?? 0;

      if (count > next) changeActiveRefs(group, new Map([[id, count - next]]), -1);
    }

    for (const [id, count] of refs) {
      const previous = current.refs.get(id) ?? 0;

      if (count > previous) changeActiveRefs(group, new Map([[id, count - previous]]), 1);
    }

    current.refs.clear();

    for (const [id, count] of refs) current.refs.set(id, count);

    return;
  }

  if (!state.releaseBoundRoots.has(rootOwner)) {
    rootOwner.onRelease(() => deactivateRoot(state, rootOwner));

    state.releaseBoundRoots.add(rootOwner);
  }

  const next: RootSelection = { root: rootOwner, refs, group };

  group.selectedRoots.set(rootOwner, state);

  changeActiveRefs(group, refs, 1);

  state.selections.set(rootOwner, next);

  selectedRootRuntimes.set(rootOwner, state);

  if (current) {
    changeActiveRefs(current.group, current.refs, -1);

    current.group.selectedRoots.delete(rootOwner);

    maybeCollectGroup(current.group);
  }
}

function createLease(record: LeaseRecord): PreparedStyleGroupLease {
  return {
    activate(rootOwner) {
      if (record.released)
        throw new RenderFault("style-lease", "A released stylesheet lease cannot activate");

      activateGroup(record.state, record.group, rootOwner);
    },

    release() {
      releaseRecord(record);
    },
  };
}

function waitWithSignal(promise: Promise<void>, signal?: AbortSignal): Promise<void> {
  if (!signal) return promise;

  if (signal.aborted)
    return Promise.reject(signal.reason ?? new RenderFault("cancelled", "Stylesheet wait aborted"));

  return new Promise<void>((resolve, reject) => {
    const aborted = (): void => {
      signal.removeEventListener("abort", aborted);

      reject(signal.reason ?? new RenderFault("cancelled", "Stylesheet wait aborted"));
    };

    signal.addEventListener("abort", aborted, { once: true });

    promise.then(
      () => {
        signal.removeEventListener("abort", aborted);

        resolve();
      },
      (error: unknown) => {
        signal.removeEventListener("abort", aborted);

        reject(error);
      },
    );
  });
}

function sameTopology(left: NormalizedPlan, right: NormalizedPlan): boolean {
  if (left.assets.size !== right.assets.size || left.owners.size !== right.owners.size)
    return false;

  if (
    left.entries.size !== right.entries.size ||
    left.compositions.size !== right.compositions.size
  )
    return false;

  for (const id of left.assets.keys()) if (!right.assets.has(id)) return false;

  for (const [id, binding] of left.owners) {
    const next = right.owners.get(id);

    if (!next || !sameStringArray(binding, next)) return false;
  }

  for (const [id, closure] of left.entries) {
    const next = right.entries.get(id);

    if (!next || !sameStringArray(closure, next)) return false;
  }

  for (const [id, composition] of left.compositions) {
    const next = right.compositions.get(id);

    if (
      !next ||
      !sameStringArray(composition.entries, next.entries) ||
      !sameStringArray(composition.styles, next.styles)
    )
      return false;
  }

  return true;
}

function assertSameTopology(current: NormalizedPlan, next: NormalizedPlan): void {
  if (!sameTopology(current, next)) {
    throw new RenderFault(
      "style-revision-topology",
      "A CSS-only revision cannot change style IDs, owners, module closures, or composition order",
    );
  }
}

function makeRevisionHandle(attempt: RevisionAttempt): PreparedStyleRevision {
  const release = (): void => {
    if (!attempt.active) return;

    attempt.active = false;

    attempt.state.revisions.delete(attempt);

    removeRevisionAbortListener(attempt);

    for (const lease of attempt.stagedLeases) releaseRecord(lease);
  };

  return {
    publish() {
      if (!attempt.active)
        throw new RenderFault(
          "style-revision-stale",
          "The stylesheet revision is no longer current",
        );

      if (
        attempt.id !== attempt.state.revisionAttemptId ||
        attempt.baseVersion !== attempt.state.version
      ) {
        release();

        throw new RenderFault(
          "style-revision-stale",
          "A newer stylesheet revision superseded this one",
        );
      }

      if (attempt.signal?.aborted) {
        release();

        throw (
          attempt.signal.reason ?? new RenderFault("cancelled", "Stylesheet revision was aborted")
        );
      }

      if (!isCurrentHead(attempt.head)) {
        release();

        throw new RenderFault("style-revision-head", "The stylesheet revision target head changed");
      }

      for (const group of attempt.staged.values()) {
        if (group.status !== "ready" || group.head !== attempt.head) {
          release();

          throw new RenderFault(
            "stylesheet-readiness",
            "A staged stylesheet group is no longer ready",
          );
        }
      }

      const state = attempt.state;

      const coveredVectors = new Set(attempt.staged.keys());
      const currentVectors = new Set<string>();

      const vectorKey = (group: PhysicalStyleGroup): string =>
        JSON.stringify(group.styles.map(({ id }) => id));

      for (const lease of state.leases) {
        if (lease.role !== "revision" && lease.group.head === attempt.head)
          currentVectors.add(vectorKey(lease.group));
      }

      for (const selection of state.selections.values()) {
        if (selection.group.head === attempt.head) currentVectors.add(vectorKey(selection.group));
      }

      for (const vector of currentVectors) {
        if (!coveredVectors.has(vector)) {
          release();

          throw new RenderFault(
            "style-revision-stale",
            "A stylesheet vector was retained after this revision was staged; prepare it again before publishing",
          );
        }
      }

      const nextFor = (group: PhysicalStyleGroup) => attempt.staged.get(vectorKey(group));

      const shiftedSelections: { old: RootSelection; next: RootSelection }[] = [];

      const touched = new Set<PhysicalStyleGroup>();

      for (const selection of state.selections.values()) {
        if (selection.group.head !== attempt.head) continue;

        const replacement = nextFor(selection.group);

        if (!replacement || replacement === selection.group) continue;

        replacement.selectedRoots.set(selection.root, state);

        changeActiveRefs(replacement, selection.refs, 1, true);

        const next: RootSelection = {
          root: selection.root,
          refs: new Map(selection.refs),
          group: replacement,
        };

        shiftedSelections.push({ old: selection, next });

        state.selections.set(selection.root, next);

        touched.add(replacement);
      }

      const shiftedLeases: { lease: LeaseRecord; old: PhysicalStyleGroup }[] = [];

      for (const lease of state.leases) {
        if (lease.role === "revision" || lease.group.head !== attempt.head) continue;

        const replacement = nextFor(lease.group);

        if (!replacement || replacement === lease.group) continue;

        replacement.retained++;
        lease.group.retained--;

        shiftedLeases.push({ lease, old: lease.group });

        lease.group.leases.delete(lease);

        replacement.leases.add(lease);

        lease.group = replacement;

        touched.add(replacement);
      }

      for (const { old } of shiftedSelections) {
        changeActiveRefs(old.group, old.refs, -1, true);

        old.group.selectedRoots.delete(old.root);

        touched.add(old.group);
      }

      for (const { old } of shiftedLeases) touched.add(old);

      state.plan = attempt.next;

      state.version++;

      attempt.published = true;

      for (const group of touched) {
        for (const { id } of group.styles) {
          const enabled = (group.activeRefs.get(id) ?? 0) > 0;

          if (group.enabled.get(id) !== enabled) setLinkEnabled(group, id, enabled);
        }
      }

      release();

      for (const { old } of shiftedSelections) maybeCollectGroup(old.group);

      for (const { old } of shiftedLeases) maybeCollectGroup(old);
    },

    release,
  };
}

function removeRevisionAbortListener(attempt: RevisionAttempt): void {
  const listener = attempt.abortListener;

  if (!listener) return;

  attempt.signal?.removeEventListener("abort", listener);

  attempt.abortListener = undefined;
}

class StyleRuntime implements InternalStyleRuntime {
  private readonly state: RuntimeState;

  constructor(plan: CompiledStylePlan) {
    this.state = {
      plan: normalizePlan(plan),
      version: 0,
      revisionAttemptId: 0,
      leases: new Set(),
      owners: new Map(),
      selections: new Map(),
      releaseBoundRoots: new WeakSet(),
      revisions: new Set(),
      committed: (owner, ownerId) => this.committed(owner, ownerId),
      suspended: (owner, ownerId) => this.suspended(owner, ownerId),
      resumed: (owner, ownerId) => this.resumed(owner, ownerId),
      released: (owner, ownerId) => this.released(owner, ownerId),
    };
  }

  bindEntry(
    definition: Function,
    entryId: StyleEntryId,
    documentCompositionId?: StyleCompositionId,
  ): void {
    const state = this.state;

    if (!state.plan.entries.has(entryId))
      throw new RenderFault("style-entry-binding", `Unknown stylesheet entry ${entryId}`);

    if (documentCompositionId && !state.plan.compositions.has(documentCompositionId))
      throw new RenderFault(
        "style-entry-binding",
        `Unknown Document composition ${documentCompositionId}`,
      );

    const next: EntryMountBinding = {
      runtime: this,
      entryId,
      ...(documentCompositionId ? { documentCompositionId } : {}),
    };

    const current = entryMountBindings.get(definition);

    if (current) {
      if (
        current.runtime === this &&
        current.entryId === entryId &&
        current.documentCompositionId === documentCompositionId
      )
        return;

      throw new RenderFault(
        "style-entry-binding",
        "A compiled component is already bound to a different style runtime or entry",
      );
    }

    entryMountBindings.set(definition, next);
  }

  preloadEntry(entryId: StyleEntryId, head: HTMLHeadElement): Promise<PreparedStyleGroupLease> {
    const closure = this.state.plan.entries.get(entryId);

    if (!closure)
      return Promise.reject(new RenderFault("style-entry", `Unknown stylesheet entry ${entryId}`));

    return this.prepareReadyLease(head, closure, "preload");
  }

  prepareDirectTarget(entryId: StyleEntryId, head: HTMLHeadElement): TargetEntryPreparation {
    const closure = this.state.plan.entries.get(entryId);

    if (!closure) throw new RenderFault("style-entry", `Unknown stylesheet entry ${entryId}`);

    const group = groupFor(this.state, head, closure);

    const record = retainGroup(this.state, group, "direct");

    const settled = group.ready.then(() => undefined);

    void settled.catch(() => undefined);

    return {
      ready:
        group.status === "ready" &&
        group.links.every(
          (link, index) => link.sheet !== null || group.styles[index]?.link?.disabled === true,
        ),
      settled,
      activate: (rootOwner) => {
        if (record.released)
          throw new RenderFault("style-lease", "A released stylesheet lease cannot activate");

        activateGroup(this.state, record.group, rootOwner);
      },
      release: () => releaseRecord(record),
    };
  }

  async prepareInstalledHead(
    compositionId: StyleCompositionId,
    head: HTMLHeadElement,
    signal?: AbortSignal,
  ): Promise<PreparedStyleGroupLease> {
    const composition = this.state.plan.compositions.get(compositionId);

    if (!composition)
      throw new RenderFault("style-composition", `Unknown stylesheet composition ${compositionId}`);

    const group = groupFor(this.state, head, composition.styles);

    const record = retainGroup(this.state, group, "composition");

    try {
      await waitWithSignal(group.ready, signal);

      if (signal?.aborted) throw signal.reason;

      if (!isCurrentHead(head))
        throw new RenderFault(
          "style-composition-head",
          "The installed stylesheet head changed during preparation",
        );

      return createLease(record);
    } catch (error) {
      releaseRecord(record);

      throw error;
    }
  }

  bindStyles(owner: Owner, ownerId: StyleOwnerId): void {
    owner.assertActive();

    const styles = this.state.plan.owners.get(ownerId);

    if (!styles) throw new RenderFault("style-owner", `Unknown stylesheet owner ${ownerId}`);

    const current = this.state.owners.get(owner);

    if (current) {
      if (current.ownerId === ownerId) return;

      throw new RenderFault(
        "style-owner-binding",
        "An Owner is already bound to a different style definition",
      );
    }

    const binding: OwnerBindingRecord = {
      owner,
      ownerId,
      root: findRoot(owner),
      styles,
      active: false,
    };

    owner.bindStyleLifecycle(this.state, ownerId);

    this.state.owners.set(owner, binding);
  }

  committed(owner: Owner, ownerId: string): void {
    const binding = this.requireOwner(owner, ownerId);

    if (binding.active) return;

    binding.active = true;

    updateOwnerRefs(this.state, binding, 1);
  }

  suspended(owner: Owner, ownerId: string): void {
    const binding = this.requireOwner(owner, ownerId);

    if (!binding.active) return;

    binding.active = false;

    updateOwnerRefs(this.state, binding, -1);
  }

  resumed(owner: Owner, ownerId: string): void {
    const binding = this.requireOwner(owner, ownerId);

    if (binding.active) return;

    binding.active = true;

    updateOwnerRefs(this.state, binding, 1);
  }

  released(owner: Owner, ownerId: string): void {
    const binding = this.requireOwner(owner, ownerId);

    if (binding.active) {
      binding.active = false;

      updateOwnerRefs(this.state, binding, -1);
    }

    this.state.owners.delete(owner);
  }

  async prepareRevision(
    nextPlan: CompiledStylePlan,
    head: HTMLHeadElement,
    signal?: AbortSignal,
  ): Promise<PreparedStyleRevision> {
    const state = this.state;

    const next = normalizePlan(nextPlan);

    assertSameTopology(state.plan, next);

    if (signal?.aborted)
      throw signal.reason ?? new RenderFault("cancelled", "Stylesheet revision was aborted");

    for (const prior of state.revisions) {
      prior.cancel(
        new RenderFault(
          "style-revision-superseded",
          "A newer stylesheet revision superseded this one",
        ),
      );
    }

    const id = ++state.revisionAttemptId;

    const staged = new Map<string, PhysicalStyleGroup>();

    const stagedLeases: LeaseRecord[] = [];

    let attempt!: RevisionAttempt;
    let rejectCancelled!: (error: unknown) => void;

    const cancelled = new Promise<never>((_resolve, reject) => {
      rejectCancelled = reject;
    });

    void cancelled.catch(() => undefined);

    const cancel = (error: unknown): void => {
      if (!attempt.active) return;

      attempt.active = false;

      state.revisions.delete(attempt);

      removeRevisionAbortListener(attempt);

      for (const lease of stagedLeases) releaseRecord(lease);

      attempt.cancelReason = error;

      attempt.rejectCancelled(error);
    };

    const onAbort = (): void =>
      cancel(signal?.reason ?? new RenderFault("cancelled", "Stylesheet revision was aborted"));

    attempt = {
      id,
      state,
      head,
      next,
      baseVersion: state.version,
      staged,
      stagedLeases,
      cancelled,
      rejectCancelled,
      ...(signal ? { signal, abortListener: onAbort } : {}),
      active: true,
      published: false,
      cancel,
      cancelReason: undefined,
    };

    state.revisions.add(attempt);

    signal?.addEventListener("abort", onAbort, { once: true });

    const vectors = new Map<string, readonly StyleId[]>();

    for (const lease of state.leases) {
      if (lease.role !== "revision" && lease.group.head === head) {
        vectors.set(
          JSON.stringify(lease.group.styles.map(({ id: styleId }) => styleId)),
          lease.group.styles.map(({ id: styleId }) => styleId),
        );
      }
    }

    for (const selection of state.selections.values()) {
      if (selection.group.head === head) {
        vectors.set(
          JSON.stringify(selection.group.styles.map(({ id: styleId }) => styleId)),
          selection.group.styles.map(({ id: styleId }) => styleId),
        );
      }
    }

    try {
      const waits: Promise<void>[] = [];

      for (const [vectorKey, ids] of vectors) {
        const group = groupFor(state, head, ids, next);

        staged.set(vectorKey, group);

        stagedLeases.push(retainGroup(state, group, "revision"));

        waits.push(group.ready);
      }

      await Promise.race([
        waitWithSignal(
          Promise.all(waits).then(() => undefined),
          signal,
        ),
        cancelled,
      ]);

      if (!attempt.active) throw attempt.cancelReason;

      if (!isCurrentHead(head))
        throw new RenderFault("style-revision-head", "The stylesheet revision target head changed");

      return makeRevisionHandle(attempt);
    } catch (error) {
      cancel(error);

      throw error;
    }
  }

  private async prepareReadyLease(
    head: HTMLHeadElement,
    styles: readonly StyleId[],
    role: "preload" | "composition",
  ): Promise<PreparedStyleGroupLease> {
    const group = groupFor(this.state, head, styles);

    const record = retainGroup(this.state, group, role);

    try {
      await group.ready;

      if (record.released)
        throw new RenderFault(
          "style-lease",
          "Stylesheet preparation was released before readiness",
        );

      if (!isCurrentHead(head))
        throw new RenderFault(
          "style-head-replaced",
          "The stylesheet head changed during preparation",
        );

      return createLease(record);
    } catch (error) {
      releaseRecord(record);

      throw error;
    }
  }

  private requireOwner(owner: Owner, ownerId: string): OwnerBindingRecord {
    const binding = this.state.owners.get(owner);

    if (!binding || binding.ownerId !== ownerId)
      throw new RenderFault(
        "style-owner",
        "Owner style lifecycle does not match its registered definition",
      );

    return binding;
  }
}

/** Create the plan-scoped runtime used by generated module preludes and factories. */
export function createInternalStyleRuntime(plan: CompiledStylePlan): InternalStyleRuntime {
  return new StyleRuntime(plan);
}

/** Resolve a generated component's private stylesheet entry for public mount(). */
export function internalStyleBindingFor(definition: Function): EntryMountBinding | undefined {
  return entryMountBindings.get(definition);
}
