import { Elysia, t } from "elysia";

type RequestRecord = { readonly name: string; readonly data: unknown };

const waiters: { readonly name: string; readonly resolve: (record: RequestRecord) => void }[] = [];

export const requests: RequestRecord[] = [];

function capture(name: string, data: unknown): void {
  const record = { name, data };

  requests.push(record);

  for (let index = waiters.length - 1; index >= 0; index--) {
    const waiter = waiters[index]!;

    if (waiter.name !== name) continue;

    waiters.splice(index, 1);

    waiter.resolve(record);
  }
}

export function waitForRequest(name: string): Promise<RequestRecord> {
  const existing = requests.find((record) => record.name === name);

  if (existing) return Promise.resolve(existing);

  return new Promise((resolve) => waiters.push({ name, resolve }));
}

let beginPending!: () => void;

export const pendingStarted = new Promise<void>((resolve) => {
  beginPending = resolve;
});

let finishPending!: () => void;

const pendingGate = new Promise<void>((resolve) => {
  finishPending = resolve;
});

export function releasePending(): void {
  finishPending();
}

const runtime = globalThis as typeof globalThis & {
  __hesperiaR16AllowServerImport?: boolean;
  __hesperiaR16ServerImports?: number;
};

if (!runtime.__hesperiaR16AllowServerImport)
  throw new Error("R16_SERVER_SOURCE_MUST_NOT_EXECUTE_DURING_ANALYSIS");

runtime.__hesperiaR16ServerImports = (runtime.__hesperiaR16ServerImports ?? 0) + 1;

const privateServerValue = "R16_EDELIA_PRIVATE_SERVER_VALUE";

const privateHandlerName = "R16_EDELIA_PRIVATE_HANDLER_NAME";

const previewTitles = new Map<string, string>([["notes", "before"]]);

let queryArrayDelivery = 0;

function privateHandler() {
  return { value: privateServerValue, handler: privateHandlerName };
}

export const app = new Elysia({ systemRouter: false })
  .get(
    "/users/:id",
    ({ params, query, headers }) => {
      const data = { id: params.id, sort: query.sort, tenant: headers["x-tenant"] };

      capture("users", data);

      return data;
    },
    {
      query: t.Object({ sort: t.String() }),
      headers: t.Object({ "x-tenant": t.String() }),
    },
  )
  .get(
    "/query-array",
    ({ query }) => {
      const data = { values: query.values, delivery: ++queryArrayDelivery };

      capture("query-array", data);

      return data;
    },
    { query: t.Object({ values: t.Array(t.String()) }) },
  )
  .get(
    "/global-head",
    ({ headers }) => {
      const data = { head: headers["x-global-head"] };

      capture("global-head", data);

      return data;
    },
    { headers: t.Object({ "x-global-head": t.String() }) },
  )
  .get(
    "/nullable",
    () => {
      capture("nullable", null);

      return new Response("null", { headers: { "content-type": "application/json" } });
    },
    { response: t.Null() },
  )
  .get("/failure", ({ set }) => {
    capture("failure", { status: 422 });

    set.status = 422;

    return { message: "expected HTTP failure" };
  })
  .get("/subscription-status", () => {
    capture("subscription-status", { path: "/subscription-status" });

    return { path: "/subscription-status" };
  })
  .get("/foo/:id/bar", ({ params }) => {
    capture("capture-first", { id: params.id });

    return { position: "capture-first", id: params.id };
  })
  .get("/foo/bar/:id", ({ params }) => {
    capture("capture-last", { id: params.id });

    return { position: "capture-last", id: params.id };
  })
  .get("/items/:id/parents/:id", ({ params, request }) => {
    const data = { id: params.id, path: new URL(request.url).pathname };

    capture("repeated", data);

    return data;
  })
  .get("/files/:version?/preview/:fileId", ({ params, request }) => {
    const data = {
      version: params.version ?? "omitted",
      fileId: params.fileId,
      title: previewTitles.get(params.fileId) ?? "missing",
      path: new URL(request.url).pathname,
    };

    capture("optional", data);

    return data;
  })
  .get("/x/then", () => {
    capture("path-then", { path: "/x/then" });

    return { path: "/x/then" };
  })
  .get("/x/catch", () => {
    capture("path-catch", { path: "/x/catch" });

    return { path: "/x/catch" };
  })
  .get("/x/finally", () => {
    capture("path-finally", { path: "/x/finally" });

    return { path: "/x/finally" };
  })
  .get("/toJSON", () => {
    capture("path-toJSON", { path: "/toJSON" });

    return { path: "/toJSON" };
  })
  .get("/private", privateHandler)
  .post(
    "/save",
    ({ body, query, headers }) => {
      capture("save", { body, query, saveHeader: headers["x-save"] });

      return { saved: body.name, source: query.source, marker: headers["x-save"] };
    },
    {
      body: t.Object({ name: t.String() }),
      query: t.Object({ source: t.String() }),
      headers: t.Object({ "x-save": t.String() }),
    },
  )
  .route(
    "M-SEARCH",
    "/custom",
    ({ body, query }) => {
      capture("m-search", { body, query });

      return { kind: body.kind, source: query.source };
    },
    {
      body: t.Object({ kind: t.String() }),
      query: t.Object({ source: t.String() }),
    },
  )
  .post("/empty-mutation", () => {
    capture("empty-mutation", { called: true });

    return { called: true };
  })
  .post(
    "/preview-refresh",
    ({ body }) => {
      previewTitles.set(body.fileId, body.title);

      capture("preview-refresh", { fileId: body.fileId, title: body.title });

      return { refreshed: body.fileId, title: body.title };
    },
    { body: t.Object({ fileId: t.String(), title: t.String() }) },
  )
  .post(
    "/pending",
    async ({ body }) => {
      capture("pending", body);

      beginPending();

      await pendingGate;

      return { complete: true };
    },
    { body: t.Object({ note: t.String() }) },
  );
