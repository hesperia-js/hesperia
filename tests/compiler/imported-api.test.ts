import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { Window, type HTMLButtonElement as HappyDOMHTMLButtonElement } from "happy-dom";
import type { Component, Rendered } from "hesperia";
import type { RouteTable } from "hesperia/routing";
import { compile } from "../../packages/compiler/src/index.ts";
import { ProjectError } from "../../packages/tooling/src/project.ts";
import { buildInProjectProcess } from "../../packages/tooling/src/project-worker-client.ts";
import { mount } from "hesperia/runtime";
import { linkFrameworkPackages, unlinkFrameworkPackages } from "../tooling/fixture-dependencies.ts";
import { installHistoryCloneAdapter } from "../routing/history-platform.ts";

const fixtureDirectory = resolve(import.meta.dir, "../../.hesperia");

const importedApiFixtures = join(import.meta.dir, "fixtures/applications/imported-api");

async function writeFixture(name: string, source: string): Promise<string> {
  await mkdir(fixtureDirectory, { recursive: true });

  const filename = join(fixtureDirectory, `${name}-${randomUUID()}.ts`);

  await writeFile(filename, source);

  return filename;
}

async function importGenerated<T extends object>(code: string): Promise<T> {
  await mkdir(fixtureDirectory, { recursive: true });

  const filename = join(fixtureDirectory, `imported-api-${randomUUID()}.mjs`);

  await writeFile(filename, code);

  try {
    return await import(pathToFileURL(filename).href);
  } finally {
    await unlink(filename);
  }
}

test("direct imported values are preserved while component references bind through the owner", async () => {
  const result = await compile(
    `import api, { helper as named } from "./api";
import * as tools from "./tools";
export function App() {
  const user = api.users.get("ada");
  return <main>{user.value()}:{named()}:{tools.value}</main>;
}`,
    { filename: "imported-api.tsx" },
  );

  expect(result.diagnostics).toStrictEqual([]);

  expect(result.code).toContain('import api, { helper as named } from "./api";');

  expect(result.code).toContain('import * as tools from "./tools";');

  expect(result.code).toContain("_$.bindImported(owner, api)");

  expect(result.code).toContain("_$.bindImported(owner, named)");

  expect(result.code).toContain("_$.bindImported(owner, tools");
});

test("a compiled component consumes a public adapted API while ordinary namespace values stay live", async () => {
  const apiFile = await writeFixture(
    "api",
    await readFile(join(importedApiFixtures, "adapted-api.ts"), "utf8"),
  );

  const componentFile = join(fixtureDirectory, `component-${randomUUID()}.tsx`);

  await writeFile(
    componentFile,
    `import defaultApi, { api as namedApi, recordRender, registerQueryViews, registerTask } from "./${apiFile.split(/[\\/]/).pop()}";
import * as modules from "./${apiFile.split(/[\\/]/).pop()}";
import { client } from "hesperia";
import { queryOptions } from "hesperia/aeolia";
export default function App() {
  recordRender();
  const user = namedApi.user.get("ada");
  const listWithOptions = namedApi.list(
    queryOptions({ initial: "initial list", revalidateAfterMs: 5_000 }),
  );
  const listBare = namedApi.list();
  const optionLikeInput = { revalidateAfterMs: "preserved as query input" };
  const optionLikeImplicit = namedApi.optionLike(optionLikeInput);
  const optionLikeExplicit = namedApi.optionLike(optionLikeInput, { revalidateAfterMs: 5_000 });
  const optionalUndefined = namedApi.optionalInput(undefined);
  const overlapExplicit = namedApi.overlap({ initial: "overlap result" }, {});
  registerQueryViews({
    listWithOptions,
    listBare,
    optionLikeImplicit,
    optionLikeExplicit,
    optionalUndefined,
    overlapExplicit,
  });
  const save = defaultApi.save();
  const task = client.task(({ signal }) => async (name) => {
    const result = await user;
    const saved = await save.run(name, { abortSignal: signal });
    return result().name + ":" + saved.saved;
  });
  registerTask(task);
  return <section>
    <button>{modules.native.method()}:{new modules.Box("box").value}:{task.value() ?? "idle"}</button>
    <output id="list-with-options">{listWithOptions.value() ?? "pending"}</output>
    <output id="list-bare">{listBare.value() ?? "pending"}</output>
    <output id="option-like-implicit">{optionLikeImplicit.value() ?? "pending"}</output>
    <output id="option-like-explicit">{optionLikeExplicit.value() ?? "pending"}</output>
    <output id="optional-undefined">{optionalUndefined.value() ?? "pending"}</output>
    <output id="overlap-explicit">{overlapExplicit.value() ?? "pending"}</output>
  </section>;
}`,
  );

  const shimFile = await writeFixture(
    "runtime-shim",
    `export * from "hesperia/runtime";
export { registerDeparture } from "hesperia/routing";
`,
  );

  try {
    const ambiguousCallSource = 'api.overlap({ initial: "overlap result" })';

    const overlapSource = `import { api } from "./${apiFile.split(/[\\/]/).pop()}";
export function App() {
  const ambiguous = ${ambiguousCallSource};
  return <output>{ambiguous.value()}</output>;
}`;

    const overlapDiagnostic = await compile(overlapSource, {
      filename: join(fixtureDirectory, `ambiguous-query-${randomUUID()}.tsx`),
      runtimeModule: pathToFileURL(shimFile).href,
    });

    const callDiagnostics = overlapDiagnostic.diagnostics.filter(
      (diagnostic) => diagnostic.code === "HES-API-CALL",
    );

    expect(callDiagnostics).toHaveLength(1);

    expect(callDiagnostics[0]).toMatchObject({ severity: "error" });

    expect(callDiagnostics[0]?.message).toContain("both the operation input and its options");

    const expectedCallStart = overlapSource.indexOf(ambiguousCallSource);

    expect(expectedCallStart).toBeGreaterThanOrEqual(0);

    expect(callDiagnostics[0]?.span).toMatchObject({
      start: expectedCallStart,
      end: expectedCallStart + ambiguousCallSource.length,
    });

    const componentSource = await Bun.file(componentFile).text();

    const result = await compile(componentSource, {
      filename: componentFile,
      runtimeModule: pathToFileURL(shimFile).href,
    });

    expect(result.diagnostics).toStrictEqual([]);

    const module = await importGenerated<{ default: (props: object) => unknown }>(result.code);

    const apiModule = await import(pathToFileURL(apiFile).href);

    const window = new Window();

    try {
      const first = mount(window.document.body as unknown as Element, module.default as never, {});

      const button = window.document.querySelector("button") as unknown as HTMLButtonElement;

      await first.settled();

      expect(button.textContent).toBe("before:box:idle");

      expect(apiModule.currentLabel).toBe("before");

      const firstTask = apiModule.activeTasks[0];

      const firstRun = firstTask.run("Grace");

      expect(apiModule.queryResolvers).toHaveLength(1);

      const secondTarget = window.document.createElement("section");

      window.document.body.append(secondTarget);

      const second = mount(secondTarget as unknown as Element, module.default as never, {});

      await second.settled();

      const secondButton = secondTarget.querySelector("button") as unknown as HTMLButtonElement;

      const queryViewSets = apiModule.queryViewSets as {
        readonly listWithOptions: {
          readonly key: unknown;
          readonly ready: Promise<string>;

          revalidate(): Promise<void>;
        };
        readonly listBare: { readonly key: unknown; readonly ready: Promise<string> };
        readonly optionLikeImplicit: { readonly key: unknown; readonly ready: Promise<string> };
        readonly optionLikeExplicit: { readonly key: unknown; readonly ready: Promise<string> };
        readonly optionalUndefined: { readonly key: unknown; readonly ready: Promise<string> };
        readonly overlapExplicit: { readonly ready: Promise<string> };
      }[];

      const listResolvers = apiModule.listResolvers as ((value: string) => void)[];

      const optionLikeResolvers = apiModule.optionLikeResolvers as {
        readonly input: { readonly revalidateAfterMs: string };
        readonly resolve: (value: string) => void;
      }[];

      const secondTask = apiModule.activeTasks[1];

      const secondRun = secondTask.run("Grace");

      expect(apiModule.queryResolvers).toHaveLength(1);

      expect(queryViewSets).toHaveLength(2);

      const listRefresh = queryViewSets[0]!.listWithOptions.revalidate();

      expect(listResolvers).toHaveLength(1);

      for (const id of ["list-with-options", "list-bare"]) {
        expect(
          [...window.document.querySelectorAll(`#${id}`)].map((node) => node.textContent),
        ).toEqual(["initial list", "initial list"]);
      }

      const queryReadiness = queryViewSets.flatMap((views) => [
        views.listWithOptions.ready,
        views.listBare.ready,
        views.optionLikeImplicit.ready,
        views.optionLikeExplicit.ready,
        views.optionalUndefined.ready,
        views.overlapExplicit.ready,
      ]);

      expect(queryViewSets[0]?.listWithOptions.key).toBe(queryViewSets[0]?.listBare.key);

      expect(queryViewSets[0]?.optionLikeImplicit.key).toBe(
        queryViewSets[0]?.optionLikeExplicit.key,
      );

      expect(listResolvers).toHaveLength(1);

      expect(optionLikeResolvers).toHaveLength(1);

      expect(optionLikeResolvers[0]?.input).toStrictEqual({
        revalidateAfterMs: "preserved as query input",
      });

      expect(apiModule.optionalInputCalls).toStrictEqual([undefined]);

      listResolvers.shift()!("loaded list");

      optionLikeResolvers.shift()!.resolve("loaded option-like input");

      await Promise.all([listRefresh, ...queryReadiness]);

      await Promise.all([first.settled(), second.settled()]);

      for (const id of ["list-with-options", "list-bare"]) {
        expect(
          [...window.document.querySelectorAll(`#${id}`)].map((node) => node.textContent),
        ).toEqual(["loaded list", "loaded list"]);
      }

      for (const id of ["option-like-implicit", "option-like-explicit"]) {
        expect(
          [...window.document.querySelectorAll(`#${id}`)].map((node) => node.textContent),
        ).toEqual(["loaded option-like input", "loaded option-like input"]);
      }

      expect(
        [...window.document.querySelectorAll("#optional-undefined")].map(
          (node) => node.textContent,
        ),
      ).toEqual(["input was undefined", "input was undefined"]);

      expect(
        [...window.document.querySelectorAll("#overlap-explicit")].map((node) => node.textContent),
      ).toEqual(["overlap result", "overlap result"]);

      first.dispose();

      await expect(firstRun).rejects.toHaveProperty("kind", "cancelled");

      apiModule.queryResolvers.shift()!({ name: "Ada" });

      await expect(secondRun).resolves.toBe("Ada:Grace");

      expect(apiModule.saveCalls).toStrictEqual(["Grace"]);

      expect(secondButton.textContent).toBe("before:box:Ada:Grace");

      expect(apiModule.currentLabel).toBe("before");

      expect(apiModule.renderCount).toBe(2);

      second.dispose();

      apiModule.graph.dispose();
    } finally {
      window.close();
    }
  } finally {
    await Promise.all([unlink(apiFile), unlink(componentFile), unlink(shimFile)]);
  }
});

test("a compiled Elysia client adapts real Treaty HTTP routes through owner-bound queries and mutations", async () => {
  const root = await mkdtemp(join(tmpdir(), "hesperia-elysia-http-adapter-"));

  const serverFilename = join(root, "src/server.ts");

  const clientAppFilename = join(root, "src/client-app.ts");

  const clientFilename = join(root, "src/client.ts");

  const clientEffectsFilename = join(root, "src/client-effects.ts");

  const shellFilename = join(root, "app.tsx");

  const globalBridge = globalThis as typeof globalThis & {
    __hesperiaR16ServerImports?: number;
    __hesperiaR16AllowServerImport?: boolean;
    __hesperiaR16ServerUrl?: string;
    __hesperiaR16ObserveRequest?: (path: string, options: RequestInit) => void;
    __hesperiaR16ObserveResponse?: (response: Response) => void;
    __hesperiaR16SaveSignal?: AbortSignal;
    __hesperiaR16SaveRun?: Promise<unknown>;
    __hesperiaR16SearchRun?: Promise<unknown>;
    __hesperiaR16PreviewRefreshRun?: Promise<unknown>;
    __hesperiaR16ArrayRevalidateRun?: Promise<void>;
    __hesperiaR16EmptyMutationRun?: Promise<unknown>;
    __hesperiaR16PendingRun?: Promise<unknown>;
    __hesperiaR16QueryKeys?: unknown[];
    __hesperiaR16ArrayQueryKeys?: unknown[];
    __hesperiaR16PathKeys?: {
      readonly repeatedFirst: string;
      readonly repeatedSecond: string;
      readonly optionalOmitted: string;
      readonly optionalPresent: string;
    }[];
    __hesperiaR16InitialReady?: Promise<unknown>[];
    __hesperiaR16FailureReady?: Promise<
      { readonly state: "resolved" } | { readonly state: "rejected"; readonly error: unknown }
    >[];
  };

  const previousWindow = Reflect.get(globalThis, "window");

  const previousServerImports = globalBridge.__hesperiaR16ServerImports;

  const previousAllowServerImport = globalBridge.__hesperiaR16AllowServerImport;

  const previousServerUrl = globalBridge.__hesperiaR16ServerUrl;

  const previousObserveRequest = globalBridge.__hesperiaR16ObserveRequest;

  const previousObserveResponse = globalBridge.__hesperiaR16ObserveResponse;

  const previousSaveSignal = globalBridge.__hesperiaR16SaveSignal;

  const previousSaveRun = globalBridge.__hesperiaR16SaveRun;

  const previousSearchRun = globalBridge.__hesperiaR16SearchRun;

  const previousPreviewRefreshRun = globalBridge.__hesperiaR16PreviewRefreshRun;

  const previousArrayRevalidateRun = globalBridge.__hesperiaR16ArrayRevalidateRun;

  const previousEmptyMutationRun = globalBridge.__hesperiaR16EmptyMutationRun;

  const previousPendingRun = globalBridge.__hesperiaR16PendingRun;

  const previousQueryKeys = globalBridge.__hesperiaR16QueryKeys;

  const previousArrayQueryKeys = globalBridge.__hesperiaR16ArrayQueryKeys;

  const previousPathKeys = globalBridge.__hesperiaR16PathKeys;

  const previousInitialReady = globalBridge.__hesperiaR16InitialReady;

  const previousFailureReady = globalBridge.__hesperiaR16FailureReady;

  let serverModule:
    | {
        readonly app: {
          readonly server?: { readonly url: URL };

          listen(port: number): unknown;

          stop(closeActiveConnections?: boolean): unknown;
        };
        readonly requests: readonly { readonly name: string; readonly data: unknown }[];
        readonly pendingStarted: Promise<void>;

        waitForRequest(name: string): Promise<{ readonly name: string; readonly data: unknown }>;

        releasePending(): void;
      }
    | undefined;

  let listenerStarted = false;

  let mounted:
    | {
        dispose(reason?: unknown): void;

        settled(): Promise<void>;
      }
    | undefined;

  let secondMounted:
    | {
        dispose(reason?: unknown): void;

        settled(): Promise<void>;
      }
    | undefined;

  let browserWindow: Window | undefined;

  let testFailed = false;

  let testFailure: unknown;

  const cleanupErrors: unknown[] = [];

  try {
    await linkFrameworkPackages(root, { elysia: true, eden: true, elysiaAdapter: true });

    await mkdir(dirname(serverFilename), { recursive: true });

    await writeFile(
      serverFilename,
      await readFile(join(importedApiFixtures, "src/server.ts"), "utf8"),
    );

    await writeFile(
      clientEffectsFilename,
      await readFile(join(importedApiFixtures, "src/client-effects.ts"), "utf8"),
    );

    await writeFile(
      clientAppFilename,
      await readFile(join(importedApiFixtures, "src/client-app.ts"), "utf8"),
    );

    await writeFile(
      clientFilename,
      `import { treaty } from "@elysia/eden";
import type { App } from "./client-app";
import { defineEdenEffect } from "@hesperia/elysia/effects";
import { withAeolia } from "@hesperia/elysia/client";

const runtime = globalThis as typeof globalThis & {
  __hesperiaR16ServerUrl?: string;
  __hesperiaR16ObserveRequest?: (path: string, options: RequestInit) => void;
  __hesperiaR16ObserveResponse?: (response: Response) => void;
};
const client = treaty<App, { readonly "x-global-head": string }>(runtime.__hesperiaR16ServerUrl ?? "http://127.0.0.1:1", {
  headers(path) {
    return path === "/global-head" ? { "x-global-head": "R16_GLOBAL_HEAD_VALUE" } : undefined;
  },
  fetcher: new Proxy(fetch, {
    apply(target, thisArg, args) {
      const [path, options] = args;
      const url = typeof path === "string" ? path : path instanceof URL ? path.href : path.url;
      runtime.__hesperiaR16ObserveRequest?.(url, options ?? {});
      return Reflect.apply(target, thisArg, args);
    },
  }),
  onResponse(response) { runtime.__hesperiaR16ObserveResponse?.(response); },
});
export const api = withAeolia(client);

type IsAssignable<From, To> = [From] extends [To] ? true : false;
type Equal<Left, Right> = IsAssignable<Left, Right> extends true
  ? IsAssignable<Right, Left>
  : false;
type IsOptional<Value, Key extends keyof Value> = {} extends Pick<Value, Key> ? true : false;
type Assert<Condition extends true> = Condition;
type AssertFalse<Condition extends false> = Condition;
type NullableQueryView = ReturnType<typeof api.nullable.get>;
type _NullableValueIsNull = Assert<
  Equal<ReturnType<NullableQueryView["value"]>, null | undefined>
>;
type _NullableReadyIsNull = Assert<Equal<Awaited<NullableQueryView["ready"]>, null>>;
type _NullableGetNeedsNoInput = Assert<
  IsAssignable<[], Parameters<typeof api.nullable.get>>
>;
type UserGetRequest = NonNullable<Parameters<ReturnType<typeof api.users>["get"]>[0]>;
type _UserQueryIsString = Assert<
  Equal<NonNullable<UserGetRequest["query"]>, { readonly sort: string }>
>;
type UserGetHeaders = NonNullable<UserGetRequest["headers"]>;
type _UserTenantHeaderIsString = Assert<Equal<UserGetHeaders["x-tenant"], string>>;
type _UserHeaderRetainsRequiredTenant = Assert<
  IsAssignable<{ readonly "x-tenant": string }, UserGetHeaders>
>;
type _UserGlobalHeadIsOptional = Assert<IsOptional<UserGetHeaders, "x-global-head">>;
type _UserHeaderStillRequiresTenant = AssertFalse<IsAssignable<{}, UserGetHeaders>>;
type _UserQueryIsRequired = AssertFalse<
  IsAssignable<{ readonly headers: { readonly "x-tenant": string } }, UserGetRequest>
>;
type _UserRequestHasDeclaredFields = Assert<
  IsAssignable<
    {
      readonly query: { readonly sort: string };
      readonly headers: { readonly "x-tenant": string };
    },
    UserGetRequest
  >
>;
type _UserHeadersAreRequired = AssertFalse<
  IsAssignable<{ readonly query: { readonly sort: string } }, UserGetRequest>
>;
type SaveTask = ReturnType<typeof api.save.post>;
type SaveRequest = Parameters<SaveTask["run"]>[0];
type SaveHeaders = NonNullable<SaveRequest["headers"]>;
type _SaveHeaderIsString = Assert<Equal<SaveHeaders["x-save"], string>>;
type _SaveBodyHasName = Assert<
  Equal<SaveRequest["body"], { readonly name: string }>
>;
type _SaveQueryHasSource = Assert<
  Equal<NonNullable<SaveRequest["query"]>, { readonly source: string }>
>;
type _SaveHeaderRetainsRequiredXSave = Assert<
  IsAssignable<{ readonly "x-save": string }, SaveHeaders>
>;
type _SaveGlobalHeadIsOptional = Assert<IsOptional<SaveHeaders, "x-global-head">>;
type _SaveHeaderStillRequiresXSave = AssertFalse<IsAssignable<{}, SaveHeaders>>;
type _SaveRequestHasDeclaredFields = Assert<
  IsAssignable<
    {
      readonly body: { readonly name: string };
      readonly query: { readonly source: string };
      readonly headers: { readonly "x-save": string };
    },
    SaveRequest
  >
>;
type _SaveQueryAndHeadersAreRequired = AssertFalse<
  IsAssignable<{ readonly body: { readonly name: string } }, SaveRequest>
>;
type _SaveBodyAndHeadersAreRequired = AssertFalse<
  IsAssignable<
    { readonly query: { readonly source: string }; readonly headers: { readonly "x-save": string } },
    SaveRequest
  >
>;
type _SaveBodyAndQueryAreRequired = AssertFalse<
  IsAssignable<
    { readonly body: { readonly name: string }; readonly query: { readonly source: string } },
    SaveRequest
  >
>;
type GlobalHeadGetArguments = Parameters<(typeof api)["global-head"]["get"]>;
type _GlobalHeadGetAllowsNoRequest = Assert<IsAssignable<[], GlobalHeadGetArguments>>;
type _NestedThenRouteSupportsGet = Assert<
  IsAssignable<[], Parameters<typeof api.x.then.get>>
>;
type _NestedCatchRouteSupportsGet = Assert<
  IsAssignable<[], Parameters<typeof api.x.catch.get>>
>;
type _NestedFinallyRouteSupportsGet = Assert<
  IsAssignable<[], Parameters<typeof api.x.finally.get>>
>;
type _ToJSONRouteSupportsGet = Assert<IsAssignable<[], Parameters<typeof api.toJSON.get>>>;
type EmptyMutationTask = ReturnType<(typeof api)["empty-mutation"]["post"]>;
type _EmptyMutationRunAllowsNoRequest = Assert<
  IsAssignable<[], Parameters<EmptyMutationTask["run"]>>
>;
type _SaveMutationRunStillRequiresRequest = AssertFalse<
  IsAssignable<[], Parameters<SaveTask["run"]>>
>;

function assertNativeEffectHelperTypes(): void {
  const defineEffect = defineEdenEffect<App>();
  defineEffect(
    { method: "POST", path: "/save" },
    { method: "GET", path: "/files/:version?/preview/:fileId" },
    ({ body, query, headers }) => {
      const name: string = body.name;
      const source: string = query.source;
      const saveHeader: string = headers["x-save"];
      // @ts-expect-error The selector input is checked against the configured App body.
      body.missing;
      void source;
      void saveHeader;
      return { params: { fileId: name } };
    },
    "revalidate",
  );
  // @ts-expect-error Eden effect selectors must return synchronously.
  defineEffect({ method: "POST", path: "/save" }, { method: "GET", path: "/files/:version?/preview/:fileId" }, async ({ body }) => ({ params: { fileId: body.name } }), "revalidate");
  // @ts-expect-error The target params must match the configured GET route.
  defineEffect({ method: "POST", path: "/save" }, { method: "GET", path: "/files/:version?/preview/:fileId" }, ({ body }) => ({ params: { missing: body.name } }), "revalidate");
}
void assertNativeEffectHelperTypes;
`,
    );

    await writeFile(shellFilename, await readFile(join(importedApiFixtures, "app.tsx"), "utf8"));

    await mkdir(join(root, "src/routes"), { recursive: true });

    await writeFile(
      join(root, "src/routes/+page.tsx"),
      await readFile(join(importedApiFixtures, "src/routes/+page.tsx"), "utf8"),
    );

    await writeFile(
      join(root, "hesperia.config.ts"),
      await readFile(join(importedApiFixtures, "hesperia.config.ts"), "utf8"),
    );

    delete globalBridge.__hesperiaR16ServerImports;

    delete globalBridge.__hesperiaR16AllowServerImport;

    const build = await buildInProjectProcess(root, false);

    expect(globalBridge.__hesperiaR16ServerImports).toBeUndefined();

    const buildMetadata = JSON.parse(await build.files.get("/hesperia-build.json")!.text()) as {
      readonly routeTable: string;
    };

    const emittedRoot = join(root, ".r16-emitted-browser");

    const scripts = await Promise.all(
      [...build.files]
        .filter(([filename]) => filename.endsWith(".js"))
        .map(async ([filename, blob]) => [filename, await blob.text()] as const),
    );

    const sourceMaps = await Promise.all(
      [...build.files]
        .filter(([filename]) => filename.endsWith(".js.map"))
        .map(([, blob]) => blob.text()),
    );

    const publicOutput = [...scripts.map(([, source]) => source), ...sourceMaps].join("\n");

    expect(publicOutput).not.toContain("R16_EDELIA_PRIVATE_SERVER_VALUE");

    expect(publicOutput).not.toContain("R16_EDELIA_PRIVATE_HANDLER_NAME");

    expect(publicOutput).not.toContain("R16_SERVER_SOURCE_MUST_NOT_EXECUTE_DURING_ANALYSIS");

    const shellArtifact = scripts.find(([, source]) => source.includes("R16_COMPILED_HTTP_SHELL"));

    expect(shellArtifact).toBeDefined();

    for (const [filename, blob] of build.files) {
      const destination = join(emittedRoot, filename.replace(/^\/+/, ""));

      await mkdir(dirname(destination), { recursive: true });

      await writeFile(destination, new Uint8Array(await blob.arrayBuffer()));
    }

    globalBridge.__hesperiaR16AllowServerImport = true;

    const importedServer = await import(pathToFileURL(serverFilename).href);

    serverModule = importedServer as typeof serverModule;

    expect(Reflect.get(globalThis, "__hesperiaR16ServerImports")).toBe(1);

    await serverModule!.app.listen(0);

    listenerStarted = true;

    const baseUrl = serverModule!.app.server?.url.href;

    if (baseUrl === undefined) throw new Error("Elysia did not publish its listener URL.");

    globalBridge.__hesperiaR16ServerUrl = baseUrl;

    const requests: {
      readonly path: string;
      readonly url: string;
      readonly signal: AbortSignal | null | undefined;
    }[] = [];

    const responses: { readonly path: string; readonly status: number }[] = [];

    const responseWaiters = new Map<
      string,
      ((response: { readonly path: string; readonly status: number }) => void)[]
    >();

    const waitForResponse = (
      path: string,
    ): Promise<{ readonly path: string; readonly status: number }> => {
      const existing = responses.find((response) => response.path === path);

      if (existing) return Promise.resolve(existing);

      return new Promise((resolveResponse) => {
        const waiters = responseWaiters.get(path) ?? [];

        waiters.push(resolveResponse);

        responseWaiters.set(path, waiters);
      });
    };

    globalBridge.__hesperiaR16ObserveRequest = (path, options) => {
      const url = new URL(path, baseUrl);

      requests.push({
        path: url.pathname,
        url: url.href,
        signal: options.signal,
      });
    };

    globalBridge.__hesperiaR16ObserveResponse = (response) => {
      const observed = { path: new URL(response.url, baseUrl).pathname, status: response.status };

      responses.push(observed);

      for (const resolveResponse of responseWaiters.get(observed.path) ?? [])
        resolveResponse(observed);

      responseWaiters.delete(observed.path);
    };

    browserWindow = new Window({ url: baseUrl });

    // Happy DOM rejects replacing its existing Document element.
    browserWindow.document.documentElement.remove();

    installHistoryCloneAdapter(
      browserWindow as unknown as Parameters<typeof installHistoryCloneAdapter>[0],
    );

    Reflect.set(globalThis, "window", browserWindow);

    const shellPath = join(emittedRoot, shellArtifact![0].replace(/^\/+/, ""));

    const emittedShell = (await import(pathToFileURL(shellPath).href)) as {
      readonly default: Component<{ children: Rendered }>;
      readonly Probe: Component<Record<string, never>>;
      readonly bootstrapApplication: typeof import("hesperia/runtime").bootstrapApplication;
      readonly mount: typeof mount;
    };

    expect(typeof emittedShell.mount).toBe("function");

    expect(typeof emittedShell.bootstrapApplication).toBe("function");

    const routeTablePath = join(emittedRoot, buildMetadata.routeTable.replace(/^\/+/, ""));

    const routeTableModule = (await import(pathToFileURL(routeTablePath).href)) as {
      readonly default: RouteTable;
    };

    const initialResponseWaits = [
      "/users/42",
      "/query-array",
      "/global-head",
      "/nullable",
      "/failure",
      "/subscription-status",
      "/foo/early/bar",
      "/foo/bar/late",
      "/items/first-A/parents/same",
      "/items/first-B/parents/same",
      "/files/preview/notes",
      "/files/v1/preview/notes",
      "/x/then",
      "/x/catch",
      "/x/finally",
      "/toJSON",
    ].map(waitForResponse);

    globalBridge.__hesperiaR16QueryKeys = [];

    globalBridge.__hesperiaR16ArrayQueryKeys = [];

    globalBridge.__hesperiaR16ArrayRevalidateRun = undefined;

    globalBridge.__hesperiaR16PathKeys = [];

    globalBridge.__hesperiaR16InitialReady = [];

    globalBridge.__hesperiaR16FailureReady = [];

    mounted = await emittedShell.bootstrapApplication(
      browserWindow as unknown as Parameters<
        typeof import("hesperia/runtime").bootstrapApplication
      >[0],
      {
        configuration: () => ({}),
        shell: () => emittedShell.default,
        routes: () => routeTableModule.default,
      },
    );

    expect(browserWindow.document.querySelector("#home-route")?.textContent).toBe("Home route");

    const secondTarget = browserWindow.document.createElement("section");

    browserWindow.document.body.append(secondTarget);

    secondMounted = emittedShell.mount(secondTarget as unknown as Element, emittedShell.Probe, {});

    await Promise.all(initialResponseWaits);

    await Promise.all(globalBridge.__hesperiaR16InitialReady ?? []);

    const failureReadyPromises = globalBridge.__hesperiaR16FailureReady ?? [];

    const failureReadiness = await Promise.all(failureReadyPromises);

    await Promise.all([mounted.settled(), secondMounted.settled()]);

    expect(browserWindow.document.querySelector("#user")?.textContent).toBe(
      "42|latest|R16_HEADER_SECRET_ALPHA",
    );

    expect(secondTarget.querySelector("#user")?.textContent).toBe(
      "42|latest|R16_HEADER_SECRET_ALPHA",
    );

    const initialArrayOutput = browserWindow.document.querySelector("#query-array")!.textContent!;

    const initialDistinctArrayOutput =
      browserWindow.document.querySelector("#query-array-distinct")!.textContent!;

    expect(initialArrayOutput).toMatch(/^cedar\|maple\|[12]$/u);

    expect(initialDistinctArrayOutput).toMatch(/^cedar\|elm\|[12]$/u);

    expect(secondTarget.querySelector("#query-array")?.textContent).toBe(initialArrayOutput);

    expect(secondTarget.querySelector("#query-array-distinct")?.textContent).toBe(
      initialDistinctArrayOutput,
    );

    const initialArrayDelivery = Number(
      initialArrayOutput.slice(initialArrayOutput.lastIndexOf("|") + 1),
    );

    const initialDistinctDelivery = Number(
      initialDistinctArrayOutput.slice(initialDistinctArrayOutput.lastIndexOf("|") + 1),
    );

    expect([initialArrayDelivery, initialDistinctDelivery].sort()).toStrictEqual([1, 2]);

    expect(browserWindow.document.querySelector("#user-other")?.textContent).toBe(
      "42|latest|R16_HEADER_SECRET_BETA",
    );

    expect(secondTarget.querySelector("#user-other")?.textContent).toBe(
      "42|latest|R16_HEADER_SECRET_BETA",
    );

    expect(browserWindow.document.querySelector("#global-head")?.textContent).toBe(
      "R16_GLOBAL_HEAD_VALUE",
    );

    expect(secondTarget.querySelector("#global-head")?.textContent).toBe("R16_GLOBAL_HEAD_VALUE");

    expect(browserWindow.document.querySelector("#nullable")?.textContent).toBe("json-null");

    expect(browserWindow.document.querySelector("#failure")?.textContent).toBe("failed");

    expect(failureReadiness).toHaveLength(2);

    for (const outcome of failureReadiness) {
      expect(outcome.state).toBe("rejected");

      if (outcome.state !== "rejected")
        throw new Error("HTTP 422 query readiness unexpectedly resolved.");

      expect(outcome.error).toBeInstanceOf(Error);

      if (outcome.error === null || typeof outcome.error !== "object")
        throw new Error("Eden HTTP error readiness did not reject with an error object.");

      expect(Reflect.get(outcome.error, "status")).toBe(422);

      expect(Reflect.get(outcome.error, "value")).toStrictEqual({
        message: "expected HTTP failure",
      });
    }

    expect(browserWindow.document.querySelector("#subscription-status")?.textContent).toBe(
      "/subscription-status",
    );

    expect(browserWindow.document.querySelector("#capture-first")?.textContent).toBe(
      "capture-first|early",
    );

    expect(browserWindow.document.querySelector("#capture-last")?.textContent).toBe(
      "capture-last|late",
    );

    expect(browserWindow.document.querySelector("#repeated-first")?.textContent).toBe(
      "/items/first-A/parents/same",
    );

    expect(secondTarget.querySelector("#repeated-first")?.textContent).toBe(
      "/items/first-A/parents/same",
    );

    expect(browserWindow.document.querySelector("#repeated-second")?.textContent).toBe(
      "/items/first-B/parents/same",
    );

    expect(secondTarget.querySelector("#repeated-second")?.textContent).toBe(
      "/items/first-B/parents/same",
    );

    expect(browserWindow.document.querySelector("#optional-omitted")?.textContent).toBe(
      "/files/preview/notes",
    );

    expect(secondTarget.querySelector("#optional-omitted")?.textContent).toBe(
      "/files/preview/notes",
    );

    expect(browserWindow.document.querySelector("#optional-omitted-title")?.textContent).toBe(
      "before",
    );

    expect(secondTarget.querySelector("#optional-omitted-title")?.textContent).toBe("before");

    expect(browserWindow.document.querySelector("#optional-present")?.textContent).toBe(
      "/files/v1/preview/notes",
    );

    expect(secondTarget.querySelector("#optional-present")?.textContent).toBe(
      "/files/v1/preview/notes",
    );

    expect(browserWindow.document.querySelector("#optional-present-title")?.textContent).toBe(
      "before",
    );

    expect(secondTarget.querySelector("#optional-present-title")?.textContent).toBe("before");

    for (const [selector, path, requestName] of [
      ["#path-then", "/x/then", "path-then"],
      ["#path-catch", "/x/catch", "path-catch"],
      ["#path-finally", "/x/finally", "path-finally"],
      ["#path-toJSON", "/toJSON", "path-toJSON"],
    ] as const) {
      expect(browserWindow.document.querySelector(selector)?.textContent).toBe(path);

      expect(secondTarget.querySelector(selector)?.textContent).toBe(path);

      expect(serverModule!.requests).toContainEqual({ name: requestName, data: { path } });
    }

    expect(serverModule!.requests).toContainEqual({
      name: "global-head",
      data: { head: "R16_GLOBAL_HEAD_VALUE" },
    });

    const usersRequests = serverModule!.requests.filter(({ name }) => name === "users");

    expect(usersRequests).toHaveLength(2);

    expect(usersRequests.map(({ data }) => data)).toContainEqual({
      id: "42",
      sort: "latest",
      tenant: "R16_HEADER_SECRET_ALPHA",
    });

    expect(usersRequests.map(({ data }) => data)).toContainEqual({
      id: "42",
      sort: "latest",
      tenant: "R16_HEADER_SECRET_BETA",
    });

    const arrayRequests = serverModule!.requests.filter(({ name }) => name === "query-array");

    expect(arrayRequests).toHaveLength(2);

    expect(arrayRequests.map(({ data }) => data)).toContainEqual({
      values: ["cedar", "maple"],
      delivery: initialArrayDelivery,
    });

    expect(arrayRequests.map(({ data }) => data)).toContainEqual({
      values: ["cedar", "elm"],
      delivery: initialDistinctDelivery,
    });

    const arrayRequestUrls = requests.filter(({ path }) => path === "/query-array");

    expect(arrayRequestUrls).toHaveLength(2);

    const arrayUrlValues = arrayRequestUrls.map(({ url }) =>
      new URL(url).searchParams.getAll("values"),
    );

    expect(arrayUrlValues).toContainEqual(["cedar", "maple"]);

    expect(arrayUrlValues).toContainEqual(["cedar", "elm"]);

    const queryKeys = globalBridge.__hesperiaR16QueryKeys ?? [];

    expect(queryKeys).toHaveLength(4);

    expect(queryKeys[0]).toBe(queryKeys[2]);

    expect(queryKeys[1]).toBe(queryKeys[3]);

    expect(queryKeys[0]).not.toBe(queryKeys[1]);

    for (const queryKey of queryKeys) {
      expect(typeof queryKey).toBe("string");

      expect(queryKey).not.toContain("R16_HEADER_SECRET_ALPHA");

      expect(queryKey).not.toContain("R16_HEADER_SECRET_BETA");
    }

    const arrayQueryKeys = globalBridge.__hesperiaR16ArrayQueryKeys ?? [];

    expect(arrayQueryKeys).toHaveLength(4);

    expect(arrayQueryKeys[0]).toBe(arrayQueryKeys[2]);

    expect(arrayQueryKeys[1]).toBe(arrayQueryKeys[3]);

    expect(arrayQueryKeys[0]).not.toBe(arrayQueryKeys[1]);

    browserWindow.document
      .querySelector<HappyDOMHTMLButtonElement>("#query-array-revalidate")!
      .click();

    const arrayRevalidateRun = globalBridge.__hesperiaR16ArrayRevalidateRun;

    expect(arrayRevalidateRun).toBeDefined();

    if (arrayRevalidateRun === undefined)
      throw new Error("The array query revalidation did not publish its completion promise.");

    await arrayRevalidateRun;

    await Promise.all([mounted.settled(), secondMounted.settled()]);

    const revalidatedArrayRequests = serverModule!.requests.filter(
      ({ name }) => name === "query-array",
    );

    expect(revalidatedArrayRequests).toHaveLength(3);

    expect(revalidatedArrayRequests[2]?.data).toStrictEqual({
      values: ["cedar", "maple"],
      delivery: 3,
    });

    const revalidatedArrayRequestUrls = requests.filter(({ path }) => path === "/query-array");

    expect(revalidatedArrayRequestUrls).toHaveLength(3);

    expect(
      new URL(revalidatedArrayRequestUrls[2]!.url).searchParams.getAll("values"),
    ).toStrictEqual(["cedar", "maple"]);

    expect(browserWindow.document.querySelector("#query-array")?.textContent).toBe("cedar|maple|3");

    expect(secondTarget.querySelector("#query-array")?.textContent).toBe("cedar|maple|3");

    expect(browserWindow.document.querySelector("#query-array-distinct")?.textContent).toBe(
      initialDistinctArrayOutput,
    );

    expect(secondTarget.querySelector("#query-array-distinct")?.textContent).toBe(
      initialDistinctArrayOutput,
    );

    expect(serverModule!.requests.find(({ name }) => name === "nullable")?.data).toBeNull();

    expect(serverModule!.requests.find(({ name }) => name === "capture-first")?.data).toStrictEqual(
      {
        id: "early",
      },
    );

    expect(serverModule!.requests.find(({ name }) => name === "capture-last")?.data).toStrictEqual({
      id: "late",
    });

    const repeatedRequests = serverModule!.requests.filter(({ name }) => name === "repeated");

    expect(repeatedRequests).toHaveLength(2);

    expect(repeatedRequests.map(({ data }) => data)).toContainEqual({
      id: "first-A",
      path: "/items/first-A/parents/same",
    });

    expect(repeatedRequests.map(({ data }) => data)).toContainEqual({
      id: "first-B",
      path: "/items/first-B/parents/same",
    });

    const optionalRequests = serverModule!.requests.filter(({ name }) => name === "optional");

    expect(optionalRequests).toHaveLength(2);

    expect(optionalRequests.map(({ data }) => data)).toContainEqual({
      version: "omitted",
      fileId: "notes",
      title: "before",
      path: "/files/preview/notes",
    });

    expect(optionalRequests.map(({ data }) => data)).toContainEqual({
      version: "v1",
      fileId: "notes",
      title: "before",
      path: "/files/v1/preview/notes",
    });

    const pathKeys = globalBridge.__hesperiaR16PathKeys ?? [];

    expect(pathKeys).toHaveLength(2);

    expect(pathKeys[0]!.repeatedFirst).toBe(pathKeys[1]!.repeatedFirst);

    expect(pathKeys[0]!.repeatedSecond).toBe(pathKeys[1]!.repeatedSecond);

    expect(pathKeys[0]!.optionalOmitted).toBe(pathKeys[1]!.optionalOmitted);

    expect(pathKeys[0]!.optionalPresent).toBe(pathKeys[1]!.optionalPresent);

    expect(pathKeys[0]!.repeatedFirst).not.toBe(pathKeys[0]!.repeatedSecond);

    expect(pathKeys[0]!.optionalOmitted).not.toBe(pathKeys[0]!.optionalPresent);

    for (const key of [
      pathKeys[0]!.repeatedFirst,
      pathKeys[0]!.repeatedSecond,
      pathKeys[0]!.optionalOmitted,
      pathKeys[0]!.optionalPresent,
    ]) {
      expect(key).not.toContain("first-A");

      expect(key).not.toContain("first-B");

      expect(key).not.toContain("notes");

      expect(key).not.toContain("v1");
    }

    expect(serverModule!.requests.filter(({ name }) => name === "preview-refresh")).toHaveLength(0);

    const previewRefreshResponse = waitForResponse("/preview-refresh");

    const previewRefreshRequest = serverModule!.waitForRequest("preview-refresh");

    browserWindow.document.querySelector<HappyDOMHTMLButtonElement>("#preview-refresh")!.click();

    const [previewRefreshObserved, previewRefreshRecord] = await Promise.all([
      previewRefreshResponse,
      previewRefreshRequest,
    ]);

    expect(previewRefreshObserved.status).toBe(200);

    expect(previewRefreshRecord.data).toStrictEqual({ fileId: "notes", title: "after" });

    await globalBridge.__hesperiaR16PreviewRefreshRun;

    await Promise.all([mounted.settled(), secondMounted.settled()]);

    const refreshedOptionalRecords = serverModule!.requests.filter(
      ({ name }) => name === "optional",
    );

    expect(refreshedOptionalRecords).toHaveLength(3);

    expect(refreshedOptionalRecords[2]?.data).toStrictEqual({
      version: "omitted",
      fileId: "notes",
      title: "after",
      path: "/files/preview/notes",
    });

    expect(requests.filter(({ path }) => path === "/files/preview/notes")).toHaveLength(2);

    expect(requests.filter(({ path }) => path === "/files/v1/preview/notes")).toHaveLength(1);

    expect(browserWindow.document.querySelector("#optional-omitted-title")?.textContent).toBe(
      "after",
    );

    expect(secondTarget.querySelector("#optional-omitted-title")?.textContent).toBe("after");

    expect(browserWindow.document.querySelector("#optional-present-title")?.textContent).toBe(
      "before",
    );

    expect(secondTarget.querySelector("#optional-present-title")?.textContent).toBe("before");

    const saveResponse = waitForResponse("/save");

    const saveRequest = serverModule!.waitForRequest("save");

    const saveAbortController = new AbortController();

    globalBridge.__hesperiaR16SaveSignal = saveAbortController.signal;

    browserWindow.document.querySelector<HappyDOMHTMLButtonElement>("#save")!.click();

    const [saveObserved] = await Promise.all([saveResponse, saveRequest]);

    expect(saveObserved.status).toBe(200);

    await globalBridge.__hesperiaR16SaveRun;

    await mounted.settled();

    expect(serverModule!.requests.find(({ name }) => name === "save")?.data).toStrictEqual({
      body: { name: "tea" },
      query: { source: "button" },
      saveHeader: "save-fixed",
    });

    expect(browserWindow.document.querySelector("#saved")?.textContent).toBe("tea");

    expect(saveAbortController.signal.aborted).toBe(false);

    const searchResponse = waitForResponse("/custom");

    const searchRequest = serverModule!.waitForRequest("m-search");

    browserWindow.document.querySelector<HappyDOMHTMLButtonElement>("#search")!.click();

    await globalBridge.__hesperiaR16SearchRun;

    const searchObserved = await searchResponse;

    expect(searchObserved.status).toBe(200);

    await searchRequest;

    await mounted.settled();

    expect(serverModule!.requests.find(({ name }) => name === "m-search")?.data).toStrictEqual({
      body: { kind: "oolong" },
      query: { source: "button" },
    });

    expect(browserWindow.document.querySelector("#search-result")?.textContent).toBe("oolong");

    const emptyMutationResponse = waitForResponse("/empty-mutation");

    const emptyMutationRequest = serverModule!.waitForRequest("empty-mutation");

    browserWindow.document.querySelector<HappyDOMHTMLButtonElement>("#empty-mutation")!.click();

    const [emptyMutationObserved, emptyMutationRecord] = await Promise.all([
      emptyMutationResponse,
      emptyMutationRequest,
    ]);

    expect(emptyMutationObserved.status).toBe(200);

    expect(emptyMutationRecord.data).toStrictEqual({ called: true });

    await globalBridge.__hesperiaR16EmptyMutationRun;

    await mounted.settled();

    const pendingRequest = serverModule!.waitForRequest("pending");

    browserWindow.document.querySelector<HappyDOMHTMLButtonElement>("#pending")!.click();

    await serverModule!.pendingStarted;

    await pendingRequest;

    const pendingTransport = requests.find(({ path }) => path === "/pending");

    expect(pendingTransport?.signal).toBeDefined();

    expect(pendingTransport?.signal?.aborted).toBe(false);

    const pendingAbortReason = new Error("dispose component owner during mutation");

    mounted.dispose(pendingAbortReason);

    expect(pendingTransport?.signal?.aborted).toBe(true);

    await expect(globalBridge.__hesperiaR16PendingRun).rejects.toBe(pendingAbortReason);

    serverModule!.releasePending();

    secondMounted.dispose();

    secondMounted = undefined;

    await serverModule!.app.stop(true);

    listenerStarted = false;

    serverModule = undefined;

    mounted = undefined;
  } catch (error) {
    if (error instanceof ProjectError) console.error(JSON.stringify(error.diagnostics, null, 2));

    testFailed = true;

    testFailure = error;
  } finally {
    const attemptCleanup = async (operation: () => unknown): Promise<void> => {
      try {
        await operation();
      } catch (error) {
        cleanupErrors.push(error);
      }
    };

    try {
      await attemptCleanup(() => serverModule?.releasePending());

      await attemptCleanup(() => mounted?.dispose(new Error("Elysia adapter test cleanup")));

      await attemptCleanup(() => secondMounted?.dispose(new Error("Elysia adapter test cleanup")));

      if (serverModule && listenerStarted) await attemptCleanup(() => serverModule!.app.stop(true));

      await attemptCleanup(() => browserWindow?.close());

      await attemptCleanup(() => unlinkFrameworkPackages(root));

      await attemptCleanup(() => rm(root, { recursive: true, force: true }));
    } finally {
      const restore = (operation: () => unknown): void => {
        try {
          operation();
        } catch (error) {
          cleanupErrors.push(error);
        }
      };

      restore(() => {
        if (previousWindow === undefined) Reflect.deleteProperty(globalThis, "window");
        else Reflect.set(globalThis, "window", previousWindow);
      });

      restore(() => {
        if (previousServerImports === undefined) delete globalBridge.__hesperiaR16ServerImports;
        else globalBridge.__hesperiaR16ServerImports = previousServerImports;
      });

      restore(() => {
        if (previousAllowServerImport === undefined)
          delete globalBridge.__hesperiaR16AllowServerImport;
        else globalBridge.__hesperiaR16AllowServerImport = previousAllowServerImport;
      });

      restore(() => {
        if (previousServerUrl === undefined) delete globalBridge.__hesperiaR16ServerUrl;
        else globalBridge.__hesperiaR16ServerUrl = previousServerUrl;
      });

      restore(() => {
        if (previousObserveRequest === undefined) delete globalBridge.__hesperiaR16ObserveRequest;
        else globalBridge.__hesperiaR16ObserveRequest = previousObserveRequest;
      });

      restore(() => {
        if (previousObserveResponse === undefined) delete globalBridge.__hesperiaR16ObserveResponse;
        else globalBridge.__hesperiaR16ObserveResponse = previousObserveResponse;
      });

      restore(() => {
        if (previousSaveSignal === undefined) delete globalBridge.__hesperiaR16SaveSignal;
        else globalBridge.__hesperiaR16SaveSignal = previousSaveSignal;
      });

      restore(() => {
        if (previousSaveRun === undefined) delete globalBridge.__hesperiaR16SaveRun;
        else globalBridge.__hesperiaR16SaveRun = previousSaveRun;
      });

      restore(() => {
        if (previousSearchRun === undefined) delete globalBridge.__hesperiaR16SearchRun;
        else globalBridge.__hesperiaR16SearchRun = previousSearchRun;
      });

      restore(() => {
        if (previousPreviewRefreshRun === undefined)
          delete globalBridge.__hesperiaR16PreviewRefreshRun;
        else globalBridge.__hesperiaR16PreviewRefreshRun = previousPreviewRefreshRun;
      });

      restore(() => {
        if (previousArrayRevalidateRun === undefined)
          delete globalBridge.__hesperiaR16ArrayRevalidateRun;
        else globalBridge.__hesperiaR16ArrayRevalidateRun = previousArrayRevalidateRun;
      });

      restore(() => {
        if (previousEmptyMutationRun === undefined)
          delete globalBridge.__hesperiaR16EmptyMutationRun;
        else globalBridge.__hesperiaR16EmptyMutationRun = previousEmptyMutationRun;
      });

      restore(() => {
        if (previousPendingRun === undefined) delete globalBridge.__hesperiaR16PendingRun;
        else globalBridge.__hesperiaR16PendingRun = previousPendingRun;
      });

      restore(() => {
        if (previousQueryKeys === undefined) delete globalBridge.__hesperiaR16QueryKeys;
        else globalBridge.__hesperiaR16QueryKeys = previousQueryKeys;
      });

      restore(() => {
        if (previousArrayQueryKeys === undefined) delete globalBridge.__hesperiaR16ArrayQueryKeys;
        else globalBridge.__hesperiaR16ArrayQueryKeys = previousArrayQueryKeys;
      });

      restore(() => {
        if (previousPathKeys === undefined) delete globalBridge.__hesperiaR16PathKeys;
        else globalBridge.__hesperiaR16PathKeys = previousPathKeys;
      });

      restore(() => {
        if (previousInitialReady === undefined) delete globalBridge.__hesperiaR16InitialReady;
        else globalBridge.__hesperiaR16InitialReady = previousInitialReady;
      });

      restore(() => {
        if (previousFailureReady === undefined) delete globalBridge.__hesperiaR16FailureReady;
        else globalBridge.__hesperiaR16FailureReady = previousFailureReady;
      });
    }
  }

  if (cleanupErrors.length > 0) {
    const errors = testFailed ? [testFailure, ...cleanupErrors] : cleanupErrors;

    throw new AggregateError(
      errors,
      testFailed
        ? "Elysia adapter test and cleanup both failed."
        : "Elysia adapter test cleanup failed.",
    );
  }

  if (testFailed) throw testFailure;
});

test("public Elysia configuration rejects Eden-reserved subscribe routes", async () => {
  const cases = [
    {
      name: "normal HTTP GET /subscribe",
      route: '.get("/subscribe", () => ({ accepted: true }))',
      diagnostic: "HTTP GET route /subscribe cannot be adapted through @elysia/eden",
      cause:
        'Treaty\'s checked client types reserve the "subscribe" property for WebSocket transport',
    },
    {
      name: "custom HTTP SUBSCRIBE",
      route: '.route("SUBSCRIBE", "/http-subscribe", () => ({ accepted: true }))',
      diagnostic: "HTTP SUBSCRIBE route /http-subscribe cannot be adapted through @elysia/eden",
      cause: 'Treaty reserves ".subscribe()" for WebSocket transport',
    },
  ] as const;

  const root = await mkdtemp(join(tmpdir(), "hesperia-elysia-subscribe-refusal-"));

  const sourceDirectory = join(root, "src");

  try {
    await linkFrameworkPackages(root, { elysia: true, eden: true, elysiaAdapter: true });

    await mkdir(sourceDirectory, { recursive: true });

    await writeFile(
      join(sourceDirectory, "client.ts"),
      `import { treaty } from "@elysia/eden";
import { withAeolia } from "@hesperia/elysia/client";
type App = typeof import("./server").app;
export const api = withAeolia(treaty<App>("http://127.0.0.1:1"));
`,
    );

    await writeFile(
      join(root, "hesperia.config.ts"),
      `import { defineConfig } from "@hesperia/tooling";
import { elysia } from "@hesperia/elysia";
export default defineConfig({ plugins: [elysia({ serverModule: "./src/server.ts", appExport: "app" })] });
`,
    );

    await writeFile(
      join(root, "app.tsx"),
      `import "./src/client";
export default function App() {
  return <html><head></head><body><output>This route must fail compilation.</output></body></html>;
}
`,
    );

    for (const scenario of cases) {
      await writeFile(
        join(sourceDirectory, "server.ts"),
        `import { Elysia } from "elysia";\nexport const app = new Elysia()${scenario.route};\n`,
      );

      let refusal: unknown;

      try {
        await buildInProjectProcess(root, false);
      } catch (error) {
        refusal = error;
      }

      expect(refusal, scenario.name).toBeInstanceOf(ProjectError);

      const errors = (refusal as ProjectError).diagnostics.filter(
        (diagnostic) => diagnostic.severity === "error",
      );

      expect(errors, scenario.name).toHaveLength(1);

      expect(errors[0]?.message, scenario.name).toContain(scenario.diagnostic);

      expect(errors[0]?.message, scenario.name).toContain(scenario.cause);

      expect(errors[0]?.message, scenario.name).toContain("work in progress");
    }
  } finally {
    await unlinkFrameworkPackages(root);

    await rm(root, { recursive: true, force: true });
  }
});

{
  const serverSource = `import { Elysia } from "elysia";
export const app = new Elysia().get("/association-proof", () => ({ value: "configured" as const }));
export const otherApp = new Elysia().get("/association-proof", () => ({ value: "configured" as const }));
`;

  const serverTypeSource = `export type App = typeof import("./server").app;\n`;

  const consumedShell = `import { api } from "./src/client";
export default function App() {
  const result = api["association-proof"].get();
  return <html><head></head><body><output>ASSOCIATION_PROOF:{result.value()?.value ?? "pending"}</output></body></html>;
}
`;

  const cases: {
    readonly name: string;
    readonly client: string;
    readonly extraFiles: Readonly<Record<string, string>>;
    readonly shell: string;
    readonly succeeds: boolean;
    readonly diagnostic?: string;
  }[] = [
    {
      name: "direct, aliased, namespace, and multiple clients preserve the configured App identity",
      client: `import { treaty as makeTreaty } from "@elysia/eden";
import type { App as ImportedApp } from "./app-type";
import { createApi } from "./factory";
import { withAeolia as directFactory } from "@hesperia/elysia/client";
import * as adapter from "@hesperia/elysia/client";
type ClientApp = ImportedApp;
const nativeClient = makeTreaty<ClientApp>("http://127.0.0.1:1");
const clientAlias = nativeClient;
const factoryAlias = createApi;
export const api = factoryAlias(clientAlias);
export const directApi = directFactory(makeTreaty<ClientApp>("http://127.0.0.1:2"));
export const secondApi = adapter.withAeolia(makeTreaty<ClientApp>("http://127.0.0.1:3"));
export function withAeolia(value: unknown) { return { value }; }
export const lookalike = withAeolia("local");
type IsAssignable<From, To> = [From] extends [To] ? true : false;
type Assert<Condition extends true> = Condition;
type NativePayload = ReturnType<ReturnType<typeof api["association-proof"]["get"]>["value"]>;
type ExpectedPayload = { readonly value: "configured" } | undefined;
type _PayloadFitsElysiaResponse = Assert<IsAssignable<NativePayload, ExpectedPayload>>;
type _ElysiaResponseFitsPayload = Assert<IsAssignable<ExpectedPayload, NativePayload>>;
// @ts-expect-error The native Eden response value must retain its checked Elysia payload.
const invalidPayload: NativePayload = { value: 123 };
void invalidPayload;
`,
      extraFiles: {
        "server-app.ts": serverTypeSource,
        "app-type.ts": `export type { App } from "./server-app";\n`,
        "factory.ts": `export { withAeolia as createApi } from "@hesperia/elysia/client";\n`,
      },
      shell: `import { api, directApi, secondApi } from "./src/client";
export default function App() {
  const first = api["association-proof"].get();
  const direct = directApi["association-proof"].get();
  const second = secondApi["association-proof"].get();
  return <html><head></head><body><output>ASSOCIATION_PROOF:{first.value()?.value ?? "pending"}:{direct.value()?.value ?? "pending"}:{second.value()?.value ?? "pending"}</output></body></html>;
}
`,
      succeeds: true,
    },
    {
      name: "unused imports and re-exports allow zero client calls",
      client: `import { withAeolia } from "@hesperia/elysia/client";
export { withAeolia };
`,
      extraFiles: {},
      shell: `import "./src/client";
export default function App() { return <html><head></head><body><output>ASSOCIATION_UNUSED</output></body></html>; }
`,
      succeeds: true,
    },
    {
      name: "a same-shape client from a different server export is rejected",
      client: `import { treaty } from "@elysia/eden";
import { withAeolia } from "@hesperia/elysia/client";
type WrongApp = typeof import("./server").otherApp;
export const api = withAeolia(treaty<WrongApp>("http://127.0.0.1:1"));
`,
      extraFiles: {},
      shell: consumedShell,
      succeeds: false,
      diagnostic: "App type does not resolve to the configured server export",
    },
    {
      name: "storing the public factory as an object property is rejected",
      client: `import { treaty } from "@elysia/eden";
import type { App } from "./server-app";
import { withAeolia } from "@hesperia/elysia/client";
const client = treaty<App>("http://127.0.0.1:1");
const tools = { adapt: withAeolia };
export const api = tools.adapt(client);
`,
      extraFiles: { "server-app.ts": serverTypeSource },
      shell: consumedShell,
      succeeds: false,
      diagnostic: "referenced outside a direct call",
    },
    {
      name: "passing the public factory as a higher-order argument is rejected",
      client: `import { treaty } from "@elysia/eden";
import type { App } from "./server-app";
import { withAeolia } from "@hesperia/elysia/client";
const client = treaty<App>("http://127.0.0.1:1");
const apply = (factory: typeof withAeolia) => factory(client);
export const api = apply(withAeolia);
`,
      extraFiles: { "server-app.ts": serverTypeSource },
      shell: consumedShell,
      succeeds: false,
      diagnostic: "referenced outside a direct call",
    },
    {
      name: "capturing the public factory in an object shorthand is rejected",
      client: `import { treaty } from "@elysia/eden";
import type { App } from "./server-app";
import { withAeolia } from "@hesperia/elysia/client";
const client = treaty<App>("http://127.0.0.1:1");
const tools = { withAeolia };
export const api = tools.withAeolia(client);
`,
      extraFiles: { "server-app.ts": serverTypeSource },
      shell: consumedShell,
      succeeds: false,
      diagnostic: "captured by an object shorthand",
    },
    {
      name: "capturing an immutable factory alias in an object shorthand is rejected",
      client: `import { treaty } from "@elysia/eden";
import type { App } from "./server-app";
import { withAeolia } from "@hesperia/elysia/client";
const client = treaty<App>("http://127.0.0.1:1");
const adapt = withAeolia;
const tools = { adapt };
export const api = tools.adapt(client);
`,
      extraFiles: { "server-app.ts": serverTypeSource },
      shell: consumedShell,
      succeeds: false,
      diagnostic: "captured by an object shorthand",
    },
    {
      name: "destructuring a renamed factory from the public namespace is rejected",
      client: `import { treaty } from "@elysia/eden";
import type { App } from "./server-app";
import * as adapter from "@hesperia/elysia/client";
const client = treaty<App>("http://127.0.0.1:1");
const { withAeolia: adapt } = adapter;
export const api = adapt(client);
`,
      extraFiles: { "server-app.ts": serverTypeSource },
      shell: consumedShell,
      succeeds: false,
      diagnostic: "destructured from a value that exposes the public factory",
    },
    {
      name: "destructuring the original factory name from the public namespace is rejected",
      client: `import { treaty } from "@elysia/eden";
import type { App } from "./server-app";
import * as adapter from "@hesperia/elysia/client";
const client = treaty<App>("http://127.0.0.1:1");
const { withAeolia } = adapter;
export const api = withAeolia(client);
`,
      extraFiles: { "server-app.ts": serverTypeSource },
      shell: consumedShell,
      succeeds: false,
      diagnostic: "destructured from a value that exposes the public factory",
    },
  ];

  for (const scenario of cases) {
    test(`public Elysia configuration verifies native Eden clients against the configured App: ${scenario.name}`, async () => {
      const root = await mkdtemp(join(tmpdir(), "hesperia-elysia-association-"));

      const sourceDirectory = join(root, "src");

      try {
        await linkFrameworkPackages(root, { elysia: true, eden: true, elysiaAdapter: true });

        await mkdir(sourceDirectory, { recursive: true });

        await writeFile(
          join(root, "hesperia.config.ts"),
          `import { defineConfig } from "@hesperia/tooling";
import { elysia } from "@hesperia/elysia";
export default defineConfig({ plugins: [elysia({ serverModule: "./src/server.ts", appExport: "app" })] });
`,
        );

        await writeFile(join(sourceDirectory, "server.ts"), serverSource);

        const optionalFiles = ["server-app.ts", "app-type.ts", "factory.ts"];

        await writeFile(join(sourceDirectory, "client.ts"), scenario.client);

        for (const filename of optionalFiles) {
          const source = scenario.extraFiles[filename];

          const destination = join(sourceDirectory, filename);

          if (source === undefined) await rm(destination, { force: true });
          else await writeFile(destination, source);
        }

        await writeFile(join(root, "app.tsx"), scenario.shell);

        let result: Awaited<ReturnType<typeof buildInProjectProcess>> | undefined;

        let refusal: unknown;

        try {
          result = await buildInProjectProcess(root, false);
        } catch (error) {
          refusal = error;
        }

        if (scenario.succeeds) {
          expect(refusal, scenario.name).toBeUndefined();

          expect(result, scenario.name).toBeDefined();
        } else {
          expect(refusal, scenario.name).toBeInstanceOf(ProjectError);

          const diagnostics = (refusal as ProjectError).diagnostics;

          expect(diagnostics.filter(({ severity }) => severity === "error")).toHaveLength(1);

          expect(
            diagnostics.some(
              ({ severity, message }) =>
                severity === "error" && message.includes(scenario.diagnostic!),
            ),
            scenario.name,
          ).toBe(true);
        }
      } finally {
        await unlinkFrameworkPackages(root);

        await rm(root, { recursive: true, force: true });
      }
    });
  }
}
