import { createClient } from "../../packages/hesperia/src/client.ts";
import {
  component,
  defineComponent,
  element,
  type Component,
} from "../../packages/hesperia/src/runtime/dom.ts";
import {
  createInternalStyleRuntime,
  type CompiledStylePlan,
  type InternalStyleRuntime,
  type StyleCompositionId,
  type StyleEntryId,
  type StyleId,
  type StyleOwnerId,
} from "../../packages/hesperia/src/runtime/style.ts";
import type { Owner } from "../../packages/hesperia/src/runtime/owner.ts";
import { Window } from "happy-dom";

export const styleIds = {
  red: "css-red" as StyleId,
  blue: "css-blue" as StyleId,
};

export const ownerIds = {
  red: "css-red-owner" as StyleOwnerId,
  redChild: "css-red-child-owner" as StyleOwnerId,
  blue: "css-blue-owner" as StyleOwnerId,
};

export const entryIds = {
  red: "css-red-entry" as StyleEntryId,
  blue: "css-blue-entry" as StyleEntryId,
};

export const compositionIds = {
  red: "css-red-composition" as StyleCompositionId,
};

export function compiledStylePlan(redRevision = "r1", blueRevision = "r1"): CompiledStylePlan {
  return {
    assets: [
      { id: styleIds.red, revision: redRevision, href: `/css/red-${redRevision}.css` },
      { id: styleIds.blue, revision: blueRevision, href: `/css/blue-${blueRevision}.css` },
    ],
    owners: [
      { ownerId: ownerIds.red, styles: [styleIds.red] },
      { ownerId: ownerIds.redChild, styles: [styleIds.red] },
      { ownerId: ownerIds.blue, styles: [styleIds.blue] },
    ],
    entries: [
      { entryId: entryIds.red, closure: [styleIds.red] },
      { entryId: entryIds.blue, closure: [styleIds.blue] },
    ],
    compositions: [
      {
        compositionId: compositionIds.red,
        entries: [entryIds.red],
        styles: [styleIds.red],
      },
    ],
  };
}

export interface StyledComponent {
  readonly definition: Component<Record<string, never>>;
  readonly owners: Owner[];
  readonly nodes: HTMLButtonElement[];
  readonly effects: string[];
}

export interface StyledTree {
  readonly definition: Component<Record<string, never>>;
  readonly parentOwners: Owner[];
  readonly childOwners: Owner[];
  readonly nodes: HTMLElement[];
  readonly effects: string[];
}

export interface CssLifecycleFixture {
  readonly window: Window;
  readonly document: Document;
  readonly head: HTMLHeadElement;
  readonly runtime: InternalStyleRuntime;

  makeComponent(label: string, ownerId?: StyleOwnerId, entryId?: StyleEntryId): StyledComponent;

  makeParentChildTree(): StyledTree;

  links(head?: HTMLHeadElement): HTMLLinkElement[];

  link(styleId: StyleId, revision: string, head?: HTMLHeadElement): HTMLLinkElement;

  completeLoad(link: HTMLLinkElement): void;

  failLoad(link: HTMLLinkElement): void;

  mediaText(link: HTMLLinkElement): string;
}

/** Build native Happy DOM fixtures with CSS resource loading controlled by each test. */
export function createCssLifecycleFixture(): CssLifecycleFixture {
  const window = new Window({ settings: { disableCSSFileLoading: true } });
  const document = window.document as unknown as Document;
  const head = document.head;
  const runtime = createInternalStyleRuntime(compiledStylePlan());

  const makeComponent = (
    label: string,
    ownerId = ownerIds.red,
    entryId = entryIds.red,
  ): StyledComponent => {
    const owners: Owner[] = [];
    const nodes: HTMLButtonElement[] = [];
    const effects: string[] = [];
    const definition = defineComponent<Record<string, never>>((owner) => {
      runtime.bindStyles(owner, ownerId);

      owners.push(owner);

      const instance = `${label}:${owners.length}`;

      createClient(owner).effect(() => {
        effects.push(`run:${instance}`);

        return () => effects.push(`cleanup:${instance}`);
      });

      const button = element(owner, "button", { "data-css-component": label }, [label]);

      nodes.push(button);

      return button;
    });

    runtime.bindEntry(definition, entryId);

    return { definition, owners, nodes, effects };
  };

  const makeParentChildTree = (): StyledTree => {
    const parentOwners: Owner[] = [];
    const childOwners: Owner[] = [];
    const nodes: HTMLElement[] = [];
    const effects: string[] = [];
    const Child = defineComponent<Record<string, never>>((owner) => {
      runtime.bindStyles(owner, ownerIds.redChild);

      childOwners.push(owner);

      createClient(owner).effect(() => {
        effects.push("run:child");

        return () => effects.push("cleanup:child");
      });

      const node = element(owner, "i", { "data-css-component": "child" }, ["child"]);

      nodes.push(node);

      return node;
    });
    const Parent = defineComponent<Record<string, never>>((owner) => {
      runtime.bindStyles(owner, ownerIds.red);

      parentOwners.push(owner);

      createClient(owner).effect(() => {
        effects.push("run:parent");

        return () => effects.push("cleanup:parent");
      });

      const node = element(owner, "section", { "data-css-component": "parent" }, [
        component(owner, Child, {}, "styled-child"),
      ]);

      nodes.push(node);

      return node;
    });

    runtime.bindEntry(Parent, entryIds.red);

    return { definition: Parent, parentOwners, childOwners, nodes, effects };
  };

  const links = (target = head): HTMLLinkElement[] =>
    Array.from(target.querySelectorAll("link[data-hesperia-style-id]")) as HTMLLinkElement[];

  const link = (styleId: StyleId, revision: string, target = head): HTMLLinkElement => {
    const found = links(target).find(
      (candidate) =>
        candidate.getAttribute("data-hesperia-style-id") === styleId &&
        candidate.getAttribute("data-hesperia-style-revision") === revision,
    );

    if (!found) throw new Error(`Missing ${styleId} stylesheet revision ${revision}`);

    return found;
  };

  const completeLoad = (stylesheet: HTMLLinkElement): void => {
    const sheet = new window.CSSStyleSheet();

    Object.defineProperty(sheet, "media", {
      configurable: true,
      value: { mediaText: stylesheet.media || "not all" },
    });

    Object.defineProperty(stylesheet, "sheet", { configurable: true, value: sheet });

    stylesheet.dispatchEvent(new window.Event("load") as unknown as Event);
  };

  const failLoad = (stylesheet: HTMLLinkElement): void => {
    stylesheet.dispatchEvent(new window.Event("error") as unknown as Event);
  };

  const mediaText = (stylesheet: HTMLLinkElement): string => {
    const sheet = stylesheet.sheet as unknown as { media: { mediaText: string } } | null;
    return sheet?.media.mediaText ?? "not all";
  };

  return {
    window,
    document,
    head,
    runtime,
    makeComponent,
    makeParentChildTree,
    links,
    link,
    completeLoad,
    failLoad,
    mediaText,
  };
}
