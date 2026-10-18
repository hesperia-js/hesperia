import { afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { createClient } from "../../packages/hesperia/src/client.ts";
import { createFilesystemRouter } from "../../packages/hesperia/src/routing/filesystem.ts";
import { installHistoryTracking } from "../../packages/hesperia/src/routing/history.ts";
import { createRouteHost } from "../../packages/hesperia/src/routing/route-host.ts";
import { reserveNavigation } from "../../packages/hesperia/src/routing/navigation-api.ts";
import type {
  RouteTable,
  RouteTableModule,
  RouteTableNode,
} from "../../packages/hesperia/src/routing/route-table.ts";
import { defineComponent, type Component } from "../../packages/hesperia/src/runtime/components.ts";
import {
  child,
  createRuntimeRoot,
  element,
  type Rendered,
} from "../../packages/hesperia/src/runtime/dom.ts";
import {
  createInternalStyleRuntime,
  type CompiledStylePlan,
  type StyleCompositionId,
  type StyleEntryId,
  type StyleId,
  type StyleOwnerId,
} from "../../packages/hesperia/src/runtime/style.ts";
import { installHistoryCloneAdapter } from "./history-platform.ts";

const windows: Window[] = [];

afterEach(() => {
  for (const window of windows.splice(0)) window.close();
});

const ids = {
  styles: {
    shell: "route-shell" as StyleId,
    layout: "route-layout" as StyleId,
    loading: "route-loading" as StyleId,
    page: "route-page" as StyleId,
    notFound: "route-not-found" as StyleId,
    error: "route-error" as StyleId,
    independent: "route-independent" as StyleId,
  },
  owners: {
    shell: "route-shell-owner" as StyleOwnerId,
    layout: "route-layout-owner" as StyleOwnerId,
    loading: "route-loading-owner" as StyleOwnerId,
    page: "route-page-owner" as StyleOwnerId,
    notFound: "route-not-found-owner" as StyleOwnerId,
    error: "route-error-owner" as StyleOwnerId,
    independent: "route-independent-owner" as StyleOwnerId,
  },
  entries: {
    shell: "route-shell-entry" as StyleEntryId,
    loading: "route-loading-entry" as StyleEntryId,
    page: "route-page-entry" as StyleEntryId,
    notFound: "route-not-found-entry" as StyleEntryId,
    error: "route-error-entry" as StyleEntryId,
    independent: "route-independent-entry" as StyleEntryId,
  },
  compositions: {
    loading: "route-loading-composition" as StyleCompositionId,
    page: "route-page-composition" as StyleCompositionId,
    notFound: "route-not-found-composition" as StyleCompositionId,
    error: "route-error-composition" as StyleCompositionId,
    independent: "route-independent-composition" as StyleCompositionId,
  },
};

function stylePlan(): CompiledStylePlan {
  const { styles, entries, compositions } = ids;
  const vectors = [
    { entryId: entries.shell, styles: [styles.shell] },
    { entryId: entries.loading, styles: [styles.shell, styles.layout, styles.loading] },
    { entryId: entries.page, styles: [styles.shell, styles.layout, styles.page] },
    { entryId: entries.notFound, styles: [styles.shell, styles.layout, styles.notFound] },
    { entryId: entries.error, styles: [styles.shell, styles.layout, styles.error] },
    { entryId: entries.independent, styles: [styles.independent] },
  ];
  return {
    assets: Object.entries(styles).map(([name, id]) => ({
      id,
      revision: "r1",
      href: `/css/${name}.css`,
    })),
    owners: Object.entries(ids.owners).map(([name, ownerId]) => ({
      ownerId,
      styles: [styles[name as keyof typeof styles]],
    })),
    entries: vectors.map(({ entryId, styles: closure }) => ({ entryId, closure })),
    compositions: [
      {
        compositionId: compositions.loading,
        entries: [entries.loading],
        styles: vectors[1]!.styles,
      },
      { compositionId: compositions.page, entries: [entries.page], styles: vectors[2]!.styles },
      {
        compositionId: compositions.notFound,
        entries: [entries.notFound],
        styles: vectors[3]!.styles,
      },
      { compositionId: compositions.error, entries: [entries.error], styles: vectors[4]!.styles },
      {
        compositionId: compositions.independent,
        entries: [entries.independent],
        styles: vectors[5]!.styles,
      },
    ],
  };
}

function module(filename: string, definition: Component<unknown>): RouteTableModule {
  return { filename, load: async () => definition };
}

function makeNode(
  id: string,
  pattern: string,
  segments: RouteTableNode["segments"],
  files: RouteTableNode["files"],
  children: readonly RouteTableNode[] = [],
  viewStyles?: RouteTableNode["viewStyles"],
): RouteTableNode {
  return { id, pattern, segments, files, children, ...(viewStyles ? { viewStyles } : {}) };
}

function links(document: Window["document"]): HTMLLinkElement[] {
  return Array.from(
    document.head.querySelectorAll("link[data-hesperia-style-id]"),
  ) as unknown as HTMLLinkElement[];
}

function ready(link: HTMLLinkElement, window: Window): void {
  const sheet = new window.CSSStyleSheet();

  Object.defineProperty(sheet, "media", {
    configurable: true,
    value: { mediaText: link.media || "not all" },
  });

  Object.defineProperty(link, "sheet", { configurable: true, value: sheet });

  link.dispatchEvent(new window.Event("load") as unknown as Event);
}

function enabled(document: Window["document"], styleId: StyleId): boolean {
  return links(document).some((link) => {
    const sheet = link.sheet as unknown as { media: { mediaText: string } } | null;
    return (
      link.getAttribute("data-hesperia-style-id") === styleId && sheet?.media.mediaText === "all"
    );
  });
}

function enabledInHead(head: Window["document"]["head"], styleId: StyleId): boolean {
  return Array.from(head.querySelectorAll("link[data-hesperia-style-id]")).some((link) => {
    const sheet = (link as unknown as HTMLLinkElement).sheet as unknown as {
      media: { mediaText: string };
    } | null;
    return (
      link.getAttribute("data-hesperia-style-id") === styleId && sheet?.media.mediaText === "all"
    );
  });
}

function settleUnselectedStyles(window: Window, document: Window["document"]): void {
  for (const link of links(document)) {
    if (link.sheet !== null) continue;

    if (link.getAttribute("data-hesperia-style-id") === ids.styles.error)
      link.dispatchEvent(new window.Event("error") as unknown as Event);
    else ready(link, window);
  }
}

async function until(predicate: () => boolean): Promise<void> {
  for (let turn = 0; turn < 500; turn++) {
    if (predicate()) return;

    await Promise.resolve();
  }

  throw new Error("The route CSS fixture did not reach its expected lifecycle state");
}

test("route loading and page styles switch before effects, preserving shell and layout CSS", async () => {
  const window = new Window({
    url: "https://example.test/slow",
    settings: {
      fetch: {
        interceptor: {
          beforeAsyncRequest: () => new Promise<never>(() => undefined),
        },
      },
    },
  });

  windows.push(window);

  installHistoryCloneAdapter(window as unknown as globalThis.Window);

  const faults: unknown[] = [];
  const runtime = createRuntimeRoot(window.document.body as unknown as Element, {
    development: false,
    onError: (error) => faults.push(error),
  });
  const styleRuntime = createInternalStyleRuntime(stylePlan());

  styleRuntime.bindStyles(runtime.owner, ids.owners.shell);

  runtime.owner.commit();

  const events: string[] = [];
  const gate = Promise.withResolvers<void>();
  let pageBodyStarted = false;
  let pageBodiesStarted = 0;

  const Layout = defineComponent<{ children: Rendered }>(
    (owner, props) => {
      styleRuntime.bindStyles(owner, ids.owners.layout);

      createClient(owner).effect(() => {
        events.push(`layout:${enabled(window.document, ids.styles.layout)}`);
      });

      return element(owner, "section", { id: "route-layout" }, [child(owner, props.children)]);
    },
    { props: { children: { kind: "value", optional: false } } },
  );
  const Loading = defineComponent((owner) => {
    styleRuntime.bindStyles(owner, ids.owners.loading);

    createClient(owner).effect(() => {
      events.push(
        `loading:${enabled(window.document, ids.styles.shell)}:${enabled(window.document, ids.styles.layout)}:${enabled(window.document, ids.styles.loading)}:${enabled(window.document, ids.styles.page)}`,
      );
    });

    return element(owner, "p", { id: "route-loading" }, ["Loading"]);
  });
  const Page = defineComponent(async (owner) => {
    styleRuntime.bindStyles(owner, ids.owners.page);

    pageBodiesStarted++;
    pageBodyStarted = true;
    await gate.promise;

    createClient(owner).effect(() => {
      events.push(
        `page:${enabled(window.document, ids.styles.shell)}:${enabled(window.document, ids.styles.layout)}:${enabled(window.document, ids.styles.loading)}:${enabled(window.document, ids.styles.page)}`,
      );
    });

    return element(owner, "main", { id: "route-page" }, ["Page"]);
  });
  const pageFailure = new Error("page boom");
  const BrokenPage = defineComponent((owner) => {
    styleRuntime.bindStyles(owner, ids.owners.page);

    throw pageFailure;
  });
  const ErrorView = defineComponent<{ error: unknown }>(
    (owner, props) => {
      styleRuntime.bindStyles(owner, ids.owners.error);

      createClient(owner).effect(() => {
        events.push(`error:${enabled(window.document, ids.styles.error)}`);
      });

      return element(owner, "p", { id: "route-error" }, [String(props.error())]);
    },
    { props: { error: { kind: "value", optional: false } } },
  );
  const root = makeNode("root", "", [], {
    layout: module("+layout.tsx", Layout as Component<unknown>),
    loading: module("+loading.tsx", Loading as Component<unknown>),
    error: module("+error.tsx", ErrorView as Component<unknown>),
  });
  const leaf = makeNode(
    "slow",
    "/slow",
    [{ kind: "static", value: "slow" }],
    { page: module("+page.tsx", Page as Component<unknown>) },
    [],
    {
      page: {
        destination: ids.compositions.page,
        loading: ids.compositions.loading,
        errors: [{ boundaryNodeId: "root", compositionId: ids.compositions.error }],
      },
    },
  );
  const brokenLeaf = makeNode(
    "broken",
    "/broken",
    [{ kind: "static", value: "broken" }],
    { page: module("+broken-page.tsx", BrokenPage as Component<unknown>) },
    [],
    leaf.viewStyles,
  );
  const laterLeaf = makeNode(
    "later",
    "/later",
    [{ kind: "static", value: "later" }],
    { page: module("+later-page.tsx", Page as Component<unknown>) },
    [],
    leaf.viewStyles,
  );
  const table: RouteTable = {
    version: 1,
    root: { ...root, children: [leaf, laterLeaf, brokenLeaf] },
    routes: [leaf, laterLeaf, brokenLeaf],
  };
  const host = createRouteHost(runtime, window.document.body as unknown as Node);
  const router = createFilesystemRouter(
    window as unknown as globalThis.Window,
    runtime,
    host,
    table,
    { pageCacheSize: 0 },
    styleRuntime,
  );

  const abandonedNavigation = router.navigate("/slow", { history: "replace" });

  void abandonedNavigation.catch((error) => faults.push(error));

  await until(() => links(window.document).length > 0);

  settleUnselectedStyles(window, window.document);

  await until(() => events.some((event) => event.startsWith("loading:")));

  expect(faults).toEqual([]);

  expect(events).toContain("loading:true:true:true:false");

  expect(window.document.querySelector("#route-loading")?.textContent).toBe("Loading");

  expect(enabled(window.document, ids.styles.independent)).toBe(false);

  await until(() =>
    links(window.document).some(
      (link) => link.getAttribute("data-hesperia-style-id") === ids.styles.page,
    ),
  );

  expect(pageBodyStarted).toBe(false);

  expect(window.document.querySelector("#route-loading")).not.toBeNull();

  expect(
    links(window.document).some(
      (link) => link.getAttribute("data-hesperia-style-id") === ids.styles.error,
    ),
  ).toBe(false);

  const navigation = router.navigate("/later", { history: "replace" });

  expect(await abandonedNavigation).toMatchObject({ status: "cancelled" });

  await until(() =>
    links(window.document).some(
      (link) =>
        link.getAttribute("data-hesperia-style-id") === ids.styles.page && link.sheet === null,
    ),
  );

  expect(pageBodyStarted).toBe(false);

  expect(window.document.querySelector("#route-loading")).not.toBeNull();

  settleUnselectedStyles(window, window.document);

  await until(() => pageBodyStarted);

  gate.resolve();

  expect(await navigation).toMatchObject({
    status: "committed",
    url: "https://example.test/later",
  });

  await runtime.context.scheduler.settled();

  expect(events).toContain("page:true:true:false:true");

  expect(window.document.querySelector("#route-page")?.textContent).toBe("Page");

  expect(enabled(window.document, ids.styles.shell)).toBe(true);

  expect(enabled(window.document, ids.styles.layout)).toBe(true);

  expect(enabled(window.document, ids.styles.loading)).toBe(false);

  expect(enabled(window.document, ids.styles.page)).toBe(true);

  const independentTarget = window.document.createElement("aside");

  window.document.body.appendChild(independentTarget);

  const independentRuntime = createRuntimeRoot(independentTarget as unknown as Element, {
    development: false,
  });

  styleRuntime.bindStyles(independentRuntime.owner, ids.owners.independent);

  const independentPreparation = styleRuntime.prepareInstalledHead(
    ids.compositions.independent,
    window.document.head as unknown as HTMLHeadElement,
  );

  await until(() =>
    links(window.document).some(
      (link) => link.getAttribute("data-hesperia-style-id") === ids.styles.independent,
    ),
  );

  settleUnselectedStyles(window, window.document);

  const independentLease = await independentPreparation;

  independentLease.activate(independentRuntime.owner);

  independentRuntime.owner.commit();

  expect(enabled(window.document, ids.styles.independent)).toBe(true);

  const oldHead = window.document.head;
  const replacementHead = window.document.createElement("head");

  window.document.documentElement.replaceChild(replacementHead, oldHead);

  independentRuntime.owner.dispose();

  independentLease.release();

  const priorLoadingEvents = events.filter((event) => event.startsWith("loading:")).length;
  const priorPageBodies = pageBodiesStarted;
  const replacementNavigation = router.navigate("/slow", { history: "push" });

  await until(() => links(window.document).some((link) => link.sheet === null));

  settleUnselectedStyles(window, window.document);

  await until(
    () => events.filter((event) => event.startsWith("loading:")).length > priorLoadingEvents,
  );

  await until(() =>
    links(window.document).some(
      (link) =>
        link.getAttribute("data-hesperia-style-id") === ids.styles.page && link.sheet === null,
    ),
  );

  expect(pageBodiesStarted).toBe(priorPageBodies);

  expect(window.document.querySelector("#route-loading")).not.toBeNull();

  settleUnselectedStyles(window, window.document);

  expect(await replacementNavigation).toMatchObject({
    status: "committed",
    url: "https://example.test/slow",
  });

  await runtime.context.scheduler.settled();

  expect(enabledInHead(replacementHead, ids.styles.page)).toBe(true);

  expect(oldHead.querySelectorAll("link[data-hesperia-style-id]")).toHaveLength(0);

  expect(pageBodiesStarted).toBe(priorPageBodies + 1);

  const history = installHistoryTracking(window as unknown as globalThis.Window);
  const reservation = reserveNavigation(window as unknown as globalThis.Window);

  reservation.setHistoryTracker(history);

  reservation.attachRouter(router, { settled: () => runtime.context.scheduler.settled() });

  await reservation.beginInitialNavigation(Promise.resolve());

  const brokenNavigation = reservation.facade.navigate("/broken");
  const finishedFailure = brokenNavigation.finished.then(
    () => ({ ok: true as const }),
    (error: unknown) => ({ ok: false as const, error }),
  );

  const settleRouteStyles = () => {
    for (const link of links(window.document)) {
      if (link.sheet === null) ready(link, window);
    }
  };

  const routeStyleLoader = new window.MutationObserver(settleRouteStyles);

  routeStyleLoader.observe(window.document.head, { childList: true });

  settleRouteStyles();

  await until(() =>
    links(window.document).some(
      (link) => link.getAttribute("data-hesperia-style-id") === ids.styles.error,
    ),
  );

  routeStyleLoader.disconnect();

  const brokenEntry = await brokenNavigation.committed;

  expect(brokenEntry.url).toBe("https://example.test/broken");

  expect(await finishedFailure).toStrictEqual({ ok: false, error: pageFailure });

  await until(() => events.includes("error:true"));

  expect(window.document.querySelector("#route-error")?.textContent).toContain("page boom");

  expect(enabled(window.document, ids.styles.error)).toBe(true);

  expect(enabled(window.document, ids.styles.page)).toBe(false);

  reservation.release();

  router.dispose();

  host.dispose();

  runtime.owner.dispose();
});

test("filesystem route styles use the runtime document when the navigation window differs", async () => {
  const window = new Window({ url: "https://example.test/" });
  const runtimeWindow = new Window({ url: "https://runtime.test/" });

  windows.push(window, runtimeWindow);

  installHistoryCloneAdapter(window as unknown as globalThis.Window);

  const runtime = createRuntimeRoot(runtimeWindow.document.body as unknown as Element, {
    development: false,
  });
  const styleRuntime = createInternalStyleRuntime(stylePlan());

  styleRuntime.bindStyles(runtime.owner, ids.owners.shell);

  runtime.owner.commit();

  const page = defineComponent((owner) => {
    styleRuntime.bindStyles(owner, ids.owners.page);

    return "Page";
  });
  const leaf = makeNode(
    "docs",
    "/docs",
    [{ kind: "static", value: "docs" }],
    { page: module("+page.tsx", page) },
    [],
    {
      page: {
        destination: ids.compositions.page,
        loading: ids.compositions.loading,
        errors: [],
      },
    },
  );
  const root = makeNode("root", "/", [], {}, [leaf]);
  const table: RouteTable = { version: 1, root, routes: [leaf] };
  const host = createRouteHost(runtime, runtimeWindow.document.body as unknown as Node);
  const router = createFilesystemRouter(
    window as unknown as globalThis.Window,
    runtime,
    host,
    table,
    { pageCacheSize: 0 },
    styleRuntime,
  );

  try {
    let navigationFinished = false;
    const navigation = router.navigate("/docs", { history: "replace" });

    void navigation.then(
      () => {
        navigationFinished = true;
      },
      () => {
        navigationFinished = true;
      },
    );

    await until(() => {
      for (const link of links(window.document)) if (link.sheet === null) ready(link, window);

      for (const link of links(runtimeWindow.document))
        if (link.sheet === null) ready(link, runtimeWindow);

      return navigationFinished;
    });

    await navigation;

    await runtime.context.scheduler.settled();

    expect(enabledInHead(runtimeWindow.document.head, ids.styles.page)).toBe(true);

    expect(enabledInHead(window.document.head, ids.styles.page)).toBe(false);
  } finally {
    router.dispose();

    host.dispose();

    runtime.owner.dispose();
  }
});

test("a pending destination stylesheet leaves loading visible without requiring unused error CSS", async () => {
  const window = new Window({
    url: "https://example.test/slow",
    settings: {
      fetch: {
        interceptor: {
          beforeAsyncRequest: () => new Promise<never>(() => undefined),
        },
      },
    },
  });

  windows.push(window);

  installHistoryCloneAdapter(window as unknown as globalThis.Window);

  const faults: unknown[] = [];
  const runtime = createRuntimeRoot(window.document.body as unknown as Element, {
    development: false,
    onError: (error) => faults.push(error),
  });
  const styleRuntime = createInternalStyleRuntime(stylePlan());

  styleRuntime.bindStyles(runtime.owner, ids.owners.shell);

  runtime.owner.commit();

  let pageBodies = 0;
  const effects: boolean[] = [];
  const Layout = defineComponent<{ children: Rendered }>(
    (owner, props) => {
      styleRuntime.bindStyles(owner, ids.owners.layout);

      return element(owner, "section", { id: "delayed-layout" }, [child(owner, props.children)]);
    },
    { props: { children: { kind: "value", optional: false } } },
  );
  const Loading = defineComponent((owner) => {
    styleRuntime.bindStyles(owner, ids.owners.loading);

    return element(owner, "p", { id: "delayed-loading" }, ["Loading"]);
  });
  const Page = defineComponent((owner) => {
    styleRuntime.bindStyles(owner, ids.owners.page);

    pageBodies++;

    createClient(owner).effect(() => {
      effects.push(enabled(window.document, ids.styles.page));
    });

    return element(owner, "main", { id: "delayed-page" }, ["Page"]);
  });
  const ErrorView = defineComponent<{ error: unknown }>(
    (owner, props) => {
      styleRuntime.bindStyles(owner, ids.owners.error);

      return element(owner, "p", { id: "unused-error" }, [String(props.error())]);
    },
    { props: { error: { kind: "value", optional: false } } },
  );
  const root = makeNode("root", "", [], {
    layout: module("+layout.tsx", Layout as Component<unknown>),
    loading: module("+loading.tsx", Loading as Component<unknown>),
    error: module("+error.tsx", ErrorView as Component<unknown>),
  });
  const page = makeNode(
    "slow",
    "/slow",
    [{ kind: "static", value: "slow" }],
    { page: module("+page.tsx", Page as Component<unknown>) },
    [],
    {
      page: {
        destination: ids.compositions.page,
        loading: ids.compositions.loading,
        errors: [{ boundaryNodeId: "root", compositionId: ids.compositions.error }],
      },
    },
  );
  const table: RouteTable = {
    version: 1,
    root: { ...root, children: [page] },
    routes: [page],
  };
  const host = createRouteHost(runtime, window.document.body as unknown as Node);
  const router = createFilesystemRouter(
    window as unknown as globalThis.Window,
    runtime,
    host,
    table,
    { pageCacheSize: 0 },
    styleRuntime,
  );
  let failedUnusedErrorCss = false;
  const failedErrorLinks = new WeakSet<HTMLLinkElement>();
  const errorCssFailure = new window.MutationObserver(() => {
    for (const link of links(window.document)) {
      if (
        link.getAttribute("data-hesperia-style-id") === ids.styles.error &&
        link.sheet === null &&
        !failedErrorLinks.has(link)
      ) {
        failedErrorLinks.add(link);

        failedUnusedErrorCss = true;

        link.dispatchEvent(new window.Event("error") as unknown as Event);
      }
    }
  });

  errorCssFailure.observe(window.document.head, { childList: true });

  const navigation = router.navigate("/slow", { history: "replace" });

  await until(() => links(window.document).some((link) => link.sheet === null));

  for (const link of links(window.document)) {
    if (link.sheet !== null) continue;

    if (link.getAttribute("data-hesperia-style-id") === ids.styles.page) continue;

    if (link.getAttribute("data-hesperia-style-id") === ids.styles.error) {
      failedErrorLinks.add(link);

      failedUnusedErrorCss = true;

      link.dispatchEvent(new window.Event("error") as unknown as Event);
    } else ready(link, window);
  }

  await until(
    () =>
      window.document.querySelector("#delayed-loading") !== null &&
      links(window.document).some(
        (link) =>
          link.getAttribute("data-hesperia-style-id") === ids.styles.page && link.sheet === null,
      ),
  );

  for (const link of links(window.document)) {
    if (link.sheet !== null) continue;

    if (link.getAttribute("data-hesperia-style-id") === ids.styles.page) continue;

    if (link.getAttribute("data-hesperia-style-id") === ids.styles.error) {
      failedErrorLinks.add(link);

      failedUnusedErrorCss = true;

      link.dispatchEvent(new window.Event("error") as unknown as Event);
    } else ready(link, window);
  }

  expect(pageBodies).toBe(0);

  expect(window.document.querySelector("#delayed-loading")?.textContent).toBe("Loading");

  expect(faults).toEqual([]);

  const destinationStylesheet = links(window.document).find(
    (link) => link.getAttribute("data-hesperia-style-id") === ids.styles.page,
  )!;

  ready(destinationStylesheet, window);

  expect(await navigation).toMatchObject({ status: "committed", url: "https://example.test/slow" });

  await runtime.context.scheduler.settled();

  expect(pageBodies).toBe(1);

  expect(effects).toEqual([true]);

  expect(window.document.querySelector("#delayed-loading")).toBeNull();

  expect(window.document.querySelector("#delayed-page")?.textContent).toBe("Page");

  expect(enabled(window.document, ids.styles.page)).toBe(true);

  expect(enabled(window.document, ids.styles.error)).toBe(false);

  expect(faults).toEqual([]);

  expect(failedUnusedErrorCss).toBe(false);

  errorCssFailure.disconnect();

  router.dispose();

  host.dispose();

  runtime.owner.dispose();
});

test("page and not-found views on one route node select separate CSS compositions", async () => {
  const window = new Window({
    url: "https://example.test/docs",
    settings: {
      fetch: {
        interceptor: {
          beforeAsyncRequest: () => new Promise<never>(() => undefined),
        },
      },
    },
  });

  windows.push(window);

  installHistoryCloneAdapter(window as unknown as globalThis.Window);

  const runtime = createRuntimeRoot(window.document.body as unknown as Element, {
    development: false,
  });
  const styleRuntime = createInternalStyleRuntime(stylePlan());

  styleRuntime.bindStyles(runtime.owner, ids.owners.shell);

  runtime.owner.commit();

  const effects: string[] = [];
  const Layout = defineComponent<{ children: Rendered }>(
    (owner, props) => {
      styleRuntime.bindStyles(owner, ids.owners.layout);

      return element(owner, "section", {}, [child(owner, props.children)]);
    },
    { props: { children: { kind: "value", optional: false } } },
  );
  const Loading = defineComponent((owner) => {
    styleRuntime.bindStyles(owner, ids.owners.loading);

    return element(owner, "p", { id: "mode-loading" }, ["Loading"]);
  });
  const Page = defineComponent((owner) => {
    styleRuntime.bindStyles(owner, ids.owners.page);

    createClient(owner).effect(() => {
      effects.push(`page:${enabled(window.document, ids.styles.page)}`);
    });

    return element(owner, "main", { id: "mode-page" }, ["Page"]);
  });
  const NotFound = defineComponent((owner) => {
    styleRuntime.bindStyles(owner, ids.owners.notFound);

    createClient(owner).effect(() => {
      effects.push(`not-found:${enabled(window.document, ids.styles.notFound)}`);
    });

    return element(owner, "main", { id: "mode-not-found" }, ["Not found"]);
  });
  const root = makeNode("root", "", [], {
    layout: module("+layout.tsx", Layout as Component<unknown>),
    loading: module("+loading.tsx", Loading as Component<unknown>),
  });
  const docs = makeNode(
    "docs",
    "/docs",
    [{ kind: "static", value: "docs" }],
    {
      page: module("+page.tsx", Page as Component<unknown>),
      notFound: module("+not-found.tsx", NotFound as Component<unknown>),
    },
    [],
    {
      page: {
        destination: ids.compositions.page,
        loading: ids.compositions.loading,
        errors: [],
      },
      notFound: {
        destination: ids.compositions.notFound,
        loading: ids.compositions.loading,
        errors: [],
      },
    },
  );
  const table: RouteTable = {
    version: 1,
    root: { ...root, children: [docs] },
    routes: [docs],
  };
  const host = createRouteHost(runtime, window.document.body as unknown as Node);
  const router = createFilesystemRouter(
    window as unknown as globalThis.Window,
    runtime,
    host,
    table,
    { pageCacheSize: 0 },
    styleRuntime,
  );

  const navigateAndReady = async (path: string, destinationStyle: StyleId): Promise<void> => {
    const navigation = router.navigate(path, { history: "push" });

    await until(() => links(window.document).some((link) => link.sheet === null));

    for (const link of links(window.document)) {
      if (link.sheet !== null) continue;

      if (link.getAttribute("data-hesperia-style-id") !== destinationStyle) ready(link, window);
    }

    await until(() =>
      links(window.document).some(
        (link) =>
          link.getAttribute("data-hesperia-style-id") === destinationStyle && link.sheet === null,
      ),
    );

    for (const link of links(window.document)) {
      if (link.sheet !== null) continue;

      if (link.getAttribute("data-hesperia-style-id") !== destinationStyle) ready(link, window);
    }

    const selected = links(window.document).find(
      (link) => link.getAttribute("data-hesperia-style-id") === destinationStyle,
    )!;

    ready(selected, window);

    expect(await navigation).toMatchObject({ status: "committed" });

    await runtime.context.scheduler.settled();
  };

  await navigateAndReady("/docs", ids.styles.page);

  expect(window.document.querySelector("#mode-page")?.textContent).toBe("Page");

  expect(enabled(window.document, ids.styles.page)).toBe(true);

  expect(enabled(window.document, ids.styles.notFound)).toBe(false);

  expect(effects).toContain("page:true");

  await navigateAndReady("/docs/missing", ids.styles.notFound);

  expect(window.document.querySelector("#mode-not-found")?.textContent).toBe("Not found");

  expect(enabled(window.document, ids.styles.page)).toBe(false);

  expect(enabled(window.document, ids.styles.notFound)).toBe(true);

  expect(effects).toContain("not-found:true");

  router.dispose();

  host.dispose();

  runtime.owner.dispose();
});
