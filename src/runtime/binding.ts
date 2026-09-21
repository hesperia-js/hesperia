import { signal, type WritableSignal } from "aeolia";
import { Owner, RenderFault, reportFault, isExecutingBody } from "./owner.ts";

/** Read-only, callable reference held by the creating component. */
export interface Binding<T> {
  /** Read the current target reactively; invalid required reads throw. */
  (): T;
}

/** Attached component's publication endpoint, valid only for its lifetime. */
export interface WritableBinding<T> extends Binding<T> {
  /** Publish this attached component's explicitly exposed interface. */
  set(value: T): void;
}

interface Attachment {
  readonly owner: Owner;
  readonly target: object;
}

interface BindingRecord {
  readonly creator: Owner;
  readonly optional: boolean;
  readonly value: WritableSignal<unknown>;
  attachment: Attachment | undefined;
  published: boolean;
}

interface ElementBindingObserver {
  readonly owner: Owner;
  readonly element: Element;
  readonly record: BindingRecord;
  readonly observer: MutationObserver;
  observe(): void;
  check(): void;
}

const records = new WeakMap<Binding<unknown>, BindingRecord>();
const endpoints = new WeakMap<
  WritableBinding<unknown>,
  { reassign(binding: Binding<unknown>): void }
>();
const elementObservers = new WeakMap<Owner, Set<ElementBindingObserver>>();

/** @internal Disconnect native binding membership observers while an owner is cached. */
export function suspendBindings(owner: Owner): void {
  for (const binding of elementObservers.get(owner) ?? []) binding.observer.disconnect();
}

/** @internal Reconnect native binding observers and report a genuinely missing target. */
export function resumeBindings(owner: Owner): void {
  for (const binding of elementObservers.get(owner) ?? []) {
    if (!owner.isCommitted()) continue;
    binding.check();
    if (binding.record.attachment?.target === binding.element) binding.observe();
  }
}

/** Create an owned reference; optional references permit absence and warn at creation. */
export function createBinding<T>(owner: Owner, optional: false): Binding<T>;
/** Create the unsafe absence-permitting reference form. */
export function createBinding<T>(owner: Owner, optional: true): Binding<T | undefined>;
export function createBinding<T>(owner: Owner, optional: boolean): Binding<T | undefined> {
  owner.assertActive();
  if (optional) owner.context.warn("unsafeBind permits missing targets; check absence before use");
  const record: BindingRecord = {
    creator: owner,
    optional,
    value: signal<unknown>(undefined),
    attachment: undefined,
    published: false,
  };
  const read = (() => {
    owner.assertReadable();
    if (owner.executingBody || isExecutingBody()) {
      throw new RenderFault("binding-body-read", "Bindings cannot be read in a component body");
    }
    const value = record.value.get();
    if (!record.attachment || !record.published) {
      if (!optional) throw new RenderFault("binding-empty", "Required binding has no live target");
      return undefined;
    }
    return value as T;
  }) as Binding<T | undefined>;
  records.set(read, record);
  if (!optional) {
    owner.publicationChecks.add(() => {
      if (owner.isCommitted() && (!record.attachment || !record.published)) {
        throw new RenderFault(
          "binding-missing",
          "Required binding did not publish by the effect pass",
        );
      }
    });
  }
  return read;
}

function getRecord(binding: Binding<unknown>): BindingRecord {
  const record = records.get(binding);
  if (!record) throw new RenderFault("binding-invalid", "Expected a Hesperia binding");
  return record;
}

/** Validate a generated binding attachment and report whether it guarantees existence. */
export function isRequiredBinding(binding: unknown): boolean {
  if (binding === undefined) return false;
  if (typeof binding !== "function")
    throw new RenderFault("binding-invalid", "Expected a Hesperia binding");
  return !getRecord(binding as Binding<unknown>).optional;
}

function attach(binding: Binding<unknown>, owner: Owner, target: object): BindingRecord {
  const record = getRecord(binding);
  record.creator.assertActive();
  owner.assertActive();
  if (record.attachment) {
    throw new RenderFault("binding-duplicate", "A binding cannot attach to multiple live targets");
  }
  const attachment = { owner, target };
  record.attachment = attachment;
  record.published = false;
  owner.onRelease(() => {
    if (record.attachment !== attachment) return;
    record.attachment = undefined;
    record.published = false;
    if (record.optional) record.value.set(undefined);
    else if (record.creator.state === "mounted") owner.context.scheduler.requestEffects();
  });
  return record;
}

/** Install the child's publication endpoint without exposing creator write access. */
export function attachComponentBinding<T>(binding: Binding<T>, owner: Owner): WritableBinding<T> {
  let current = binding;
  let record = attach(binding, owner, owner);
  let attachment = record.attachment;
  let published: T | undefined;
  let hasPublished = false;
  const read = (() => current()) as WritableBinding<T>;
  read.set = (value: T) => {
    owner.assertActive();
    if (record.attachment !== attachment) {
      throw new RenderFault("binding-stale", "The binding publication endpoint is stale");
    }
    if (value === undefined) {
      throw new RenderFault("binding-publication", "A component must publish a defined interface");
    }
    published = value;
    hasPublished = true;
    record.published = true;
    record.value.set(guardExposed(value, owner));
  };
  endpoints.set(read, {
    reassign(next) {
      owner.assertActive();
      if (next === current) return;
      const nextRecord = getRecord(next);
      nextRecord.creator.assertActive();
      if (nextRecord.attachment)
        throw new RenderFault(
          "binding-duplicate",
          "A binding cannot attach to multiple live targets",
        );
      record.attachment = undefined;
      record.published = false;
      if (record.optional) record.value.set(undefined);
      else if (record.creator.state === "mounted") owner.context.scheduler.requestEffects();
      current = next as Binding<T>;
      record = attach(current, owner, owner);
      attachment = record.attachment;
      if (hasPublished) read.set(published as T);
    },
  });
  return read;
}

/** Retarget an intact child endpoint while preserving its body and latest publication. */
export function reassignComponentBinding(
  endpoint: WritableBinding<unknown>,
  binding: Binding<unknown>,
): void {
  const state = endpoints.get(endpoint);
  if (!state) throw new RenderFault("binding-invalid", "Expected an attached component endpoint");
  state.reassign(binding);
}

/** Attach the actual native element and observe its continued membership in the rendered tree. */
export function attachElementBinding<T extends Element>(
  binding: Binding<T>,
  owner: Owner,
  element: T,
): void {
  const record = attach(binding, owner, element);
  record.published = true;
  record.value.set(element);
  const Observer = owner.context.document.defaultView?.MutationObserver;
  if (!Observer) throw new RenderFault("dom-observer", "The document has no MutationObserver");
  const bindingObserver: ElementBindingObserver = {
    owner,
    element,
    record,
    observer: new Observer(() => {
      if (!owner.isCommitted() || record.attachment?.target !== element) return;
      if (!owner.context.container.contains(element)) {
        bindingObserver.check();
      }
    }),
    observe() {
      bindingObserver.observer.observe(owner.context.container, { childList: true, subtree: true });
    },
    check() {
      if (record.attachment?.target !== element || owner.state === "suspended") return;
      if (owner.context.container.contains(element)) return;
      bindingObserver.observer.disconnect();
      record.attachment = undefined;
      record.published = false;
      if (record.optional) record.value.set(undefined);
      reportFault(
        owner,
        new RenderFault("binding-removed", "A bound element was removed from its rendered tree"),
      );
    },
  };
  bindingObserver.observe();
  const observers = elementObservers.get(owner) ?? new Set<ElementBindingObserver>();
  observers.add(bindingObserver);
  elementObservers.set(owner, observers);
  owner.onRelease(() => {
    bindingObserver.observer.disconnect();
    observers.delete(bindingObserver);
  });
}

function guardExposed<T>(value: T, owner: Owner): T {
  const cache = new WeakMap<object, object>();
  function wrap<V>(input: V): V {
    if ((typeof input !== "object" || input === null) && typeof input !== "function") return input;
    const object = input as object;
    const existing = cache.get(object);
    if (existing) return existing as V;
    const facade: object =
      typeof input === "function"
        ? function (this: unknown, ...args: unknown[]) {
            owner.assertReadable();
            return Reflect.apply(input, this, args);
          }
        : Object.create(null);
    cache.set(object, facade);
    const properties = new Map<PropertyKey, PropertyDescriptor>();
    let prototype: object | null = object;
    while (prototype && prototype !== Object.prototype && prototype !== Function.prototype) {
      for (const key of Reflect.ownKeys(prototype)) {
        if (!properties.has(key))
          properties.set(key, Object.getOwnPropertyDescriptor(prototype, key)!);
      }
      prototype = Object.getPrototypeOf(prototype);
    }
    for (const [property, descriptor] of properties) {
      const ownDescriptor = Object.getOwnPropertyDescriptor(facade, property);
      if (ownDescriptor && !ownDescriptor.configurable) continue;
      Object.defineProperty(facade, property, {
        enumerable: descriptor.enumerable ?? false,
        configurable: false,
        get() {
          owner.assertReadable();
          const member: unknown = Reflect.get(object, property, object);
          if (typeof member === "function") {
            return (...args: unknown[]) => {
              owner.assertReadable();
              return Reflect.apply(member, object, args);
            };
          }
          return wrap(member);
        },
      });
    }
    return facade as V;
  }
  return wrap(value);
}
