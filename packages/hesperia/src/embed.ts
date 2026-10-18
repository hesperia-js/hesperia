import { signal, type WritableSignal } from "aeolia";
import { attachNativeEventListener, attribute } from "./runtime/dom.ts";
import { defineComponent, type Component } from "./runtime/components.ts";
import { Owner, RenderFault, registerOwnerResourceLifecycle } from "./runtime/owner.ts";
import { allowUnsafeEmbedFor } from "./runtime/project-policy.ts";

type EmbedEventHandler = { handle(this: HTMLIFrameElement, event: Event): unknown }["handle"];

type EmbedEventOptions = Readonly<{
  capture?: boolean;
  once?: boolean;
  passive?: boolean;
}>;

type EmbedEventInput = EmbedEventHandler | readonly [EmbedEventHandler, EmbedEventOptions];

/** Native iframe options supported by Hesperia's official embedded-document component. */
export interface EmbedProps {
  /** URL or Blob loaded by the iframe. `srcdoc`, when present, takes native precedence. */
  readonly src?: string | Blob;
  /** Native inline document source; it takes precedence over `src` when both are present. */
  readonly srcdoc?: string;
  /** Accessible title applied to the inner iframe. */
  readonly title?: string;
  /** Native sandbox tokens. Omission creates the strict empty sandbox. */
  readonly sandbox?: string;
  /** Wrapper width in CSS pixels or CSS length syntax. */
  readonly width?: number | string;
  /** Wrapper height in CSS pixels or CSS length syntax. */
  readonly height?: number | string;
  /** Wrapper aspect ratio as a number or CSS ratio string such as `16 / 9`. */
  readonly aspectRatio?: number | string;
  /** Native iframe loading strategy. */
  readonly loading?: HTMLIFrameElement["loading"];
  /** Native iframe referrer policy. */
  readonly referrerPolicy?: HTMLIFrameElement["referrerPolicy"];
  /** Native iframe browsing-context name. */
  readonly name?: string;
  /** Native iframe load event. The event targets the replaceable inner iframe. */
  readonly "on:load"?: EmbedEventInput;
  /** Native iframe error event; browsers may suppress it for failed navigations. */
  readonly "on:error"?: EmbedEventInput;
  /** Publish the persistent wrapper element through a Hesperia binding. */
  readonly bind?: HTMLElement;
}

interface Inputs {
  readonly src: string | Blob | undefined;
  readonly srcdoc: string | undefined;
  readonly title: string | undefined;
  readonly sandbox: string | undefined;
  readonly width: number | string | undefined;
  readonly height: number | string | undefined;
  readonly aspectRatio: number | string | undefined;
  readonly loading: HTMLIFrameElement["loading"] | undefined;
  readonly referrerPolicy: HTMLIFrameElement["referrerPolicy"] | undefined;
  readonly name: string | undefined;
}

interface FrameResource {
  readonly owner: Owner;
  readonly element: HTMLIFrameElement;
  readonly permissions: readonly string[];
  readonly src: WritableSignal<string | Blob | undefined>;
  readonly srcdoc: WritableSignal<string | undefined>;
  assignedSrc: string | Blob | undefined;
  assignedSrcdoc: string | undefined;
}

const propSchema = {
  src: { kind: "value", optional: true },
  srcdoc: { kind: "value", optional: true },
  title: { kind: "value", optional: true },
  sandbox: { kind: "value", optional: true },
  width: { kind: "value", optional: true },
  height: { kind: "value", optional: true },
  aspectRatio: { kind: "value", optional: true },
  loading: { kind: "value", optional: true },
  referrerPolicy: { kind: "value", optional: true },
  name: { kind: "value", optional: true },
  "on:load": { kind: "value", optional: true },
  "on:error": { kind: "value", optional: true },
  bind: { kind: "binding", optional: true },
} as const;

function readInputs(props: Component.Props<EmbedProps>): Inputs {
  return {
    src: props.src(),
    srcdoc: props.srcdoc(),
    title: props.title(),
    sandbox: props.sandbox(),
    width: props.width(),
    height: props.height(),
    aspectRatio: props.aspectRatio(),
    loading: props.loading(),
    referrerPolicy: props.referrerPolicy(),
    name: props.name(),
  };
}

function parsePermissions(sandbox: string | undefined): string[] {
  if (sandbox !== undefined && typeof sandbox !== "string")
    throw new RenderFault("embed-sandbox-value", "Embed sandbox must be a string");

  if (!sandbox) return [];

  const tokens = sandbox
    .split(/[\t\n\f\r ]+/)
    .filter(Boolean)
    .map((token) => token.replace(/[A-Z]/g, (character) => character.toLowerCase()));

  return [...new Set(tokens)];
}

function validatePermissions(
  frame: HTMLIFrameElement,
  sandbox: string | undefined,
  allowUnsafeEmbed: boolean,
): string[] {
  const tokens = parsePermissions(sandbox);

  const sandboxTokens = frame.sandbox as (DOMTokenList | undefined) & {
    supports?: (token: string) => boolean;
  };

  for (const token of tokens) {
    let supported = false;

    try {
      const supports = sandboxTokens?.supports;

      supported = typeof supports === "function" && supports.call(sandboxTokens, token);
    } catch {
      supported = false;
    }

    if (!supported)
      throw new RenderFault(
        "embed-sandbox-token",
        `The browser does not support the iframe sandbox token ${token}`,
      );

    if (token !== "allow-scripts" && !allowUnsafeEmbed)
      throw new RenderFault(
        "embed-permission",
        `The iframe sandbox token ${token} requires allowUnsafeEmbed in the project configuration`,
      );
  }

  return tokens;
}

function setOptionalAttribute(element: Element, name: string, value: unknown): void {
  if (value === undefined || value === null) element.removeAttribute(name);
  else element.setAttribute(name, String(value));
}

function cssValue(value: number | string, numericUnit: "px" | "ratio"): string {
  return typeof value === "number" ? (numericUnit === "px" ? `${value}px` : String(value)) : value;
}

function setOwnedStyle(
  style: CSSStyleDeclaration,
  name: string,
  value: number | string | undefined,
  numericUnit: "px" | "ratio",
  previouslySet: boolean,
): boolean {
  if (value === undefined || value === null) {
    if (previouslySet) style.removeProperty(name);

    return false;
  }

  style.setProperty(name, cssValue(value, numericUnit));

  return true;
}

function updateWrapperSizing(
  wrapper: HTMLElement,
  inputs: Inputs,
  previous: { width: boolean; height: boolean; ratio: boolean },
): { width: boolean; height: boolean; ratio: boolean; fill: boolean } {
  const width = setOwnedStyle(wrapper.style, "width", inputs.width, "px", previous.width);

  const height = setOwnedStyle(wrapper.style, "height", inputs.height, "px", previous.height);

  const ratio = setOwnedStyle(
    wrapper.style,
    "aspect-ratio",
    inputs.aspectRatio,
    "ratio",
    previous.ratio,
  );

  const fill = inputs.width != null || inputs.height != null || inputs.aspectRatio != null;

  return { width, height, ratio, fill };
}

function applyFrameSizing(
  frame: HTMLIFrameElement,
  fill: boolean,
  previouslyFilled: boolean,
): void {
  if (fill) {
    frame.style.setProperty("display", "block");

    frame.style.setProperty("width", "100%");

    frame.style.setProperty("height", "100%");

    frame.style.setProperty("border", "0");
  } else if (previouslyFilled) {
    frame.style.removeProperty("display");

    frame.style.removeProperty("width");

    frame.style.removeProperty("height");

    frame.style.removeProperty("border");
  }
}

function applyNativeOptions(frame: HTMLIFrameElement, inputs: Inputs): void {
  setOptionalAttribute(frame, "title", inputs.title);

  setOptionalAttribute(frame, "loading", inputs.loading);

  setOptionalAttribute(frame, "referrerpolicy", inputs.referrerPolicy);

  setOptionalAttribute(frame, "name", inputs.name);
}

function permissionKey(tokens: readonly string[]): string {
  return tokens.slice().sort().join("\u0000");
}

/**
 * Render a sandboxed native iframe with project-gated permissions and owner-bound lifetime.
 * The wrapper remains stable when permission changes replace the inner browsing context.
 */
export const Embed: Component<EmbedProps> = defineComponent<EmbedProps>(
  (owner, props) => {
    const document = owner.context.document;

    const wrapper = document.createElement("div");

    owner.nodes.add(wrapper);

    props.bind?.set(wrapper);

    let resource: FrameResource | undefined;
    let resourcesActive = true;
    let ownedSizing = { width: false, height: false, ratio: false, fill: false };

    const createResource = (inputs: Inputs): FrameResource => {
      const frame = document.createElement("iframe");

      const validatedPermissions = validatePermissions(
        frame,
        inputs.sandbox,
        allowUnsafeEmbedFor(owner),
      );

      const frameOwner = new Owner(owner.context, owner, `${owner.identity}/embed-frame`);

      frameOwner.executingBody = false;

      frameOwner.nodes.add(frame);

      try {
        frame.setAttribute("sandbox", validatedPermissions.join(" "));

        applyNativeOptions(frame, inputs);

        applyFrameSizing(frame, ownedSizing.fill, false);

        const addHandler = (name: "load" | "error", read: () => unknown): void => {
          attachNativeEventListener(frameOwner, frame, name, read(), read);
        };

        addHandler("load", () => props["on:load"]());

        addHandler("error", () => props["on:error"]());

        const src = signal<string | Blob | undefined>(inputs.src);

        const srcdoc = signal<string | undefined>(inputs.srcdoc);

        attribute(frameOwner, frame, "srcdoc", () => srcdoc.get());

        attribute(frameOwner, frame, "src", () => src.get());

        return {
          owner: frameOwner,
          element: frame,
          permissions: validatedPermissions,
          src,
          srcdoc,
          assignedSrc: inputs.src,
          assignedSrcdoc: inputs.srcdoc,
        };
      } catch (error) {
        frameOwner.dispose(error);

        throw error;
      }
    };

    const synchronize = (): void => {
      const inputs = readInputs(props);

      const permissionProbe = document.createElement("iframe");

      const permissions = validatePermissions(
        permissionProbe,
        inputs.sandbox,
        allowUnsafeEmbedFor(owner),
      );

      const previousSizing = ownedSizing;

      ownedSizing = updateWrapperSizing(wrapper, inputs, ownedSizing);

      if (!resourcesActive) return;

      const shouldReplace =
        resource === undefined ||
        permissionKey(resource.permissions) !== permissionKey(permissions);

      if (shouldReplace) {
        const next = createResource(inputs);

        const previous = resource;

        try {
          previous?.owner.dispose();

          wrapper.appendChild(next.element);

          resource = next;

          if (owner.state === "mounted") next.owner.commit();
        } catch (error) {
          next.owner.dispose(error);

          resource = undefined;

          throw error;
        }

        return;
      }

      const current = resource!;

      applyNativeOptions(current.element, inputs);

      applyFrameSizing(current.element, ownedSizing.fill, previousSizing.fill);

      if (!Object.is(current.assignedSrcdoc, inputs.srcdoc)) {
        current.srcdoc.set(inputs.srcdoc);

        current.assignedSrcdoc = inputs.srcdoc;
      }

      if (!Object.is(current.assignedSrc, inputs.src)) {
        current.src.set(inputs.src);

        current.assignedSrc = inputs.src;
      }
    };

    registerOwnerResourceLifecycle(owner, {
      suspended() {
        resourcesActive = false;

        const current = resource;

        resource = undefined;

        current?.owner.dispose();
      },

      resumed() {
        resourcesActive = true;

        synchronize();
      },
    });

    owner.context.scheduler.render(owner, synchronize);

    return wrapper;
  },
  { name: "Embed", props: propSchema },
);
