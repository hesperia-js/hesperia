import { attachElementBinding, type Binding } from "./binding.ts";
import { Owner, RenderFault, reportFault, type RuntimeContext } from "./owner.ts";
import { Scheduler } from "./scheduler.ts";
import {
  isDynamic,
  instantiateComponent,
  prepareComponent,
  type CallerProps,
  type Component,
} from "./components.ts";

declare const __HESPERIA_DEV__: boolean;

/** Values accepted by the synchronous browser renderer. */
export type Rendered = Node | string | number | boolean | null | undefined | readonly Rendered[];

export { defineComponent, dynamic } from "./components.ts";
export type {
  CallerProps,
  Component,
  ComponentFactory,
  ComponentOptions,
  ComponentProps,
  Dynamic,
  PropSchema,
} from "./components.ts";
export { component, componentItem, region } from "./structure.ts";

/** Create a stable text node with synchronously observed contents. */
export function text(owner: Owner, read: () => unknown): Text {
  const node = owner.context.document.createTextNode("");
  owner.nodes.add(node);
  owner.context.scheduler.render(owner, () => {
    const value = read();
    if (value !== null && typeof value === "object") {
      throw new RenderFault(
        "render-value",
        "Read reactive values explicitly; objects are not text children",
      );
    }
    node.data =
      value === null || value === undefined || typeof value === "boolean" ? "" : String(value);
  });
  return node;
}

/**
 * Observe one child expression without converting native nodes to strings.
 * Nested arrays are flattened into the stable comment range. Unchanged native
 * siblings stay installed, and consumed fragments retain their complete ranges.
 */
export function child(owner: Owner, read: () => unknown): DocumentFragment {
  const document = owner.context.document;
  const fragment = document.createDocumentFragment();
  const start = document.createComment("hesperia");
  const end = document.createComment("/hesperia");
  owner.nodes.add(start);
  owner.nodes.add(end);
  fragment.append(start, end);
  type Part = { value: Node | string | number; nodes: Node[]; range?: readonly [Comment, Comment] };
  let installed: Part[] = [];
  const fragments = new WeakMap<Node, Part>();
  const nodesOf = (part: Part): Node[] => {
    const range = part.range;
    if (range && range[0].parentNode) {
      const nodes: Node[] = [];
      let node: Node | null = range[0];
      while (node) {
        nodes.push(node);
        if (node === range[1]) break;
        node = node.nextSibling;
      }
      part.nodes = nodes;
    }
    return part.nodes;
  };
  owner.context.scheduler.render(
    owner,
    () => {
      const values: (Node | string | number)[] = [];
      const arrays = new Set<unknown>();
      const collect = (value: unknown): void => {
        if (value == null || typeof value === "boolean") return;
        if (Array.isArray(value) && !arrays.has(value)) {
          arrays.add(value);
          for (const nested of value) collect(nested);
          arrays.delete(value);
        } else if (typeof value === "object" && "nodeType" in value) values.push(value as Node);
        else if (typeof value === "number" || typeof value === "string") values.push(value);
        else
          throw new RenderFault(
            "render-value",
            "A child expression must yield native nodes, primitive values, or arrays of them",
          );
      };
      collect(read());
      const previousNodes = installed.flatMap(nodesOf);
      const next = values.map((value, index): Part => {
        if (typeof value !== "object") {
          const previous = installed[index];
          const scalar =
            previous && typeof previous.value !== "object"
              ? (previous.nodes[0] as Text)
              : document.createTextNode("");
          scalar.data = String(value);
          return { value, nodes: [scalar] };
        }
        if (value.nodeType !== 11) return { value, nodes: [value] };
        const known = fragments.get(value);
        if (known) return known;
        const first = document.createComment("children");
        const last = document.createComment("/children");
        value.insertBefore(first, value.firstChild);
        value.appendChild(last);
        const part: Part = { value, nodes: [...value.childNodes], range: [first, last] };
        fragments.set(value, part);
        return part;
      });
      const nextNodes = next.flatMap(nodesOf);
      const retained = new Set(nextNodes);
      for (const node of previousNodes) if (!retained.has(node)) node.parentNode?.removeChild(node);
      let cursor = start.nextSibling;
      for (const node of nextNodes) {
        if (cursor === node) cursor = cursor.nextSibling;
        else end.parentNode?.insertBefore(node, cursor ?? end);
      }
      installed = next;
    },
    true,
  );
  owner.onRelease(() => {
    for (const node of installed.flatMap(nodesOf)) node.parentNode?.removeChild(node);
  });
  return fragment;
}

/** Assign one native attribute or property from an observed authored expression. */
export function attribute(owner: Owner, node: Element, name: string, read: () => unknown): void {
  owner.context.scheduler.render(owner, () => setAttribute(node, name, read()));
}

function setAttribute(node: Element, name: string, value: unknown): void {
  if (name === "className") name = "class";
  if (name === "value" || name === "checked" || name === "selected" || name === "muted") {
    Reflect.set(node, name, value ?? (name === "value" ? "" : false));
    return;
  }
  if (value === null || value === undefined || value === false) node.removeAttribute(name);
  else node.setAttribute(name, value === true ? "" : String(value));
}

/**
 * Create the actual native element. Dynamic attributes are explicitly marked;
 * event callbacks remain callbacks and are released with their owner.
 */
export function element<K extends keyof HTMLElementTagNameMap>(
  owner: Owner,
  tag: K,
  props?: Record<string, unknown>,
  children?: readonly Rendered[],
): HTMLElementTagNameMap[K];
/** Create a namespace-qualified native element for compiler-validated foreign content. */
export function element(
  owner: Owner,
  tag: string,
  props?: Record<string, unknown>,
  children?: readonly Rendered[],
  namespace?: string,
): Element;
export function element(
  owner: Owner,
  tag: string,
  props: Record<string, unknown> = {},
  children: readonly Rendered[] = [],
  namespace?: string,
): Element {
  owner.assertActive();
  const node = namespace
    ? owner.context.document.createElementNS(namespace, tag)
    : owner.context.document.createElement(tag);
  owner.nodes.add(node);
  for (const [name, value] of Object.entries(props)) {
    if (name === "key") continue;
    if (name === "bind") {
      if (value !== undefined) attachElementBinding(value as Binding<Element>, owner, node);
    } else if (name.startsWith("on:") && typeof value === "function") {
      const event = name.slice(3);
      const handler: EventListener = (event) => {
        if (owner.state !== "mounted") return;
        try {
          Reflect.apply(value, node, [event]);
        } catch (error) {
          reportFault(owner, error);
        }
      };
      node.addEventListener(event, handler);
      owner.onRelease(() => node.removeEventListener(event, handler));
    } else if (isDynamic(value)) attribute(owner, node, name, value.read);
    else setAttribute(node, name, value);
  }
  for (const child of children) append(node, child, owner.context.document);
  return node;
}

function append(parent: Node, value: Rendered, document: Document, owner?: Owner): void {
  if (value == null || typeof value === "boolean") return;
  if (Array.isArray(value)) {
    for (const child of value) append(parent, child, document, owner);
  } else if (typeof value === "string" || typeof value === "number") {
    const node = document.createTextNode(String(value));
    owner?.nodes.add(node);
    parent.appendChild(node);
  } else if (typeof value === "object" && "nodeType" in value) {
    parent.appendChild(value as Node);
  } else {
    throw new RenderFault(
      "render-value",
      "Only native nodes and primitive child values can be rendered",
    );
  }
}

/** Browser mount configuration. */
export interface MountOptions {
  /** Receives unhandled rendering faults; defaults to throwing. */
  readonly onError?: (error: unknown) => void;
  /** Receives development warnings; defaults to console.warn. */
  readonly warn?: (message: string) => void;
  /** Enable unsafe-operation diagnostics; the development command supplies true. */
  readonly development?: boolean;
}

/** Mounted application lifetime and deterministic effect completion barrier. */
export interface MountedApplication {
  /** Remove the application and revoke its owned work. Idempotent. */
  dispose(reason?: unknown): void;
  /** Resolve when pending DOM and effect passes have settled. */
  settled(): Promise<void>;
}

/** Internal services and root lifetime shared by a prepared render tree. */
export interface RuntimeRoot {
  readonly context: RuntimeContext;
  readonly owner: Owner;
}

/** A synchronously materialized tree waiting for explicit DOM installation. */
export interface PreparedTree {
  readonly owner: Owner;
  readonly fragment: DocumentFragment;
  install(target: Node): void;
  dispose(reason?: unknown): void;
}

/**
 * Create the same document-scoped root services used by {@link mount}.
 *
 * This is an internal source-level seam for route preparation. It is not
 * exported from the runtime or package entrypoints.
 */
export function createRuntimeRoot(
  container: Element | Document,
  options: MountOptions = {},
): RuntimeRoot {
  const document = container.nodeType === 9 ? (container as Document) : container.ownerDocument!;
  const context = {
    document,
    container,
    onError:
      options.onError ??
      ((error: unknown) => {
        throw error;
      }),
    warn:
      (options.development ?? (typeof __HESPERIA_DEV__ === "undefined" || __HESPERIA_DEV__))
        ? (message: string) => {
            console.warn(message);
            options.warn?.(message);
            const window = document.defaultView;
            if (window)
              window.dispatchEvent(new window.CustomEvent("hesperia:warning", { detail: message }));
          }
        : () => undefined,
    nextGeneration: 0,
  } as RuntimeContext;
  const owner = new Owner(context, null, "root");
  context.scheduler = new Scheduler(owner);
  return { context, owner };
}

/**
 * Materialize one owner tree in a detached fragment until the caller installs
 * or disposes it. The owner is deliberately supplied by the caller so route
 * candidates can remain in the same logical tree without an extra lifetime.
 */
export function prepareTree(owner: Owner, render: () => Rendered): PreparedTree {
  owner.assertActive();
  if (owner.state !== "building")
    throw new RenderFault("render-state", "Prepared trees require a fresh building owner");
  const fragment = owner.context.document.createDocumentFragment();
  let installed = false;
  try {
    append(fragment, render(), owner.context.document, owner);
  } catch (error) {
    owner.dispose(error);
    throw error;
  }
  return {
    owner,
    fragment,
    install(target) {
      if (installed) throw new RenderFault("render-state", "Prepared tree is already installed");
      owner.assertActive();
      try {
        if (target.nodeType === 9) {
          const document = target as Document;
          const html = fragment.firstChild;
          if (
            fragment.childNodes.length !== 1 ||
            html?.nodeType !== 1 ||
            (html as Element).localName !== "html" ||
            (html as Element).namespaceURI !== "http://www.w3.org/1999/xhtml"
          )
            throw new RenderFault(
              "document-shell",
              "A document shell must render exactly one native HTML root",
            );
          if (document.documentElement) document.replaceChild(html, document.documentElement);
          else document.appendChild(html);
        } else target.appendChild(fragment);
        installed = true;
        owner.commit();
        owner.context.scheduler.requestEffects();
      } catch (error) {
        owner.dispose(error);
        throw error;
      }
    },
    dispose(reason) {
      owner.dispose(reason);
    },
  };
}

/**
 * Install a compiled browser application into an Element or whole Document.
 *
 * A Document target must render exactly one native HTML root. The existing
 * document element is replaced only after the candidate tree has been built;
 * ordinary element mounts append their tree to the target as before.
 */
export function mount<P>(
  container: Element | Document,
  definition: Component<P>,
  props: CallerProps<P>,
  options: MountOptions = {},
): MountedApplication {
  const { context, owner } = createRuntimeRoot(container, options);
  try {
    const prepared = prepareTree(owner, () => {
      const result = instantiateComponent(owner, prepareComponent(definition, props)).output;
      if (result instanceof Promise)
        throw new RenderFault(
          "async-boundary",
          "Root async components require an enclosing boundary",
        );
      return result;
    });
    prepared.install(container);
  } catch (error) {
    owner.dispose(error);
    reportFault(owner, error);
  }
  return {
    dispose: (reason) => owner.dispose(reason),
    settled: () => context.scheduler.settled(),
  };
}
