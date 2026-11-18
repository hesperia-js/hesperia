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
import {
  disposeOwnerSyncPreservingFailure,
  Owner,
  RenderFault,
  runComponentBody,
  runRenderContext,
} from "./owner.ts";

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

/** Checked compiler metadata; authority requires its original admitted call and construction. */
export interface CheckedResumeSourceUse {
  readonly id: string;
  readonly component?: string;
  readonly kind: "state" | "derived" | "query" | "feed" | "graph";
}

/** Compiler-produced contract used before incoming values are published. */
export interface ComponentOptions {
  /** Exact compiler module array retained by the original registered declaration. */
  readonly sourceUses?: readonly CheckedResumeSourceUse[];
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
  readonly declaration: Component<unknown>;
  readonly factory: ComponentFactory<unknown>;
  readonly options: ComponentOptions;
  readonly sourceUses?: readonly CheckedResumeSourceUse[];
}

const definitions = new WeakMap<Function, Definition>();
const actualComponentDefinitions = new WeakMap<
  Owner,
  {
    readonly entry: Definition;
    readonly view:
      | { readonly definition: Function; readonly sourceUses: readonly CheckedResumeSourceUse[] }
      | undefined;
  }
>();

type ActualNativeSourceView = {
  readonly definition: Function;
  readonly sourceUses: readonly CheckedResumeSourceUse[];
};
const nativeSourceDelegations = new WeakMap<
  Owner,
  {
    readonly sourceOwner: Owner;
    readonly entry: Definition;
    readonly view: ActualNativeSourceView;
    readonly issuer: object;
    readonly callbacks: Set<Function>;
  }
>();

function bindActualComponentDefinition(owner: Owner, entry: Definition): void {
  owner.assertActive();
  const existing = actualComponentDefinitions.get(owner);

  if (existing) {
    if (existing.entry !== entry)
      throw new RenderFault(
        "resume-source",
        "A component Owner already belongs to another registered declaration",
      );

    return;
  }

  actualComponentDefinitions.set(owner, {
    entry,
    view:
      entry.sourceUses === undefined
        ? undefined
        : Object.freeze({ definition: entry.declaration, sourceUses: entry.sourceUses }),
  });
}

function originalNativeSource(owner: Owner):
  | {
      readonly sourceOwner: Owner;
      readonly entry: Definition;
      readonly view: ActualNativeSourceView;
    }
  | undefined {
  owner.assertActive();
  const own = actualComponentDefinitions.get(owner);
  if (own?.view) return { sourceOwner: owner, entry: own.entry, view: own.view };
  const delegated = nativeSourceDelegations.get(owner);
  if (!delegated) return undefined;
  delegated.sourceOwner.assertActive();
  const actual = actualComponentDefinitions.get(delegated.sourceOwner);
  if (
    delegated.sourceOwner.context !== owner.context ||
    actual?.entry !== delegated.entry ||
    actual.view !== delegated.view
  )
    throw new RenderFault(
      "resume-structure",
      "A native source delegation lost its original actual declaration",
    );
  return delegated;
}

/** @internal Read the creating Owner's actual registered declaration and original module array. */
export function readActualComponentSourceUses(owner: Owner): ActualNativeSourceView | undefined {
  owner.assertActive();
  return originalNativeSource(owner)?.view;
}

function installNativeSourceDelegation(
  owner: Owner,
  source: {
    readonly sourceOwner: Owner;
    readonly entry: Definition;
    readonly view: ActualNativeSourceView;
  },
  issuer: object,
  callback: Function,
): void {
  owner.assertActive();
  const prior = nativeSourceDelegations.get(owner);
  if (prior) {
    if (
      prior.sourceOwner !== source.sourceOwner ||
      prior.entry !== source.entry ||
      prior.view !== source.view ||
      prior.issuer !== issuer
    )
      throw new RenderFault(
        "resume-structure",
        "A native Owner cannot acquire another original source delegation",
      );
    prior.callbacks.add(callback);
    return;
  }
  if (owner.context !== source.sourceOwner.context)
    throw new RenderFault("resume-structure", "A native callback belongs to another source runtime");
  nativeSourceDelegations.set(owner, { ...source, issuer, callbacks: new Set([callback]) });
  owner.onRelease(() => nativeSourceDelegations.delete(owner));
}

/** @internal Native constructors delegate only their actual parent's registered original source. */
export function bindNativeChildSourceOwner(owner: Owner, parent: Owner, callback: Function): void {
  owner.assertActive();
  parent.assertActive();
  if (
    owner.parent !== parent ||
    owner.context !== parent.context ||
    !parent.children.includes(owner) ||
    typeof callback !== "function"
  )
    throw new RenderFault(
      "resume-structure",
      "A native callback has no actual constructor parent and original function",
    );
  const source = originalNativeSource(parent);
  if (source) installNativeSourceDelegation(owner, source, parent, callback);
}

const dynamicValue = Symbol("hesperia.dynamic");
const componentValueAccessors = new WeakSet<Function>();

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

/** Preserve generated component value props when forwarding them to native elements. */
export function forwardComponentProp(value: unknown): unknown {
  return typeof value === "function" && componentValueAccessors.has(value)
    ? dynamic(value as () => unknown)
    : value;
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

  definitions.set(definition, {
    declaration: definition as Component<unknown>,
    factory: factory as ComponentFactory<unknown>,
    options,
    ...(options.sourceUses === undefined ? {} : { sourceUses: options.sourceUses }),
  });

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
  bindActualComponentDefinition(owner, entry);
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

      const read = () => {
        owner.assertReadable();

        return readable.get();
      };

      componentValueAccessors.add(read);

      bodyValue = read;
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
    let output = runRenderContext(owner, () => runComponentBody(() => entry.factory(owner, props)));

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

    disposeOwnerSyncPreservingFailure(owner, error);

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
