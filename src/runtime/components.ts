import { signal, type WritableSignal } from "aeolia";
import type { Accessor } from "../client.ts";
import {
  attachComponentBinding,
  isRequiredBinding,
  reassignComponentBinding,
  type Binding,
  type WritableBinding,
} from "./binding.ts";
import type { Rendered } from "./dom.ts";
import { Owner, RenderFault, runComponentBody } from "./owner.ts";

declare const componentPropsType: unique symbol;

/**
 * Body-facing props derived from the author's incoming type `P`.
 *
 * Ordinary values become tracked accessors. A field whose complete type is
 * callable remains directly callable; a callback allowing `undefined` becomes
 * an accessor returning that callback or `undefined`. Optional ordinary fields
 * therefore always have a body accessor, even when the caller omits the value.
 * The reserved `bind` field instead receives a writable attachment endpoint.
 * The private type-only member preserves `P` for compiler checking and emission.
 */
export type ComponentProps<P> = {
  readonly [K in keyof P as K extends "bind" ? never : K]-?: P[K] extends (
    ...args: never[]
  ) => unknown
    ? P[K]
    : Accessor<P[K]>;
} & {
  readonly [K in keyof P as K extends "bind" ? K : never]:
    | WritableBinding<Exclude<P[K], undefined>>
    | (undefined extends P[K] ? undefined : never);
} & { readonly bind?: unknown; readonly [componentPropsType]?: P };

/** Caller binding values become writable publication endpoints only during attachment. */
export type CallerProps<P> = {
  [K in keyof P]: K extends "bind"
    ? Binding<Exclude<P[K], undefined> | undefined> | (undefined extends P[K] ? undefined : never)
    : P[K];
} & { readonly bind?: unknown };

/** Authored component declaration, invoked only through compiled JSX. */
export interface Component<P = Record<string, never>> {
  /** Execute an authored body using its mapped props. */
  (props: ComponentProps<P>): Rendered | Promise<Rendered>;
}

/** Types for authored component declarations. */
export namespace Component {
  /**
   * Map incoming `P` to body accessors, callable callbacks, and the reserved
   * binding endpoint. Optional callbacks are accessors because their values may
   * be `undefined`; only `?` permits the caller to omit a declared prop.
   */
  export type Props<P = Record<string, never>> = ComponentProps<P>;
}

/** Compiler-produced body with an explicit lifetime capability. */
export type ComponentFactory<P> = (
  owner: Owner,
  props: ComponentProps<P>,
) => Rendered | Promise<Rendered>;

/** One compiler-checked incoming prop slot. */
export interface PropSchema {
  /** Values use signals, callbacks forward calls, bindings attach endpoints, and page inputs may remain plain. */
  readonly kind: "value" | "callback" | "binding" | "plain";
  /** Whether absence is valid for this input. */
  readonly optional: boolean;
}

/** Compiler-produced contract used before incoming values are published. */
export interface ComponentOptions {
  /** Mark a body requiring an enclosing async waiting boundary before it starts. */
  readonly async?: boolean;
  /** Diagnostic component name. */
  readonly name?: string;
  /** Declared slot kinds and presence requirements. */
  readonly props?: Readonly<Record<string, PropSchema>>;
  /** Required names emitted by older compiler helpers without full slot metadata. */
  readonly requiredProps?: readonly string[];
}

interface Definition {
  readonly factory: ComponentFactory<unknown>;
  readonly options: ComponentOptions;
}

const definitions = new WeakMap<Function, Definition>();
const dynamicValue = Symbol("hesperia.dynamic");

/** Explicit generated expression marker, distinct from a callback prop. */
export interface Dynamic<T> {
  /** Evaluate the authored expression in the active Aeolia tracking context. */
  readonly read: () => T;
  /** Runtime marker separating generated expressions from ordinary objects. */
  readonly [dynamicValue]: true;
}

/** Mark an expression that generated code observes explicitly. */
export function dynamic<T>(read: () => T): Dynamic<T> {
  return { [dynamicValue]: true, read };
}

/** Test the compiler's explicit expression marker without implicitly reading arbitrary objects. */
export function isDynamic(value: unknown): value is Dynamic<unknown> {
  return typeof value === "object" && value !== null && dynamicValue in value;
}

/** Register a compiled body; ordinary direct invocation fails. */
export function defineComponent<P>(
  factory: ComponentFactory<P>,
  options: ComponentOptions = {},
): Component<P> {
  const definition = (() => {
    throw new RenderFault("component-direct-call", "Components must be reached through JSX");
  }) as Component<P>;
  definitions.set(definition, { factory: factory as ComponentFactory<unknown>, options });
  return definition;
}

/** Validated incoming values, collected once and reused if reconciliation needs recreation. */
export interface PreparedComponent {
  /** Resolved declaration identity. */
  readonly definition: Component<unknown>;
  /** Frozen sequence of own incoming entries; referenced object values are not copied. */
  readonly entries: readonly (readonly [string, unknown])[];
  /** Validated declared and inferred slot schema. */
  readonly schema: ReadonlyMap<string, PropSchema>;
}

/** Collect one incoming snapshot and validate every required slot before any publication. */
export function prepareComponent<P>(
  definition: Component<P>,
  incoming: CallerProps<P>,
): PreparedComponent {
  const entry = definitions.get(definition);
  if (!entry)
    throw new RenderFault("component-uncompiled", "Expected a compiled Hesperia component");
  const entries = Object.entries(incoming as object).map(([name, value]) =>
    Object.freeze([name, isDynamic(value) ? value.read() : value] as const),
  );
  const values = new Map(entries);
  const schema = new Map(Object.entries(entry.options.props ?? {}));
  for (const name of entry.options.requiredProps ?? []) {
    if (!schema.has(name))
      schema.set(name, { kind: name === "bind" ? "binding" : "value", optional: false });
  }
  for (const [name, value] of entries) {
    if (name === "key" || schema.has(name)) continue;
    schema.set(name, {
      kind: name === "bind" ? "binding" : typeof value === "function" ? "callback" : "value",
      optional: true,
    });
  }
  for (const [name, slot] of schema) {
    if (!slot.optional && !values.has(name)) {
      throw new RenderFault("prop-missing", `Missing required prop ${name}`);
    }
    const value = values.get(name);
    if (slot.kind === "callback" && value !== undefined && typeof value !== "function") {
      throw new RenderFault("prop-invalid", `Callback prop ${name} must be callable`);
    }
    if (slot.kind === "binding" && value !== undefined && typeof value !== "function") {
      throw new RenderFault("prop-invalid", `Binding prop ${name} must be a Hesperia binding`);
    }
  }
  return { definition: definition as Component<unknown>, entries: Object.freeze(entries), schema };
}

interface PropSlot {
  readonly schema: PropSchema;
  readonly bodyValue: unknown;
  readonly source?: WritableSignal<unknown>;
  current: unknown;
}

/** One executed component instance and its plain body-props mapping. */
export interface ComponentInstance {
  /** Fresh lifetime for this instance. */
  readonly owner: Owner;
  /** Resolved component declaration. */
  readonly definition: Component<unknown>;
  /** Actual body result, installed by the owning region. */
  readonly output: Rendered | Promise<Rendered>;
  /** Plain container passed to the body; retained to verify accessor mapping integrity. */
  readonly props: Record<string, unknown>;
  /** Recorded slots backing the public props container. */
  readonly slots: ReadonlyMap<string, PropSlot>;
}

/** Execute one fresh body from an already-validated input snapshot. */
export function instantiateComponent(
  owner: Owner,
  prepared: PreparedComponent,
  awaited = false,
): ComponentInstance {
  const entry = definitions.get(prepared.definition)!;
  const values = new Map(prepared.entries);
  const checkAsync = () => {
    if (
      !owner.asyncBoundary ||
      owner.asyncBoundary.owner.state === "cleaning" ||
      owner.asyncBoundary.owner.state === "destroyed"
    ) {
      throw new RenderFault(
        "async-boundary",
        "An async component requires an enclosing async boundary",
      );
    }
    if (!awaited && isRequiredBinding(values.get("bind"))) {
      throw new RenderFault(
        "async-binding",
        "A required binding cannot attach to an independently loading async component",
      );
    }
  };
  if (entry.options.async || entry.factory.constructor.name === "AsyncFunction") checkAsync();
  const props: Record<string, unknown> = {};
  const slots = new Map<string, PropSlot>();
  for (const [name, schema] of prepared.schema) {
    if (name === "key") continue;
    const value = values.get(name);
    let bodyValue: unknown;
    let source: WritableSignal<unknown> | undefined;
    const slot: PropSlot = { schema, current: value, bodyValue: undefined };
    if (schema.kind === "plain") {
      bodyValue = value;
    } else if (schema.kind === "binding") {
      bodyValue =
        value === undefined ? undefined : attachComponentBinding(value as Binding<unknown>, owner);
    } else if (schema.kind === "callback") {
      bodyValue =
        value === undefined
          ? undefined
          : function (this: unknown, ...args: unknown[]) {
              owner.assertReadable();
              return Reflect.apply(slot.current as Function, this, args);
            };
    } else {
      source = signal(value);
      const readable = source;
      bodyValue = () => {
        owner.assertReadable();
        return readable.get();
      };
    }
    Object.assign(slot, { bodyValue, ...(source ? { source } : {}) });
    Object.defineProperty(props, name, {
      value: bodyValue,
      enumerable: true,
      configurable: true,
      writable: true,
    });
    slots.set(name, slot);
  }
  try {
    let output = runComponentBody(() => entry.factory(owner, props));
    if (output && typeof output === "object" && "then" in output) {
      try {
        checkAsync();
      } catch (error) {
        void Promise.resolve(output).catch(() => undefined);
        throw error;
      }
      owner.commitDeferred = true;
      output = Promise.resolve(output).then(
        (value) => {
          owner.assertActive();
          owner.executingBody = false;
          owner.commitDeferred = false;
          return value;
        },
        (error: unknown) => {
          owner.executingBody = false;
          throw error;
        },
      );
    } else {
      owner.executingBody = false;
    }
    return { owner, definition: prepared.definition, output, props, slots };
  } catch (error) {
    owner.executingBody = false;
    owner.dispose(error);
    throw error;
  }
}

/**
 * Determine whether the plain props mapping can still represent valid incoming
 * data. Descriptor checks never invoke a damaged getter or recollect inputs.
 */
export function canPublishComponent(
  instance: ComponentInstance,
  prepared: PreparedComponent,
): boolean {
  return canPublishComponentExcept(instance, prepared, new Set());
}

/**
 * Route hosts retain a layout while replacing its structural children. The
 * children slot is published through the existing signal-backed prop; every
 * other captured prop still has to pass the ordinary publication checks.
 */
export function canPublishComponentExcept(
  instance: ComponentInstance,
  prepared: PreparedComponent,
  ignored: ReadonlySet<string>,
): boolean {
  if (instance.owner.state === "cleaning" || instance.owner.state === "destroyed") {
    return false;
  }
  const next = new Map(prepared.entries);
  for (const [name, schema] of prepared.schema) {
    const slot = instance.slots.get(name);
    if (!slot || slot.schema.kind !== schema.kind) {
      return false;
    }
  }
  for (const [name, slot] of instance.slots) {
    const descriptor = Object.getOwnPropertyDescriptor(instance.props, name);
    if (!descriptor || !("value" in descriptor) || descriptor.value !== slot.bodyValue) {
      return false;
    }
    if (ignored.has(name)) continue;
    const value = next.get(name);
    if (slot.schema.kind === "plain" && !Object.is(value, slot.current)) return false;
    if (slot.schema.kind === "binding" && (value === undefined) !== (slot.current === undefined))
      return false;
    if (slot.schema.kind === "callback" && (value === undefined) !== (slot.current === undefined))
      return false;
  }
  return true;
}

/** Publish the validated values into an intact instance without executing its body again. */
export function publishComponent(instance: ComponentInstance, prepared: PreparedComponent): void {
  const next = new Map(prepared.entries);
  for (const [name, slot] of instance.slots) {
    const value = next.get(name);
    if (slot.schema.kind === "binding" && value !== slot.current && value !== undefined) {
      reassignComponentBinding(
        slot.bodyValue as WritableBinding<unknown>,
        value as Binding<unknown>,
      );
    }
    slot.current = value;
    slot.source?.set(value);
  }
}
