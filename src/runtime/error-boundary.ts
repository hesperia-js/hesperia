import type { Accessor } from "../client.ts";
import { prepareTree, type Rendered } from "./dom.ts";
import { Owner, RenderFault, reportFault, runComponentBody } from "./owner.ts";

/**
 * Internal error-view composition for filesystem boundaries. The first fault
 * destroys the content lifetime before constructing the error view. The view
 * receives only a readable error; replacing this boundary starts fresh content.
 * Failures in the error view or in teardown continue to an enclosing boundary.
 */
export function errorBoundary(
  parent: Owner,
  slot: string,
  fallback: (owner: Owner, error: Accessor<unknown>) => Rendered,
  content: (owner: Owner) => Rendered,
  onFailure?: () => void,
): DocumentFragment {
  parent.assertActive();
  const owner = new Owner(parent.context, parent, `${parent.identity}/${slot}`);
  owner.executingBody = false;
  const document = owner.context.document;
  const fragment = document.createDocumentFragment();
  const start = document.createComment("error");
  const end = document.createComment("/error");
  owner.nodes.add(start);
  owner.nodes.add(end);
  fragment.append(start, end);
  const contentOwner = new Owner(owner.context, owner, `${owner.identity}/content`);
  let preparing = true;
  // Failed preparation can report cleanup faults before rethrowing its body fault.
  const preparationFaults: unknown[] = [];

  const disposeAfterForwarding = (error: unknown): void => {
    try {
      reportFault(parent, error);
    } finally {
      if (owner.state !== "cleaning" && owner.state !== "destroyed") owner.dispose(error);
    }
  };

  const rangeParent = (): Node | null => {
    const parentNode = end.parentNode;
    return parentNode && start.parentNode === parentNode ? parentNode : null;
  };

  const fail = (error: unknown) => {
    owner.assertActive();
    onFailure?.();
    owner.errorHandler = undefined;
    contentOwner.dispose(error);
    if (owner.signal.aborted) return;
    if (!rangeParent()) {
      disposeAfterForwarding(error);
      return;
    }
    let node = start.nextSibling;
    while (node && node !== end) {
      const next = node.nextSibling;
      node.parentNode?.removeChild(node);
      node = next;
    }
    const viewOwner = new Owner(owner.context, owner, `${owner.identity}/error`);
    const readError = () => {
      viewOwner.assertReadable();
      return error;
    };
    let view: ReturnType<typeof prepareTree>;
    try {
      view = prepareTree(viewOwner, () => runComponentBody(() => fallback(viewOwner, readError)));
      viewOwner.executingBody = false;
    } catch (fallbackError) {
      // A boundary's own view is outside its recovery scope. Forward its
      // failure through the enclosing owner instead of selecting itself again.
      reportFault(parent, fallbackError);
      return;
    }
    const insertionParent = rangeParent();
    if (!insertionParent) {
      viewOwner.dispose(error);
      disposeAfterForwarding(error);
      return;
    }
    try {
      insertionParent.insertBefore(view.fragment, end);
      if (owner.state === "mounted") {
        viewOwner.commit();
        owner.context.scheduler.requestEffects();
      }
    } catch (fallbackError) {
      viewOwner.dispose(fallbackError);
      // A boundary's own view is outside its recovery scope. Forward its
      // failure through the enclosing owner instead of selecting itself again.
      reportFault(parent, fallbackError);
    }
  };
  owner.errorHandler = (error) => {
    if (preparing) preparationFaults.push(error);
    else fail(error);
  };
  owner.onCleanup(() => {
    owner.errorHandler = undefined;
  });
  try {
    let tree: ReturnType<typeof prepareTree> | undefined;
    let failure: { error: unknown } | undefined;
    try {
      tree = prepareTree(contentOwner, () => runComponentBody(() => content(contentOwner)));
      contentOwner.executingBody = false;
    } catch (error) {
      failure = { error };
    }
    preparing = false;
    if (failure) {
      owner.errorHandler = undefined;
      for (const error of preparationFaults) reportFault(parent, error);
      if (!owner.signal.aborted) fail(failure.error);
    } else if (preparationFaults.length) {
      fail(preparationFaults[0]);
      for (const error of preparationFaults.slice(1)) reportFault(parent, error);
    } else if (!owner.signal.aborted && tree) {
      const insertionParent = rangeParent();
      if (!insertionParent) {
        const fault = new RenderFault(
          "render-state",
          "Error boundary anchors must remain in the same rendered tree",
        );
        disposeAfterForwarding(fault);
      } else insertionParent.insertBefore(tree.fragment, end);
    }
    return fragment;
  } catch (error) {
    owner.dispose(error);
    throw error;
  }
}
