import { observeStore, subscribe } from "aeolia";
import type { Graph, ObservationLease, QueryStore, StoreIdentity } from "aeolia";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import { registerOwnerResourceLifecycle, type Owner } from "../runtime/owner.ts";
import { validateStandardSchema } from "../validation/standard-schema.ts";
import type { MappedObservation, RegisteredNativeQuery } from "./native-observation.ts";
import type { ObservationIssue } from "./types.ts";

interface Membership {
  readonly owner: Owner;
  readonly guard: () => void;
  active: boolean;
  released: boolean;
}

interface NativeObservationOriginal {
  state: "invoking" | "pending" | "settled" | "unobserved";
  originalAssigned: boolean;
  original?: unknown;
}

interface Activation {
  readonly epoch: number;
  stopped: boolean;
  stopAssigned: boolean;
  stopCalled: boolean;
  stop?: () => void | Promise<void>;
}

interface Resource {
  readonly graph: Graph;
  readonly store: QueryStore<unknown, unknown>;
  readonly registration: RegisteredNativeQuery;
  readonly input: unknown;
  readonly version: number;
  members: Set<Membership>;
  lease?: ObservationLease<unknown>;
  stopAuthority?: () => void;
  activation?: Activation;
  creating: boolean;
  terminal: boolean;
  retired: boolean;
  sequence: number;
  epoch: number;
  readonly originals: Set<NativeObservationOriginal>;
  readonly cleanupFailures: unknown[];
  readonly closeCompletion: Promise<void>;
  readonly resolveClose: () => void;
  readonly rejectClose: (cause: unknown) => void;
  closeSettled: boolean;
  retireInProgress: boolean;
}

interface ResourceTable {
  current: Map<StoreIdentity, Resource>;
}

const resources = new WeakMap<Graph, ResourceTable>();
const createdIssues = new WeakSet<object>();
const nativePromiseThen = Promise.prototype.then;
const nativeApply = Reflect.apply;

function ensureResourceTable(graph: Graph): ResourceTable {
  let table = resources.get(graph);

  if (table === undefined) {
    table = { current: new Map() };
    resources.set(graph, table);
  }

  return table;
}

function createObservationResource(
  graph: Graph,
  store: QueryStore<unknown, unknown>,
  registration: RegisteredNativeQuery,
  input: unknown,
  version: number,
): Resource {
  let resolveClose!: () => void;
  let rejectClose!: (cause: unknown) => void;
  const closeCompletion = new Promise<void>((resolve, reject) => {
    resolveClose = resolve;
    rejectClose = reject;
  });

  closeCompletion.catch(() => undefined);

  return {
    graph,
    store,
    registration,
    input,
    version,
    members: new Set(),
    creating: true,
    terminal: false,
    retired: false,
    sequence: 0,
    epoch: 0,
    originals: new Set(),
    cleanupFailures: [],
    closeCompletion,
    resolveClose,
    rejectClose,
    closeSettled: false,
    retireInProgress: false,
  };
}

function finishResourceClose(resource: Resource): void {
  if (
    !resource.retired ||
    resource.creating ||
    resource.retireInProgress ||
    resource.originals.size > 0 ||
    resource.closeSettled
  )
    return;

  resource.closeSettled = true;

  if (resource.cleanupFailures.length === 1) resource.rejectClose(resource.cleanupFailures[0]);
  else if (resource.cleanupFailures.length > 1)
    resource.rejectClose(
      new AggregateError(resource.cleanupFailures, "Native query observation retirement failed"),
    );
  else resource.resolveClose();
}

function reserveObservationOriginal(resource: Resource): NativeObservationOriginal {
  const original: NativeObservationOriginal = {
    state: "invoking",
    originalAssigned: false,
  };

  resource.originals.add(original);

  return original;
}

function completeObservationOriginal(
  resource: Resource,
  original: NativeObservationOriginal,
): void {
  if (original.state === "settled" || original.state === "unobserved") return;

  original.state = "settled";
  resource.originals.delete(original);
  finishResourceClose(resource);
}

function failObservationOriginal(
  resource: Resource,
  original: NativeObservationOriginal,
  reason: unknown,
): void {
  if (original.state === "settled") return;

  original.state = "settled";

  resource.cleanupFailures.push(reason);

  resource.originals.delete(original);
  finishResourceClose(resource);
}

function failUnobservedOriginal(
  resource: Resource,
  original: NativeObservationOriginal,
  cause: unknown,
): void {
  if (original.state === "settled" || original.state === "unobserved") return;

  original.state = "unobserved";
  const failure = Object.assign(
    new Error("Native observation retirement is incomplete", { cause }),
    {
      incomplete: true,
      original: original.original,
    },
  );

  resource.cleanupFailures.push(failure);
  resource.originals.delete(original);
  finishResourceClose(resource);
}

function observeValidationOriginal(resource: Resource, original: NativeObservationOriginal): void {
  original.state = "pending";

  try {
    nativeApply(nativePromiseThen, original.original, [
      () => completeObservationOriginal(resource, original),
      () => completeObservationOriginal(resource, original),
    ]);
  } catch (cause) {
    failUnobservedOriginal(resource, original, cause);
  }
}

function observeAdoptedOriginal(
  resource: Resource,
  original: NativeObservationOriginal,
  raw: unknown,
  completion: Promise<unknown>,
): void {
  original.original = raw;
  original.originalAssigned = true;
  original.state = "pending";

  try {
    void completion
      .then(
        () => completeObservationOriginal(resource, original),
        () => completeObservationOriginal(resource, original),
      )
      .catch((reason: unknown) => failObservationOriginal(resource, original, reason));
  } catch (reason) {
    failObservationOriginal(resource, original, reason);
  }
}

function observeStopOriginal(
  resource: Resource,
  original: NativeObservationOriginal,
  raw: unknown,
): void {
  original.original = raw;
  original.originalAssigned = true;

  original.state = "pending";

  // The captured native then method validates the receiver when the browser leaf lacks the Node brand helper.
  try {
    nativeApply(nativePromiseThen, raw, [
      () => completeObservationOriginal(resource, original),
      (reason: unknown) => failObservationOriginal(resource, original, reason),
    ]);
  } catch (reason) {
    failObservationOriginal(resource, original, reason);
  }
}

function issueOf(resource: Resource): ObservationIssue | undefined {
  const issue = resource.lease?.issue.get();

  if (issue === undefined) return undefined;

  if (
    createdIssues.has(issue) &&
    ((Reflect.get(issue, "kind") === "schema" && Array.isArray(Reflect.get(issue, "issues"))) ||
      (Reflect.get(issue, "kind") === "processing" &&
        ["mapping", "validation"].includes(Reflect.get(issue, "phase")) &&
        Object.hasOwn(issue, "cause")))
  )
    return issue as ObservationIssue;

  throw new TypeError("Observation issue belongs to an incompatible publisher", { cause: issue });
}

function report(resource: Resource, cause: unknown): void {
  try {
    resource.lease?.report(cause);
  } catch {
    // Native continuation reporting owns hook failures; do not recursively report them.
  }
}

function stopActivation(resource: Resource): void {
  const activation = resource.activation;

  if (!activation) return;

  activation.stopped = true;
  resource.activation = undefined;
  resource.sequence++;

  releaseStop(resource, activation);
}

function releaseStop(resource: Resource, activation: Activation): void {
  if (!activation.stopped || !activation.stopAssigned || activation.stopCalled) return;

  activation.stopCalled = true;
  const original = reserveObservationOriginal(resource);

  try {
    const cleanup = activation.stop?.();

    original.original = cleanup;
    original.originalAssigned = true;

    if (cleanup === null || (typeof cleanup !== "object" && typeof cleanup !== "function")) {
      completeObservationOriginal(resource, original);
    } else {
      observeStopOriginal(resource, original, cleanup);
    }
  } catch (cause) {
    failObservationOriginal(resource, original, cause);

    report(resource, cause);
  }
}

function retire(resource: Resource): void {
  if (resource.retired) return;

  resource.retired = true;
  resource.retireInProgress = true;

  stopActivation(resource);

  const table = resources.get(resource.graph);
  const map = table?.current;

  if (table !== undefined && map?.get(resource.store.identity) === resource) {
    const next = new Map(map);
    next.delete(resource.store.identity);
    table.current = next;
  }

  const stopAuthority = resource.stopAuthority;
  resource.stopAuthority = undefined;

  try {
    stopAuthority?.();
  } catch (cause) {
    report(resource, cause);
    resource.cleanupFailures.push(cause);
  }

  try {
    resource.lease?.dispose();
  } catch (cause) {
    report(resource, cause);
    resource.cleanupFailures.push(cause);
  }

  resource.retireInProgress = false;
  finishResourceClose(resource);
}

function eligible(resource: Resource, activation: Activation, sequence: number): boolean {
  if (
    resource.retired ||
    resource.terminal ||
    resource.activation !== activation ||
    activation.stopped ||
    sequence !== resource.sequence ||
    resource.version !== resource.graph.resetVersion.get() ||
    !resource.lease?.active.get()
  )
    return false;

  for (const member of resource.members) {
    if (!member.active || member.released || !member.owner.isCommitted()) continue;

    try {
      member.guard();

      return (
        !resource.retired &&
        !resource.terminal &&
        resource.activation === activation &&
        !activation.stopped &&
        sequence === resource.sequence &&
        resource.version === resource.graph.resetVersion.get() &&
        resource.lease.active.get()
      );
    } catch {
      // Another compatible owner may still authorize this shared activation.
    }
  }

  return false;
}

function rejectProcessing(
  resource: Resource,
  activation: Activation,
  sequence: number,
  phase: "mapping" | "validation",
  cause: unknown,
): void {
  if (!eligible(resource, activation, sequence)) return;

  const issue = Object.freeze({ kind: "processing", phase, cause } as const);

  createdIssues.add(issue);

  try {
    resource.lease!.reject(issue, { cause });
  } catch (failure) {
    report(resource, failure);
  }
}

function validateCandidate(
  resource: Resource,
  activation: Activation,
  sequence: number,
  mapped: MappedObservation,
): void {
  if (!eligible(resource, activation, sequence)) return;
  if (mapped.kind === "incomplete") return;

  const publish = (value: unknown): void => {
    if (!eligible(resource, activation, sequence)) return;

    try {
      resource.lease!.publish(value);
    } catch (cause) {
      report(resource, cause);
    }
  };

  const schema = resource.registration.profile.output;
  const candidate = mapped.value;

  if (!eligible(resource, activation, sequence)) return;

  if (schema === undefined) {
    publish(candidate);

    return;
  }

  const accept = (settled: StandardSchemaV1.Result<unknown>): void => {
    if (!eligible(resource, activation, sequence)) return;

    try {
      const issues = settled.issues;

      if (!eligible(resource, activation, sequence)) return;

      if (issues !== undefined) {
        const issue = Object.freeze({ kind: "schema", issues } as const);

        createdIssues.add(issue);

        try {
          resource.lease!.reject(issue);
        } catch (cause) {
          report(resource, cause);
        }
      } else publish(settled.value);
    } catch (cause) {
      rejectProcessing(resource, activation, sequence, "validation", cause);
    }
  };

  const original = reserveObservationOriginal(resource);
  let returned: { readonly value: unknown } | undefined;
  let assigned = false;

  try {
    const result = validateStandardSchema(schema, candidate);
    returned = { value: result };
    original.original = result;
    original.originalAssigned = true;

    if (isPromiseLike(result)) {
      observeValidationOriginal(resource, original);
      const completion = Promise.resolve(result);
      const processed = completion.then(accept, (cause: unknown) =>
        rejectProcessing(resource, activation, sequence, "validation", cause),
      );
      const settled = processed.catch((cause: unknown) => report(resource, cause));
      const continuation = reserveObservationOriginal(resource);

      observeAdoptedOriginal(resource, continuation, settled, settled);
      assigned = true;
    } else {
      completeObservationOriginal(resource, original);
      assigned = true;

      accept(result);
    }
  } catch (cause) {
    if (!assigned) {
      if (returned && original.state !== "pending") {
        failUnobservedOriginal(resource, original, cause);
      } else if (!returned) {
        completeObservationOriginal(resource, original);
      }
    }

    rejectProcessing(resource, activation, sequence, "validation", cause);
  }
}

function notify(resource: Resource, activation: Activation, event: unknown): void {
  if (!eligible(resource, activation, resource.sequence)) return;

  const sequence = ++resource.sequence;

  if (!eligible(resource, activation, sequence)) return;

  const original = reserveObservationOriginal(resource);
  let returned: { readonly value: unknown } | undefined;
  let assigned = false;

  try {
    const mapped = resource.registration.observation!.map(event);
    returned = { value: mapped };
    original.original = mapped;
    original.originalAssigned = true;
    const accept = (candidate: MappedObservation): void => {
      try {
        validateCandidate(resource, activation, sequence, candidate);
      } catch (cause) {
        rejectProcessing(resource, activation, sequence, "mapping", cause);
      }
    };

    if (isPromiseLike(mapped)) {
      const completion = Promise.resolve(mapped);
      const processed = completion.then(accept, (cause: unknown) =>
        rejectProcessing(resource, activation, sequence, "mapping", cause),
      );
      const settled = processed.catch((cause: unknown) => report(resource, cause));

      observeAdoptedOriginal(resource, original, mapped, settled);
      assigned = true;
    } else {
      completeObservationOriginal(resource, original);
      assigned = true;

      accept(mapped);
    }
  } catch (cause) {
    if (!assigned) {
      if (returned) {
        failUnobservedOriginal(resource, original, cause);
      } else {
        completeObservationOriginal(resource, original);
      }
    }

    rejectProcessing(resource, activation, sequence, "mapping", cause);
  }
}

function isPromiseLike<T>(value: T | PromiseLike<T>): value is PromiseLike<T> {
  return (
    value !== null &&
    (typeof value === "object" || typeof value === "function") &&
    typeof Reflect.get(value, "then") === "function"
  );
}

function terminate(resource: Resource, cause: unknown): void {
  if (resource.retired || resource.terminal) return;

  resource.terminal = true;

  stopActivation(resource);
  report(resource, cause);
}

function activate(resource: Resource): void {
  if (resource.activation || resource.terminal || resource.retired || resource.creating) return;

  const activation: Activation = {
    epoch: ++resource.epoch,
    stopped: false,
    stopAssigned: false,
    stopCalled: false,
  };
  resource.activation = activation;

  if (!eligible(resource, activation, resource.sequence)) {
    stopActivation(resource);

    return;
  }

  const startOriginal = reserveObservationOriginal(resource);

  try {
    const stop = resource.registration.observation!.start(resource.input, {
      notify: (event) => {
        try {
          notify(resource, activation, event);
        } catch (cause) {
          report(resource, cause);
        }
      },
      terminate: (cause) => {
        if (resource.activation === activation && !activation.stopped) terminate(resource, cause);
      },
    });

    startOriginal.original = stop;
    startOriginal.originalAssigned = true;

    if (typeof stop !== "function")
      throw new TypeError("A native query watch must return its stop function");

    activation.stop = stop;
    activation.stopAssigned = true;

    releaseStop(resource, activation);
    completeObservationOriginal(resource, startOriginal);
  } catch (cause) {
    failObservationOriginal(resource, startOriginal, cause);

    if (resource.activation === activation && !activation.stopped) terminate(resource, cause);
  }
}

interface PreparedMembershipOperations {
  readonly membership: Membership;
  readonly pause: () => void;
  readonly release: () => void;
  readonly resume: () => void;
  setUnregister(unregister: () => void): void;
  setResource(resource: Resource): void;
}

function prepareMembershipOperations(
  resource: Resource,
  owner: Owner,
  guard: () => void,
  signals: readonly AbortSignal[],
): PreparedMembershipOperations {
  let current = resource;
  const membership: Membership = { owner, guard, active: false, released: false };
  let unregister: (() => void) | undefined;

  const pause = (): void => {
    membership.active = false;

    if (![...current.members].some((member) => member.active && !member.released))
      stopActivation(current);
  };

  const release = (): void => {
    if (membership.released) return;

    membership.released = true;
    pause();

    try {
      unregister?.();
    } catch (cause) {
      report(current, cause);
    }

    for (const signal of signals) {
      try {
        signal.removeEventListener("abort", release);
      } catch (cause) {
        report(current, cause);
      }
    }

    const nextMembers = new Set(current.members);
    nextMembers.delete(membership);
    current.members = nextMembers;

    if (current.members.size === 0) retire(current);
  };

  const resume = (): void => {
    if (membership.released) return;

    guard();

    if (!owner.isCommitted()) return;

    membership.active = true;
    activate(current);

    if (membership.released || current.retired) return;

    try {
      guard();
    } catch {
      release();
    }
  };

  return {
    membership,
    pause,
    release,
    resume,
    setUnregister(next): void {
      unregister = next;
    },
    setResource(next): void {
      current = next;
    },
  };
}

function installMembership(
  resource: Resource,
  prepared: PreparedMembershipOperations,
  signals: readonly AbortSignal[],
): void {
  const { membership, pause, release, resume } = prepared;

  issueOf(resource);
  membership.guard();

  if (!resource.stopAuthority) {
    const stop = subscribe(resource.lease!.active, (active) => {
      if (!active) retire(resource);
    });

    if (resource.retired) stop();
    else resource.stopAuthority = stop;
  }

  prepared.setUnregister(
    registerOwnerResourceLifecycle(membership.owner, { suspended: pause, resumed: resume }),
  );

  for (const signal of signals) {
    if (membership.released) break;

    try {
      signal.addEventListener("abort", release, { once: true });
    } catch (cause) {
      try {
        signal.removeEventListener("abort", release);
      } catch (cleanup) {
        report(resource, cleanup);
      }

      throw cause;
    }

    if (membership.released) {
      try {
        signal.removeEventListener("abort", release);
      } catch (cleanup) {
        report(resource, cleanup);
      }

      break;
    }
  }

  membership.owner.onRelease(release);
  membership.guard();
  membership.owner.onCommit(resume);
  membership.guard();

  if (
    signals.some((signal) => signal.aborted) ||
    membership.released ||
    resource.retired ||
    !resource.lease!.active.get()
  )
    throw new TypeError("The query observation membership ended during acquisition");
}

/** Reserve one native publisher and owner membership without starting the provider. @internal */
export function joinQueryObservation(
  owner: Owner,
  graph: Graph,
  store: QueryStore<unknown, unknown>,
  registration: RegisteredNativeQuery,
  input: unknown,
  guard: () => void,
  signals: readonly AbortSignal[] = [],
  trackRetirement?: (completion: Promise<void>) => void,
): { readonly issue: () => ObservationIssue | undefined; readonly release: () => void } {
  guard();

  const table = ensureResourceTable(graph);
  let resource = table.current.get(store.identity);

  if (resource && (resource.retired || resource.lease?.active.get() === false)) {
    retire(resource);
    resource = undefined;
  }

  if (resource && (resource.creating || resource.registration !== registration))
    throw new TypeError("The query already has an incompatible observation resource");

  if (!resource) {
    resource = createObservationResource(
      graph,
      store,
      registration,
      input,
      graph.resetVersion.get(),
    );
    trackRetirement?.(resource.closeCompletion);
    const next = new Map(table.current);
    next.set(store.identity, resource);
    table.current = next;

    try {
      resource.lease = observeStore(graph, store);
      resource.creating = false;
      issueOf(resource);
      finishResourceClose(resource);
    } catch (cause) {
      resource.creating = false;

      try {
        report(resource, cause);
      } finally {
        retire(resource);
      }

      throw cause;
    }
  }

  trackRetirement?.(resource.closeCompletion);
  const current = resource;
  const prepared = prepareMembershipOperations(current, owner, guard, signals);
  const nextMembers = new Set(current.members);
  nextMembers.add(prepared.membership);
  current.members = nextMembers;

  try {
    installMembership(current, prepared, signals);

    return { issue: () => issueOf(current), release: prepared.release };
  } catch (cause) {
    prepared.release();

    throw cause;
  }
}
