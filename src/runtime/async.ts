import { frameworkAwaitRegistration, registerFrameworkAwaitable } from "../data/protocol.ts";
import {
  instantiateComponent,
  prepareComponent,
  type CallerProps,
  type Component,
} from "./components.ts";
import type { Rendered } from "./dom.ts";
import {
  Owner,
  RenderFault,
  reportFault,
  runComponentBody,
  runCleanup,
  type AsyncBoundaryHost,
} from "./owner.ts";

/** Authored waiting-boundary props. The compiler lowers both trees lazily with their owners. */
export interface AsyncBoundaryProps {
  /** Native loading view while any contained component is waiting. */
  readonly fallback: Rendered;
  /** Content tree whose asynchronous descendants share this waiting boundary. */
  readonly children?: Rendered;
}

/** Authoring marker for the compiler's explicit asynchronous waiting boundary. */
export function AsyncBoundary(_props: AsyncBoundaryProps): never {
  throw new RenderFault("compiler-required", "AsyncBoundary requires Hesperia compilation");
}

function append(parent: Node, value: Rendered, owner: Owner): void {
  if (value == null || typeof value === "boolean") return;
  if (Array.isArray(value)) {
    for (const child of value) append(parent, child, owner);
  } else if (typeof value === "string" || typeof value === "number") {
    const node = owner.context.document.createTextNode(String(value));
    owner.nodes.add(node);
    parent.appendChild(node);
  } else if (typeof value === "object" && "nodeType" in value) parent.appendChild(value as Node);
  else
    throw new RenderFault(
      "render-value",
      "A boundary view must return native nodes or primitive children",
    );
}

/**
 * Generated waiting boundary. The complete content tree remains detached and
 * uncommitted until all its independently loading component bodies settle.
 */
export function asyncBoundary(
  parent: Owner,
  slot: string,
  loading: (owner: Owner) => Rendered,
  content: (owner: Owner) => Rendered,
  onReady?: (ready: Promise<void>) => void,
): DocumentFragment {
  parent.assertActive();
  const owner = new Owner(parent.context, parent, `${parent.identity}/${slot}`);
  owner.executingBody = false;
  const document = parent.context.document;
  const fragment = document.createDocumentFragment();
  const end = document.createComment("/async");
  const start = document.createComment("async");
  owner.nodes.add(start);
  owner.nodes.add(end);
  fragment.append(start, end);
  const waiting = new Set<object>();
  let initialized = false;
  let failed = false;
  let installed = false;
  let loadingOwner: Owner | undefined;
  let contentOwner!: Owner;
  let resolveReady!: () => void;
  let readySettled = false;
  const ready = new Promise<void>((resolve) => {
    resolveReady = resolve;
  });
  const settleReady = () => {
    if (readySettled || !initialized || waiting.size) return;
    readySettled = true;
    resolveReady();
  };
  const contentNodes = document.createDocumentFragment();

  const showLoading = () => {
    if (loadingOwner || owner.signal.aborted) return;
    if (installed) {
      let node = start.nextSibling;
      while (node && node !== end) {
        const next = node.nextSibling;
        contentNodes.appendChild(node);
        node = next;
      }
      installed = false;
      contentOwner.commitDeferred = true;
    }
    loadingOwner = new Owner(parent.context, owner, `${owner.identity}/loading`);
    loadingOwner.asyncBoundary = parent.asyncBoundary;
    const view = runComponentBody(() => loading(loadingOwner!));
    loadingOwner.executingBody = false;
    const loadingNodes = document.createDocumentFragment();
    append(loadingNodes, view, loadingOwner);
    end.parentNode?.insertBefore(loadingNodes, end);
    if (owner.state === "mounted") {
      loadingOwner.commit();
      owner.context.scheduler.requestEffects();
    }
  };

  const activate = () => {
    if (
      !initialized ||
      installed ||
      failed ||
      waiting.size ||
      owner.state === "destroyed" ||
      owner.state === "cleaning"
    )
      return;
    loadingOwner?.dispose();
    loadingOwner = undefined;
    end.parentNode?.insertBefore(contentNodes, end);
    installed = true;
    contentOwner.commitDeferred = false;
    if (owner.state === "mounted") {
      contentOwner.commit();
      owner.context.scheduler.requestEffects();
    }
  };

  const host: AsyncBoundaryHost = {
    owner,
    capture(waitOwner, promise) {
      owner.assertActive();
      const token = {};
      waiting.add(token);
      if (initialized) showLoading();
      const release = () => {
        if (!waiting.delete(token)) return;
        waitOwner.signal.removeEventListener("abort", cancelled);
        activate();
        settleReady();
      };
      const cancelled = () => release();
      waitOwner.signal.addEventListener("abort", cancelled, { once: true });
      void promise.then(
        () => release(),
        (error: unknown) => {
          if (
            !waitOwner.signal.aborted &&
            owner.state !== "destroyed" &&
            owner.state !== "cleaning"
          ) {
            failed = true;
            try {
              reportFault(waitOwner, error);
            } finally {
              waitOwner.dispose(error);
            }
          }
          release();
        },
      );
    },
  };
  owner.asyncBoundary = host;
  contentOwner = new Owner(parent.context, owner, `${owner.identity}/content`);
  contentOwner.commitDeferred = true;
  try {
    const result = runComponentBody(() => content(contentOwner));
    contentOwner.executingBody = false;
    append(contentNodes, result, contentOwner);
    if (waiting.size) showLoading();
    initialized = true;
    activate();
    onReady?.(ready);
    settleReady();
    return fragment;
  } catch (error) {
    owner.dispose(error);
    throw error;
  }
}

/**
 * Drive a compiled async body as explicit synchronous continuation segments.
 * Only owner-registered query or child-render waits may suspend component work.
 */
export function runAsyncBody(
  owner: Owner,
  create: () => Generator<unknown, Rendered, unknown>,
): Promise<Rendered> {
  owner.assertActive();
  if (!owner.asyncBoundary)
    throw new RenderFault("async-boundary", "Async component work requires an enclosing boundary");
  const iterator = create();
  let finished = false;
  let closed = false;
  let rejectWait!: (reason: unknown) => void;
  const abort = () => {
    if (finished) return;
    finished = true;
    rejectWait(owner.signal.reason);
  };
  owner.signal.addEventListener("abort", abort, { once: true });
  owner.onCleanup(() => {
    if (!closed) {
      closed = true;
      runCleanup(() => {
        iterator.return(undefined);
      });
    }
  });
  const result = new Promise<Rendered>((resolve, reject) => {
    rejectWait = reject;
    const step = (method: "next" | "throw", value: unknown) => {
      if (finished) return;
      try {
        owner.assertActive();
        const next = runComponentBody(() => iterator[method](value));
        if (next.done) {
          closed = true;
          finished = true;
          owner.signal.removeEventListener("abort", abort);
          resolve(next.value);
          return;
        }
        const registered = frameworkAwaitRegistration(next.value);
        if (
          !registered ||
          registered.kind === "task" ||
          (registered.kind === "render" && registered.owner !== owner)
        ) {
          throw new RenderFault(
            "render-await",
            "Component bodies may await only their registered query or child render",
          );
        }
        const waiting =
          registered.kind === "query" && registered.waitForOwner
            ? registered.waitForOwner(owner)
            : next.value;
        Promise.resolve(waiting).then(
          (value) => step("next", value),
          (error: unknown) => step("throw", error),
        );
      } catch (error) {
        finished = true;
        owner.signal.removeEventListener("abort", abort);
        reject(error);
      }
    };
    step("next", undefined);
  });
  return result;
}

/** Await a child's render result while retaining attachment and lifetime until the parent installs it. */
export function awaitComponent<P>(
  parent: Owner,
  definition: Component<P>,
  props: CallerProps<P>,
  slot: string,
): Promise<Rendered> {
  parent.assertActive();
  if (!parent.executingBody)
    throw new RenderFault("render-await", "Child composition awaits belong in a component body");
  const child = new Owner(parent.context, parent, `${parent.identity}/${slot}`);
  try {
    const instance = instantiateComponent(child, prepareComponent(definition, props), true);
    const result = Promise.resolve(instance.output).then((output) => {
      parent.assertActive();
      child.assertActive();
      return output;
    });
    void result.catch(() => undefined);
    return registerFrameworkAwaitable(result, parent, "render");
  } catch (error) {
    child.dispose(error);
    throw error;
  }
}
