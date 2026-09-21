import { computed, signal, type Computed, type SignalOptions, type WritableSignal } from "aeolia";
import { createBinding, type Binding } from "./runtime/binding.ts";
import { Owner, RenderFault } from "./runtime/owner.ts";
import type { Rendered } from "./runtime/dom.ts";
import { createTask } from "./data/task.ts";
import type { Task, TaskFactory } from "./data/types.ts";
import { registerDeparture, type DepartureCheck } from "./routing/navigation.ts";

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

/** Owner-bound departure checks registered by a compiled component. */
export interface Navigation {
  /**
   * Register a departure check for this component's lifetime. Returning false
   * keeps the current route; a promise delays the decision. Incoming route
   * guards run first, and the check receives that navigation's abort signal.
   */
  beforeLeave(check: DepartureCheck): void;
}

/** Author operations bound to one explicit component lifetime. */
export interface Client {
  /** Register a check consulted before the current route leaves. */
  readonly navigation: Navigation;
  /** Create local state; writes after teardown starts are rejected. */
  state<T>(initial: T, options?: SignalOptions<T>): State<T>;
  /** Create a lazy synchronous derivation using Aeolia dependency tracking. */
  derived<T>(compute: () => T, options?: SignalOptions<T>): Derived<T>;
  /** Register an ordered, auto-tracked post-DOM effect. */
  effect(run: Effect): void;
  /** Register untracked cleanup before descendant destruction. */
  cleanup(run: () => void): void;
  /** Create a required binding with an explicit published target type. */
  bind<T>(): Binding<T>;
  /** Create an absence-permitting binding and emit a development warning. */
  unsafeBind<T>(): Binding<T | undefined>;
  /** Create an owner-bound task controller; each run creates fresh work. */
  task<Input, Output>(factory: TaskFactory<Input, Output>): Task<Input, Output>;
  /** Insert opaque HTML into an authored host or Fragment; requires the project permission flag. */
  unsafeHTML(host: Rendered, html: unknown): Rendered;
}

/** Construct the capability retained by generated component code across continuations. */
export function createClient(owner: Owner): Client {
  const capability: Client = {
    navigation: { beforeLeave: (check) => registerDeparture(owner, check) },
    state<T>(initial: T, options: SignalOptions<T> = {}): State<T> {
      owner.assertActive();
      const source = signal(initial, options);
      const read = (() => {
        owner.assertReadable();
        return source.get();
      }) as State<T>;
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
    derived<T>(compute: () => T, options: SignalOptions<T> = {}): Derived<T> {
      owner.assertActive();
      const source = computed(compute, options);
      const read = (() => {
        owner.assertReadable();
        return source.get();
      }) as Derived<T>;
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
    task<Input, Output>(factory: TaskFactory<Input, Output>) {
      return createTask(owner, factory);
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
  navigation: { beforeLeave: missingCompilation },
  state: missingCompilation,
  derived: missingCompilation,
  effect: missingCompilation,
  cleanup: missingCompilation,
  bind: missingCompilation,
  unsafeBind: missingCompilation,
  task: missingCompilation,
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
/** Compiler-lowered raw HTML operation with an authored host or Fragment. */
export const unsafeHTML: Client["unsafeHTML"] = missingCompilation;

export type { Binding, WritableBinding } from "./runtime/binding.ts";
