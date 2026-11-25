import { afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { createClient, type State } from "../../packages/hesperia/src/client.ts";
import { Embed } from "../../packages/hesperia/src/embed.ts";
import {
  component,
  defineComponent,
  dynamic,
  element,
  mount,
  registerProjectPolicy,
  bootstrapApplication,
  type CallerProps,
  type Rendered,
} from "../../packages/hesperia/src/runtime/index.ts";
import {
  RenderFault,
  registerOwnerResourceLifecycle,
  type Owner,
} from "../../packages/hesperia/src/runtime/owner.ts";
import type { Binding, MountedApplication } from "../../packages/hesperia/src/runtime/index.ts";
import type { EmbedProps } from "../../packages/hesperia/src/embed.ts";
import type { RouteTable } from "../../packages/hesperia/src/routing/route-table.ts";
import { installHistoryCloneAdapter } from "../routing/history-platform.ts";

const windows: Window[] = [];
const supportedSandboxTokens = new Set([
  "allow-downloads",
  "allow-forms",
  "allow-modals",
  "allow-orientation-lock",
  "allow-pointer-lock",
  "allow-popups",
  "allow-popups-to-escape-sandbox",
  "allow-presentation",
  "allow-same-origin",
  "allow-scripts",
  "allow-top-navigation",
  "allow-top-navigation-by-user-activation",
  "allow-top-navigation-to-custom-protocols",
]);

afterEach(() => {
  for (const window of windows.splice(0)) window.close();
});

function createWindow(): Window {
  const window = new Window();

  windows.push(window);

  return window;
}

function installSandboxSupport(window: Window): void {
  const tokenList = window.document.createElement("div").classList;
  const prototype = Object.getPrototypeOf(tokenList) as object;

  Object.defineProperty(prototype, "supports", {
    configurable: true,

    value(this: DOMTokenList, token: string) {
      return supportedSandboxTokens.has(token);
    },
  });

  Object.defineProperty(window.HTMLIFrameElement.prototype, "sandbox", {
    configurable: true,

    get(this: HTMLIFrameElement) {
      return this.classList;
    },
  });
}

function spyOnIframeOperations(window: Window): {
  readonly operations: string[];
  readonly eventOptions: {
    readonly type: string;
    readonly options: boolean | AddEventListenerOptions | undefined;
  }[];

  restore(): void;
} {
  const operations: string[] = [];
  const eventOptions: {
    readonly type: string;
    readonly options: boolean | AddEventListenerOptions | undefined;
  }[] = [];
  const elementPrototype = window.Element.prototype as unknown as {
    setAttribute: Element["setAttribute"];
  };
  const iframePrototype = window.HTMLIFrameElement.prototype as unknown as {
    addEventListener: EventTarget["addEventListener"];
  };
  const originalSetAttribute = elementPrototype.setAttribute;
  const originalAddEventListener = iframePrototype.addEventListener;
  elementPrototype.setAttribute = function (this: Element, name: string, value: string): void {
    if (this.localName === "iframe") operations.push(`attribute:${name.toLowerCase()}`);

    originalSetAttribute.call(this, name, value);
  };
  iframePrototype.addEventListener = function (
    this: EventTarget,
    type: string,
    callback: EventListenerOrEventListenerObject | null,
    options?: boolean | AddEventListenerOptions,
  ): void {
    if ((this as unknown as Element).localName === "iframe") {
      operations.push(`event:${type}`);

      eventOptions.push({ type, options });
    }

    originalAddEventListener.call(this, type, callback, options);
  };
  return {
    operations,
    eventOptions,

    restore() {
      elementPrototype.setAttribute = originalSetAttribute;
      iframePrototype.addEventListener = originalAddEventListener;
    },
  };
}

interface HarnessOptions {
  readonly window?: Window;
  readonly target?: HTMLElement;
  readonly allowUnsafeEmbed?: boolean;
  readonly src?: string | Blob;
  readonly srcdoc?: string;
  readonly title?: string;
  readonly sandbox?: string;
  readonly width?: number | string;
  readonly height?: number | string;
  readonly aspectRatio?: number | string;
  readonly loading?: HTMLIFrameElement["loading"];
  readonly referrerPolicy?: HTMLIFrameElement["referrerPolicy"];
  readonly name?: string;
  readonly onLoad?: EmbedEventInput;
  readonly onError?: EmbedEventInput;
}

type EmbedEventInput = NonNullable<EmbedProps["on:load"]>;

interface Harness {
  readonly window: Window;
  readonly target: HTMLElement;
  readonly app: MountedApplication;
  readonly root: Owner;
  readonly binding: Binding<HTMLElement>;
  readonly src: State<string | Blob | undefined>;
  readonly srcdoc: State<string | undefined>;
  readonly title: State<string | undefined>;
  readonly sandbox: State<string | undefined>;
  readonly width: State<number | string | undefined>;
  readonly height: State<number | string | undefined>;
  readonly aspectRatio: State<number | string | undefined>;
  readonly loading: State<HTMLIFrameElement["loading"] | undefined>;
  readonly referrerPolicy: State<HTMLIFrameElement["referrerPolicy"] | undefined>;
  readonly name: State<string | undefined>;
  readonly onLoad: State<EmbedEventInput | undefined>;
  readonly onError: State<EmbedEventInput | undefined>;
  readonly errors: unknown[];
}

function createHarness(options: HarnessOptions = {}): Harness {
  const window = options.window ?? createWindow();

  installSandboxSupport(window);

  const target =
    options.target ?? (window.document.createElement("main") as unknown as HTMLElement);

  if (!target.parentNode) window.document.body.appendChild(target as never);

  const errors: unknown[] = [];
  let root!: Owner;
  let src!: State<string | Blob | undefined>;
  let srcdoc!: State<string | undefined>;
  let title!: State<string | undefined>;
  let sandbox!: State<string | undefined>;
  let width!: State<number | string | undefined>;
  let height!: State<number | string | undefined>;
  let aspectRatio!: State<number | string | undefined>;
  let loading!: State<HTMLIFrameElement["loading"] | undefined>;
  let referrerPolicy!: State<HTMLIFrameElement["referrerPolicy"] | undefined>;
  let name!: State<string | undefined>;
  let onLoad!: State<EmbedEventInput | undefined>;
  let onError!: State<EmbedEventInput | undefined>;
  let binding!: Binding<HTMLElement>;

  const Root = defineComponent((owner) => {
    root = owner;
    const client = createClient(owner);
    src = client.state(options.src);
    srcdoc = client.state(options.srcdoc);
    title = client.state(options.title);
    sandbox = client.state(options.sandbox);
    width = client.state(options.width);
    height = client.state(options.height);
    aspectRatio = client.state(options.aspectRatio);
    loading = client.state(options.loading);
    referrerPolicy = client.state(options.referrerPolicy);
    name = client.state(options.name);
    onLoad = client.state(options.onLoad);
    onError = client.state(options.onError);
    binding = client.bind<HTMLElement>();
    return component(
      owner,
      Embed,
      {
        src: dynamic(src),
        srcdoc: dynamic(srcdoc),
        title: dynamic(title),
        sandbox: dynamic(sandbox),
        width: dynamic(width),
        height: dynamic(height),
        aspectRatio: dynamic(aspectRatio),
        loading: dynamic(loading),
        referrerPolicy: dynamic(referrerPolicy),
        name: dynamic(name),
        "on:load": dynamic(onLoad),
        "on:error": dynamic(onError),
        bind: binding,
      } as unknown as CallerProps<EmbedProps>,
      "embed",
    );
  });
  const definition =
    options.allowUnsafeEmbed === undefined
      ? Root
      : registerProjectPolicy(Root, { allowUnsafeEmbed: options.allowUnsafeEmbed });
  const app = mount(target, definition, {}, { onError: (error) => errors.push(error) });
  return {
    window,
    target,
    app,
    root,
    binding,
    src,
    srcdoc,
    title,
    sandbox,
    width,
    height,
    aspectRatio,
    loading,
    referrerPolicy,
    name,
    onLoad,
    onError,
    errors,
  };
}

function currentFrame(target: Element): HTMLIFrameElement {
  const frame = target.querySelector("iframe");

  if (!frame) throw new Error("Expected one native iframe");

  return frame as unknown as HTMLIFrameElement;
}

function currentWrapper(target: Element): HTMLElement {
  const wrapper = target.querySelector("div");

  if (!wrapper) throw new Error("Expected the persistent Embed wrapper");

  return wrapper as unknown as HTMLElement;
}

test("a detached-document Embed publishes its native wrapper and still guards ordinary interfaces", async () => {
  const window = createWindow();

  installSandboxSupport(window);

  const document = window.document.implementation.createHTMLDocument();

  expect(document.defaultView).toBeNull();

  const target = document.body as unknown as HTMLElement;
  const errors: unknown[] = [];
  let wrapperBinding!: Binding<HTMLElement>;
  let interfaceBinding!: Binding<{ ping(): string }>;

  const Ordinary = defineComponent<{ bind: { ping(): string } }>((owner, props) => {
    createClient(owner).effect(() => {
      props.bind.set({ ping: () => "pong" });
    });

    return null;
  });
  const Root = defineComponent((owner) => {
    const client = createClient(owner);
    wrapperBinding = client.bind<HTMLElement>();
    interfaceBinding = client.bind<{ ping(): string }>();
    return [
      component(
        owner,
        Embed,
        {
          sandbox: "allow-scripts",
          width: 320,
          bind: wrapperBinding,
        } as unknown as CallerProps<EmbedProps>,
        "embed",
      ),
      component(owner, Ordinary, { bind: interfaceBinding }, "ordinary"),
    ];
  });
  const app = mount(target, Root, {}, { onError: (error) => errors.push(error) });

  await app.settled();

  const wrapper = wrapperBinding();
  const savedMethod = interfaceBinding().ping;
  const actualWrapper = document.querySelector("div");

  if (!actualWrapper) throw new Error("Expected the persistent Embed wrapper");

  expect(errors).toStrictEqual([]);

  expect(wrapper).toBe(actualWrapper as unknown as HTMLElement);

  expect(wrapper).toBeInstanceOf(window.HTMLElement);

  expect(wrapper.style.width).toBe("320px");

  const range = document.createRange();
  const rangeNode = wrapper as unknown as Parameters<typeof range.selectNode>[0];

  expect(() => range.selectNode(rangeNode)).not.toThrow();

  expect(savedMethod()).toBe("pong");

  app.dispose();

  expect(() => wrapperBinding()).toThrow("destroyed");

  expect(() => savedMethod()).toThrow("destroyed");
});

test("root registration is same-identity, idempotent, and rejects conflicts", () => {
  const Root = defineComponent(() => null);

  expect(registerProjectPolicy(Root, { allowUnsafeEmbed: true })).toBe(Root);

  expect(registerProjectPolicy(Root, { allowUnsafeEmbed: true })).toBe(Root);

  expect(() => registerProjectPolicy(Root, { allowUnsafeEmbed: false })).toThrow(
    "conflicting project policies",
  );

  expect(() =>
    registerProjectPolicy(Root, { allowUnsafeEmbed: "true" as unknown as boolean }),
  ).toThrow("allowUnsafeEmbed must be a boolean");
});

test("missing policy is strict, allow-scripts stays opaque, and sandbox tokens normalize case", () => {
  const harness = createHarness({ sandbox: "  ALLOW-SCRIPTS\tallow-scripts " });

  expect(harness.errors).toStrictEqual([]);

  const frame = currentFrame(harness.target);

  expect(frame.getAttribute("sandbox")).toBe("allow-scripts");

  const binding = harness.binding();

  expect(binding.contains(frame)).toBe(true);

  expect(harness.binding()).toBe(binding);

  harness.app.dispose();
});

test("separate roots keep separate project policies and nested registrations cannot elevate", () => {
  const window = createWindow();

  installSandboxSupport(window);

  const allowedTarget = window.document.createElement("main");
  const strictTarget = window.document.createElement("main");

  window.document.body.append(allowedTarget, strictTarget);

  const allowed = createHarness({
    window,
    target: allowedTarget as unknown as HTMLElement,
    allowUnsafeEmbed: true,
    sandbox: "allow-same-origin",
  });

  expect(allowed.errors).toStrictEqual([]);

  expect(currentFrame(allowedTarget as unknown as Element).getAttribute("sandbox")).toBe(
    "allow-same-origin",
  );

  const strict = createHarness({
    window,
    target: strictTarget as unknown as HTMLElement,
    sandbox: "ALLOW-SAME-ORIGIN",
    src: "https://embed.test/frame",
  });

  expect(strict.errors).toHaveLength(1);

  expect(strict.errors[0]).toBeInstanceOf(RenderFault);

  expect((strict.errors[0] as RenderFault).kind).toBe("embed-permission");

  expect(strictTarget.querySelector("iframe")).toBeNull();

  const nestedTarget = window.document.createElement("main");

  window.document.body.appendChild(nestedTarget);

  const nestedErrors: unknown[] = [];
  const Elevated = registerProjectPolicy(
    defineComponent((owner) =>
      component(
        owner,
        Embed,
        { sandbox: "allow-same-origin", src: "https://embed.test/nested" },
        "embed",
      ),
    ),
    { allowUnsafeEmbed: true },
  );
  const Root = defineComponent((owner) => component(owner, Elevated, {}, "elevated"));
  const nested = mount(
    nestedTarget as unknown as HTMLElement,
    Root,
    {},
    {
      onError: (error) => nestedErrors.push(error),
    },
  );

  expect(nestedErrors).toHaveLength(1);

  expect((nestedErrors[0] as RenderFault).kind).toBe("embed-permission");

  expect(nestedTarget.querySelector("iframe")).toBeNull();

  allowed.app.dispose();

  strict.app.dispose();

  nested.dispose();
});

test("bootstrap installs the compiled shell policy before the shell body runs", async () => {
  const window = createWindow();

  installSandboxSupport(window);

  window.happyDOM.setURL("https://example.test/");

  installHistoryCloneAdapter(window as unknown as globalThis.Window);

  // Happy DOM inserts before removing in Document.replaceChild; start empty so
  // its single-document-element guard does not reject the shell replacement.
  window.document.removeChild(window.document.documentElement);

  const Page = defineComponent(() => null);
  const Loading = defineComponent(() => null);
  const pageNode = {
    id: "/",
    pattern: "/",
    segments: [],
    files: {
      page: { filename: "routes/+page.tsx", load: async () => Page },
      loading: { filename: "routes/+loading.tsx", load: async () => Loading },
    },
    children: [],
  } as const;
  const routes: RouteTable = { version: 1, root: pageNode, routes: [pageNode] };
  const Shell = registerProjectPolicy(
    defineComponent<{ children: Rendered }>((owner, props) =>
      element(owner, "html", {}, [
        element(owner, "head", {}, [element(owner, "title", {}, ["Embed policy test"])]),
        element(owner, "body", {}, [
          component(
            owner,
            Embed,
            { sandbox: "allow-same-origin" } as unknown as CallerProps<EmbedProps>,
            "embed",
          ),
          props.children(),
        ]),
      ]),
    ),
    { allowUnsafeEmbed: true },
  );
  const app = await bootstrapApplication(window as unknown as globalThis.Window, {
    configuration: () => ({}),
    shell: () => Shell,
    routes: () => routes,
  });
  const frame = currentFrame(window.document as unknown as Element);

  expect(frame.getAttribute("sandbox")).toBe("allow-same-origin");

  app.dispose();
});

test("unsupported or unauthorized sandbox tokens fault before either source is assigned", () => {
  const window = createWindow();

  installSandboxSupport(window);

  const spy = spyOnIframeOperations(window);
  const unauthorized = createHarness({
    window,
    sandbox: "allow-same-origin",
    src: "https://embed.test/strict",
    srcdoc: "<p>strict</p>",
  });

  expect((unauthorized.errors[0] as RenderFault).kind).toBe("embed-permission");

  expect(spy.operations).not.toContain("attribute:src");

  expect(spy.operations).not.toContain("attribute:srcdoc");

  const unsupportedTarget = window.document.createElement("main");

  window.document.body.appendChild(unsupportedTarget);

  const unsupportedErrors: unknown[] = [];
  const Unsupported = defineComponent((owner) =>
    component(
      owner,
      Embed,
      { sandbox: "allow-unrecognized", src: "https://embed.test/unsupported" },
      "embed",
    ),
  );
  const unsupportedRoot = registerProjectPolicy(Unsupported, { allowUnsafeEmbed: true });
  const unsupported = mount(
    unsupportedTarget as unknown as HTMLElement,
    unsupportedRoot,
    {},
    {
      onError: (error) => unsupportedErrors.push(error),
    },
  );

  expect((unsupportedErrors[0] as RenderFault).kind).toBe("embed-sandbox-token");

  expect(spy.operations).not.toContain("attribute:src");

  expect(spy.operations).not.toContain("attribute:srcdoc");

  expect(unsupportedTarget.querySelector("iframe")).toBeNull();

  spy.restore();

  unauthorized.app.dispose();

  unsupported.dispose();
});

test("missing sandbox token support produces a typed fault instead of a native TypeError", () => {
  const window = createWindow();

  Object.defineProperty(window.HTMLIFrameElement.prototype, "sandbox", {
    configurable: true,
    get: () => undefined,
  });

  const target = window.document.createElement("main");

  window.document.body.appendChild(target);

  const errors: unknown[] = [];
  const Root = registerProjectPolicy(
    defineComponent((owner) =>
      component(
        owner,
        Embed,
        { sandbox: "allow-scripts", src: "https://embed.test/no-api" },
        "embed",
      ),
    ),
    { allowUnsafeEmbed: true },
  );
  const app = mount(
    target as unknown as HTMLElement,
    Root,
    {},
    {
      onError: (error) => errors.push(error),
    },
  );

  expect(errors[0]).toBeInstanceOf(RenderFault);

  expect((errors[0] as RenderFault).kind).toBe("embed-sandbox-token");

  app.dispose();
});

test("native iframe options and namespaced events are installed before both sources", async () => {
  const operationsWindow = createWindow();
  const spy = spyOnIframeOperations(operationsWindow);
  const callbackEvents: { type: string; target: EventTarget | null; receiver: unknown }[] = [];
  const harness = createHarness({
    window: operationsWindow,
    src: "https://embed.test/fallback",
    srcdoc: "<p>srcdoc</p>",
    title: "Embedded example",
    sandbox: "ALLOW-SCRIPTS",
    loading: "lazy",
    referrerPolicy: "no-referrer",
    name: "embedded-content",
    onLoad: [
      function (this: HTMLIFrameElement, event) {
        callbackEvents.push({ type: event.type, target: event.target, receiver: this });
      },
      { capture: true, once: true },
    ],
    onError: [
      function (this: HTMLIFrameElement, event) {
        event.preventDefault();

        callbackEvents.push({ type: event.type, target: event.target, receiver: this });
      },
      { passive: true },
    ],
  });
  const frame = currentFrame(harness.target);

  expect(frame.getAttribute("sandbox")).toBe("allow-scripts");

  expect(frame.getAttribute("title")).toBe("Embedded example");

  expect(frame.getAttribute("loading")).toBe("lazy");

  expect(frame.getAttribute("referrerpolicy")).toBe("no-referrer");

  expect(frame.getAttribute("name")).toBe("embedded-content");

  expect(frame.getAttribute("srcdoc")).toBe("<p>srcdoc</p>");

  expect(frame.getAttribute("src")).toBe("https://embed.test/fallback");

  expect(spy.operations).toStrictEqual([
    "attribute:sandbox",
    "attribute:title",
    "attribute:loading",
    "attribute:referrerpolicy",
    "attribute:name",
    "event:load",
    "event:error",
    "attribute:srcdoc",
    "attribute:src",
  ]);

  expect(spy.eventOptions).toStrictEqual([
    { type: "load", options: { capture: true, once: true } },
    { type: "error", options: { passive: true } },
  ]);

  frame.dispatchEvent(new operationsWindow.Event("load") as unknown as Event);

  frame.dispatchEvent(new operationsWindow.Event("load") as unknown as Event);

  const errorEvent = new operationsWindow.Event("error", { cancelable: true }) as unknown as Event;

  frame.dispatchEvent(errorEvent);

  expect(errorEvent.defaultPrevented).toBe(false);

  expect(callbackEvents).toStrictEqual([
    { type: "load", target: frame, receiver: frame },
    { type: "error", target: frame, receiver: frame },
  ]);

  let latestCalls = 0;

  harness.onError.set(() => latestCalls++);

  await harness.app.settled();

  frame.dispatchEvent(new operationsWindow.Event("error") as unknown as Event);

  expect(latestCalls).toBe(1);

  spy.restore();

  harness.app.dispose();
});

test("permission replacement and cache restore keep the wrapper binding and release each Blob URL once", async () => {
  const window = createWindow();

  installSandboxSupport(window);

  const created: string[] = [];
  const revoked: string[] = [];

  Object.defineProperty(window.URL, "createObjectURL", {
    configurable: true,
    value: () => {
      const url = `blob:embed-${created.length + 1}`;

      created.push(url);

      return url;
    },
  });

  Object.defineProperty(window.URL, "revokeObjectURL", {
    configurable: true,
    value: (url: string) => revoked.push(url),
  });

  const firstBlob = new window.Blob(["first"]) as unknown as Blob;
  const harness = createHarness({
    window,
    allowUnsafeEmbed: true,
    src: firstBlob,
    sandbox: "allow-scripts",
    width: 640,
  });
  const binding = harness.binding();
  const wrapper = currentWrapper(harness.target);
  const firstFrame = currentFrame(harness.target);

  expect(firstFrame.getAttribute("sandbox")).toBe("allow-scripts");

  expect(created).toStrictEqual(["blob:embed-1"]);

  expect(binding).toBe(wrapper);

  const HTMLElementConstructor = harness.target.ownerDocument.defaultView?.HTMLElement;

  expect(HTMLElementConstructor && binding instanceof HTMLElementConstructor).toBe(true);

  expect(wrapper.style.width).toBe("640px");

  expect(() => harness.target.ownerDocument.createRange().selectNode(binding)).not.toThrow();

  harness.sandbox.set("ALLOW-SAME-ORIGIN");

  await harness.app.settled();

  const secondFrame = currentFrame(harness.target);

  expect(secondFrame).not.toBe(firstFrame);

  expect(secondFrame.parentElement).toBe(wrapper);

  expect(wrapper.style.width).toBe("640px");

  expect(secondFrame.getAttribute("sandbox")).toBe("allow-same-origin");

  expect(secondFrame.getAttribute("src")).toBe("blob:embed-2");

  expect(created).toStrictEqual(["blob:embed-1", "blob:embed-2"]);

  expect(revoked).toStrictEqual(["blob:embed-1"]);

  expect(harness.binding()).toBe(binding);

  harness.root.suspend();

  expect(wrapper.querySelector("iframe")).toBeNull();

  expect(harness.binding()).toBe(binding);

  expect(revoked).toStrictEqual(["blob:embed-1", "blob:embed-2"]);

  harness.sandbox.set("ALLOW-SCRIPTS");

  harness.src.set(new window.Blob(["while suspended"]) as unknown as Blob);

  harness.root.resume();

  await harness.app.settled();

  const thirdFrame = currentFrame(harness.target);

  expect(thirdFrame).not.toBe(secondFrame);

  expect(thirdFrame.getAttribute("sandbox")).toBe("allow-scripts");

  expect(thirdFrame.getAttribute("src")).toBe("blob:embed-3");

  expect(harness.binding()).toBe(binding);

  expect(revoked).toStrictEqual(["blob:embed-1", "blob:embed-2"]);

  harness.app.dispose();

  expect(revoked).toStrictEqual(["blob:embed-1", "blob:embed-2", "blob:embed-3"]);

  expect(() => harness.binding()).toThrow("destroyed");
});

test("omitted sizing preserves native defaults while explicit dimensions size the wrapper", () => {
  const unsized = createHarness({ sandbox: undefined });
  const unsizedWrapper = currentWrapper(unsized.target);
  const unsizedFrame = currentFrame(unsized.target);

  expect(unsizedWrapper.style.width).toBe("");

  expect(unsizedWrapper.style.height).toBe("");

  expect(unsizedWrapper.style.getPropertyValue("aspect-ratio")).toBe("");

  expect(unsizedFrame.style.cssText).toBe("");

  const sized = createHarness({
    sandbox: "allow-scripts",
    width: 640,
    height: "360px",
    aspectRatio: "16 / 9",
  });
  const wrapper = currentWrapper(sized.target);
  const frame = currentFrame(sized.target);

  expect(wrapper.style.width).toBe("640px");

  expect(wrapper.style.height).toBe("360px");

  expect(wrapper.style.getPropertyValue("aspect-ratio")).toBe("16 / 9");

  expect(frame.style.width).toBe("100%");

  expect(frame.style.height).toBe("100%");

  expect(frame.style.display).toBe("block");

  unsized.app.dispose();

  sized.app.dispose();
});

test("a throwing suspension resource cannot prevent a later embed resource from stopping", () => {
  const window = createWindow();

  installSandboxSupport(window);

  const target = window.document.createElement("main");

  window.document.body.appendChild(target);

  const errors: unknown[] = [];
  let root!: Owner;
  const ThrowingResource = defineComponent((owner) => {
    registerOwnerResourceLifecycle(owner, {
      suspended() {
        throw new Error("cleanup failed");
      },

      resumed() {},
    });

    return null;
  });
  const App = defineComponent((owner) => {
    root = owner;
    return [
      component(owner, Embed, { sandbox: "allow-scripts", src: "about:blank" }, "embed"),
      component(owner, ThrowingResource, {}, "throwing-resource"),
    ];
  });
  const app = mount(
    target as unknown as HTMLElement,
    App,
    {},
    {
      onError: (error) => errors.push(error),
    },
  );
  const frame = currentFrame(target as unknown as Element);

  root.suspend();

  expect(errors).toHaveLength(1);

  expect((errors[0] as AggregateError).message).toContain("suspension failed");

  expect(frame.parentNode).toBeNull();

  app.dispose();
});
