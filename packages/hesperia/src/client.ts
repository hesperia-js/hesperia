import {
  captureReactiveConstruction,
  computed,
  signal,
  type Computed,
  type ReactiveConstruction,
  type SignalOptions,
  type WritableSignal,
} from "aeolia";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import { createBinding, type Binding } from "./runtime/binding.ts";
import { Owner, RenderFault } from "./runtime/owner.ts";
import type { Rendered } from "./runtime/dom.ts";
import { createTask } from "./data/task.ts";
import type { InferredTask, Task, TaskContext, TaskFactory, TaskInvocation } from "./data/types.ts";
import { createForm } from "./validation/form.ts";
import type { Form, FormOptions } from "./validation/form.ts";
import * as eventHelpers from "./events.ts";

const nativeArgumentSlice = Array.prototype.slice;
const nativeArgumentApply = Reflect.apply;

/** Native event listener helpers available from the `hesperia/client` namespace. */
export { eventHelpers as events };

/** Callable read that participates in Aeolia tracking when a context is active. */
export interface Accessor<T> {
  /** Return the current value. */
  (): T;
}

/** Component-owned writable state backed by one Aeolia signal. */
export interface State<T> extends Accessor<T> {
  /** Publish a value synchronously; dependent DOM updates finish before return. */
  set(value: T): void;

  /** Compute a value from the current state and publish it synchronously. */
  update(next: (current: T) => T): void;

  /** Underlying public Aeolia signal for explicit interoperability. */
  readonly source: WritableSignal<T>;
}

/** Lazy component-owned derivation backed by one Aeolia computed. */
export interface Derived<T> extends Accessor<T> {
  /** Underlying public Aeolia computed. */
  readonly source: Computed<T>;
}

/** Callback invoked after DOM installation; a returned cleanup precedes its next run. */
export type Effect = () => void | (() => void);

/** Author operations bound to one explicit component lifetime. */
export interface Client {
  /** Composable native listener options shared with the `hesperia/events` module. */
  readonly events: typeof eventHelpers;

  /** Create local state; writes after teardown starts are rejected. */
  state<T>(initial: T, options?: SignalOptions<T>): State<T>;

  /** Create a lazy synchronous derivation using Aeolia dependency tracking. */
  derived<T>(compute: () => T, options?: SignalOptions<T>): Derived<T>;

  /** Register an ordered, auto-tracked post-DOM effect. */
  effect(run: Effect): void;

  /**
   * Register untracked cleanup before descendant destruction. Primitive returns
   * are ignored. Object and function returns are observed as native Promises
   * without thenable assimilation and may make retirement incomplete. Revocation
   * remains synchronous; owner-bound writes are unavailable after an await.
   */
  cleanup(run: () => unknown): void;

  /** Create a required binding with an explicit published target type. */
  bind<T>(): Binding<T>;

  /** Create an absence-permitting binding and emit a development warning. */
  unsafeBind<T>(): Binding<T | undefined>;

  /** Create an owner-bound task controller; each run creates fresh work. */
  task<Args extends Parameters<Operation>, Output, Operation extends TaskInvocation<never, Output>>(
    factory: (context: TaskContext) => Operation,
  ): InferredTask<Args, Operation>;

  /** Create a task with explicitly selected input and output types. */
  task<Input = void, Output = unknown>(factory: TaskFactory<Input, Output>): Task<Input, Output>;

  /**
   * Create a dormant Standard Schema validator bound to this component's lifetime.
   *
   * A run fulfills with the schema result, including validation issues; thrown
   * errors and task cancellation fail the run. `runForm` captures native form
   * data and its optional submitter synchronously when the run starts, then
   * applies `options.map` before validation. `reset` clears validation state only.
   *
   * @param schema Standard Schema validator used by each run.
   * @param options Optional form-data-to-input mapping.
   * @returns The owner-bound form validator.
   */
  form<Input, Output>(
    schema: StandardSchemaV1<Input, Output>,
    options?: FormOptions<Input>,
  ): Form<Input, Output>;

  /** Insert opaque HTML into an authored host or Fragment; requires the project permission flag. */
  unsafeHTML(host: Rendered, html: unknown): Rendered;
}

/** @internal The actual first-party call retained before its accessor is exposed. */
export interface ActualReactiveConstruction {
  readonly owner: Owner;
  readonly kind: "state" | "derived";
  readonly construction: ReactiveConstruction<unknown>;
  readonly source: WritableSignal<unknown> | Computed<unknown>;
  readonly accessor: object;
  readonly factory: typeof signal | typeof computed;
  readonly callee: Function;
  readonly receiver: unknown;
  /** Shallow call-time slots; referenced objects and callbacks retain live identity. */
  readonly arguments: readonly unknown[];
  readonly optionsSupplied: boolean;
}

const reactiveConstructions = new WeakMap<object, ActualReactiveConstruction>();
const reactiveConstructionLedgers = new WeakMap<Owner, ActualReactiveConstruction[]>();
const activeReactiveCalls = new WeakMap<Owner, Set<ActualReactiveConstruction>[]>();

/** @internal Capture an actual new first-party constructor result during this exact call. */
export function captureActualReactiveCall<T>(
  owner: Owner,
  construct: () => T,
): { readonly value: T; readonly receipt: ActualReactiveConstruction } {
  owner.assertActive();

  const scopes = activeReactiveCalls.get(owner) ?? [];
  const receipts = new Set<ActualReactiveConstruction>();

  scopes.push(receipts);
  activeReactiveCalls.set(owner, scopes);

  try {
    const value = construct();
    const receipt = readActualReactiveConstruction(owner, value);

    if (!receipt || !receipts.has(receipt))
      throw new RenderFault(
        "resume-source",
        "The generated call did not return its actual new client construction",
      );

    return Object.freeze({ value, receipt });
  } finally {
    scopes.pop();

    if (!scopes.length) activeReactiveCalls.delete(owner);
  }
}

/** @internal Read only a receipt issued by the actual client constructor for this Owner. */
export function readActualReactiveConstruction(
  owner: Owner,
  value: unknown,
): ActualReactiveConstruction | undefined {
  if ((typeof value !== "object" || value === null) && typeof value !== "function") return;

  const receipt = reactiveConstructions.get(value);

  return receipt?.owner === owner ? receipt : undefined;
}

/**
 * @internal Return exact first-party reactive construction receipts in issuer receipt order.
 * This is evidence order, separate from Host checked-call entry order.
 * @param owner The live Owner whose actual Client constructors were issued.
 * @returns A frozen defensive snapshot containing the same authentic receipt objects.
 * @throws {RenderFault} If the Owner is no longer active or a retained receipt is inconsistent.
 */
export function readActualReactiveConstructionLedger(
  owner: Owner,
): readonly ActualReactiveConstruction[] {
  owner.assertActive();

  const snapshot = (reactiveConstructionLedgers.get(owner) ?? []).slice();

  for (const receipt of snapshot) {
    if (
      receipt.owner !== owner ||
      receipt.source !== receipt.construction.source ||
      reactiveConstructions.get(receipt.accessor) !== receipt ||
      reactiveConstructions.get(receipt.source) !== receipt
    )
      throw new RenderFault(
        "resume-source",
        "The Owner construction ledger contains a mismatched actual receipt",
      );
  }

  return Object.freeze(snapshot);
}

function retainReactiveConstruction(
  owner: Owner,
  accessor: object,
  kind: ActualReactiveConstruction["kind"],
  construction: ReactiveConstruction<unknown>,
  source: WritableSignal<unknown> | Computed<unknown>,
  factory: typeof signal | typeof computed,
  callee: Function,
  receiver: unknown,
  args: readonly unknown[],
  optionsSupplied: boolean,
): void {
  const receipt = Object.freeze({
    owner,
    kind,
    construction,
    source,
    accessor,
    factory,
    callee,
    receiver,
    arguments: Object.freeze(args),
    optionsSupplied,
  });

  reactiveConstructions.set(accessor, receipt);
  reactiveConstructions.set(construction.source, receipt);

  const ledger = reactiveConstructionLedgers.get(owner);
  if (ledger && owner.state !== "cleaning" && owner.state !== "destroyed") ledger.push(receipt);

  for (const scope of activeReactiveCalls.get(owner) ?? []) scope.add(receipt);
}

function ensureReactiveConstructionLedger(owner: Owner): void {
  if (reactiveConstructionLedgers.has(owner)) return;

  const ledger: ActualReactiveConstruction[] = [];
  owner.onRelease(() => {
    if (reactiveConstructionLedgers.get(owner) === ledger)
      reactiveConstructionLedgers.delete(owner);
  });
  reactiveConstructionLedgers.set(owner, ledger);
}

/** Construct the capability retained by generated component code across continuations. */
export function createClient(owner: Owner): Client {
  const capability: Client = {
    events: eventHelpers,

    state<T>(initial: T, options?: SignalOptions<T>): State<T> {
      owner.assertActive();

      const optionsSupplied = arguments.length > 1;
      const actualArguments = nativeArgumentApply(nativeArgumentSlice, arguments, []) as unknown[];
      ensureReactiveConstructionLedger(owner);
      const source = optionsSupplied ? signal(initial, options) : signal(initial);
      const construction = captureReactiveConstruction(source);

      const read = (() => {
        owner.assertReadable();

        return source.get();
      }) as State<T>;

      retainReactiveConstruction(
        owner,
        read,
        "state",
        construction,
        source,
        signal,
        capability.state,
        this,
        actualArguments,
        optionsSupplied,
      );
      owner.assertActive();
      Object.defineProperty(read, "source", { value: source });

      read.set = (value) => {
        owner.assertActive();

        source.set(value);
      };

      read.update = (next) => {
        owner.assertActive();

        source.update(next);
      };

      return read;
    },

    derived<T>(compute: () => T, options?: SignalOptions<T>): Derived<T> {
      owner.assertActive();

      const optionsSupplied = arguments.length > 1;
      const actualArguments = nativeArgumentApply(nativeArgumentSlice, arguments, []) as unknown[];
      ensureReactiveConstructionLedger(owner);
      const source = optionsSupplied ? computed(compute, options) : computed(compute);
      const construction = captureReactiveConstruction(source);

      const read = (() => {
        owner.assertReadable();

        return source.get();
      }) as Derived<T>;

      retainReactiveConstruction(
        owner,
        read,
        "derived",
        construction,
        source,
        computed,
        capability.derived,
        this,
        actualArguments,
        optionsSupplied,
      );
      owner.assertActive();
      Object.defineProperty(read, "source", { value: source });

      return read;
    },

    effect(run) {
      owner.assertActive();

      owner.context.scheduler.effect(owner, run);
    },

    cleanup(run) {
      owner.onCleanup(run);
    },

    bind<T>() {
      return createBinding<T>(owner, false);
    },

    unsafeBind<T>() {
      return createBinding<T>(owner, true);
    },

    task<Input = void, Output = unknown>(factory: TaskFactory<Input, Output>) {
      return createTask(owner, factory);
    },

    form<Input, Output>(schema: StandardSchemaV1<Input, Output>, options?: FormOptions<Input>) {
      return createForm<Input, Output>(owner, schema, options);
    },

    unsafeHTML: missingCompilation,
  };

  return capability;
}

function missingCompilation(): never {
  throw new RenderFault(
    "compiler-required",
    "Use Hesperia's compiler to bind client operations to a component",
  );
}

/**
 * Authoring marker rewritten to an owner-bound client by the compiler. Calling
 * these operations in uncompiled code is a rendering contract violation.
 */
const uncompiledClient = {
  events: eventHelpers,
  state: missingCompilation,
  derived: missingCompilation,
  effect: missingCompilation,
  cleanup: missingCompilation,
  bind: missingCompilation,
  unsafeBind: missingCompilation,
  task: missingCompilation,
  form: missingCompilation,
  unsafeHTML: missingCompilation,
};
export const client: Client = uncompiledClient;

/** Compiler-bound local state authoring operation. */
export const state: Client["state"] = missingCompilation;
/** Compiler-bound lazy derivation authoring operation. */
export const derived: Client["derived"] = missingCompilation;
/** Compiler-bound effect registration authoring operation. */
export const effect: Client["effect"] = missingCompilation;
/** Compiler-bound lifetime cleanup authoring operation. */
export const cleanup: Client["cleanup"] = missingCompilation;
/** Compiler-bound required publication reference authoring operation. */
export const bind: Client["bind"] = missingCompilation;
/** Compiler-bound optional reference authoring operation. */
export const unsafeBind: Client["unsafeBind"] = missingCompilation;
/** Compiler-bound owner task authoring operation. */
export const task: Client["task"] = missingCompilation;
/** Compiler-bound owner form-validation authoring operation. */
export const form: Client["form"] = missingCompilation;
/** Compiler-lowered raw HTML operation with an authored host or Fragment. */
export const unsafeHTML: Client["unsafeHTML"] = missingCompilation;

export type { Binding, WritableBinding } from "./runtime/binding.ts";
export type { Form, FormOptions, FormRunOptions } from "./validation/form.ts";
