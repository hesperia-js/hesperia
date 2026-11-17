import { Owner, RenderFault, type RuntimeContext } from "../runtime/owner.ts";

declare const applicationBrand: unique symbol;
declare const partitionBrand: unique symbol;
declare const transitionBrand: unique symbol;

/** Realm-local application identity shared by compatible data roots. */
export interface DataApplication {
  /** Type-only nominal identity; runtime provenance belongs to the constructor. */
  readonly [applicationBrand]: true;
}

/** Application-owned identity for callers with compatible security authority. */
export interface DataSecurityPartition {
  /** Type-only nominal identity; runtime provenance belongs to the constructor. */
  readonly [partitionBrand]: true;
}

/** Explicit public scope or a genuine application-owned security partition. */
export type DataSecurity =
  | { readonly kind: "none" }
  | { readonly kind: "partition"; readonly partition: DataSecurityPartition };

/** Root creator's authority to fence security changes before credentials mutate. */
export interface DataBindingRootControl {
  /** Last published generation, retained during revocation or replacement. */
  readonly generation: number;
  /** Stable actual root lifetime, distinct from a replaceable environment. */
  readonly signal: AbortSignal;
  /**
   * Fence the old environment before applying an owned credential change.
   * @param expectedGeneration - Last published generation observed by this caller.
   * @param next - Explicit next security scope, validated before revocation.
   * @param apply - Credential change owned by this attempt, invoked at most once.
   * @param reason - Cancellation reason for the old environment.
   * @returns The published generation, or rejection with the original apply failure.
   * Stale, concurrent or disposed attempts reject without invoking apply.
   */
  replaceSecurity(
    expectedGeneration: number,
    next: DataSecurity,
    apply: () => void | PromiseLike<void>,
    reason?: unknown,
  ): Promise<number>;
  /**
   * Revoke this root's environment without disposing its component tree.
   * @param reason - Cancellation reason for this root's environment.
   * A live root can retry replacement against its last published generation.
   */
  revoke(reason?: unknown): void;
}

/** Explicit data identity and authentication integration for one real root. */
export interface DataBindingBootstrap {
  /** Canonical application singleton created in this JavaScript realm. */
  readonly application: DataApplication;
  /**
   * Read the explicit current scope once during this root's setup.
   * @returns Explicit none or a genuine partition selected by the authentication owner.
   */
  readonly security: () => DataSecurity;
  /**
   * Attach authentication before component preparation.
   * @param control - This root's genuine replacement and revocation control.
   * @returns Optional synchronous unsubscribe, called once during root teardown.
   */
  readonly attach?: (control: DataBindingRootControl) => void | (() => void);
}

/** @internal Validated identity input; undefined security represents explicit none. */
export interface DataBindingEnvironmentInput {
  /** Genuine realm-local application identity. */
  readonly application: DataApplication;
  /** Genuine partition or an explicitly supplied undefined for public scope. */
  readonly security: DataSecurityPartition | undefined;
}

/** @internal Immutable authority snapshot belonging to one root generation. */
export interface DataBindingEnvironment extends DataBindingEnvironmentInput {
  /** Never-reused generation published by this root. */
  readonly generation: number;
  /** Environment lifetime, revoked before a successor can be published. */
  readonly lifetime: AbortSignal;
}

/** @internal One shared binding-context membership reserved under an issued root generation. */
export interface DataBindingContextJoin {
  complete(): void;
  waitFor(completion: Promise<void>): void;
}

/** @internal Exact ownership of an in-progress root security change. */
export interface DataBindingTransition {
  /** @internal Structural tokens cannot finish a replacement. */
  readonly [transitionBrand]: true;
}

interface RootRecord {
  readonly owner: Owner;
  readonly route: string;
  readonly cleanupErrors: unknown[];
  eligible: boolean;
  bootstrapped: boolean;
  generation: number;
  reservedGeneration: number;
  application?: DataApplication;
  current?: DataBindingEnvironment;
  controller?: AbortController;
  transition?: TransitionRecord;
  detach?: () => void;
  setup?: { failure?: { readonly cause: unknown } };
  readonly contextRetirements: Set<Promise<void>>;
}

interface IssuedContextLifetime {
  readonly root: RootRecord;
  readonly environment: DataBindingEnvironment;
  readonly generation: number;
}

interface TransitionRecord {
  readonly root: RootRecord;
  readonly input: DataBindingEnvironmentInput;
  readonly generation: number;
  readonly completion: Promise<number>;
  readonly resolve: (generation: number) => void;
  readonly reject: (cause: unknown) => void;
}

const applications = new WeakSet<object>();
const partitions = new WeakSet<object>();
const roots = new WeakMap<RuntimeContext, RootRecord>();
const transitions = new WeakMap<DataBindingTransition, TransitionRecord>();
const issuedContextLifetimes = new WeakMap<DataBindingEnvironment, IssuedContextLifetime>();

/**
 * Create an inert application identity; reuse it across compatible roots.
 * @returns A realm-local identity with no graph, root or transport effects.
 */
export function createDataApplication(): DataApplication {
  const application = Object.freeze(Object.create(null)) as DataApplication;

  applications.add(application);

  return application;
}

/**
 * Create an inert partition identity chosen by the application's auth owner.
 * @returns A realm-local identity; the application decides which callers may share it.
 */
export function createDataSecurityPartition(): DataSecurityPartition {
  const partition = Object.freeze(Object.create(null)) as DataSecurityPartition;

  partitions.add(partition);

  return partition;
}

/**
 * Snapshot a bootstrap descriptor without invoking security or attach.
 * @param value - Optional authored descriptor containing supported own data fields.
 * @returns A frozen descriptor, or undefined when no descriptor was supplied.
 * @throws TypeError for malformed fields or identities not created by this core.
 * @internal
 */
export function normalizeDataBindingBootstrap(value: unknown): DataBindingBootstrap | undefined {
  if (value === undefined) return undefined;

  const fields = ownFields(value, ["application", "security", "attach"]);
  const application = fields.application;

  assertApplication(application);

  if (
    typeof fields.security !== "function" ||
    (fields.attach !== undefined && typeof fields.attach !== "function")
  )
    throw new TypeError("dataBinding requires a security callback and an optional attach callback");

  return Object.freeze({
    application,
    security: fields.security as DataBindingBootstrap["security"],
    ...(fields.attach === undefined
      ? {}
      : { attach: fields.attach as NonNullable<DataBindingBootstrap["attach"]> }),
  });
}

/**
 * Register eligibility from an actual root creator, before authored setup runs.
 * @param owner - Genuine root Owner with its actual runtime services and lifetime.
 * @param route - Configuration route used by missing-environment diagnostics.
 * @throws RenderFault for a reused context, component owner or ended root.
 * @internal
 */
export function registerDataBindingRoot(owner: Owner, route: string): void {
  if (
    !(owner instanceof Owner) ||
    owner.parent !== null ||
    owner.state !== "building" ||
    owner.signal.aborted
  )
    throw fault("Data binding requires a fresh actual runtime root");

  if (roots.has(owner.context)) throw fault("Runtime services already belong to a data root");

  const root: RootRecord = {
    owner,
    route,
    cleanupErrors: [],
    contextRetirements: new Set(),
    eligible: true,
    bootstrapped: false,
    generation: 0,
    reservedGeneration: 0,
  };

  roots.set(owner.context, root);
  owner.onRelease(() => waitForDataBindingContextRetirements(root));
}

/**
 * Install the current descriptor before component preparation or adoption.
 * @param owner - Actual root registered by its browser, server or host creator.
 * @param input - Optional explicit descriptor; absence creates no environment.
 * @param mode - Async bootstraps may await an attach-initiated replacement.
 * @returns Completion only when asynchronous setup must finish before rendering.
 * @throws The original setup cause, or an aggregate retaining cleanup failures.
 * A synchronous root rejects an unfinished attach-initiated replacement.
 * @internal
 */
export function bootstrapDataBindingRoot(
  owner: Owner,
  input: DataBindingBootstrap | undefined,
  mode: "sync" | "async" = "sync",
): void | Promise<void> {
  const root = rootFor(owner.context);

  assertEligible(root);

  if (root.owner !== owner || root.bootstrapped)
    throw fault("Data binding bootstrap can run only once on its actual root");

  root.bootstrapped = true;
  const setup: { failure?: { readonly cause: unknown } } = {};
  const complete = (): void => {
    root.setup = undefined;
  };
  root.setup = setup;

  try {
    const descriptor = normalizeDataBindingBootstrap(input);

    assertEligible(root);

    if (descriptor === undefined) {
      complete();

      return;
    }

    const selected = descriptor.security();

    assertEligible(root);

    const security = normalizeSecurity(selected);

    assertEligible(root);

    registerDataBindingEnvironment(
      owner.context,
      { application: descriptor.application, security },
      owner.signal,
    );

    if (descriptor.attach) {
      const detach = descriptor.attach(controlFor(root));

      if (detach !== undefined && typeof detach !== "function")
        throw new TypeError("dataBinding.attach must return a cleanup function or undefined");

      root.detach = typeof detach === "function" ? detach : undefined;

      assertEligible(root);
    }

    if (root.transition) {
      if (mode === "sync")
        throw fault(
          "Finish authentication before creating a synchronous data root; attach started an asynchronous security replacement",
        );

      return waitForSetup(root)
        .catch((cause: unknown) => {
          throw failSetup(owner, cause);
        })
        .finally(complete);
    }

    if (!root.current && setup.failure) throw setup.failure.cause;

    currentDataBindingEnvironment(owner.context);

    complete();
  } catch (cause) {
    complete();

    throw failSetup(owner, cause);
  }
}

/**
 * Publish the first immutable environment for a registered real root.
 * @param runtime - Exact root services, never a clone or component context substitute.
 * @param input - Genuine application and explicitly present security field.
 * @param rootSignal - That root's actual stable Owner signal.
 * @returns Its initial environment.
 * @throws TypeError for invalid identities; RenderFault for an ineligible/reused slot.
 * @internal
 */
export function registerDataBindingEnvironment(
  runtime: RuntimeContext,
  input: DataBindingEnvironmentInput,
  rootSignal: AbortSignal,
): DataBindingEnvironment {
  const root = rootFor(runtime);

  assertEligible(root);

  const captured = normalizeEnvironment(input);

  assertEligible(root);

  if (root.owner.signal !== rootSignal || root.application !== undefined)
    throw fault("Data environment registration requires the unused actual root slot and lifetime");

  root.application = captured.application;

  return publish(root, captured, reserveGeneration(root));
}

/**
 * Read current authority for a fresh acquisition without creating an environment.
 * @param runtime - Exact services registered by the real root creator.
 * @returns The currently eligible immutable environment.
 * @throws RenderFault when configuration is missing, replacing, revoked or disposed.
 * @internal
 */
export function currentDataBindingEnvironment(runtime: RuntimeContext): DataBindingEnvironment {
  const root = rootFor(runtime);

  assertEligible(root);

  if (!root.current)
    throw fault(
      `No current data environment; configure explicit dataBinding through ${root.route}`,
    );

  return root.current;
}

/**
 * Fence one environment and reserve exact ownership before credential mutation.
 * @param runtime - Actual root services.
 * @param expectedGeneration - Last published generation; stale attempts have no effect.
 * @param input - Same application identity and explicit next security scope.
 * @param reason - Old environment's cancellation reason.
 * @returns A genuine private transition that only its owning attempt may finish.
 * @throws TypeError for malformed input; RenderFault for stale/concurrent/ended roots.
 * @internal
 */
export function beginDataBindingReplacement(
  runtime: RuntimeContext,
  expectedGeneration: number,
  input: DataBindingEnvironmentInput,
  reason?: unknown,
): DataBindingTransition {
  const root = rootFor(runtime);

  assertEligible(root);

  const captured = normalizeEnvironment(input);

  assertEligible(root);

  if (
    !Number.isSafeInteger(expectedGeneration) ||
    expectedGeneration !== root.generation ||
    root.application !== captured.application ||
    root.transition
  )
    throw fault(
      "Security replacement requires the current generation, application and unreserved root",
    );

  const generation = reserveGeneration(root);
  let resolve!: (value: number) => void;
  let reject!: (cause: unknown) => void;
  const completion = new Promise<number>((success, failure) => {
    resolve = success;
    reject = failure;
  });
  const record: TransitionRecord = {
    root,
    input: captured,
    generation,
    completion,
    resolve,
    reject,
  };
  const transition = Object.freeze(Object.create(null)) as DataBindingTransition;

  completion.catch(() => {});

  transitions.set(transition, record);

  root.transition = record;

  if (root.setup) root.setup.failure = undefined;

  retireEnvironment(root, reason);

  assertTransition(record);

  return transition;
}

/**
 * Finish only the transition still owned by this actual live root.
 * @param transition - Exact token returned by begin, never a structural substitute.
 * @param outcome - Applied success or the original thrown/rejected cause.
 * @returns The successor environment after a successful live apply.
 * @throws The original failed cause, including undefined, or a stale-lifetime fault.
 * @internal
 */
export function finishDataBindingReplacement(
  transition: DataBindingTransition,
  outcome: { readonly kind: "applied" } | { readonly kind: "failed"; readonly cause: unknown },
): DataBindingEnvironment {
  const record = transitions.get(transition);

  if (!record) throw fault("Security replacement requires a genuine transition");

  assertTransition(record);

  record.root.transition = undefined;

  if (outcome.kind === "failed") {
    if (record.root.setup) record.root.setup.failure = { cause: outcome.cause };

    record.reject(outcome.cause);

    throw outcome.cause;
  }

  const environment = publish(record.root, record.input, record.generation);

  record.resolve(environment.generation);

  return environment;
}

/**
 * Revoke only this root's current environment and pending replacement.
 * @param runtime - Exact registered root services.
 * @param reason - Cancellation cause; no other root or graph is disposed.
 * @throws RenderFault if the actual root has ended.
 * @internal
 */
export function revokeDataBindingEnvironment(runtime: RuntimeContext, reason?: unknown): void {
  const root = rootFor(runtime);

  assertEligible(root);

  invalidateTransition(root, reason);

  retireEnvironment(root, reason);
}

/**
 * Permanently fence a real root before abort and drain its owned cleanup failures.
 * @param owner - Actual root being destroyed; component teardown has no authority here.
 * @param reason - Root teardown reason.
 * @returns Failures for Owner's existing independent cleanup/error path.
 * Repeated calls can drain a detach returned after reentrant destruction.
 * @internal
 */
export function retireDataBindingRoot(owner: Owner, reason: unknown): readonly unknown[] {
  const root = roots.get(owner.context);

  if (!root || root.owner !== owner) return [];

  root.eligible = false;

  invalidateTransition(root, reason);

  retireEnvironment(root, reason);

  const detach = root.detach;
  root.detach = undefined;

  if (detach) {
    try {
      detach();
    } catch (cause) {
      root.cleanupErrors.push(cause);
    }
  }

  return root.cleanupErrors.splice(0);
}

function controlFor(root: RootRecord): DataBindingRootControl {
  return Object.freeze({
    get generation() {
      return root.generation;
    },
    signal: root.owner.signal,
    replaceSecurity(
      expected: number,
      next: DataSecurity,
      apply: () => void | PromiseLike<void>,
      reason?: unknown,
    ): Promise<number> {
      let transition: DataBindingTransition;

      try {
        assertEligible(root);

        if (typeof apply !== "function")
          throw new TypeError("Security replacement requires an apply callback");

        const security = normalizeSecurity(next);

        transition = beginDataBindingReplacement(
          root.owner.context,
          expected,
          { application: root.application!, security },
          reason,
        );
      } catch (cause) {
        return Promise.reject(cause);
      }

      const record = transitions.get(transition)!;
      const finish = (
        outcome:
          | { readonly kind: "applied" }
          | { readonly kind: "failed"; readonly cause: unknown },
      ): void => {
        try {
          finishDataBindingReplacement(transition, outcome);
        } catch (cause) {
          record.reject(cause);
        }
      };

      try {
        const result = apply();

        if (result === undefined) finish({ kind: "applied" });
        else
          Promise.resolve(result).then(
            () => finish({ kind: "applied" }),
            (cause: unknown) => finish({ kind: "failed", cause }),
          );
      } catch (cause) {
        finish({ kind: "failed", cause });
      }

      return record.completion;
    },
    revoke(reason?: unknown): void {
      revokeDataBindingEnvironment(root.owner.context, reason);
    },
  });
}

async function waitForSetup(root: RootRecord): Promise<void> {
  while (root.transition) {
    await root.transition.completion;

    assertEligible(root);
  }

  if (!root.current && root.setup?.failure) throw root.setup.failure.cause;

  currentDataBindingEnvironment(root.owner.context);
}

function publish(
  root: RootRecord,
  input: DataBindingEnvironmentInput,
  generation: number,
): DataBindingEnvironment {
  const controller = new AbortController();
  const environment = Object.freeze({ ...input, generation, lifetime: controller.signal });
  root.current = environment;
  root.controller = controller;
  root.generation = generation;
  issuedContextLifetimes.set(environment, { root, environment, generation });

  return environment;
}

/** @internal Reserve one pool membership against the exact current root generation. */
export function reserveDataBindingContextJoin(
  environment: DataBindingEnvironment,
): DataBindingContextJoin {
  const issued = issuedContextLifetimes.get(environment);

  if (
    !issued ||
    issued.environment !== environment ||
    issued.generation !== environment.generation ||
    issued.root.current !== environment ||
    issued.root.generation !== issued.generation ||
    !issued.root.eligible ||
    environment.lifetime.aborted
  )
    throw fault("A shared data context requires its exact current root environment");

  let resolve!: () => void;
  let reject!: (reason: unknown) => void;
  let pending = true;
  const completion = new Promise<void>((success, failure) => {
    resolve = success;
    reject = failure;
  });

  completion.catch(() => undefined);
  issued.root.contextRetirements.add(completion);

  return Object.freeze({
    complete(): void {
      if (!pending) return;

      pending = false;
      resolve();
    },
    waitFor(original: Promise<void>): void {
      if (!pending) throw new TypeError("A data context membership can bind one retirement join");

      pending = false;

      try {
        original.then(resolve, reject);
      } catch (reason) {
        reject(reason);
      }
    },
  });
}

async function waitForDataBindingContextRetirements(root: RootRecord): Promise<void> {
  const outcomes = await Promise.all(
    [...root.contextRetirements].map((completion) =>
      completion.then(
        () => ({ ok: true as const }),
        (reason: unknown) => ({ ok: false as const, reason }),
      ),
    ),
  );

  root.contextRetirements.clear();

  const failures = outcomes.flatMap((outcome) => (outcome.ok ? [] : [outcome.reason]));

  if (failures.length === 1) throw failures[0];
  if (failures.length > 1)
    throw new AggregateError(failures, "Owned data context retirement failed");
}

function retireEnvironment(root: RootRecord, reason: unknown): void {
  const controller = root.controller;
  root.current = undefined;
  root.controller = undefined;

  if (controller) {
    try {
      controller.abort(reason);
    } catch (cause) {
      root.cleanupErrors.push(cause);
    }
  }
}

function invalidateTransition(root: RootRecord, cause: unknown): void {
  const transition = root.transition;
  root.transition = undefined;

  transition?.reject(cause);
}

function assertTransition(record: TransitionRecord): void {
  assertEligible(record.root);

  if (record.root.transition !== record)
    throw fault("Security replacement no longer owns its root slot");
}

function rootFor(runtime: RuntimeContext): RootRecord {
  const root = roots.get(runtime);

  if (!root) throw fault("Data binding requires actual registered root runtime services");

  return root;
}

function assertEligible(root: RootRecord): void {
  if (
    !root.eligible ||
    root.owner.signal.aborted ||
    root.owner.state === "cleaning" ||
    root.owner.state === "destroyed"
  )
    throw fault("The data binding root is no longer eligible");
}

function reserveGeneration(root: RootRecord): number {
  if (root.reservedGeneration >= Number.MAX_SAFE_INTEGER)
    throw fault("Data environment generations are exhausted");

  return ++root.reservedGeneration;
}

function failSetup(owner: Owner, cause: unknown): unknown {
  const errors = owner.disposeWithErrors(cause);

  return errors.length
    ? new AggregateError([cause, ...errors], "Data binding setup and cleanup failed", { cause })
    : cause;
}

function normalizeSecurity(value: unknown): DataSecurityPartition | undefined {
  const fields = ownFields(value, ["kind", "partition"]);

  if (fields.kind === "none" && !Object.hasOwn(fields, "partition")) return undefined;

  if (
    fields.kind !== "partition" ||
    !isObject(fields.partition) ||
    !partitions.has(fields.partition)
  )
    throw new TypeError("dataBinding security must explicitly select none or a genuine partition");

  return fields.partition as DataSecurityPartition;
}

function normalizeEnvironment(value: DataBindingEnvironmentInput): DataBindingEnvironmentInput {
  const fields = ownFields(value, ["application", "security"]);
  const application = fields.application;
  const security = fields.security;

  assertApplication(application);

  if (
    !Object.hasOwn(fields, "security") ||
    (security !== undefined && (!isObject(security) || !partitions.has(security)))
  )
    throw new TypeError("A data environment requires an explicit genuine security identity");

  return Object.freeze({ application, security: security as DataSecurityPartition | undefined });
}

function assertApplication(value: unknown): asserts value is DataApplication {
  if (!isObject(value) || !applications.has(value))
    throw new TypeError("dataBinding requires a genuine DataApplication");
}

function ownFields(value: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (!isObject(value) || Array.isArray(value))
    throw new TypeError("Data binding options require own data fields");

  const fields: Record<string, unknown> = Object.create(null);

  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);

    if (
      typeof key !== "string" ||
      !allowed.includes(key) ||
      !descriptor ||
      !("value" in descriptor)
    )
      throw new TypeError("Data binding options contain an unsupported field or accessor");

    Object.defineProperty(fields, key, { value: descriptor.value, enumerable: true });
  }

  return fields;
}

function isObject(value: unknown): value is object {
  return value !== null && typeof value === "object";
}

function fault(message: string): RenderFault {
  return new RenderFault("data-binding-environment", message);
}
