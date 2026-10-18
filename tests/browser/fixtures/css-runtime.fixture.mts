import {
  component,
  createClient,
  createInternalStyleRuntime,
  defineComponent,
  element,
  mount,
  type MountedApplication,
  type StyleAsset,
  type StyleCompositionId,
  type StyleEntryId,
  type StyleId,
  type StyleOwnerId,
} from "hesperia/runtime";
import type { Owner } from "hesperia/runtime";

type Failure = { readonly name: string; readonly kind?: string; readonly message: string };

type RevisionOutcome = { readonly status: string; readonly kind?: string };

interface CssRuntimeHarness {
  mountDirect(target: Element, name: string): void;

  mountBlue(target: Element, name: string): void;

  mountConditional(target: Element, name: string, includeChild: boolean): void;

  mountOrdered(target: Element, name: string, reversed: boolean): Promise<void>;

  mountNested(target: Element, name: string): void;

  exerciseRootReleaseBound(name: string): Promise<{
    readonly initialRegistrations: number;
    readonly afterSwitches: number;
    readonly afterHeadRetirement: number;
    readonly afterReactivation: number;
    readonly redMediaBeforeDispose: string | null;
    readonly redMediaAfterDispose: string | null;
  }>;

  replaceHeadThenDispose(name: string): {
    readonly faultCount: number;
    readonly oldHeadLinkCount: number;
  };

  mountDocument(): void;

  settle(name: string): Promise<"resolved" | "rejected">;

  dispose(name: string): void;

  disposeAll(): void;

  settleFailed(name: string): Promise<{ readonly sameFault: boolean; readonly kind?: string }>;

  suspendNested(): void;

  resumeNested(): void;

  startRevisionSupersession(): Promise<RevisionOutcome>;

  publishSupersedingRevision(): Promise<void>;

  retainRevisionPreload(): Promise<void>;

  releaseRevisionPreload(): void;

  prepareRevisionWithLateBlue(): Promise<RevisionOutcome>;

  failRevision(): Promise<RevisionOutcome>;

  preloadOriginalDocumentHead(): Promise<void>;

  snapshot(): {
    readonly effects: readonly string[];
    readonly faults: readonly Failure[];
    readonly unhandled: readonly string[];
    readonly directButtons: readonly HTMLButtonElement[];
    readonly documentSnapshot?: { readonly display: string; readonly color: string };
    readonly oldHeadDetached: boolean;
    readonly oldHeadLeaseCount: number;
    readonly leaseCount: number;
    readonly validLeaseMembership: boolean;
  };
}

declare global {
  interface Window {
    __cssRuntimeHarness: CssRuntimeHarness;
    __cssRuntimeUnhandled: string[];
  }
}

window.__cssRuntimeUnhandled = [];

window.addEventListener("unhandledrejection", (event) => {
  window.__cssRuntimeUnhandled.push(String(event.reason));
});

const styleId = (value: string): StyleId => value as StyleId;

const ownerId = (value: string): StyleOwnerId => value as StyleOwnerId;

const entryId = (value: string): StyleEntryId => value as StyleEntryId;

const compositionId = (value: string): StyleCompositionId => value as StyleCompositionId;

const ids = {
  red: styleId("css-red"),
  blue: styleId("css-blue"),
  document: styleId("css-document"),
  rootRed: ownerId("root-red"),
  rootBlue: ownerId("root-blue"),
  rootEmpty: ownerId("root-empty"),
  childRed: ownerId("child-red"),
  conditionalRoot: ownerId("conditional-root"),
  conditionalBlue: ownerId("conditional-blue"),
  orderedRoot: ownerId("ordered-root"),
  rootDocument: ownerId("root-document"),
  redEntry: entryId("entry-red"),
  blueEntry: entryId("entry-blue"),
  childEntry: entryId("entry-child"),
  documentEntry: entryId("entry-document"),
  conditionalEntry: entryId("entry-conditional"),
  orderedForwardEntry: entryId("entry-order-forward"),
  orderedReverseEntry: entryId("entry-order-reverse"),
  documentComposition: compositionId("document-red"),
  orderedForwardComposition: compositionId("order-forward"),
  orderedReverseComposition: compositionId("order-reverse"),
};

const redAsset: StyleAsset = {
  id: ids.red,
  revision: "r1",
  href: "/css/red.css",
};
const blueAsset: StyleAsset = {
  id: ids.blue,
  revision: "b1",
  href: "/css/blue.css",
};
const documentAsset: StyleAsset = {
  id: ids.document,
  revision: "d1",
  href: "/css/document.css",
};

function plan(assets: readonly StyleAsset[] = [redAsset, blueAsset, documentAsset]) {
  return {
    assets,
    owners: [
      { ownerId: ids.rootRed, styles: [ids.red] },
      { ownerId: ids.rootBlue, styles: [ids.blue] },
      { ownerId: ids.rootEmpty, styles: [] },
      { ownerId: ids.childRed, styles: [ids.red] },
      { ownerId: ids.conditionalRoot, styles: [ids.red] },
      { ownerId: ids.conditionalBlue, styles: [ids.blue] },
      { ownerId: ids.orderedRoot, styles: [ids.red, ids.blue] },
      { ownerId: ids.rootDocument, styles: [ids.document] },
    ],
    entries: [
      { entryId: ids.redEntry, closure: [ids.red] },
      { entryId: ids.blueEntry, closure: [ids.blue] },
      { entryId: ids.childEntry, closure: [ids.red] },
      { entryId: ids.documentEntry, closure: [ids.document] },
      { entryId: ids.conditionalEntry, closure: [ids.red, ids.blue] },
      { entryId: ids.orderedForwardEntry, closure: [ids.red, ids.blue] },
      { entryId: ids.orderedReverseEntry, closure: [ids.blue, ids.red] },
    ],
    compositions: [
      {
        compositionId: ids.documentComposition,
        entries: [ids.documentEntry],
        styles: [ids.document],
      },
      {
        compositionId: ids.orderedForwardComposition,
        entries: [ids.orderedForwardEntry],
        styles: [ids.red, ids.blue],
      },
      {
        compositionId: ids.orderedReverseComposition,
        entries: [ids.orderedReverseEntry],
        styles: [ids.blue, ids.red],
      },
    ],
  };
}

const runtime = createInternalStyleRuntime(plan());
const applications = new Map<string, MountedApplication>();
const orderedLeases = new Map<string, { release(): void }>();
const effects: string[] = [];
const faults = new Map<string, unknown[]>();
const directButtons: HTMLButtonElement[] = [];
const rootOwners = new Map<string, Owner>();
const rootReleaseRegistrations = new WeakMap<Owner, { count: number }>();
const childOwners = new Map<string, Owner>();
let nextName = "";
let nextConditionalChild = false;
let documentSnapshot: { display: string; color: string } | undefined;
let originalHead: HTMLHeadElement | undefined;
let originalPreload: { release(): void } | undefined;
let revisionPreload: { release(): void } | undefined;
let revisionPromise: Promise<import("hesperia/runtime").PreparedStyleRevision> | undefined;

function onError(name: string): (error: unknown) => void {
  const list = faults.get(name) ?? [];

  faults.set(name, list);

  return (error) => list.push(error);
}

function button(owner: Owner, name: string, className = "css-red-node"): HTMLButtonElement {
  const node = element(owner, "button", { class: className, "data-css-name": name });
  node.textContent = name;

  directButtons.push(node);

  return node;
}

function rootOwnerOf(owner: Owner): Owner {
  let root = owner;

  while (root.parent) root = root.parent;

  return root;
}

const DirectRed = defineComponent((owner) => {
  const name = nextName;

  rootOwners.set(name, owner);

  const registrations = { count: 0 };
  const registerRelease = owner.onRelease.bind(owner);
  owner.onRelease = (release) => {
    registrations.count++;

    registerRelease(release);
  };

  rootReleaseRegistrations.set(owner, registrations);

  runtime.bindStyles(owner, ids.rootRed);

  const node = button(owner, name);

  createClient(owner).effect(() => effects.push(`${name}:${node.parentElement?.id ?? "detached"}`));

  return [`new range ${name}:`, node];
});

runtime.bindEntry(DirectRed, ids.redEntry, ids.documentComposition);

const DirectBlue = defineComponent((owner) => {
  const name = nextName;

  rootOwners.set(name, owner);

  runtime.bindStyles(owner, ids.rootBlue);

  return button(owner, name, "css-blue-node");
});

runtime.bindEntry(DirectBlue, ids.blueEntry);

const ConditionalBlue = defineComponent((owner) => {
  const name = nextName;

  childOwners.set(name, owner);

  runtime.bindStyles(owner, ids.conditionalBlue);

  return button(owner, `${name}-conditional`, "css-blue-node");
});

const ConditionalShell = defineComponent((owner) => {
  const name = nextName;

  rootOwners.set(name, owner);

  runtime.bindStyles(owner, ids.conditionalRoot);

  const shell = element(owner, "div", {
    id: `${name}-conditional-shell`,
    class: "css-red-node",
  });

  if (nextConditionalChild) shell.append(component(owner, ConditionalBlue, {}));

  return shell;
});

runtime.bindEntry(ConditionalShell, ids.conditionalEntry);

const OrderedForward = defineComponent((owner) => {
  const name = nextName;

  rootOwners.set(name, rootOwnerOf(owner));

  runtime.bindStyles(owner, ids.orderedRoot);

  return button(owner, name, "order-node");
});

const OrderedReverse = defineComponent((owner) => {
  const name = nextName;

  rootOwners.set(name, rootOwnerOf(owner));

  runtime.bindStyles(owner, ids.orderedRoot);

  return button(owner, name, "order-node");
});

const ChildRed = defineComponent((owner) => {
  const name = nextName;

  childOwners.set(name, owner);

  runtime.bindStyles(owner, ids.childRed);

  return button(owner, `${name}-child`);
});

const Nested = defineComponent((owner) => {
  const name = nextName;

  rootOwners.set(name, owner);

  runtime.bindStyles(owner, ids.rootEmpty);

  const section = element(owner, "section", { id: "nested-css-root" });

  section.append(component(owner, ChildRed, {}));

  return section;
});

runtime.bindEntry(Nested, ids.childEntry, ids.documentComposition);

const DocumentShell = defineComponent((owner) => {
  rootOwners.set("document", owner);

  runtime.bindStyles(owner, ids.rootDocument);

  const client = createClient(owner);
  const head = element(owner, "head", {}, [element(owner, "title", {}, ["CSS shell"])]);
  const body = element(owner, "body", { id: "css-document-body" }, [
    "document text ",
    button(owner, "document", "css-document-node"),
  ]);
  body.style.display = "grid";
  const html = element(owner, "html", {}, [head, body]);

  client.effect(() => {
    documentSnapshot = {
      display: window.getComputedStyle(body).display,
      color: window.getComputedStyle(body.querySelector(".css-document-node")!).color,
    };

    effects.push("document");
  });

  return html;
});

runtime.bindEntry(DocumentShell, ids.documentEntry, ids.documentComposition);

const failuresFor = (name: string): readonly unknown[] => faults.get(name) ?? [];

async function settle(name: string): Promise<"resolved" | "rejected"> {
  const application = applications.get(name);

  if (!application) throw new Error(`No mounted application named ${name}`);

  try {
    await application.settled();

    return "resolved";
  } catch {
    return "rejected";
  }
}

const nextRevisionPlan = plan([
  { id: ids.red, revision: "r2", href: "/css/red-next.css" },
  blueAsset,
  documentAsset,
]);

window.__cssRuntimeHarness = {
  mountDirect(target, name) {
    nextName = name;

    applications.set(name, mount(target, DirectRed, {}, { onError: onError(name) }));
  },

  mountBlue(target, name) {
    nextName = name;

    applications.set(name, mount(target, DirectBlue, {}, { onError: onError(name) }));
  },

  async exerciseRootReleaseBound(name) {
    const root = rootOwners.get(name);
    const application = applications.get(name);
    const registrations = root && rootReleaseRegistrations.get(root);

    if (!root || !application || !registrations)
      throw new Error(`No tracked root Owner named ${name}`);

    const initialRegistrations = registrations.count;
    const forward = await runtime.prepareInstalledHead(
      ids.orderedForwardComposition,
      document.head,
    );
    const reverse = await runtime.prepareInstalledHead(
      ids.orderedReverseComposition,
      document.head,
    );

    for (let index = 0; index < 20; index++) {
      (index % 2 === 0 ? forward : reverse).activate(root);
    }

    const afterSwitches = registrations.count;

    const oldHead = document.head;
    const replacement = document.createElement("head");

    oldHead.parentNode!.replaceChild(replacement, oldHead);

    const renewed = await runtime.prepareInstalledHead(ids.orderedForwardComposition, replacement);
    const afterHeadRetirement = registrations.count;

    renewed.activate(root);

    const afterReactivation = registrations.count;
    const redLink = replacement.querySelector(
      'link[data-hesperia-style-id="css-red"]',
    ) as HTMLLinkElement | null;
    const redMediaBeforeDispose = redLink?.sheet?.media.mediaText ?? null;

    application.dispose();

    const redMediaAfterDispose = redLink?.sheet?.media.mediaText ?? null;

    renewed.release();

    forward.release();

    reverse.release();

    return {
      initialRegistrations,
      afterSwitches,
      afterHeadRetirement,
      afterReactivation,
      redMediaBeforeDispose,
      redMediaAfterDispose,
    };
  },

  replaceHeadThenDispose(name) {
    const oldHead = document.head;
    const application = applications.get(name);

    if (!application) throw new Error(`No mounted application named ${name}`);

    const replacement = document.createElement("head");

    oldHead.parentNode!.replaceChild(replacement, oldHead);

    application.dispose();

    return {
      faultCount: failuresFor(name).length,
      oldHeadLinkCount: oldHead.querySelectorAll("link[data-hesperia-style-id]").length,
    };
  },

  mountConditional(target, name, includeChild) {
    nextName = name;
    nextConditionalChild = includeChild;

    applications.set(name, mount(target, ConditionalShell, {}, { onError: onError(name) }));
  },

  async mountOrdered(target, name, reversed) {
    nextName = name;
    const definition = reversed ? OrderedReverse : OrderedForward;

    applications.set(name, mount(target, definition, {}, { onError: onError(name) }));

    await applications.get(name)!.settled();

    const owner = rootOwners.get(name);

    if (!owner) throw new Error(`No root Owner captured for ${name}`);

    const composition = reversed ? ids.orderedReverseComposition : ids.orderedForwardComposition;
    const lease = await runtime.prepareInstalledHead(composition, document.head);

    orderedLeases.set(name, lease);

    lease.activate(owner);
  },

  mountNested(target, name) {
    nextName = name;

    applications.set(name, mount(target, Nested, {}, { onError: onError(name) }));
  },

  mountDocument() {
    applications.set(
      "document",
      mount(document, DocumentShell, {}, { onError: onError("document") }),
    );
  },

  settle,

  dispose(name) {
    applications.get(name)?.dispose();

    orderedLeases.get(name)?.release();

    orderedLeases.delete(name);
  },

  disposeAll() {
    for (const application of applications.values()) application.dispose();

    for (const lease of orderedLeases.values()) lease.release();

    orderedLeases.clear();

    originalPreload?.release();

    revisionPreload?.release();
  },

  async settleFailed(name) {
    try {
      await applications.get(name)!.settled();

      return { sameFault: false };
    } catch (error) {
      return {
        sameFault: failuresFor(name).at(-1) === error,
        kind: (error as { kind?: string }).kind,
      };
    }
  },

  suspendNested() {
    const root = rootOwners.get("nested");
    const child = childOwners.get("nested");

    root?.suspend();

    child?.suspend();
  },

  resumeNested() {
    rootOwners.get("nested")?.resume();
  },

  async startRevisionSupersession() {
    const first = runtime.prepareRevision(nextRevisionPlan, document.head).then(
      () => ({ status: "resolved" }),
      (error: unknown) => ({ status: "rejected", kind: (error as { kind?: string }).kind }),
    );
    revisionPromise = runtime.prepareRevision(nextRevisionPlan, document.head);
    return Promise.race([
      first,
      new Promise<RevisionOutcome>((resolve) => {
        window.setTimeout(() => resolve({ status: "still-waiting" }), 1000);
      }),
    ]);
  },

  async publishSupersedingRevision() {
    if (!revisionPromise) throw new Error("No superseding stylesheet revision is pending");

    (await revisionPromise).publish();

    revisionPromise = undefined;
  },

  async retainRevisionPreload() {
    revisionPreload = await runtime.preloadEntry(ids.redEntry, document.head);
  },

  releaseRevisionPreload() {
    revisionPreload?.release();

    revisionPreload = undefined;
  },

  async prepareRevisionWithLateBlue() {
    const pending = runtime.prepareRevision(nextRevisionPlan, document.head);
    nextName = "late-blue";
    const blueApplication = mount(
      document.querySelector("#blue-target")!,
      DirectBlue,
      {},
      { onError: onError("late-blue") },
    );

    applications.set("late-blue", blueApplication);

    await blueApplication.settled();

    const revision = await pending;

    try {
      revision.publish();

      return { status: "published" };
    } catch (error) {
      return { status: "rejected", kind: (error as { kind?: string }).kind };
    }
  },

  async failRevision() {
    try {
      const revision = await runtime.prepareRevision(nextRevisionPlan, document.head);

      revision.release();

      return { status: "resolved" };
    } catch (error) {
      return { status: "rejected", kind: (error as { kind?: string }).kind };
    }
  },

  async preloadOriginalDocumentHead() {
    originalHead = document.head;
    originalPreload = await runtime.preloadEntry(ids.redEntry, originalHead);
  },

  snapshot() {
    const allFaults = [...faults.values()].flat().map((error) => ({
      name: error instanceof Error ? error.name : typeof error,
      kind: (error as { kind?: string })?.kind,
      message: error instanceof Error ? error.message : String(error),
    }));
    const state = (
      runtime as unknown as {
        state?: {
          leases?: Set<{ group?: { head?: HTMLHeadElement; leases?: Set<unknown> } }>;
        };
      }
    ).state;
    const oldHeadLeaseCount = originalHead
      ? [...(state?.leases ?? [])].filter((lease) => lease.group?.head === originalHead).length
      : 0;
    return {
      effects: effects.slice(),
      faults: allFaults,
      unhandled: window.__cssRuntimeUnhandled.slice(),
      directButtons: directButtons.slice(),
      ...(documentSnapshot ? { documentSnapshot: { ...documentSnapshot } } : {}),
      oldHeadDetached: originalHead
        ? !originalHead.isConnected &&
          originalHead.querySelectorAll("link[data-hesperia-style-id]").length === 0
        : false,
      oldHeadLeaseCount,
      leaseCount: state?.leases?.size ?? 0,
      validLeaseMembership: [...(state?.leases ?? [])].every((lease) =>
        lease.group?.leases?.has(lease),
      ),
    };
  },
};
