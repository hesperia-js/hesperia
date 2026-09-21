import { afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { createClient } from "../../src/client.ts";
import { createRouteHost, type RouteHostModule } from "../../src/routing/route-host.ts";
import { createQueryParams } from "../../src/routing/query.ts";
import {
  child,
  createRuntimeRoot,
  element,
  text,
  type Rendered,
  type RuntimeRoot,
} from "../../src/runtime/dom.ts";
import {
  defineComponent,
  type Component,
  type ComponentProps,
} from "../../src/runtime/components.ts";
import { createBinding } from "../../src/runtime/binding.ts";
import type { RouteInputs } from "../../src/routing/navigation.ts";

const windows: Window[] = [];

afterEach(() => {
  for (const window of windows.splice(0)) window.close();
});

function browser(): { window: globalThis.Window; runtime: RuntimeRoot; events: string[] } {
  const window = new Window({ url: "https://example.test/" });
  windows.push(window);
  const target = window.document.body as unknown as Element;
  const runtime = createRuntimeRoot(target, { development: false });
  runtime.owner.commit();
  return { window: window as unknown as globalThis.Window, runtime, events: [] };
}

type LayoutProps = { children: Rendered };
type PageProps = { label: string; query: () => string | null };

function definitions(events: string[]) {
  const Frame = defineComponent<LayoutProps>(
    (owner, props) => {
      const client = createClient(owner);
      const count = client.state(0);
      events.push("body:frame");
      client.effect(() => {
        props.children();
        events.push("effect:frame");
      });
      client.cleanup(() => {
        events.push("cleanup:frame");
      });
      return element(owner, "section", { id: "frame" }, [
        element(
          owner,
          "button",
          { id: "count", "on:click": () => count.update((value) => value + 1) },
          [text(owner, count)],
        ),
        child(owner, props.children),
      ]);
    },
    { props: { children: { kind: "value", optional: false } } },
  );
  const Nested = defineComponent<LayoutProps>(
    (owner, props) => {
      events.push("body:nested");
      clientEffect(owner, props, events, "nested");
      return element(owner, "article", { id: "nested" }, [child(owner, props.children)]);
    },
    { props: { children: { kind: "value", optional: false } } },
  );
  const Page = defineComponent<PageProps>(
    (owner, props) => {
      events.push(`body:${props.label()}`);
      const node = element(owner, "main", { id: "page" }, [
        text(owner, () => props.label()),
        text(owner, () => `:${props.query() ?? "none"}`),
      ]);
      createClient(owner).effect(() => {
        events.push(`effect:${props.label()}:${node.isConnected}`);
      });
      createClient(owner).cleanup(() => {
        events.push(`cleanup:${props.label()}:${node.isConnected}`);
      });
      return node;
    },
    {
      props: {
        label: { kind: "value", optional: false },
        query: { kind: "callback", optional: false },
      },
    },
  );
  return { Frame, Nested, Page };
}

function moduleOf<P>(
  definition: Component<P>,
  node: object,
  props?: RouteHostModule["props"],
): RouteHostModule {
  return { definition: definition as Component<unknown>, node, props };
}

function routeInputs(
  label: string,
  search: string,
): {
  inputs: RouteInputs;
  query: ReturnType<typeof createQueryParams>;
  controller: AbortController;
} {
  const controller = new AbortController();
  const query = createQueryParams(search, controller.signal);
  return {
    query,
    controller,
    inputs: { params: { label }, queryParams: query.read, signal: controller.signal },
  };
}

function clientEffect(
  owner: import("../../src/runtime/owner.ts").Owner,
  props: ComponentProps<LayoutProps>,
  events: string[],
  label: string,
): void {
  createClient(owner).effect(() => {
    props.children();
    events.push(`effect:${label}`);
  });
  createClient(owner).cleanup(() => events.push(`cleanup:${label}`));
}

test("stages a fresh page, retains common layout owners, and publishes a live query accessor", async () => {
  const { window, runtime, events } = browser();
  const { Frame, Nested, Page } = definitions(events);
  const frameNode = {};
  const nestedNode = {};
  const pageNode = {};
  const host = createRouteHost(runtime, window.document.body);
  const first = routeInputs("/nested/one", "?tab=one");
  const firstPrepared = host.prepare({
    layouts: [
      moduleOf(Frame as Component<unknown>, frameNode),
      moduleOf(Nested as Component<unknown>, nestedNode),
    ],
    page: moduleOf(Page as Component<unknown>, pageNode, (inputs) => ({
      label: inputs.params.label,
      query: () => inputs.queryParams().get("tab"),
    })),
    inputs: first.inputs,
  });
  firstPrepared.install();
  await runtime.context.scheduler.settled();
  const frame = window.document.querySelector("#frame");
  const nested = window.document.querySelector("#nested");
  const page = window.document.querySelector("#page");
  expect(window.document.body.textContent).toContain("/nested/one:one");
  window.document.querySelector<HTMLButtonElement>("#count")!.click();
  expect(window.document.querySelector("#count")!.textContent).toBe("1");

  const second = routeInputs("/nested/two", "?tab=two");
  const secondPrepared = host.prepare({
    layouts: [
      moduleOf(Frame as Component<unknown>, frameNode),
      moduleOf(Nested as Component<unknown>, nestedNode),
    ],
    page: moduleOf(Page as Component<unknown>, pageNode, (inputs) => ({
      label: inputs.params.label,
      query: () => inputs.queryParams().get("tab"),
    })),
    inputs: second.inputs,
  });
  expect(window.document.querySelector("#page")).toBe(page);
  secondPrepared.install();
  await runtime.context.scheduler.settled();
  expect(window.document.querySelector("#frame")).toBe(frame);
  expect(window.document.querySelector("#nested")).toBe(nested);
  expect(window.document.querySelector("#page")).not.toBe(page);
  expect(window.document.querySelector("#count")!.textContent).toBe("1");
  expect(window.document.body.textContent).toContain("/nested/two:two");

  second.query.update("?tab=latest");
  await runtime.context.scheduler.settled();
  expect(window.document.body.textContent).toContain("/nested/two:latest");
  expect(events.filter((event) => event === "body:frame")).toHaveLength(1);
  expect(events.filter((event) => event === "body:nested")).toHaveLength(1);
  expect(events).toContain("cleanup:/nested/one:true");
  host.dispose();
});

test("a canceled staged candidate disposes only its suffix and reports retained departure roots", async () => {
  const { window, runtime, events } = browser();
  const { Frame, Nested, Page } = definitions(events);
  const frameNode = {};
  const nestedNode = {};
  const pageNode = {};
  const host = createRouteHost(runtime, window.document.body);
  const first = routeInputs("/nested/one", "");
  const route = (inputs: RouteInputs, nested: boolean, label: string) => ({
    layouts: [
      moduleOf(Frame as Component<unknown>, frameNode),
      ...(nested ? [moduleOf(Nested as Component<unknown>, nestedNode)] : []),
    ],
    page: moduleOf(Page as Component<unknown>, pageNode, (current) => ({
      label,
      query: () => current.queryParams().get("tab"),
    })),
    inputs,
  });
  const current = host.prepare(route(first.inputs, true, "/nested/one"));
  current.install();
  await runtime.context.scheduler.settled();
  const departingNested = host.departingOwners(route(first.inputs, false, "/outside").layouts);
  expect(departingNested).toHaveLength(1);
  expect(departingNested[0]!.identity).toBe("route-layout:1");
  expect(host.departingOwners(route(first.inputs, true, "/nested/two").layouts)).toHaveLength(1);

  const next = routeInputs("/nested/slow", "");
  const staged = host.prepare(route(next.inputs, true, "/nested/slow"));
  const stagedPage = staged.owners.at(-1)!;
  expect(stagedPage.state).toBe("building");
  next.controller.abort(new Error("superseded"));
  expect(stagedPage.state).toBe("destroyed");
  expect(window.document.body.textContent).toContain("/nested/one");
  expect(events).not.toContain("effect:/nested/slow:false");
  const afterCancellation = events.slice();
  expect(() => host.prepare(route(next.inputs, true, "/nested/slow"))).toThrow("superseded");
  expect(events).toStrictEqual(afterCancellation);
  host.dispose();
});

test("disposing the host releases its outlet and makes reuse fail without disposing the runtime root", () => {
  const { window, runtime, events } = browser();
  const { Page } = definitions(events);
  const host = createRouteHost(runtime, window.document.body);
  const input = routeInputs("/only", "");
  const prepared = host.prepare({
    layouts: [],
    page: moduleOf(Page as Component<unknown>, {}, (current) => ({
      label: current.params.label,
      query: () => current.queryParams().get("tab"),
    })),
    inputs: input.inputs,
  });
  prepared.install();
  expect(window.document.querySelector("#page")).not.toBeNull();
  const staged = host.prepare({
    layouts: [],
    page: moduleOf(Page as Component<unknown>, {}, () => ({ label: "staged", query: () => null })),
    inputs: routeInputs("staged", "").inputs,
  });
  host.dispose(new Error("unmount"));
  expect(window.document.body.childNodes).toHaveLength(0);
  expect(staged.owners.every((owner) => owner.state === "destroyed")).toBe(true);
  expect(() => staged.install()).toThrow(/disposed/u);
  expect(runtime.owner.state).toBe("mounted");
  expect(() =>
    host.prepare({
      layouts: [],
      page: moduleOf(Page as Component<unknown>, {}),
      inputs: input.inputs,
    }),
  ).toThrow(/disposed/u);
});

test("retained layouts use the new candidate's props snapshot and reject bad mappings before commit", () => {
  const { window, runtime, events } = browser();
  const { Page } = definitions(events);
  const node = {};
  const reads: string[] = [];
  const Frame = defineComponent<{ children: Rendered; title: string }>(
    (owner, props) =>
      element(owner, "section", {}, [
        element(owner, "h1", {}, [text(owner, props.title)]),
        child(owner, props.children),
      ]),
    {
      props: {
        children: { kind: "value", optional: false },
        title: { kind: "value", optional: false },
      },
    },
  );
  const host = createRouteHost(runtime, window.document.body);
  const route = (title: string) => ({
    layouts: [
      moduleOf(Frame as Component<unknown>, node, () => {
        reads.push(title);
        if (title === "bad") throw new Error("bad mapping");
        return { title };
      }),
    ],
    page: moduleOf(Page as Component<unknown>, {}, () => ({ label: title, query: () => null })),
    inputs: routeInputs(title, "").inputs,
  });
  const first = host.prepare(route("one"));
  first.install();
  const frame = window.document.querySelector("section");
  const second = host.prepare(route("two"));
  expect(reads).toStrictEqual(["one", "two"]);
  expect(window.document.querySelector("h1")?.textContent).toBe("one");
  second.install();
  expect(reads).toStrictEqual(["one", "two"]);
  expect(window.document.querySelector("h1")?.textContent).toBe("two");
  expect(window.document.querySelector("section")).toBe(frame);
  const page = window.document.querySelector("#page");
  expect(() => host.prepare(route("bad"))).toThrow("bad mapping");
  expect(window.document.querySelector("#page")).toBe(page);
  expect(events).not.toContain("body:bad");
  host.dispose();
});

test("a damaged retained layout is replaced after cleanup from one captured prop snapshot", () => {
  const { window, runtime, events } = browser();
  let bodyProps!: ComponentProps<{ children: Rendered; title: string }>;
  let mapperReads = 0;
  const Layout = defineComponent<{ children: Rendered; title: string }>(
    (owner, props) => {
      bodyProps = props;
      const title = props.title();
      events.push(`body:${title}`);
      createClient(owner).cleanup(() => events.push(`cleanup:${title}`));
      return element(owner, "section", { id: "recover-layout" }, [
        text(owner, props.title),
        child(owner, props.children),
      ]);
    },
    {
      props: {
        children: { kind: "value", optional: false },
        title: { kind: "value", optional: false },
      },
    },
  );
  const host = createRouteHost(runtime, window.document.body);
  const layoutNode = {};
  const pageNode = {};
  const Page = definitions(events).Page;
  const route = (title: string) => ({
    layouts: [
      moduleOf(Layout as Component<unknown>, layoutNode, () => {
        mapperReads++;
        return { title };
      }),
    ],
    page: moduleOf(Page as Component<unknown>, pageNode, (inputs) => ({
      label: inputs.params.label,
      query: () => null,
    })),
    inputs: routeInputs(title, "").inputs,
  });

  const first = host.prepare(route("one"));
  first.install();
  const oldNode = window.document.querySelector("#recover-layout");
  Object.defineProperty(bodyProps, "title", {
    configurable: true,
    get() {
      throw new Error("damaged props getter must not run");
    },
  });
  const beforeRecovery = events.slice();
  for (let attempt = 0; attempt < 3; attempt++) {
    const canceled = host.prepare(route("two"));
    canceled.dispose(new Error("canceled recovery"));
  }
  const second = host.prepare(route("two"));
  expect(events).toStrictEqual(beforeRecovery);
  expect(mapperReads).toBe(5);
  expect(window.document.querySelector("#recover-layout")).toBe(oldNode);
  second.install();
  expect(events.indexOf("cleanup:one")).toBeLessThan(events.indexOf("body:two"));
  expect(window.document.querySelector("#recover-layout")).not.toBe(oldNode);
  expect(window.document.body.textContent).toContain("two");
  host.dispose();
});

test("late retained-prop invalidation refuses install before changing the active route", () => {
  const { window, runtime, events } = browser();
  const propsSnapshots: ComponentProps<{ children: Rendered; title: string }>[] = [];
  const Layout = defineComponent<{ children: Rendered; title: string }>(
    (owner, props) => {
      propsSnapshots.push(props);
      const title = props.title();
      createClient(owner).cleanup(() => events.push(`cleanup:late:${title}`));
      return element(owner, "section", { id: "late-layout" }, [
        text(owner, props.title),
        child(owner, props.children),
      ]);
    },
    {
      props: {
        children: { kind: "value", optional: false },
        title: { kind: "value", optional: false },
      },
    },
  );
  const Page = defineComponent((owner) => element(owner, "main", { id: "late-page" }));
  const host = createRouteHost(runtime, window.document.body);
  const layoutNode = {};
  const pageNode = {};
  const route = (title: string) => ({
    layouts: [moduleOf(Layout as Component<unknown>, layoutNode, () => ({ title }))],
    page: moduleOf(Page as Component<unknown>, pageNode),
    inputs: routeInputs(title, "").inputs,
  });
  host.prepare(route("one")).install();
  const oldNode = window.document.querySelector("#late-layout");
  const late = host.prepare(route("two"));
  Object.defineProperty(propsSnapshots[0]!, "title", {
    configurable: true,
    get() {
      throw new Error("late damaged getter must not run");
    },
  });
  expect(() => late.install()).toThrow("captured props snapshot");
  expect(window.document.querySelector("#late-layout")).toBe(oldNode);
  expect(events).not.toContain("cleanup:late:one");
  host.dispose();
});

test("late retained children accessor corruption refuses install before changing the active route", () => {
  const { window, runtime, events } = browser();
  let bodyProps!: ComponentProps<{ children: Rendered; title: string }>;
  const Layout = defineComponent<{ children: Rendered; title: string }>(
    (owner, props) => {
      bodyProps = props;
      return element(owner, "section", { id: "children-damaged-layout" }, [
        text(owner, props.title),
        child(owner, props.children),
      ]);
    },
    {
      props: {
        children: { kind: "value", optional: false },
        title: { kind: "value", optional: false },
      },
    },
  );
  const host = createRouteHost(runtime, window.document.body);
  const layoutNode = {};
  const pageNode = {};
  const Page = definitions(events).Page;
  const route = (title: string) => ({
    layouts: [moduleOf(Layout as Component<unknown>, layoutNode, () => ({ title }))],
    page: moduleOf(Page as Component<unknown>, pageNode, (inputs) => ({
      label: inputs.params.label,
      query: () => null,
    })),
    inputs: routeInputs(title, "").inputs,
  });

  host.prepare(route("one")).install();
  const oldLayout = window.document.querySelector("#children-damaged-layout");
  const candidate = host.prepare(route("two"));
  expect(Reflect.deleteProperty(bodyProps, "children")).toBe(true);
  expect(() => candidate.install()).toThrow("captured props snapshot");
  expect(window.document.querySelector("#children-damaged-layout")).toBe(oldLayout);
  expect(window.document.body.textContent).toContain("one");
  host.dispose();
});

test("a failed deferred recovery tears down staged owners without running staged effects", async () => {
  const { window, runtime, events } = browser();
  let bodyProps!: ComponentProps<{ children: Rendered; title: string }>;
  const Layout = defineComponent<{ children: Rendered; title: string }>(
    (owner, props) => {
      bodyProps = props;
      const title = props.title();
      events.push(`body:failure:${title}`);
      createClient(owner).effect(() => {
        events.push(`effect:failure:${title}`);
      });
      createClient(owner).cleanup(() => {
        events.push(`cleanup:failure:${title}`);
      });
      if (title === "boom") throw new Error("recovery body failed");
      return element(owner, "section", { id: "failure-layout" }, [child(owner, props.children)]);
    },
    {
      props: {
        children: { kind: "value", optional: false },
        title: { kind: "value", optional: false },
      },
    },
  );
  const Page = defineComponent((owner) => element(owner, "main", { id: "failure-page" }));
  const host = createRouteHost(runtime, window.document.body);
  const layoutNode = {};
  const pageNode = {};
  const route = (title: string) => ({
    layouts: [moduleOf(Layout as Component<unknown>, layoutNode, () => ({ title }))],
    page: moduleOf(Page as Component<unknown>, pageNode),
    inputs: routeInputs(title, "").inputs,
  });
  host.prepare(route("one")).install();
  await runtime.context.scheduler.settled();
  Object.defineProperty(bodyProps, "title", {
    configurable: true,
    get() {
      throw new Error("failed recovery damaged getter must not run");
    },
  });
  const failed = host.prepare(route("boom"));
  expect(() => failed.install()).toThrow("recovery body failed");
  expect(window.document.querySelector("#failure-layout")).toBeNull();
  expect(events.indexOf("cleanup:failure:one")).toBeLessThan(events.indexOf("body:failure:boom"));
  expect(events).not.toContain("effect:failure:boom");
  host.dispose();
});

test("optional retained callback presence changes recreate the layout from its captured snapshot", () => {
  const { window, runtime, events } = browser();
  let bodies = 0;
  const Layout = defineComponent<{ children: Rendered; onDone?: () => void }>(
    (owner, props) => {
      const generation = ++bodies;
      const onDone: unknown = props.onDone;
      events.push(`body:optional:${generation}:${onDone === undefined ? "absent" : "present"}`);
      createClient(owner).cleanup(() => events.push(`cleanup:optional:${generation}`));
      return element(owner, "section", { id: "optional-layout" }, [child(owner, props.children)]);
    },
    {
      props: {
        children: { kind: "value", optional: false },
        onDone: { kind: "callback", optional: true },
      },
    },
  );
  const Page = defineComponent((owner) => element(owner, "main", { id: "optional-page" }));
  const host = createRouteHost(runtime, window.document.body);
  const layoutNode = {};
  const pageNode = {};
  const route = (present: boolean) => ({
    layouts: [
      moduleOf(Layout as Component<unknown>, layoutNode, () =>
        present ? { onDone: () => undefined } : {},
      ),
    ],
    page: moduleOf(Page as Component<unknown>, pageNode),
    inputs: routeInputs(present ? "present" : "absent", "").inputs,
  });

  host.prepare(route(false)).install();
  host.prepare(route(true)).install();
  host.prepare(route(false)).install();
  expect(events).toStrictEqual([
    "body:optional:1:absent",
    "cleanup:optional:1",
    "body:optional:2:present",
    "cleanup:optional:2",
    "body:optional:3:absent",
  ]);
  host.dispose();
});

test("ancestor commit cannot activate staged candidates and an intervening commit invalidates their handles", async () => {
  const { window, runtime, events } = browser();
  const { Page } = definitions(events);
  const host = createRouteHost(runtime, window.document.body);
  const prepare = (label: string) =>
    host.prepare({
      layouts: [],
      page: moduleOf(Page as Component<unknown>, {}, () => ({ label, query: () => null })),
      inputs: routeInputs(label, "").inputs,
    });
  const older = prepare("older");
  runtime.owner.commit();
  await runtime.context.scheduler.settled();
  expect(events.filter((event) => event.startsWith("effect:"))).toStrictEqual([]);
  const newer = prepare("newer");
  newer.install();
  await runtime.context.scheduler.settled();
  expect(events.filter((event) => event.startsWith("effect:"))).toStrictEqual([
    "effect:newer:true",
  ]);
  newer.dispose();
  expect(() => older.install()).toThrow(/no longer current/);
  older.dispose();
  host.dispose();
});

test("parks an outgoing page with its owner identity and restores it without rerunning the body", async () => {
  const { window, runtime, events } = browser();
  const { Page } = definitions(events);
  const host = createRouteHost(runtime, window.document.body);
  const route = (label: string) => ({
    layouts: [],
    page: moduleOf(Page as Component<unknown>, {}, (inputs) => ({
      label,
      query: () => inputs.queryParams().get("tab"),
    })),
    inputs: routeInputs(label, "").inputs,
  });
  const first = host.prepare(route("one"));
  first.install();
  await runtime.context.scheduler.settled();
  const pageNode = window.document.querySelector("#page");
  const bodies = events.filter((event) => event === "body:one").length;

  const second = host.prepare(route("two"));
  second.install({ preserving: new Set(first.owners) });
  await runtime.context.scheduler.settled();
  expect(first.owners.at(-1)!.state).toBe("suspended");
  expect(window.document.querySelector("#page")).not.toBe(pageNode);

  second.park?.();
  first.restore?.();
  await runtime.context.scheduler.settled();
  expect(first.owners.at(-1)!.state).toBe("mounted");
  expect(window.document.querySelector("#page")).toBe(pageNode);
  expect(events.filter((event) => event === "body:one")).toHaveLength(bodies);
  expect(events.filter((event) => event.startsWith("effect:one:"))).toStrictEqual([
    "effect:one:true",
    "effect:one:true",
  ]);
  host.dispose();
});

test("restores retained bindings and effects only after the native target is connected", async () => {
  const { window, runtime, events } = browser();
  const Bound = defineComponent((owner) => {
    const binding = createBinding<HTMLElement>(owner, false);
    const node = element(owner, "main", { id: "bound", bind: binding });
    createClient(owner).effect(() => {
      events.push(`bound:${binding() === node && node.isConnected}`);
    });
    return node;
  });
  const Page = definitions(events).Page;
  const host = createRouteHost(runtime, window.document.body);
  const input = (label: string): RouteInputs => routeInputs(label, "").inputs;
  const first = host.prepare({
    layouts: [],
    page: moduleOf(Bound as Component<unknown>, {}, () => ({ label: "bound" })),
    inputs: input("bound"),
  });
  first.install();
  await runtime.context.scheduler.settled();
  const second = host.prepare({
    layouts: [],
    page: moduleOf(Page as Component<unknown>, {}, (current) => ({
      label: "other",
      query: () => current.queryParams().get("tab"),
    })),
    inputs: input("other"),
  });
  second.install({ preserving: new Set(first.owners) });
  await runtime.context.scheduler.settled();
  second.park?.();
  first.restore?.();
  await runtime.context.scheduler.settled();
  expect(events.filter((event) => event.startsWith("bound:"))).toStrictEqual([
    "bound:true",
    "bound:true",
  ]);
  host.dispose();
});

test("restores a retained layout binding only after its parked native range is connected", async () => {
  const { window, runtime, events } = browser();
  const Layout = defineComponent<LayoutProps>(
    (owner, props) => {
      const binding = createBinding<HTMLElement>(owner, false);
      const node = element(owner, "section", { id: "bound-layout", bind: binding }, [
        child(owner, props.children),
      ]);
      createClient(owner).effect(() => {
        events.push(`layout-bound:${binding() === node && node.isConnected}`);
      });
      return node;
    },
    { props: { children: { kind: "value", optional: false } } },
  );
  const Page = definitions(events).Page;
  const host = createRouteHost(runtime, window.document.body);
  const input = (label: string): RouteInputs => routeInputs(label, "").inputs;
  const first = host.prepare({
    layouts: [moduleOf(Layout, {})],
    page: moduleOf(Page as Component<unknown>, {}, () => ({ label: "first", query: () => null })),
    inputs: input("first"),
  });
  first.install();
  await runtime.context.scheduler.settled();
  const second = host.prepare({
    layouts: [],
    page: moduleOf(Page as Component<unknown>, {}, () => ({ label: "second", query: () => null })),
    inputs: input("second"),
  });
  second.install({ preserving: new Set() });
  await runtime.context.scheduler.settled();
  second.park?.();
  first.restore?.();
  await runtime.context.scheduler.settled();
  expect(events.filter((event) => event.startsWith("layout-bound:"))).toStrictEqual([
    "layout-bound:true",
    "layout-bound:true",
  ]);
  host.dispose();
});

test("retained pages survive replacement of their former shared layout", async () => {
  const { window, runtime, events } = browser();
  const { Frame, Nested, Page } = definitions(events);
  const frameNode = {};
  const nestedNode = {};
  const pageNode = {};
  const host = createRouteHost(runtime, window.document.body);
  const route = (label: string, layout: "frame" | "nested") => ({
    layouts: [
      moduleOf(layout === "frame" ? Frame : Nested, layout === "frame" ? frameNode : nestedNode),
    ],
    page: moduleOf(Page as Component<unknown>, pageNode, (inputs) => ({
      label,
      query: () => inputs.queryParams().get("tab"),
    })),
    inputs: routeInputs(label, "").inputs,
  });
  const first = host.prepare(route("one", "frame"));
  first.install();
  await runtime.context.scheduler.settled();
  const firstPage = window.document.querySelector("#page");
  const second = host.prepare(route("two", "frame"));
  second.install({ preserving: new Set([first.owners[0]!]) });
  await runtime.context.scheduler.settled();
  second.park?.();
  const third = host.prepare(route("three", "nested"));
  third.install({ preserving: new Set() });
  await runtime.context.scheduler.settled();
  first.restore?.();
  await runtime.context.scheduler.settled();
  expect(window.document.querySelector("#page")).toBe(firstPage);
  expect(events.filter((event) => event === "body:one")).toHaveLength(1);
  expect(events.filter((event) => event === "body:frame")).toHaveLength(1);
  expect(events.filter((event) => event === "effect:two:true")).toHaveLength(1);
  host.dispose();
});

test("a layout error boundary owns descendant page preparation and fallback effects", async () => {
  const { window, runtime, events } = browser();
  const fallback = defineComponent<{ error: unknown }>(
    (owner, props) => {
      events.push("body:error");
      createClient(owner).effect(() => void events.push("effect:error"));
      return element(owner, "p", { id: "route-error" }, [text(owner, () => String(props.error()))]);
    },
    { props: { error: { kind: "value", optional: false } } },
  );
  const layout = defineComponent<LayoutProps>(
    (owner, props) =>
      element(owner, "section", { id: "boundary-layout" }, [child(owner, props.children)]),
    { props: { children: { kind: "value", optional: false } } },
  );
  const page = defineComponent((_owner) => {
    events.push("body:page-fails");
    throw new Error("page failed");
  });
  const controller = new AbortController();
  const query = createQueryParams("", controller.signal);
  const host = createRouteHost(runtime, window.document.body);
  host
    .prepare({
      layouts: [
        {
          node: {},
          definition: layout as Component<unknown>,
          error: fallback as Component<unknown>,
        },
      ],
      page: { node: {}, definition: page as Component<unknown> },
      inputs: { params: {}, queryParams: query.read, signal: controller.signal },
    })
    .install();
  await runtime.context.scheduler.settled();
  expect(window.document.querySelector("#route-error")?.textContent).toBe("Error: page failed");
  expect(events).toContain("body:error");
  expect(events).toContain("effect:error");
  host.dispose();
});

test("a failing nearest route error view bubbles to the enclosing boundary", () => {
  const { window, runtime } = browser();
  const outerError = defineComponent<{ error: unknown }>(
    (owner, props) =>
      element(owner, "p", { id: "outer-route-error" }, [text(owner, () => String(props.error()))]),
    { props: { error: { kind: "value", optional: false } } },
  );
  const brokenError = defineComponent<{ error: unknown }>(
    () => {
      throw new Error("error view failed");
    },
    { props: { error: { kind: "value", optional: false } } },
  );
  const layout = defineComponent<LayoutProps>(
    (owner, props) => element(owner, "section", {}, [child(owner, props.children)]),
    { props: { children: { kind: "value", optional: false } } },
  );
  const page = defineComponent(() => {
    throw new Error("page failed");
  });
  const controller = new AbortController();
  const query = createQueryParams("", controller.signal);
  const host = createRouteHost(runtime, window.document.body);
  host
    .prepare({
      layouts: [
        {
          node: {},
          definition: layout as Component<unknown>,
          error: outerError as Component<unknown>,
        },
        {
          node: {},
          definition: layout as Component<unknown>,
          error: brokenError as Component<unknown>,
        },
      ],
      page: { node: {}, definition: page as Component<unknown> },
      inputs: { params: {}, queryParams: query.read, signal: controller.signal },
    })
    .install();
  expect(window.document.querySelector("#outer-route-error")?.textContent).toBe(
    "Error: error view failed",
  );
  host.dispose();
});

test("a failing layout body prevents the descendant page body from executing", () => {
  const { window, runtime } = browser();
  let pageBodies = 0;
  const layout = defineComponent(
    (_owner, _props) => {
      throw new Error("layout failed");
    },
    { props: { children: { kind: "value", optional: false } } },
  );
  const page = defineComponent((_owner) => {
    pageBodies++;
    return "page";
  });
  const controller = new AbortController();
  const query = createQueryParams("", controller.signal);
  const host = createRouteHost(runtime, window.document.body);
  expect(() =>
    host.prepare({
      layouts: [{ node: {}, definition: layout as Component<unknown> }],
      page: { node: {}, definition: page as Component<unknown> },
      inputs: { params: {}, queryParams: query.read, signal: controller.signal },
    }),
  ).toThrow("layout failed");
  expect(pageBodies).toBe(0);
  host.dispose();
});

test("an applicable loading module supplies an implicit async route boundary", async () => {
  const { window, runtime } = browser();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let ready!: () => void;
  const pageReady = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const loading = defineComponent((_owner) => "wait");
  const page = defineComponent(
    async (owner) => {
      await gate;
      ready();
      return element(owner, "main", { id: "route-ready" }, ["ready"]);
    },
    { async: true },
  );
  const controller = new AbortController();
  const query = createQueryParams("", controller.signal);
  const host = createRouteHost(runtime, window.document.body);
  host
    .prepare({
      layouts: [],
      page: {
        node: {},
        definition: page as Component<unknown>,
        loading: loading as Component<unknown>,
      },
      inputs: { params: {}, queryParams: query.read, signal: controller.signal },
    })
    .install();
  await runtime.context.scheduler.settled();
  expect(window.document.body.textContent).toContain("wait");
  release();
  await pageReady;
  await Promise.resolve();
  await Promise.resolve();
  await runtime.context.scheduler.settled();
  expect(window.document.querySelector("#route-ready")?.textContent).toBe("ready");
  host.dispose();
});
