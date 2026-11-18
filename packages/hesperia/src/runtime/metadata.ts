import { Signal } from "aeolia";
import { captureActualReactiveCall, createClient } from "../client.ts";
import type { ActualReactiveConstruction, Derived } from "../client.ts";
import {
  registerOwnerResourceLifecycle,
  RenderFault,
  reportFault,
  type Owner,
  type RuntimeContext,
} from "./owner.ts";

/** @internal One scalar HTML metadata attribute. */
export type MetadataAttributeValue = string | number | bigint | boolean | null | undefined;
/** @internal Literal attributes for one managed metadata row. */
export type MetadataAttributeRecord = Readonly<Record<string, MetadataAttributeValue>>;
/** @internal One component-owned metadata contribution. */
export interface MetadataValue {
  readonly title?: string;
  readonly meta?: readonly MetadataAttributeRecord[];
  readonly link?: readonly MetadataAttributeRecord[];
}
/** @internal Fixed metadata or its synchronous tracked reader. */
export type MetadataInput = MetadataValue | (() => MetadataValue);

/** @internal A metadata field selected by the runtime resolver. */
export type MetadataField = "title" | "meta" | "link";

/** @internal Literal, normalized attribute input passed to native head writers. */
export type MetadataAttributePair = readonly [name: string, value: string | null];

/** @internal One actual Owner-owned meta or link row. */
export interface ResolvedMetadataElement {
  /** Actual Owner whose registration supplied this row. */
  readonly owner: Owner;
  /** Stable native claim address derived from compiler occurrence and actual local rank. */
  readonly occurrence: string;
  /** Immutable literal attribute pairs; null removes that named attribute. */
  readonly attributes: readonly MetadataAttributePair[];
}

/** @internal Current title and managed element rows for one actual visible view. */
export interface ResolvedMetadata {
  /** Selected title, omitted when the visible Owner set has no valid title. */
  readonly title?: string;
  /** Ordered managed meta rows from the current field winner or retained publication. */
  readonly meta: readonly ResolvedMetadataElement[];
  /** Ordered managed link rows from the current field winner or retained publication. */
  readonly link: readonly ResolvedMetadataElement[];
}

/** @internal Distinguish browser dispatch eligibility from visible server output. */
export type MetadataProjectionMode = "browser" | "server";

/** @internal Prepared synchronous reader bound to one actual computed. */
export interface PreparedMetadataSource {
  /** Validated snapshot callback passed to one actual Client.derived construction. */
  readonly compute: () => MetadataValue;
}

/** @internal The authored input class and Core-normalized value at one actual call. */
export type MetadataSourceCallInput =
  | Readonly<{ readonly kind: "fixed"; readonly value: MetadataValue }>
  | Readonly<{ readonly kind: "reader" }>;

/** @internal One exact performed call joined to Core registration and call-time input. */
export interface MetadataSourceCall {
  /** Actual Owner-local registration and source receipt for this performed call. */
  readonly registration: MetadataRegistration;
  /** Fixed Core-normalized snapshot or a reader marker; callbacks are not exposed or invoked. */
  readonly input: MetadataSourceCallInput;
}

/** @internal Actual source receipt plus stable Owner-local rank. */
export interface MetadataRegistration {
  /** Actual Owner that owns the source and its lifetime. */
  readonly owner: Owner;
  /** Genuine first-party derived construction receipt issued for this Owner. */
  readonly receipt: ActualReactiveConstruction;
  /** Compiler call-site address used only for stable native nodes. */
  readonly occurrence: string;
  /** Actual registration position within this Owner. */
  readonly rank: number;
}

interface MetadataCandidateFields {
  readonly title?: { readonly value: string };
  readonly meta?: { readonly rows: readonly (readonly MetadataAttributePair[])[] };
  readonly link?: { readonly rows: readonly (readonly MetadataAttributePair[])[] };
}

interface MetadataCandidate {
  readonly value: MetadataValue;
  readonly fields: MetadataCandidateFields;
}

interface MetadataOutcome {
  readonly token: object;
  readonly candidate?: MetadataCandidate;
  readonly sourceValue?: unknown;
  readonly failed: boolean;
  readonly failure?: unknown;
}

interface PreparedMetadataState {
  readonly prepared: PreparedMetadataSource;
  readonly compute: () => MetadataValue;
  readonly callInput: MetadataSourceCallInput;
  current?: MetadataOutcome;
  registration?: MetadataRegistrationState;
}

interface MetadataRegistrationState extends MetadataRegistration {
  readonly prepared: PreparedMetadataState;
  active: boolean;
  lastValid?: MetadataCandidate;
  deliveredOutcome?: object;
}

interface MetadataFieldCandidate {
  readonly registration: MetadataRegistrationState;
  readonly value: string | readonly ResolvedMetadataElement[];
}

interface MetadataPublishedField {
  readonly registration: MetadataRegistrationState;
  readonly candidate: MetadataFieldCandidate;
}

interface MetadataPublicationState {
  readonly publications: Map<MetadataField, MetadataPublishedField>;
  readonly winners: Map<MetadataField, MetadataRegistrationState>;
  readonly conflicts: Map<MetadataField, ReadonlySet<MetadataRegistrationState>>;
}

interface MetadataProjection {
  readonly scopeOwner: Owner;
  readonly readVisibleOwners: () => readonly Owner[];
  readonly apply: (metadata: ResolvedMetadata) => void;
  active: boolean;
  running: boolean;
  pending: boolean;
}

const preparedStates = new WeakMap<PreparedMetadataSource, PreparedMetadataState>();
const preparedByCompute = new WeakMap<Function, PreparedMetadataState>();
const registrationsByOwner = new WeakMap<Owner, Set<MetadataRegistrationState>>();
const registrationsBySource = new WeakMap<object, MetadataRegistrationState>();
const nextRankByOwner = new WeakMap<Owner, number>();
const publicationByScope = new WeakMap<Owner, MetadataPublicationState>();
const projectionsByScope = new WeakMap<Owner, Set<MetadataProjection>>();
const projectionsByContext = new WeakMap<RuntimeContext, Set<MetadataProjection>>();

const emptyRows: readonly ResolvedMetadataElement[] = Object.freeze([]);

function invalidMetadata(message: string): TypeError {
  return new TypeError("HES-METADATA: " + message);
}

function ownDataEntries(value: unknown, label: string): readonly (readonly [string, unknown])[] {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw invalidMetadata(label + " must be a plain object");

  const prototype = Object.getPrototypeOf(value);

  if (prototype !== Object.prototype && prototype !== null)
    throw invalidMetadata(label + " must be a plain object");

  const entries: (readonly [string, unknown])[] = [];

  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") throw invalidMetadata(label + " cannot contain symbol properties");

    const descriptor = Object.getOwnPropertyDescriptor(value, key);

    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, "value"))
      throw invalidMetadata(label + " properties must be enumerable data properties");

    entries.push(Object.freeze([key, descriptor.value] as const));
  }

  return Object.freeze(entries);
}

const invalidMetadataAttributeName = /[\s"'<>/=]/u;

function hasMetadataControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);

    if (code <= 0x1f || code === 0x7f) return true;
  }

  return false;
}

function normalizeAttributeValue(name: string, value: unknown): string | null {
  if (
    value !== null &&
    value !== undefined &&
    typeof value !== "string" &&
    typeof value !== "number" &&
    typeof value !== "bigint" &&
    typeof value !== "boolean"
  )
    throw invalidMetadata("attribute " + name + " must have a scalar value");

  if (value === null || value === undefined) return null;
  if (typeof value === "boolean") {
    if (name.toLowerCase().startsWith("aria-")) return String(value);

    return value ? "" : null;
  }

  return String(value);
}

function snapshotAttributes(value: unknown, label: string): readonly MetadataAttributePair[] {
  const values = new Map<string, string | null>();

  for (const [originalName, attributeValue] of ownDataEntries(value, label)) {
    const name = originalName.toLowerCase();

    // Match the native HTML serializer's rejected characters and reserve its generated address.
    if (!name || invalidMetadataAttributeName.test(name) || hasMetadataControlCharacter(name))
      throw invalidMetadata(label + " contains an invalid attribute name");

    if (name === "data-hesperia-key")
      throw invalidMetadata(label + " cannot set reserved data-hesperia-key");

    values.set(name, normalizeAttributeValue(name, attributeValue));
  }

  return Object.freeze([...values].map(([name, value]) => Object.freeze([name, value] as const)));
}

function snapshotAttributeRows(
  value: unknown,
  field: "meta" | "link",
): readonly (readonly MetadataAttributePair[])[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw invalidMetadata(field + " must be an attribute-record array");

  for (const key of Reflect.ownKeys(value)) {
    if (key === "length") continue;

    if (typeof key !== "string" || !/^\d+$/.test(key) || Number(key) >= value.length)
      throw invalidMetadata(field + " cannot contain extra array properties");
  }

  const rows: (readonly MetadataAttributePair[])[] = [];

  for (let index = 0; index < value.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));

    if (!descriptor || !Object.hasOwn(descriptor, "value"))
      throw invalidMetadata(field + " cannot contain sparse rows");

    rows.push(snapshotAttributes(descriptor.value, field + "[" + index + "]"));
  }

  return Object.freeze(rows);
}

function copyAttributeRecord(pairs: readonly MetadataAttributePair[]): MetadataAttributeRecord {
  const record: Record<string, MetadataAttributeRecord[string]> = Object.create(null) as Record<
    string,
    MetadataAttributeRecord[string]
  >;

  for (const [name, value] of pairs) {
    Object.defineProperty(record, name, {
      value,
      enumerable: true,
      configurable: false,
      writable: false,
    });
  }

  return Object.freeze(record);
}

function snapshotCandidate(value: unknown): MetadataCandidate {
  const entries = ownDataEntries(value, "metadata");
  const input = new Map(entries);

  for (const key of input.keys()) {
    if (key !== "title" && key !== "meta" && key !== "link")
      throw invalidMetadata("metadata supports only title, meta, and link");
  }

  const titleValue = input.get("title");
  let title: { readonly value: string } | undefined;

  if (titleValue !== undefined) {
    if (typeof titleValue !== "string") throw invalidMetadata("title must be a string");
    title = Object.freeze({ value: titleValue });
  }

  const metaRows = snapshotAttributeRows(input.get("meta"), "meta");
  const linkRows = snapshotAttributeRows(input.get("link"), "link");
  const fields: {
    title?: { readonly value: string };
    meta?: { readonly rows: readonly (readonly MetadataAttributePair[])[] };
    link?: { readonly rows: readonly (readonly MetadataAttributePair[])[] };
  } = {};
  const publicValue: {
    title?: string;
    meta?: readonly MetadataAttributeRecord[];
    link?: readonly MetadataAttributeRecord[];
  } = {};

  if (title) {
    fields.title = title;
    publicValue.title = title.value;
  }

  if (metaRows !== undefined) {
    fields.meta = Object.freeze({ rows: metaRows });
    publicValue.meta = Object.freeze(metaRows.map(copyAttributeRecord));
  }

  if (linkRows !== undefined) {
    fields.link = Object.freeze({ rows: linkRows });
    publicValue.link = Object.freeze(linkRows.map(copyAttributeRecord));
  }

  return Object.freeze({
    value: Object.freeze(publicValue),
    fields: Object.freeze(fields),
  });
}

/**
 * @internal Prepare a synchronous fixed value or callback for one real derived construction.
 * @param input Fixed metadata or its synchronous reader.
 * @returns A receiver whose compute function can be used by one actual derived source.
 * @throws {TypeError} When a fixed candidate is invalid; reader candidates fail on evaluation.
 */
export function prepareMetadataSource(input: MetadataInput): PreparedMetadataSource {
  const fixed = typeof input === "function" ? undefined : snapshotCandidate(input);
  const reader = typeof input === "function" ? input : undefined;
  const callInput: MetadataSourceCallInput = fixed
    ? Object.freeze({ kind: "fixed" as const, value: fixed.value })
    : Object.freeze({ kind: "reader" as const });
  const state = {} as PreparedMetadataState;

  const compute = (): MetadataValue => {
    const token = {};
    let candidate: MetadataCandidate;

    try {
      candidate = fixed ?? snapshotCandidate(reader!());
    } catch (failure) {
      state.current = Object.freeze({ token, failed: true, failure });

      throw failure;
    }

    state.current = Object.freeze({
      token,
      candidate,
      sourceValue: candidate.value,
      failed: false,
    });

    if (state.registration && isRegistrationAvailable(state.registration))
      state.registration.lastValid = candidate;

    return candidate.value;
  };

  const prepared: PreparedMetadataSource = Object.freeze({ compute });
  Object.assign(state, { prepared, compute, callInput });
  preparedStates.set(prepared, state);
  preparedByCompute.set(compute, state);

  return prepared;
}

/**
 * @internal Register only the actual Owner-bound computed returned by createRuntimeClient.
 * @param owner The real component Owner.
 * @param receipt The source receipt returned by captureActualReactiveCall.
 * @param prepared The exact prepared callback passed to the derived constructor.
 * @param occurrence Stable compiler call-site address for native claim nodes.
 * @returns The Owner-local registration with its fixed local rank.
 * @throws {RenderFault} If the Owner, receipt, callback, or occurrence is inconsistent.
 */
export function registerMetadataSource(
  owner: Owner,
  receipt: ActualReactiveConstruction,
  prepared: PreparedMetadataSource,
  occurrence = "metadata",
): MetadataRegistration {
  owner.assertActive();

  const state = preparedStates.get(prepared);

  if (
    !state ||
    receipt.owner !== owner ||
    receipt.kind !== "derived" ||
    receipt.source !== receipt.construction.source ||
    receipt.arguments[0] !== prepared.compute ||
    preparedByCompute.get(receipt.arguments[0] as Function) !== state ||
    state.registration
  )
    throw new RenderFault(
      "metadata-source",
      "Metadata registration requires its exact actual Owner-bound derived source",
    );

  if (typeof occurrence !== "string" || occurrence.length === 0)
    throw new RenderFault("metadata-source", "Metadata source requires a stable occurrence");

  const rank = nextRankByOwner.get(owner) ?? 0;
  nextRankByOwner.set(owner, rank + 1);

  const registration: MetadataRegistrationState = {
    owner,
    receipt,
    occurrence,
    rank,
    prepared: state,
    active: true,
  };
  state.registration = registration;

  const registrations = registrationsByOwner.get(owner) ?? new Set<MetadataRegistrationState>();
  registrations.add(registration);
  registrationsByOwner.set(owner, registrations);

  const unregisterLifecycle = registerOwnerResourceLifecycle(owner, {
    suspended: () => refreshMetadataProjectionsForContext(owner.context),
    resumed: () => refreshMetadataProjectionsForContext(owner.context),
  });

  const unregister = (): void => {
    if (!registration.active) return;

    registration.active = false;
    unregisterLifecycle();
    registrations.delete(registration);

    if (registrationsBySource.get(receipt.accessor) === registration)
      registrationsBySource.delete(receipt.accessor);

    if (registrations.size === 0 && registrationsByOwner.get(owner) === registrations)
      registrationsByOwner.delete(owner);

    refreshMetadataProjectionsForContext(owner.context);
  };

  owner.onRelease(unregister);
  registrationsBySource.set(receipt.accessor, registration);

  return registration;
}

/**
 * @internal Read the call-time normalized state for one exact actual metadata Derived.
 * @param owner The actual Owner that created the metadata call.
 * @param source The exact Derived returned by createMetadataSource for that performed call.
 * @returns Its Core registration and fixed normalized candidate, or a reader marker.
 * @throws {RenderFault} When source is not the exact active metadata construction for owner.
 */
export function readMetadataSourceCall(
  owner: Owner,
  source: unknown,
): MetadataSourceCall {
  owner.assertActive();

  if (typeof source !== "function")
    throw new RenderFault(
      "metadata-source",
      "Metadata call lookup requires its actual Derived accessor",
    );

  const registration = registrationsBySource.get(source);

  if (
    !registration ||
    !registration.active ||
    registration.owner !== owner ||
    registration.receipt.owner !== owner ||
    registration.receipt.kind !== "derived" ||
    registration.receipt.accessor !== source ||
    registration.prepared.registration !== registration ||
    !registrationsByOwner.get(owner)?.has(registration)
  )
    throw new RenderFault(
      "metadata-source",
      "Metadata call lookup requires its exact active Owner-bound registration",
    );

  return Object.freeze({
    registration,
    input: registration.prepared.callInput,
  });
}

/**
 * @internal Read the actual occurrence order for compiler-recorded Owner restoration.
 * @param owner The live actual Owner whose sources were registered.
 * @returns Frozen compiler occurrence IDs in actual registration order, with duplicates.
 * @throws {RenderFault} When the Owner is no longer active.
 */
export function readMetadataRegistrationOrder(owner: Owner): readonly string[] {
  owner.assertActive();

  return Object.freeze(
    [...(registrationsByOwner.get(owner) ?? [])]
      .filter((registration) => registration.active)
      .map((registration) => registration.occurrence),
  );
}

/**
 * @internal Read one exact source cache and deliver each actual failed computation through its Owner once.
 * @param registration The actual source registration.
 * @returns The validated current or last-valid candidate, or undefined before its first valid read.
 * @throws If the Owner error route throws while reporting a source failure.
 */
export function readMetadataSource(registration: MetadataRegistration): MetadataValue | undefined {
  const current = registration as MetadataRegistrationState;

  if (!current.active) return current.lastValid?.value;

  let sourceValue: unknown;

  try {
    sourceValue = current.receipt.source.get();
  } catch (caught) {
    let outcome = current.prepared.current;

    if (!outcome || !outcome.failed || Object.hasOwn(outcome, "sourceValue")) {
      outcome = Object.freeze({ token: {}, failed: true, failure: caught });
      current.prepared.current = outcome;
    }

    if (current.deliveredOutcome !== outcome.token) {
      current.deliveredOutcome = outcome.token;
      reportFault(current.owner, outcome.failure);
    }

    return current.lastValid?.value;
  }

  let outcome = current.prepared.current;

  if (outcome?.failed && outcome.sourceValue === sourceValue) return current.lastValid?.value;

  if (!outcome || outcome.failed || outcome.sourceValue !== sourceValue) {
    let candidate: MetadataCandidate;

    try {
      candidate = snapshotCandidate(sourceValue);
    } catch (failure) {
      outcome = Object.freeze({ token: {}, sourceValue, failed: true, failure });
      current.prepared.current = outcome;

      if (current.deliveredOutcome !== outcome.token) {
        current.deliveredOutcome = outcome.token;
        reportFault(current.owner, failure);
      }

      return current.lastValid?.value;
    }

    outcome = Object.freeze({
      token: {},
      candidate,
      sourceValue: sourceValue as MetadataValue,
      failed: false,
    });
    current.prepared.current = outcome;
  }

  if (outcome.candidate) {
    if (isRegistrationAvailable(current)) current.lastValid = outcome.candidate;

    return outcome.candidate.value;
  }

  return current.lastValid?.value;
}

/**
 * @internal Read one source in its own Scheduler effect, then refresh native projections untracked.
 * @param registration The actual source registration whose dependencies this effect observes.
 * @returns Nothing.
 * @throws If the Owner error route or a native projection throws.
 */
export function publishMetadataSource(registration: MetadataRegistration): void {
  readMetadataSource(registration);

  Signal.subtle.untrack(() => refreshMetadataProjectionsForContext(registration.owner.context));
}

function isRegistrationAvailable(registration: MetadataRegistrationState): boolean {
  return (
    registration.active &&
    registration.owner.state !== "cleaning" &&
    registration.owner.state !== "destroyed" &&
    registration.owner.isDispatchEligible()
  );
}

function isAncestor(ancestor: Owner, descendant: Owner): boolean {
  for (let current: Owner | null = descendant; current; current = current.parent) {
    if (current === ancestor) return true;
  }

  return false;
}

function isEligibleOwner(
  owner: Owner,
  scopeOwner: Owner,
  mode: MetadataProjectionMode,
): boolean {
  if (owner.context !== scopeOwner.context || !owner.isDispatchEligible()) return false;

  if (mode === "server")
    return (
      owner.context.target === "server" && (owner.state === "building" || owner.state === "mounted")
    );

  return owner.context.target !== "server" && owner.isCommitted();
}

function visibleOwnersFor(
  scopeOwner: Owner,
  actualVisibleOwners: readonly Owner[],
  mode: MetadataProjectionMode,
): readonly Owner[] {
  if (!isEligibleOwner(scopeOwner, scopeOwner, mode)) return [];

  const owners = new Set<Owner>([scopeOwner]);

  for (const visibleOwner of actualVisibleOwners) {
    if (visibleOwner.context !== scopeOwner.context || !isAncestor(scopeOwner, visibleOwner))
      throw new RenderFault(
        "metadata-view",
        "Visible metadata Owners must belong to the actual projection scope",
      );

    const lineage: Owner[] = [];

    for (
      let current: Owner | null = visibleOwner;
      current && isAncestor(scopeOwner, current);
      current = current.parent
    ) {
      lineage.push(current);

      if (current === scopeOwner) break;
    }

    for (const owner of lineage.reverse())
      if (isEligibleOwner(owner, scopeOwner, mode)) owners.add(owner);
  }

  return Object.freeze([...owners]);
}

function rowOccurrence(
  registration: MetadataRegistrationState,
  field: "meta" | "link",
  index: number,
): string {
  return registration.occurrence + "/" + registration.rank + "/" + field + "/" + index;
}

function fieldCandidate(
  registration: MetadataRegistrationState,
  candidate: MetadataCandidate,
  field: MetadataField,
): MetadataFieldCandidate | undefined {
  if (field === "title") {
    const title = candidate.fields.title;

    return title ? { registration, value: title.value } : undefined;
  }

  const rows = field === "meta" ? candidate.fields.meta?.rows : candidate.fields.link?.rows;

  if (!rows) return undefined;

  return {
    registration,
    value: Object.freeze(
      rows.map((attributes, index) =>
        Object.freeze({
          owner: registration.owner,
          occurrence: rowOccurrence(registration, field, index),
          attributes,
        }),
      ),
    ),
  };
}

function candidateForOwner(
  registrations: ReadonlySet<MetadataRegistrationState> | undefined,
  field: MetadataField,
): MetadataFieldCandidate | undefined {
  if (!registrations) return undefined;

  let selected: MetadataFieldCandidate | undefined;

  for (const registration of registrations) {
    if (!registration.active || !registration.lastValid) continue;

    const candidate = fieldCandidate(registration, registration.lastValid, field);

    if (candidate && (!selected || candidate.registration.rank > selected.registration.rank))
      selected = candidate;
  }

  return selected;
}

function sameRegistrationSet(
  left: ReadonlySet<MetadataRegistrationState> | undefined,
  right: ReadonlySet<MetadataRegistrationState>,
): boolean {
  if (!left || left.size !== right.size) return false;

  for (const registration of right) if (!left.has(registration)) return false;

  return true;
}

function conflictOwner(
  scopeOwner: Owner,
  contenders: readonly MetadataFieldCandidate[],
): Owner {
  const first = contenders[0]?.registration.owner;

  if (!first) return scopeOwner;

  for (let current: Owner | null = first; current; current = current.parent) {
    if (current.context !== scopeOwner.context) continue;

    if (contenders.every((candidate) => isAncestor(current!, candidate.registration.owner)))
      return current;
  }

  return scopeOwner;
}

function makeConflictFault(field: MetadataField): RenderFault {
  return new RenderFault(
    "metadata-conflict",
    "Unrelated components supplied conflicting " + field + " metadata",
  );
}

function publicationIsEligible(
  publication: MetadataPublishedField | undefined,
  visibleOwners: ReadonlySet<Owner>,
  scopeOwner: Owner,
  mode: MetadataProjectionMode,
  field: MetadataField,
): publication is MetadataPublishedField {
  if (!publication) return false;

  const registration = publication.registration;

  return (
    registration.active &&
    visibleOwners.has(registration.owner) &&
    isEligibleOwner(registration.owner, scopeOwner, mode) &&
    Boolean(registration.lastValid && fieldCandidate(registration, registration.lastValid, field))
  );
}

function resolveField(
  scopeOwner: Owner,
  state: MetadataPublicationState,
  visibleOwners: readonly Owner[],
  field: MetadataField,
  mode: MetadataProjectionMode,
): MetadataFieldCandidate | undefined {
  const ownerSet = new Set(visibleOwners);
  const ownerCandidates = visibleOwners
    .filter((owner) => isEligibleOwner(owner, scopeOwner, mode))
    .map((owner) => candidateForOwner(registrationsByOwner.get(owner), field))
    .filter((candidate): candidate is MetadataFieldCandidate => candidate !== undefined);
  const maximal = ownerCandidates.filter(
    (candidate) =>
      !ownerCandidates.some(
        (other) =>
          other !== candidate &&
          other.registration.owner !== candidate.registration.owner &&
          isAncestor(candidate.registration.owner, other.registration.owner),
      ),
  );

  if (maximal.length > 1) {
    const conflicts = new Set(maximal.map((candidate) => candidate.registration));
    const previousConflict = state.conflicts.get(field);

    state.winners.delete(field);

    if (!sameRegistrationSet(previousConflict, conflicts)) {
      state.conflicts.set(field, conflicts);
      reportFault(conflictOwner(scopeOwner, maximal), makeConflictFault(field));
    }

    const previous = state.publications.get(field);

    if (publicationIsEligible(previous, ownerSet, scopeOwner, mode, field))
      return previous.candidate;

    state.publications.delete(field);

    return undefined;
  }

  state.conflicts.delete(field);

  const winner = maximal[0];

  if (winner) {
    state.winners.set(field, winner.registration);
    state.publications.set(field, {
      registration: winner.registration,
      candidate: winner,
    });

    return winner;
  }

  state.winners.delete(field);
  state.publications.delete(field);

  return undefined;
}

function resolveOnce(
  scopeOwner: Owner,
  visibleOwners: readonly Owner[],
  mode: MetadataProjectionMode,
  readSources: boolean,
): ResolvedMetadata {
  let state = publicationByScope.get(scopeOwner);

  if (!state) {
    state = {
      publications: new Map(),
      winners: new Map(),
      conflicts: new Map(),
    };
    publicationByScope.set(scopeOwner, state);
  }

  if (readSources) {
    for (const owner of visibleOwners) {
      for (const registration of registrationsByOwner.get(owner) ?? []) {
        if (!registration.active) continue;

        readMetadataSource(registration);
      }
    }
  }

  const title = resolveField(scopeOwner, state, visibleOwners, "title", mode);
  const meta = resolveField(scopeOwner, state, visibleOwners, "meta", mode);
  const link = resolveField(scopeOwner, state, visibleOwners, "link", mode);

  return Object.freeze({
    ...(title ? { title: title.value as string } : {}),
    meta: (meta?.value as readonly ResolvedMetadataElement[] | undefined) ?? emptyRows,
    link: (link?.value as readonly ResolvedMetadataElement[] | undefined) ?? emptyRows,
  });
}

/**
 * @internal Resolve sources belonging to the actual visible Owner ancestry and current target.
 * @param scopeOwner Actual document or server-session Owner for the projection.
 * @param actualVisibleOwners Owner instances derived from the actual installed view or server output.
 * @param mode Browser eligibility or same-session server output visibility.
 * @returns A frozen selection with field provenance retained privately.
 * @throws {RenderFault} For an inconsistent Owner set or an unhandled metadata conflict.
 */
function resolveForOwners(
  scopeOwner: Owner,
  actualVisibleOwners: readonly Owner[],
  mode: MetadataProjectionMode,
  readSources: boolean,
): ResolvedMetadata {
  const visible = visibleOwnersFor(scopeOwner, actualVisibleOwners, mode);
  const result = resolveOnce(scopeOwner, visible, mode, readSources);
  const stillVisible = visible.filter((owner) => isEligibleOwner(owner, scopeOwner, mode));

  if (stillVisible.length === visible.length) return result;

  return resolveForOwners(scopeOwner, stillVisible, mode, readSources);
}

/** @internal Resolve current source caches for Host and RouteHost selection. */
export function resolveMetadataForOwners(
  scopeOwner: Owner,
  actualVisibleOwners: readonly Owner[],
  mode: MetadataProjectionMode,
): ResolvedMetadata {
  return resolveForOwners(scopeOwner, actualVisibleOwners, mode, true);
}

/** @internal Seed every eligible source cache before publishing a complete browser selection. */
function resolvePublishedMetadataForOwners(
  scopeOwner: Owner,
  actualVisibleOwners: readonly Owner[],
): ResolvedMetadata {
  return resolveForOwners(scopeOwner, actualVisibleOwners, "browser", true);
}

function projectionFor(scopeOwner: Owner): Set<MetadataProjection> | undefined {
  return projectionsByScope.get(scopeOwner);
}

function sameOwnerSet(
  left: readonly Owner[],
  right: readonly Owner[],
): boolean {
  if (left.length !== right.length) return false;

  const rightSet = new Set(right);

  return left.every((owner) => rightSet.has(owner));
}

function runProjection(projection: MetadataProjection): void {
  if (!projection.active) return;

  if (projection.running) {
    projection.pending = true;

    return;
  }

  projection.running = true;

  try {
    do {
      projection.pending = false;
      let owners = projection.readVisibleOwners();

      while (projection.active) {
        const snapshot = resolvePublishedMetadataForOwners(projection.scopeOwner, owners);
        const currentOwners = projection.readVisibleOwners();

        if (sameOwnerSet(owners, currentOwners)) {
          projection.apply(snapshot);
          break;
        }

        owners = currentOwners;
      }
    } while (projection.pending && projection.active);
  } finally {
    projection.running = false;
  }
}

/**
 * @internal Bind one actual document head sink to a provider of the current visible Owner set.
 * @param scopeOwner Actual document Owner that owns the native projection.
 * @param readVisibleOwners Reads the currently installed actual Owner set.
 * @param apply Applies one resolved selection to the native head.
 * @returns Idempotent disposer for this native binding.
 * @throws {RenderFault} When the scope Owner cannot own a browser document head.
 */
export function bindMetadataProjection(
  scopeOwner: Owner,
  readVisibleOwners: () => readonly Owner[],
  apply: (metadata: ResolvedMetadata) => void,
): () => void {
  scopeOwner.assertActive();

  if (scopeOwner.context.target === "server")
    throw new RenderFault("metadata-projection", "Server head projection is owned by the Host");

  if (typeof readVisibleOwners !== "function" || typeof apply !== "function")
    throw new TypeError("HES-METADATA: projection readers must be functions");

  const projection: MetadataProjection = {
    scopeOwner,
    readVisibleOwners,
    apply,
    active: true,
    running: false,
    pending: false,
  };
  const scoped = projectionsByScope.get(scopeOwner) ?? new Set<MetadataProjection>();
  scoped.add(projection);
  projectionsByScope.set(scopeOwner, scoped);

  const contextProjections =
    projectionsByContext.get(scopeOwner.context) ?? new Set<MetadataProjection>();
  contextProjections.add(projection);
  projectionsByContext.set(scopeOwner.context, contextProjections);

  const unregisterLifecycle = registerOwnerResourceLifecycle(scopeOwner, {
    suspended: () => refreshMetadataProjection(scopeOwner),
    resumed: () => refreshMetadataProjection(scopeOwner),
  });

  const dispose = (): void => {
    if (!projection.active) return;

    projection.active = false;
    unregisterLifecycle();
    scoped.delete(projection);
    contextProjections.delete(projection);

    if (scoped.size === 0 && projectionsByScope.get(scopeOwner) === scoped)
      projectionsByScope.delete(scopeOwner);

    if (
      contextProjections.size === 0 &&
      projectionsByContext.get(scopeOwner.context) === contextProjections
    )
      projectionsByContext.delete(scopeOwner.context);
  };

  scopeOwner.onRelease(dispose);

  return dispose;
}

/**
 * @internal Reconcile one actual projection after the Host or RouteHost changes its visible Owner set.
 * @param scopeOwner Actual document Owner whose bound projection must be refreshed.
 * @returns Nothing.
 * @throws If the visible-Owner reader or native projection reports an error.
 */
export function refreshMetadataProjection(scopeOwner: Owner): void {
  Signal.subtle.untrack(() => {
    for (const projection of projectionFor(scopeOwner) ?? []) runProjection(projection);
  });
}

/** Apply initial metadata for actual client-side output after its Owners are known. */
function refreshMetadataProjectionsForContext(context: RuntimeContext): void {
  Signal.subtle.untrack(() => {
    for (const projection of projectionsByContext.get(context) ?? []) runProjection(projection);
  });
}

/** @internal Construct and register the actual Owner-bound metadata Derived and effect. */
export function createMetadataSource(
  owner: Owner,
  input: MetadataInput,
  occurrence: string,
): Derived<MetadataValue> {
  owner.assertActive();

  const prepared = prepareMetadataSource(input);
  const capability = createClient(owner);
  const captured = captureActualReactiveCall(owner, () => capability.derived(prepared.compute));
  const registration = registerMetadataSource(owner, captured.receipt, prepared, occurrence);

  capability.effect(() => publishMetadataSource(registration));

  return captured.value;
}
