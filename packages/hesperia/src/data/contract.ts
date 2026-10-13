import { signal, subscribe } from "aeolia";
import type {
  Contract,
  ContractApi,
  Graph,
  MutationDefinition,
  MutationOptions,
  OperationDefinition,
  OperationTree,
  QueryDefinition,
  QueryStore,
  Store,
  StoreDefinition,
  StoreOptions,
  StreamDefinition,
  StreamStore,
  ValueOptions,
  queryOptions,
} from "aeolia";
import { RenderFault, type Owner } from "../runtime/owner.ts";
import { isNonArrayObject, isNonNullObject } from "../utils.ts";
import { createFeed } from "./feed.ts";
import { createQueryView } from "./query.ts";
import { createTask } from "./task.ts";
import type { Accessor, Cell, Feed, QueryView, Task, TaskRun } from "./types.ts";

type BrandedOperationOptions<Options extends StoreOptions<any> | MutationOptions> = ReturnType<
  typeof queryOptions<Options>
>;

/**
 * Owner-bound mutation controller returned by an adapted contract member.
 *
 * Construction is dormant. The mutation payload and optional Aeolia
 * cancellation/optimistic options are supplied to each invocation, so one
 * controller can be reused for multiple independent submissions.
 */
export type MutationTask<Input, Output> = Omit<Task<Input, Output>, "run"> & {
  /**
   * Start a mutation, immediately cancelling this controller's previous run.
   * @param input - Payload for this invocation, passed to the Aeolia mutation.
   * @param options - Per-invocation Aeolia cancellation and optimistic options.
   * @returns A cancellable handle that resolves this invocation's result or rejects
   * its failure/cancellation. Superseded results cannot replace controller state.
   * A graph reset cancels a pending invocation and keeps the last successful
   * value visible until this controller starts another run.
   * @throws A rendering fault if called in a component body or after teardown starts.
   */
  readonly run: ((input: Input, options?: MutationOptions) => TaskRun<Output>) &
    ([Input] extends [void | undefined]
      ? (() => TaskRun<Output>) &
          ((options: MutationOptions | BrandedOperationOptions<MutationOptions>) => TaskRun<Output>)
      : {});
};

interface MutationInvocation {
  readonly sequence: number;
  readonly version: number;
  handle?: TaskRun<unknown>;
  resetReason?: unknown;
  finished?: boolean;
}

/** Map an Aeolia contract declaration to Hesperia's owner-bound member shape. */
export type HesperiaMember<D> =
  D extends QueryDefinition<infer I, infer T, any>
    ? ((input: I, options?: StoreOptions<T>) => QueryView<T>) &
        ([I] extends [void | undefined]
          ? (() => QueryView<T>) &
              ((
                options: StoreOptions<T> | BrandedOperationOptions<StoreOptions<T>>,
              ) => QueryView<T>)
          : {})
    : D extends MutationDefinition<infer I, infer R>
      ? () => MutationTask<I, R>
      : D extends StreamDefinition<infer I, infer T, any>
        ? (input: I, options?: ValueOptions<T>) => Feed<T>
        : D extends StoreDefinition<infer T, any>
          ? () => Cell<T>
          : D extends OperationTree
            ? { readonly [K in keyof D]: HesperiaMember<D[K]> }
            : never;

/** Hesperia's owner-bound projection of an Aeolia contract tree. */
export type HesperiaContractApi<C extends Contract> =
  C extends Contract<infer T> ? { readonly [K in keyof T]: HesperiaMember<T[K]> } : never;

/**
 * Adapt the public Aeolia graph API to Hesperia's owner-bound data handles.
 *
 * The contract is passed explicitly because Aeolia's public `Graph` deliberately
 * exposes no declaration-tree introspection. Query members are materialized when
 * called, stream members remain dormant until owner commit, and mutation members
 * return task controllers whose invocation is the first point that dispatches
 * the underlying Aeolia mutation.
 */
export function createContractApi<C extends Contract>(
  owner: Owner,
  graph: Graph<C>,
  contract: C,
): HesperiaContractApi<C> {
  owner.assertActive();

  const rawApi = graph.api as ContractApi<C>;
  return buildTree(owner, graph, rawApi, contract.operations) as HesperiaContractApi<C>;
}

function buildTree(
  owner: Owner,
  graph: Graph,
  rawApi: unknown,
  declarations: OperationTree,
): unknown {
  if (rawApi === null || typeof rawApi !== "object")
    throw new TypeError("Aeolia graph API must be an object");

  const source = rawApi as Record<string, unknown>;
  const result: Record<string, unknown> = {};

  for (const [property, declaration] of Object.entries(declarations)) {
    const member = source[property];

    if (isStoreDefinition(declaration)) {
      if (typeof member !== "function") throw malformedMember(property);

      result[property] = () => {
        owner.assertActive();

        return createCellView(owner, member() as Store<unknown>);
      };
    } else if (isQueryDefinition(declaration)) {
      if (typeof member !== "function") throw malformedMember(property);

      result[property] = (...args: [input?: unknown, options?: StoreOptions<unknown>]) => {
        owner.assertActive();

        const queryMember = member as (
          ...args: [input?: unknown, options?: StoreOptions<unknown>]
        ) => QueryStore<unknown>;
        const store = queryMember(...args);
        return createQueryView(owner, graph, store, () => {
          queryMember(...args);
        });
      };
    } else if (isMutationDefinition(declaration)) {
      if (typeof member !== "function") throw malformedMember(property);

      result[property] = () => {
        type Invocation = {
          readonly input: unknown;
          readonly options?: MutationOptions;
          readonly record: MutationInvocation;
        };

        type RetainedValue = { readonly sequence: number; readonly value: unknown | undefined };

        const retainedValue = signal<RetainedValue | undefined>(undefined, {
          label: "contract:mutation-retained-value",
        });
        let sequence = 0;
        let latest: MutationInvocation | undefined;
        let lastSettled:
          | { readonly sequence: number; readonly value: unknown | undefined }
          | undefined;

        const task = createTask<Invocation, unknown>(
          owner,
          ({ signal: taskSignal }) =>
            (invocation) => {
              const { record } = invocation;

              if (record.resetReason !== undefined || record.version !== graph.resetVersion.get()) {
                throw record.resetReason ?? cancellationReason();
              }

              const linked = linkAbortSignals(taskSignal, invocation.options?.abortSignal);

              try {
                const operationOptions =
                  invocation.options === undefined
                    ? { abortSignal: linked.signal }
                    : { ...invocation.options, abortSignal: linked.signal };
                const operation = (
                  member as (value: unknown, callOptions: MutationOptions) => Promise<unknown>
                )(invocation.input, operationOptions);
                return rejectOnAbort(operation, invocation.options?.abortSignal).finally(
                  linked.stop,
                );
              } catch (error) {
                linked.stop();

                throw error;
              }
            },
        );

        let observedVersion = graph.resetVersion.get();
        const stopReset = subscribe(graph.resetVersion, (version) => {
          if (version === observedVersion) return;

          observedVersion = version;

          if (owner.state === "cleaning" || owner.state === "destroyed") return;

          const record = latest;

          if (!record) return;

          if (record.handle && task.status() === "success") {
            const value = task.value();

            if (record.sequence >= (lastSettled?.sequence ?? -1)) {
              lastSettled = { sequence: record.sequence, value };
            }
          }

          if (record.version === version || record.resetReason !== undefined || record.finished)
            return;

          const starting = record.handle === undefined;

          if (!starting && !task.pending()) return;

          const reason = cancellationReason();
          record.resetReason = reason;

          try {
            if (lastSettled) {
              retainedValue.set({ sequence: record.sequence, value: lastSettled.value });
            }
          } finally {
            record.handle?.cancel(reason);
          }
        });

        owner.onRelease(stopReset);

        const value = (): unknown | undefined => {
          const currentValue = task.value();
          const currentStatus = task.status();
          const record = latest;
          const retained = retainedValue.get();

          if (
            record?.resetReason !== undefined &&
            currentStatus === "cancelled" &&
            retained?.sequence === record.sequence
          ) {
            return retained.value;
          }

          return currentValue;
        };

        const run = (...args: [input?: unknown, options?: MutationOptions]) => {
          let [input, options] = args;

          owner.assertActive();

          if (owner.executingBody)
            throw new RenderFault("task-body", "Task dispatch is forbidden in a component body");

          if (args.length < 2 && options === undefined && hasMutationOptionsLikeField(input)) {
            options = input as MutationOptions;
            input = undefined;
          }

          const previous = latest;

          if (previous && task.status() === "success") {
            const settledValue = task.value();

            if (previous.sequence >= (lastSettled?.sequence ?? -1)) {
              lastSettled = { sequence: previous.sequence, value: settledValue };
            }
          }

          const record: MutationInvocation = {
            sequence: ++sequence,
            version: graph.resetVersion.get(),
          };
          latest = record;
          const handle = task.run({ input, options, record });
          record.handle = handle;

          if (record.resetReason !== undefined) handle.cancel(record.resetReason);

          void handle.then(
            (settledValue) => {
              record.finished = true;

              if (
                record.resetReason === undefined &&
                record.sequence >= (lastSettled?.sequence ?? -1)
              ) {
                lastSettled = { sequence: record.sequence, value: settledValue };
              }
            },
            () => {
              record.finished = true;
            },
          );

          return handle;
        };

        return Object.freeze({ ...task, value, run });
      };
    } else if (isStreamDefinition(declaration)) {
      if (typeof member !== "function") throw malformedMember(property);

      result[property] = (input: unknown, options?: ValueOptions<unknown>) =>
        createFeed(owner, () => member(input, options) as StreamStore<unknown>);
    } else if (isOperationTree(declaration)) {
      result[property] = buildTree(owner, graph, member, declaration);
    } else {
      throw malformedMember(property);
    }
  }

  return Object.freeze(result);
}

function createCellView<T>(owner: Owner, store: Store<T>): Cell<T> {
  const read: Accessor<T | undefined> = () => {
    owner.assertReadable();

    return store.value.get();
  };

  const cell = read as Cell<T>;

  Object.defineProperties(cell, {
    source: {
      get() {
        owner.assertReadable();

        return store;
      },
    },
    set: {
      value(value: T) {
        owner.assertActive();

        store.set(value);
      },
    },
    update: {
      value(next: (current: T | undefined) => T) {
        owner.assertActive();

        store.update(next);
      },
    },
  });

  return Object.freeze(cell);
}

function isOperationTree(value: unknown): value is OperationTree {
  return isNonNullObject(value) && !isOperationDefinition(value) && !isStoreDefinition(value);
}

function isOperationDefinition(value: unknown): value is OperationDefinition {
  if (!isNonNullObject(value)) return false;

  const kind = (value as { kind?: unknown }).kind;
  return kind === "query" || kind === "mutation" || kind === "stream";
}

function isStoreDefinition(value: unknown): value is StoreDefinition<unknown> {
  return isNonNullObject(value) && (value as { kind?: unknown }).kind === "store";
}

function isQueryDefinition(value: unknown): value is QueryDefinition<unknown, unknown, string> {
  return isOperationDefinition(value) && value.kind === "query";
}

function isMutationDefinition(value: unknown): value is MutationDefinition<unknown, unknown> {
  return isOperationDefinition(value) && value.kind === "mutation";
}

function isStreamDefinition(value: unknown): value is StreamDefinition<unknown, unknown, string> {
  return isOperationDefinition(value) && value.kind === "stream";
}

function hasMutationOptionsLikeField(value: unknown): value is object {
  return (
    isNonArrayObject(value) &&
    ["abortSignal", "optimistic"].some((field) => Object.hasOwn(value, field))
  );
}

function malformedMember(property: string): RenderFault {
  return new RenderFault(
    "contract",
    `Aeolia graph member ${property} does not match its declaration`,
  );
}

function linkAbortSignals(
  primary: AbortSignal,
  secondary: AbortSignal | undefined,
): {
  readonly signal: AbortSignal;
  readonly stop: () => void;
} {
  if (secondary === undefined) return { signal: primary, stop: () => undefined };

  const controller = new AbortController();
  let active = true;

  const forward = (source: AbortSignal): void => {
    if (!controller.signal.aborted) controller.abort(source.reason);
  };

  const onPrimary = (): void => forward(primary);

  const onSecondary = (): void => forward(secondary);

  primary.addEventListener("abort", onPrimary, { once: true });

  secondary.addEventListener("abort", onSecondary, { once: true });

  if (primary.aborted) onPrimary();
  else if (secondary.aborted) onSecondary();

  return {
    signal: controller.signal,
    stop: () => {
      if (!active) return;

      active = false;

      primary.removeEventListener("abort", onPrimary);

      secondary.removeEventListener("abort", onSecondary);
    },
  };
}

function rejectOnAbort<T>(operation: PromiseLike<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return Promise.resolve(operation);

  if (signal.aborted) return Promise.reject(signal.reason ?? cancellationReason());

  return new Promise<T>((resolve, reject) => {
    let active = true;

    const stop = (): void => {
      if (!active) return;

      active = false;

      signal.removeEventListener("abort", abort);
    };

    const abort = (): void => {
      if (!active) return;

      stop();

      reject(signal.reason ?? cancellationReason());
    };

    signal.addEventListener("abort", abort, { once: true });

    Promise.resolve(operation).then(
      (value) => {
        if (!active) return;

        stop();

        resolve(value);
      },
      (error: unknown) => {
        if (!active) return;

        stop();

        reject(error);
      },
    );
  });
}

function cancellationReason(): DOMException {
  return new DOMException("Mutation invocation cancelled", "AbortError");
}

export type { Cell } from "./types.ts";
