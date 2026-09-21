import { afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { createFilesystemRouter } from "../../src/routing/filesystem.ts";
import { createRouteHost } from "../../src/routing/route-host.ts";
import type {
  RouteTable,
  RouteTableModule,
  RouteTableNode,
} from "../../src/tooling/route-table.ts";
import { defineComponent, type Component } from "../../src/runtime/components.ts";
import { createRuntimeRoot, element, text } from "../../src/runtime/dom.ts";
import { installHistoryCloneAdapter } from "./history-platform.ts";

const windows: Window[] = [];

afterEach(() => {
  for (const window of windows.splice(0)) window.close();
});

function routeModule(name: string, definition: Component<unknown>): RouteTableModule {
  return { filename: name, load: async () => definition };
}

function node(
  id: string,
  pattern: string,
  segments: RouteTableNode["segments"],
  files: RouteTableNode["files"],
  children: readonly RouteTableNode[] = [],
): RouteTableNode {
  return { id, pattern, segments, files, children };
}

test("filesystem boundaries follow declaration ancestry and skip a failed layout's descendants", async () => {
  const window = new Window({ url: "https://example.test/" });
  windows.push(window);
  installHistoryCloneAdapter(window as unknown as globalThis.Window);
  const runtime = createRuntimeRoot(window.document.body as unknown as Element, {
    development: false,
  });
  runtime.owner.commit();
  const events: string[] = [];
  const errorProps = { props: { error: { kind: "value" as const, optional: false } } };
  const outerError = defineComponent<{ error: unknown }>(
    (owner, props) =>
      element(owner, "p", { id: "outer-error" }, [text(owner, () => String(props.error()))]),
    errorProps,
  );
  const innerError = defineComponent<{ error: unknown }>(() => {
    events.push("inner-error");
    throw new Error("error view failed");
  }, errorProps);
  const failingLayout = defineComponent(() => {
    events.push("layout");
    throw new Error("layout failed");
  });
  const page = defineComponent(() => {
    events.push("page");
    return "page";
  });
  const root = node("root", "", [], {
    error: routeModule("+error.tsx", outerError as Component<unknown>),
  });
  const child = node("child", "/child", [{ kind: "static", value: "child" }], {
    layout: routeModule("+layout.tsx", failingLayout as Component<unknown>),
    error: routeModule("+error.tsx", innerError as Component<unknown>),
    page: routeModule("+page.tsx", page as Component<unknown>),
  });
  const table: RouteTable = {
    version: 1,
    root: { ...root, children: [child] },
    routes: [child],
  };
  const host = createRouteHost(runtime, window.document.body as unknown as Node);
  const router = createFilesystemRouter(
    window as unknown as globalThis.Window,
    runtime,
    host,
    table,
    {
      pageCacheSize: 0,
    },
  );

  await router.navigate("/child", { history: "replace" });
  await runtime.context.scheduler.settled();

  expect(window.document.querySelector("#outer-error")?.textContent).toBe(
    "Error: error view failed",
  );
  expect(events.filter((event) => event === "layout")).toHaveLength(2);
  expect(events.filter((event) => event === "inner-error")).toHaveLength(2);
  expect(events).not.toContain("page");
  router.dispose();
  host.dispose();
});

test("filesystem pages get an empty async boundary when no loading module exists", async () => {
  const window = new Window({ url: "https://example.test/" });
  windows.push(window);
  installHistoryCloneAdapter(window as unknown as globalThis.Window);
  const runtime = createRuntimeRoot(window.document.body as unknown as Element, {
    development: false,
  });
  runtime.owner.commit();
  const page = defineComponent(async (owner) => {
    await Promise.resolve();
    return element(owner, "main", { id: "async-page" }, [text(owner, () => "ready")]);
  });
  const leaf = node("root", "/", [], { page: routeModule("+page.tsx", page) });
  const table: RouteTable = { version: 1, root: leaf, routes: [leaf] };
  const host = createRouteHost(runtime, window.document.body as unknown as Node);
  const router = createFilesystemRouter(
    window as unknown as globalThis.Window,
    runtime,
    host,
    table,
    { pageCacheSize: 0 },
  );

  await router.navigate("/", { history: "replace" });
  await runtime.context.scheduler.settled();

  expect(window.document.querySelector("#async-page")?.textContent).toBe("ready");
  router.dispose();
  host.dispose();
});
