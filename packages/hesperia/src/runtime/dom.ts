import { attachElementBinding, type Binding } from "./binding.ts";
import { Owner, RenderFault, reportFault, type RuntimeContext } from "./owner.ts";
import { Scheduler } from "./scheduler.ts";
import { installRootProjectPolicy } from "./project-policy.ts";
import {
  isDynamic,
  instantiateComponent,
  prepareComponent,
  type CallerProps,
  type Component,
} from "./components.ts";
import {
  internalStyleBindingFor,
  type InternalStyleRuntime,
  type PreparedStyleGroupLease,
  type StyleCompositionId,
  type StyleEntryId,
  type TargetEntryPreparation,
} from "./style.ts";
import { isNonArrayObject, isNonNullObject } from "../utils.ts";

declare const __HESPERIA_DEV__: boolean;

const HTML_NAMESPACE = "http://www.w3.org/1999/xhtml";
const EMBEDDED_DOCUMENT_TAGS = new Set(["iframe", "embed", "object"]);
const EVENT_OPTION_NAMES = new Set(["capture", "once", "passive"]);

type NativeEventHandler = (this: Element, event: Event) => unknown;

interface NativeEventRegistration {
  readonly handler: NativeEventHandler;
  readonly options: AddEventListenerOptions;
}

function eventOptionsFault(message: string): never {
  throw new RenderFault("event-options", message);
}

function copyEventOptions(value: unknown): AddEventListenerOptions {
  if (!isNonArrayObject(value))
    return eventOptionsFault("A native event listener pair requires a plain options object");

  const prototype = Object.getPrototypeOf(value);

  if (prototype !== null && Object.getPrototypeOf(prototype) !== null)
    return eventOptionsFault("Native event listener options must be a plain object");

  const copied: AddEventListenerOptions = {};

  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !EVENT_OPTION_NAMES.has(key))
      return eventOptionsFault(`Unsupported native event listener option ${String(key)}`);

    const descriptor = Object.getOwnPropertyDescriptor(value, key);

    if (!descriptor || !("value" in descriptor) || typeof descriptor.value !== "boolean")
      return eventOptionsFault(`Native event listener option ${key} must be a boolean value`);

    if (key === "capture") copied.capture = descriptor.value;
    else if (key === "once") copied.once = descriptor.value;
    else copied.passive = descriptor.value;
  }

  return Object.freeze(copied);
}

function normalizeEventRegistration(value: unknown): NativeEventRegistration {
  let handler: unknown = value;
  let options: AddEventListenerOptions = {};

  if (Array.isArray(value)) {
    if (value.length !== 2)
      return eventOptionsFault("A native event listener pair must contain a handler and options");

    const handlerProperty = Object.getOwnPropertyDescriptor(value, "0");
    const optionsProperty = Object.getOwnPropertyDescriptor(value, "1");

    if (
      !handlerProperty ||
      !("value" in handlerProperty) ||
      !optionsProperty ||
      !("value" in optionsProperty)
    )
      return eventOptionsFault("A native event listener pair must contain ordinary tuple values");

    handler = handlerProperty.value;
    options = copyEventOptions(optionsProperty.value);
  }

  if (typeof handler !== "function")
    return eventOptionsFault(
      "A native event listener must be a function or a handler/options pair",
    );

  return { handler: handler as NativeEventHandler, options };
}

function currentEventHandler(value: unknown): NativeEventHandler | undefined {
  if (value === undefined || value === null) return undefined;

  let handler: unknown = value;

  if (Array.isArray(value)) {
    if (value.length !== 2)
      return eventOptionsFault("A native event listener pair must contain a handler and options");

    const handlerProperty = Object.getOwnPropertyDescriptor(value, "0");

    if (!handlerProperty || !("value" in handlerProperty))
      return eventOptionsFault("A native event listener pair must contain ordinary tuple values");

    handler = handlerProperty.value;
  }

  if (typeof handler !== "function")
    return eventOptionsFault(
      "A native event listener must be a function or a handler/options pair",
    );

  return handler as NativeEventHandler;
}

export function attachNativeEventListener(
  owner: Owner,
  node: Element,
  eventName: string,
  initialValue: unknown,
  readCurrent?: () => unknown,
): void {
  const initial =
    initialValue === undefined || initialValue === null
      ? undefined
      : normalizeEventRegistration(initialValue);

  if (!initial && !readCurrent) return;

  const handler: EventListener = (event) => {
    if (owner.state !== "mounted") return;

    try {
      const currentHandler = readCurrent ? currentEventHandler(readCurrent()) : initial?.handler;

      if (currentHandler) Reflect.apply(currentHandler, node, [event]);
    } catch (error) {
      reportFault(owner, error);
    }
  };

  node.addEventListener(eventName, handler, initial?.options);

  owner.onRelease(() =>
    node.removeEventListener(eventName, handler, initial?.options.capture ?? false),
  );
}

interface OwnedObjectURL {
  readonly url: string;
  readonly release: () => void;
}

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

    if (isNonNullObject(value)) {
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

      const previousParts = installed.map((part) => ({ part, nodes: nodesOf(part) }));
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

      for (const { part, nodes } of previousParts) {
        if (
          part.range &&
          typeof part.value === "object" &&
          nodes.every((node) => !retained.has(node))
        ) {
          for (const node of nodes) part.value.appendChild(node);
        } else {
          for (const node of nodes) if (!retained.has(node)) node.parentNode?.removeChild(node);
        }
      }

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
  if (!usesOwnedSourceAttribute(node, name)) {
    owner.context.scheduler.render(owner, () => setAttribute(node, name, read()));

    return;
  }

  const document = owner.context.document;
  let ownedURLs = new Map<Blob, OwnedObjectURL>();

  const release = (entry: OwnedObjectURL): void => entry.release();

  owner.context.scheduler.render(owner, () => {
    const nextURLs = new Map<Blob, OwnedObjectURL>();
    const created: OwnedObjectURL[] = [];

    const objectURL = (blob: Blob): string => {
      const entry =
        nextURLs.get(blob) ?? ownedURLs.get(blob) ?? createOwnedObjectURL(document, blob);

      if (!nextURLs.has(blob) && !ownedURLs.has(blob)) created.push(entry);

      nextURLs.set(blob, entry);

      return entry.url;
    };

    let value = read();

    try {
      if (name === "src" && isBlob(document, value)) {
        if (node.localName === "script")
          throw new RenderFault(
            "blob-source",
            "A Blob source cannot be assigned to an executable element",
          );

        value = objectURL(value);
      } else if (name === "poster" && node.localName === "video" && isBlob(document, value)) {
        value = objectURL(value);
      } else if (name === "srcset" && Array.isArray(value)) {
        value = value
          .map((candidate) => {
            if (!Array.isArray(candidate) || candidate.length !== 2) {
              throw new RenderFault(
                "srcset-value",
                "Each structured srcset candidate must be a [source, descriptor] pair",
              );
            }

            const source: unknown = candidate[0];
            const descriptor: unknown = candidate[1];

            if (typeof descriptor !== "string") {
              throw new RenderFault("srcset-value", "A srcset descriptor must be a string");
            }

            if (isBlob(document, source)) return `${objectURL(source)} ${descriptor}`;

            if (typeof source === "string") return `${source} ${descriptor}`;

            throw new RenderFault("srcset-value", "A srcset source must be a Blob or URL string");
          })
          .join(", ");
      }

      setAttribute(node, name, value);
    } catch (error) {
      for (const entry of created) {
        try {
          release(entry);
        } catch {
          // Preserve the failed update; the old DOM value and its lease remain current.
        }
      }

      throw error;
    }

    const previousURLs = ownedURLs;
    ownedURLs = nextURLs;

    for (const [blob, entry] of previousURLs) {
      if (!nextURLs.has(blob)) release(entry);
    }
  });

  owner.onRelease(() => {
    for (const entry of ownedURLs.values()) release(entry);

    ownedURLs.clear();
  });
}

function usesOwnedSourceAttribute(node: Element, name: string): boolean {
  return (
    node.namespaceURI === HTML_NAMESPACE &&
    (name === "src" || name === "srcset" || (name === "poster" && node.localName === "video"))
  );
}

function isBlob(document: Document, value: unknown): value is Blob {
  if (typeof value !== "object" || value === null) return false;

  const BlobConstructor = document.defaultView?.Blob;

  if (typeof BlobConstructor === "function" && value instanceof BlobConstructor) return true;

  const knownConstructors = [
    BlobConstructor,
    typeof globalThis.Blob === "function" ? globalThis.Blob : undefined,
  ];

  for (const constructor of knownConstructors) {
    if (typeof constructor !== "function") continue;

    const size = Object.getOwnPropertyDescriptor(constructor.prototype, "size")?.get;

    if (!size) continue;

    try {
      size.call(value);

      return true;
    } catch {}
  }

  return false;
}

function createOwnedObjectURL(document: Document, blob: Blob): OwnedObjectURL {
  const url = document.defaultView?.URL;

  if (
    !url ||
    typeof url.createObjectURL !== "function" ||
    typeof url.revokeObjectURL !== "function"
  )
    throw new RenderFault("blob-url", "This document cannot create and release Blob object URLs");

  const value = url.createObjectURL(blob);
  return { url: value, release: () => url.revokeObjectURL(value) };
}

function needsOwnedSourceAttribute(node: Element, name: string, value: unknown): boolean {
  if (node.namespaceURI !== HTML_NAMESPACE) return false;

  if (name === "src" && isBlob(node.ownerDocument, value)) return true;

  if (name === "poster" && node.localName === "video" && isBlob(node.ownerDocument, value))
    return true;

  return name === "srcset" && Array.isArray(value);
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

  if (EMBEDDED_DOCUMENT_TAGS.has(tag.toLowerCase()))
    throw new RenderFault(
      "embed-required",
      "Use Hesperia's official Embed component from hesperia/embed instead of creating embedded-document elements directly",
    );

  const node = namespace
    ? owner.context.document.createElementNS(namespace, tag)
    : owner.context.document.createElement(tag);

  owner.nodes.add(node);

  for (const [name, value] of Object.entries(props)) {
    if (name === "key") continue;

    if (name === "bind") {
      if (value !== undefined) attachElementBinding(value as Binding<Element>, owner, node);
    } else if (name.startsWith("on:")) {
      if (value === undefined || value === null) continue;

      const event = name.slice(3);

      if (isDynamic(value)) attachNativeEventListener(owner, node, event, value.read(), value.read);
      else attachNativeEventListener(owner, node, event, value);
    } else if (isDynamic(value)) attribute(owner, node, name, value.read);
    else if (needsOwnedSourceAttribute(node, name, value))
      attribute(owner, node, name, () => value);
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

function mountedHandle(
  owner: Owner,
  context: RuntimeContext,
  startup: Promise<void> = Promise.resolve(),
): MountedApplication {
  void startup.catch(() => undefined);

  return {
    dispose: (reason) => owner.dispose(reason),
    settled: () => startup.then(() => context.scheduler.settled()),
  };
}

function installHiddenRange(target: Element, fragment: DocumentFragment, owner: Owner): () => void {
  const document = owner.context.document;
  const wrapper =
    target.namespaceURI === "http://www.w3.org/2000/svg"
      ? document.createElementNS(target.namespaceURI, "g")
      : document.createElement("div");

  wrapper.setAttribute("data-hesperia-pending", "");

  wrapper.style.setProperty("display", "none", "important");

  wrapper.appendChild(fragment);

  owner.nodes.add(wrapper);

  target.appendChild(wrapper);

  return () => {
    if (wrapper.parentNode !== target)
      throw new RenderFault("style-target", "The pending mount range left its target Element");

    while (wrapper.firstChild) target.insertBefore(wrapper.firstChild, wrapper);

    target.removeChild(wrapper);

    owner.nodes.delete(wrapper);
  };
}

interface DocumentShell {
  readonly html: HTMLElement;
  readonly head: HTMLHeadElement;
  readonly body: HTMLBodyElement;
  readonly bodyBefore: Node | null;
}

function documentShell(fragment: DocumentFragment): DocumentShell {
  const html = fragment.firstChild;

  if (
    fragment.childNodes.length !== 1 ||
    html?.nodeType !== 1 ||
    (html as Element).localName !== "html" ||
    (html as Element).namespaceURI !== HTML_NAMESPACE
  )
    throw new RenderFault(
      "document-shell",
      "A document shell must render exactly one native HTML root",
    );

  const root = html as HTMLElement;
  const heads = Array.from(root.children).filter((child) => child.localName === "head");
  const bodies = Array.from(root.children).filter((child) => child.localName === "body");

  if (
    heads.length !== 1 ||
    bodies.length !== 1 ||
    heads[0]!.namespaceURI !== HTML_NAMESPACE ||
    bodies[0]!.namespaceURI !== HTML_NAMESPACE
  )
    throw new RenderFault("document-shell", "A Document mount requires one native head and body");

  const body = bodies[0] as HTMLBodyElement;
  return { html: root, head: heads[0] as HTMLHeadElement, body, bodyBefore: body.nextSibling };
}

function installHiddenDocument(document: Document, shell: DocumentShell): () => void {
  const hadStyleAttribute = shell.body.hasAttribute("style");
  const oldDisplay = shell.body.style.getPropertyValue("display");
  const oldPriority = shell.body.style.getPropertyPriority("display");

  shell.body.style.setProperty("display", "none", "important");

  shell.html.removeChild(shell.body);

  if (document.documentElement) document.replaceChild(shell.html, document.documentElement);
  else document.appendChild(shell.html);

  shell.html.insertBefore(
    shell.body,
    shell.bodyBefore?.parentNode === shell.html ? shell.bodyBefore : null,
  );

  return () => {
    if (oldDisplay || oldPriority) shell.body.style.setProperty("display", oldDisplay, oldPriority);
    else shell.body.style.removeProperty("display");

    if (!hadStyleAttribute && shell.body.style.length === 0) shell.body.removeAttribute("style");
  };
}

function reportStylesheetFault(owner: Owner, error: unknown): void {
  try {
    reportFault(owner, error);
  } catch {
    // The CSS error remains the settled() result; the existing fault channel was invoked.
  }
}

function pendingStartup(): {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
  readonly reject: (error: unknown) => void;
} {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((accept, fail) => {
    resolve = accept;
    reject = fail;
  });

  void promise.catch(() => undefined);

  return { promise, resolve, reject };
}

function observeHead(document: Document, changed: () => void): MutationObserver | undefined {
  const Observer = document.defaultView?.MutationObserver;

  if (!Observer) return undefined;

  const observer = new Observer(changed);

  observer.observe(document, { childList: true, subtree: true });

  return observer;
}

function startDirectStyles(
  owner: Owner,
  runtime: InternalStyleRuntime,
  entryId: StyleEntryId,
  reveal: () => void,
  initialHead: HTMLHeadElement,
  initial: TargetEntryPreparation,
): Promise<void> {
  const document = owner.context.document;
  const startup = pendingStartup();
  let currentHead: HTMLHeadElement | null = initialHead;
  let current: TargetEntryPreparation | undefined = initial;
  let complete = false;
  let disposed = false;
  let attemptId = 0;
  let observer: MutationObserver | undefined;

  const fail = (error: unknown): void => {
    if (complete || disposed) return;

    complete = true;

    observer?.disconnect();

    current?.release();

    current = undefined;

    reportStylesheetFault(owner, error);

    startup.reject(error);
  };

  const watch = (attempt: TargetEntryPreparation, head: HTMLHeadElement, id: number): void => {
    void attempt.settled.then(
      () => {
        if (disposed || complete || attempt !== current || id !== attemptId) return;

        if (document.head !== head) {
          restart();

          return;
        }

        try {
          attempt.activate(owner);

          reveal();

          owner.commit();

          owner.context.scheduler.requestEffects();

          complete = true;

          observer?.disconnect();

          startup.resolve();
        } catch (error) {
          fail(error);
        }
      },
      (error: unknown) => {
        if (disposed || complete || attempt !== current || id !== attemptId) return;

        if (document.head !== head) {
          restart();

          return;
        }

        fail(error);
      },
    );
  };

  const restart = (): void => {
    if (disposed || complete) return;

    const nextHead = document.head;

    if (!nextHead || nextHead === currentHead) return;

    const previous = current;

    try {
      currentHead = nextHead;
      current = undefined;

      previous?.release();

      const next = runtime.prepareDirectTarget(entryId, nextHead);
      current = next;
      const id = ++attemptId;

      watch(next, nextHead, id);
    } catch (error) {
      fail(error);
    }
  };

  observer = observeHead(document, () => {
    if (document.head !== currentHead) restart();
  });

  owner.onRelease(() => {
    disposed = true;
    attemptId++;

    observer?.disconnect();

    current?.release();

    current = undefined;

    if (!complete) startup.resolve();
  });

  watch(initial, initialHead, ++attemptId);

  return startup.promise;
}

function startDocumentStyles(
  owner: Owner,
  runtime: InternalStyleRuntime,
  compositionId: StyleCompositionId,
  restoreBody: () => void,
): Promise<void> {
  const document = owner.context.document;
  const startup = pendingStartup();
  let currentHead: HTMLHeadElement | null = null;
  let currentLease: PreparedStyleGroupLease | undefined;
  let controller: AbortController | undefined;
  let attemptId = 0;
  let complete = false;
  let disposed = false;
  let observer: MutationObserver | undefined;

  const fail = (error: unknown): void => {
    if (complete || disposed) return;

    complete = true;
    attemptId++;

    controller?.abort(error);

    observer?.disconnect();

    currentLease?.release();

    currentLease = undefined;

    reportStylesheetFault(owner, error);

    startup.reject(error);
  };

  const begin = (head: HTMLHeadElement): void => {
    const id = ++attemptId;
    const nextController = new AbortController();
    controller = nextController;
    currentHead = head;

    void runtime.prepareInstalledHead(compositionId, head, nextController.signal).then(
      (lease) => {
        if (disposed || complete || id !== attemptId) {
          lease.release();

          return;
        }

        if (document.head !== head) {
          lease.release();

          restart();

          return;
        }

        currentLease = lease;

        try {
          lease.activate(owner);

          restoreBody();

          owner.commit();

          owner.context.scheduler.requestEffects();

          complete = true;

          observer?.disconnect();

          startup.resolve();
        } catch (error) {
          fail(error);
        }
      },
      (error: unknown) => {
        if (disposed || complete || id !== attemptId) return;

        if (document.head !== head) {
          restart();

          return;
        }

        fail(error);
      },
    );
  };

  const restart = (): void => {
    if (disposed || complete) return;

    const nextHead = document.head;

    if (nextHead === currentHead) return;

    const previousController = controller;
    const previousLease = currentLease;
    controller = undefined;
    currentLease = undefined;

    previousController?.abort(
      new RenderFault("style-composition-superseded", "The installed stylesheet head changed"),
    );

    previousLease?.release();

    currentHead = nextHead;

    if (nextHead) begin(nextHead);
  };

  observer = observeHead(document, restart);

  owner.onRelease(() => {
    disposed = true;
    attemptId++;

    controller?.abort(owner.signal.reason);

    observer?.disconnect();

    currentLease?.release();

    currentLease = undefined;

    if (!complete) startup.resolve();
  });

  const initialHead = document.head;

  if (!initialHead) {
    fail(new RenderFault("style-document-head", "The installed Document shell has no head"));

    return startup.promise;
  }

  begin(initialHead);

  return startup.promise;
}

/**
 * Install a compiled browser application into an Element or whole Document.
 *
 * A Document target must render one HTML shell with a native head and body.
 * Styled targets wait for the CSS group in the installed head before revealing
 * content or running initial effects.
 */
export function mount<P>(
  container: Element | Document,
  definition: Component<P>,
  props: CallerProps<P>,
  options: MountOptions = {},
): MountedApplication {
  const { context, owner } = createRuntimeRoot(container, options);

  try {
    installRootProjectPolicy(owner, definition as Component<unknown>);

    const styleBinding = internalStyleBindingFor(definition);

    if (container.nodeType === 9 && styleBinding && !styleBinding.documentCompositionId) {
      throw new RenderFault(
        "style-document-composition",
        "A compiled Document mount requires a generated Document stylesheet composition",
      );
    }

    const prepared = prepareTree(owner, () => {
      const result = instantiateComponent(owner, prepareComponent(definition, props)).output;

      if (result instanceof Promise)
        throw new RenderFault(
          "async-boundary",
          "Root async components require an enclosing boundary",
        );

      return result;
    });

    if (!styleBinding) {
      prepared.install(container);

      return mountedHandle(owner, context);
    }

    if (container.nodeType === 9) {
      const document = container as Document;
      const shell = documentShell(prepared.fragment);
      const restoreBody = installHiddenDocument(document, shell);
      return mountedHandle(
        owner,
        context,
        startDocumentStyles(
          owner,
          styleBinding.runtime,
          styleBinding.documentCompositionId!,
          restoreBody,
        ),
      );
    }

    const document = context.document;
    const head = document.head;

    if (!head) throw new RenderFault("style-target-head", "The mount target Document has no head");

    const preparation = styleBinding.runtime.prepareDirectTarget(styleBinding.entryId, head);

    if (preparation.ready) {
      owner.onRelease(() => preparation.release());

      preparation.activate(owner);

      prepared.install(container);

      return mountedHandle(owner, context);
    }

    const reveal = installHiddenRange(container as Element, prepared.fragment, owner);
    return mountedHandle(
      owner,
      context,
      startDirectStyles(
        owner,
        styleBinding.runtime,
        styleBinding.entryId,
        reveal,
        head,
        preparation,
      ),
    );
  } catch (error) {
    owner.dispose(error);

    reportFault(owner, error);
  }

  return mountedHandle(owner, context);
}
