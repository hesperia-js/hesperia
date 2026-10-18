import { Signal } from "aeolia";
import {
  canPublishComponent,
  defineComponent,
  instantiateComponent,
  prepareComponent,
  publishComponent,
  type CallerProps,
  type Component,
  type ComponentInstance,
  type PreparedComponent,
} from "./components.ts";
import type { Rendered } from "./dom.ts";
import type { Accessor } from "../client.ts";
import { Owner, RenderFault } from "./owner.ts";

const itemMarker = Symbol("hesperia.component-item");
const nativeDefinitions = new WeakMap<Function, Component<unknown>>();

/** Snapshot fields read by a hoisted native factory, including function-valued fields. */
export type NativeScope<S> = { readonly [K in keyof S]: Accessor<S[K]> };

/** Stable compiler-hoisted factory receiving a native item's current reactive scope. */
export type NativeFactory<S> = (owner: Owner, scope: NativeScope<S>) => Rendered;

/**
 * Describe a native occurrence using a stable hoisted factory and one captured
 * scope snapshot. Reconciliation reuses its owner and updates scope accessors.
 */
export function nativeItem<S extends object>(
  factory: NativeFactory<S>,
  scope: S,
  slot: string,
  key?: unknown,
): ComponentItem {
  const snapshot = Object.freeze(Object.fromEntries(Object.entries(scope))) as S;

  let definition = nativeDefinitions.get(factory);

  if (!definition) {
    definition = defineComponent<{ scope: S }>(
      (owner, props) => {
        const readScope = props.scope as Accessor<S>;

        const accessors = Object.fromEntries(
          Object.keys(snapshot).map((name) => [name, () => readScope()[name as keyof S]]),
        ) as NativeScope<S>;

        return factory(owner, accessors);
      },
      { props: { scope: { kind: "value", optional: false } } },
    ) as Component<unknown>;

    nativeDefinitions.set(factory, definition);
  }

  return componentItem(definition as Component<{ scope: S }>, { scope: snapshot }, slot, key);
}

/** Inert generated component occurrence, validated before a region changes its committed tree. */
export interface ComponentItem {
  /** Marker separating structural descriptions from author values. */
  readonly [itemMarker]: true;
  /** Resolved component or compiler-hoisted native factory. */
  readonly definition: Component<unknown>;
  /** Incoming container, collected once for the candidate update. */
  readonly props: object;
  /** Compiler source slot for diagnostics; conditional arms share the containing region identity. */
  readonly slot: string;
  /** Explicit key value, if supplied separately by generation. */
  readonly key?: unknown;
}

/** Construct a lazy structural description without executing or attaching its component. */
export function componentItem<P>(
  definition: Component<P>,
  props: CallerProps<P>,
  slot: string,
  key?: unknown,
): ComponentItem {
  return {
    [itemMarker]: true,
    definition: definition as Component<unknown>,
    props: props as object,
    slot,
    key,
  };
}

/** Values generated for one conditional or keyed list region. */
export type RegionValue =
  | ComponentItem
  | null
  | undefined
  | false
  | readonly ComponentItem[]
  | Iterable<ComponentItem>;

interface Candidate {
  readonly id: string;
  readonly prepared: PreparedComponent;
}

interface Entry {
  readonly id: string;
  readonly start: Comment;
  readonly end: Comment;
  readonly instance: ComponentInstance;
}

function canonicalKey(key: unknown): string {
  if (typeof key === "string") return JSON.stringify(["string", key]);

  if (typeof key === "number" && Number.isFinite(key))
    return JSON.stringify(["number", key === 0 ? 0 : key]);

  throw new RenderFault("key-invalid", "Keys must be strings or finite numbers");
}

function prepareRegion(value: RegionValue): Candidate[] {
  const listed = value != null && value !== false && !(itemMarker in value);
  const items: readonly ComponentItem[] =
    value == null || value === false
      ? []
      : listed
        ? Array.from(value as Iterable<ComponentItem>)
        : [value as ComponentItem];
  const ids = new Set<string>();

  return items.map((item) => {
    if (!item || typeof item !== "object" || !(itemMarker in item)) {
      throw new RenderFault(
        "key-missing",
        "Every rendered list item needs an explicit keyed occurrence",
      );
    }

    const prepared = prepareComponent(item.definition, item.props);

    const key = item.key !== undefined ? item.key : new Map(prepared.entries).get("key");

    if (listed && key === undefined)
      throw new RenderFault("key-missing", "Every rendered list item needs an explicit key");

    const id = key === undefined ? "single" : canonicalKey(key);

    if (ids.has(id))
      throw new RenderFault("key-duplicate", "A candidate list contains duplicate keys");

    ids.add(id);

    return { id, prepared };
  });
}

function appendOutput(parent: Node, output: Rendered, owner: Owner): void {
  if (output == null || typeof output === "boolean") return;

  if (Array.isArray(output)) {
    for (const child of output) appendOutput(parent, child, owner);
  } else if (typeof output === "number" || typeof output === "string") {
    const node = owner.context.document.createTextNode(String(output));

    owner.nodes.add(node);

    parent.appendChild(node);
  } else if (typeof output === "object" && "nodeType" in output) {
    parent.appendChild(output as Node);
  } else {
    throw new RenderFault(
      "render-value",
      "Component output must contain native nodes or primitive values",
    );
  }
}

function instantiateEntry(owner: Owner, candidate: Candidate): Entry {
  const itemOwner = new Owner(owner.context, owner, `${owner.identity}/${candidate.id}`);

  const document = owner.context.document;

  const fragment = document.createDocumentFragment();
  const start = document.createComment("item");
  const end = document.createComment("/item");

  itemOwner.nodes.add(start);

  itemOwner.nodes.add(end);

  fragment.appendChild(start);

  try {
    const instance = Signal.subtle.untrack(() =>
      instantiateComponent(itemOwner, candidate.prepared),
    );

    fragment.appendChild(end);

    if (instance.output instanceof Promise) {
      const ready = instance.output.then((output) => {
        itemOwner.assertActive();

        const content = document.createDocumentFragment();

        appendOutput(content, output, itemOwner);

        end.parentNode?.insertBefore(content, end);
      });

      itemOwner.asyncBoundary!.capture(itemOwner, ready);
    } else {
      const content = document.createDocumentFragment();

      appendOutput(content, instance.output, itemOwner);

      fragment.insertBefore(content, end);
    }

    return { id: candidate.id, start, end, instance };
  } catch (error) {
    itemOwner.dispose(error);

    throw error;
  }
}

function moveEntry(entry: Entry, parent: Node, before: Node): void {
  if (entry.end.nextSibling === before && entry.start.parentNode === parent) return;

  let current: Node | null = entry.start;

  const nodes: Node[] = [];

  while (current) {
    nodes.push(current);

    if (current === entry.end) break;

    current = current.nextSibling;
  }

  for (const node of nodes) parent.insertBefore(node, before);
}

/**
 * Observe a structural region, preserving keyed owner ranges on moves and
 * publishing validated props into retained instances. Missing/duplicate keys
 * reject the complete candidate before any existing owner is changed.
 */
export function region(parent: Owner, slot: string, read: () => RegionValue): DocumentFragment {
  const owner = new Owner(parent.context, parent, `${parent.identity}/${slot}`);

  owner.executingBody = false;

  const document = parent.context.document;

  const fragment = document.createDocumentFragment();
  const start = document.createComment("region");
  const end = document.createComment("/region");

  owner.nodes.add(start);

  owner.nodes.add(end);

  fragment.append(start, end);

  let entries: Entry[] = [];

  owner.context.scheduler.render(
    owner,
    () => {
      const candidates = prepareRegion(read());

      Signal.subtle.untrack(() =>
        owner.context.scheduler.reconcile(() => {
          const previous = new Map(entries.map((entry) => [entry.id, entry]));

          const next: Entry[] = [];
          const retained = new Set<Entry>();

          for (const candidate of candidates) {
            const existing = previous.get(candidate.id);

            if (!existing || existing.instance.definition !== candidate.prepared.definition)
              continue;

            if (!canPublishComponent(existing.instance, candidate.prepared)) {
              owner.context.scheduler.requestRecreation(existing.instance.owner);
            } else retained.add(existing);
          }

          const cleanupErrors: unknown[] = [];

          for (const entry of entries) {
            if (retained.has(entry)) continue;

            try {
              entry.instance.owner.dispose();
            } catch (error) {
              cleanupErrors.push(error);
            }
          }

          if (cleanupErrors.length)
            throw new AggregateError(cleanupErrors, "Structural cleanup failed");

          try {
            for (const candidate of candidates) {
              let entry = previous.get(candidate.id);

              previous.delete(candidate.id);

              if (entry && retained.has(entry)) {
                publishComponent(entry.instance, candidate.prepared);
              } else {
                entry = instantiateEntry(owner, candidate);
              }

              next.push(entry);
            }
          } catch (error) {
            for (const entry of next) {
              if (!retained.has(entry)) entry.instance.owner.dispose(error);
            }

            entries = entries.filter((entry) => retained.has(entry));

            throw error;
          }

          const container = end.parentNode!;

          let before: Node = end;

          for (let index = next.length - 1; index >= 0; index--) {
            const entry = next[index]!;

            moveEntry(entry, container, before);

            before = entry.start;
          }

          entries = next;

          owner.children.splice(
            0,
            owner.children.length,
            ...next.map((entry) => entry.instance.owner),
          );

          if (parent.state === "mounted") {
            owner.state = "mounted";

            for (const entry of next) {
              if (entry.instance.owner.state === "building") entry.instance.owner.commit();
            }

            owner.context.scheduler.requestEffects();
          }
        }),
      );
    },
    true,
  );

  return fragment;
}

/** Create a stable single component slot, observing explicitly marked incoming expressions. */
export function component<P>(
  parent: Owner,
  definition: Component<P>,
  props: CallerProps<P>,
  slot?: string,
): Rendered {
  return region(parent, slot ?? String(parent.children.length), () =>
    componentItem(definition, props, slot ?? "component"),
  );
}
