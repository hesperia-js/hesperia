import { bindOperation, createBindingContext, subscribe } from "aeolia";
import type { BindingContext, Graph, QueryBinding, QueryDefinition, StoreOptions } from "aeolia";
import { RenderFault, type Owner } from "../runtime/owner.ts";
import { completeProfileQueryValue } from "../validation/native-operation.ts";
import type { ValidationProfile } from "../validation/profiles.ts";
import {
  reserveDataBindingContextJoin,
  type DataApplication,
  type DataBindingContextJoin,
  type DataBindingEnvironment,
  type DataSecurityPartition,
} from "./environment.ts";
import type { RegisteredNativeQuery } from "./native-observation.ts";
import { joinQueryObservation } from "./observation.ts";
import type { PreparedQuerySource } from "./query.ts";

type Definition = QueryDefinition<unknown, unknown, string, any>;
const nativePromiseThen = Promise.prototype.then;

interface QueryContext {
  native?: BindingContext;
  state: "creating" | "ready" | "retiring";
  readonly remove: () => void;
  readonly environments: Map<
    DataBindingEnvironment,
    {
      readonly join: DataBindingContextJoin;
      readonly release: () => void;
    }
  >;
  readonly bindings: Map<Definition, Map<ValidationProfile, QueryBinding<Definition, unknown>>>;
  readonly observationRetirements: Set<Promise<void>>;
  readonly validationRetirements: Set<Promise<void>>;
  closeCompletion?: Promise<void>;
  stopAuthority?: () => void;
}

const contexts = new WeakMap<
  Graph,
  WeakMap<DataApplication, Map<DataSecurityPartition | undefined, QueryContext>>
>();

/** Fence one captured root generation without selecting a replacement for an existing view. @internal */
export function assertQueryEnvironment(owner: Owner, environment: DataBindingEnvironment): void {
  owner.assertReadable();

  if (environment.lifetime.aborted)
    throw new RenderFault(
      "query-environment-expired",
      "The query's data environment is no longer current",
    );
}

function closeQueryContext(
  current: QueryContext,
  dispose: boolean,
  finalJoin?: DataBindingContextJoin,
): Promise<void> {
  if (current.closeCompletion) {
    finalJoin?.waitFor(current.closeCompletion);

    return current.closeCompletion;
  }

  let resolve!: () => void;
  let reject!: (reason: unknown) => void;
  const completion = new Promise<void>((success, failure) => {
    resolve = success;
    reject = failure;
  });

  completion.catch(() => undefined);
  current.closeCompletion = completion;
  current.state = "retiring";
  current.remove();

  const members = [...current.environments.entries()];
  current.environments.clear();

  for (const [environment, member] of members) {
    environment.lifetime.removeEventListener("abort", member.release);
    if (member.join !== finalJoin) member.join.waitFor(completion);
  }

  finalJoin?.waitFor(completion);
  current.bindings.clear();

  const cleanupFailures: unknown[] = [];
  const stop = current.stopAuthority;
  current.stopAuthority = undefined;

  try {
    stop?.();
  } catch (reason) {
    cleanupFailures.push(reason);
  }

  let nativeRetirement: Promise<void> | undefined;
  const native = current.native;

  if (native) {
    if (dispose) {
      try {
        native.dispose();
      } catch (reason) {
        cleanupFailures.push(reason);
      }
    }

    try {
      nativeRetirement = native.retire();
      nativeRetirement.catch(() => undefined);
    } catch (reason) {
      cleanupFailures.push(reason);
    }
  }

  const originals = [
    ...(nativeRetirement === undefined ? [] : [nativeRetirement]),
    ...current.observationRetirements,
    ...current.validationRetirements,
  ];

  void Promise.allSettled(originals).then((outcomes) => {
    const failures = [...cleanupFailures];

    for (const outcome of outcomes) {
      if (outcome.status === "rejected") failures.push(outcome.reason);
    }

    if (failures.length === 1) reject(failures[0]);
    else if (failures.length > 1)
      reject(new AggregateError(failures, "Query BindingContext retirement failed"));
    else resolve();
  });

  return completion;
}

function releaseQueryEnvironment(
  current: QueryContext,
  environment: DataBindingEnvironment,
  join: DataBindingContextJoin,
): void {
  const member = current.environments.get(environment);

  if (!member || member.join !== join) return;

  environment.lifetime.removeEventListener("abort", member.release);
  current.environments.delete(environment);

  if (current.state !== "ready") return;

  if (current.environments.size > 0) {
    join.complete();

    return;
  }

  closeQueryContext(current, true, join);
}

function addQueryEnvironment(
  current: QueryContext,
  environment: DataBindingEnvironment,
  join: DataBindingContextJoin,
): void {
  const release = (): void => releaseQueryEnvironment(current, environment, join);

  current.environments.set(environment, { join, release });
  environment.lifetime.addEventListener("abort", release, { once: true });

  if (environment.lifetime.aborted) release();
}

function queryContext(graph: Graph, environment: DataBindingEnvironment): QueryContext {
  let applications = contexts.get(graph);

  if (!applications) {
    applications = new WeakMap();
    contexts.set(graph, applications);
  }

  let security = applications.get(environment.application);

  if (!security) {
    security = new Map();
    applications.set(environment.application, security);
  }

  let record = security.get(environment.security);

  if (record?.state === "creating")
    throw new TypeError("A query BindingContext cannot be acquired during its construction");

  if (record && (record.state !== "ready" || !record.native?.active.get())) {
    closeQueryContext(record, false);
    record = undefined;
  }

  if (record) {
    if (!record.environments.has(environment)) {
      const join = reserveDataBindingContextJoin(environment);
      addQueryEnvironment(record, environment, join);
    }

    if (record.state !== "ready" || !record.native?.active.get())
      throw new RenderFault(
        "query-environment-expired",
        "The query's shared BindingContext is no longer current",
      );

    return record;
  }

  const join = reserveDataBindingContextJoin(environment);
  const current: QueryContext = {
    state: "creating",
    remove: () => {
      if (security.get(environment.security) === current) security.delete(environment.security);
    },
    environments: new Map(),
    bindings: new Map(),
    observationRetirements: new Set(),
    validationRetirements: new Set(),
  };

  security.set(environment.security, current);

  try {
    current.native = createBindingContext(graph);
    current.state = "ready";
    addQueryEnvironment(current, environment, join);

    if (current.state !== "ready" || !current.native.active.get())
      throw new RenderFault(
        "query-environment-expired",
        "The query's shared BindingContext ended during acquisition",
      );

    const stop = subscribe(current.native.active, (active) => {
      if (!active) closeQueryContext(current, false);
    });

    if (current.state !== "ready") stop();
    else if (current.native.active.get()) current.stopAuthority = stop;
    else {
      stop();
      closeQueryContext(current, false);
    }

    if (current.state !== "ready")
      throw new RenderFault(
        "query-environment-expired",
        "The query's shared BindingContext ended during acquisition",
      );

    return current;
  } catch (reason) {
    if (current.native) closeQueryContext(current, true);
    else {
      join.complete();
      current.state = "retiring";
      current.remove();
    }

    throw reason;
  }
}

/** Acquire the real native caller after successful input preparation. @internal */
export function acquireProfileQuery<P>(
  owner: Owner,
  graph: Graph,
  definition: QueryDefinition<unknown, unknown, string, P>,
  registration: RegisteredNativeQuery,
  input: unknown,
  options: StoreOptions<unknown> | undefined,
  environment: DataBindingEnvironment,
): PreparedQuerySource<unknown, P> {
  const assertEnvironment = (): void => {
    assertQueryEnvironment(owner, environment);

    if (options?.abortSignal?.aborted) throw options.abortSignal.reason;
  };

  assertEnvironment();

  const context = queryContext(graph, environment);
  const assertCurrent = (): void => {
    assertEnvironment();

    if (context.state !== "ready" || !context.native?.active.get())
      throw new RenderFault(
        "query-environment-expired",
        "The query's shared BindingContext is no longer current",
      );
  };

  assertCurrent();

  const definitionKey = definition as unknown as Definition;
  let profiles = context.bindings.get(definitionKey);

  if (!profiles) {
    profiles = new Map();
    context.bindings.set(definitionKey, profiles);
  }

  let binding = profiles.get(registration.profile) as
    | QueryBinding<QueryDefinition<unknown, unknown, string, P>, unknown>
    | undefined;

  if (!binding) {
    const profile = registration.profile;
    binding = bindOperation(graph, definition, {
      context: context.native!,
      profile,
      fetch: async (nativeInput, nativeOptions) => {
        const definitionOptions = nativeOptions as Parameters<typeof definition.fetch>[1];
        let resolveValidation!: () => void;
        let rejectValidation!: (cause: unknown) => void;
        const validation = new Promise<void>((resolve, reject) => {
          resolveValidation = resolve;
          rejectValidation = reject;
        });
        let tracked = false;

        void validation.catch(() => undefined);
        context.validationRetirements.add(validation);

        try {
          const value = await definition.fetch(nativeInput, definitionOptions);

          return completeProfileQueryValue(value, profile, (completion) => {
            tracked = true;

            try {
              Reflect.apply(nativePromiseThen, completion, [resolveValidation, rejectValidation]);
            } catch (cause) {
              rejectValidation(
                Object.assign(new Error("Validation retirement observation failed", { cause }), {
                  incomplete: true,
                  original: completion,
                }),
              );
            }
          });
        } finally {
          if (!tracked) resolveValidation();
        }
      },
      ...(profile.output === undefined && definition.equals !== undefined
        ? { value: { equals: definition.equals } }
        : {}),
    });
    profiles.set(profile, binding as QueryBinding<Definition, unknown>);
  }

  assertCurrent();

  const member = binding.member;
  const store = member(input, options);

  assertCurrent();

  const observation = registration.observation
    ? joinQueryObservation(
        owner,
        graph,
        store,
        registration,
        input,
        assertCurrent,
        options?.abortSignal ? [environment.lifetime, options.abortSignal] : [environment.lifetime],
        (completion) => {
          context.observationRetirements.add(completion);
          completion.catch(() => undefined);
        },
      )
    : undefined;

  try {
    assertCurrent();

    return {
      store,
      assertCurrent,
      recover: () => {
        assertCurrent();
        member(input, options);
        assertCurrent();
      },
      ...(observation ? { release: observation.release, observationIssue: observation.issue } : {}),
    };
  } catch (cause) {
    observation?.release();

    throw cause;
  }
}
