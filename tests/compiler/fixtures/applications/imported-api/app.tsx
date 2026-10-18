import { api } from "./src/client";
import type { Component, Rendered } from "hesperia";

export { bootstrapApplication, mount } from "hesperia/runtime";

const runtime = globalThis as typeof globalThis & {
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

export function Probe() {
  const alphaQuery = { sort: "latest" };

  const alphaHeaders = { "x-tenant": "R16_HEADER_SECRET_ALPHA" };

  const user = api.users({ id: "42" }).get({ query: alphaQuery, headers: alphaHeaders });

  alphaQuery.sort = "R16_MUTATED_QUERY_AFTER_KEY_SELECTION";

  alphaHeaders["x-tenant"] = "R16_MUTATED_HEADER_AFTER_KEY_SELECTION";

  const userOther = api.users({ id: "42" }).get({
    query: { sort: "latest" },
    headers: { "x-tenant": "R16_HEADER_SECRET_BETA" },
  });

  const globalHead = api["global-head"].get();

  runtime.__hesperiaR16QueryKeys?.push(user.key, userOther.key);

  const callerArray = ["cedar", "maple"];

  const arrayQuery = api["query-array"].get({ query: { values: callerArray } });

  callerArray[0] = "R16_MUTATED_ARRAY_AFTER_KEY_SELECTION";

  callerArray.push("R16_LATE_ARRAY_VALUE");

  const distinctArrayQuery = api["query-array"].get({ query: { values: ["cedar", "elm"] } });

  runtime.__hesperiaR16ArrayQueryKeys?.push(arrayQuery.key, distinctArrayQuery.key);

  const pathThen = api.x.then.get();

  const pathCatch = api.x.catch.get();

  const pathFinally = api.x.finally.get();

  const pathToJSON = api.toJSON.get();

  const nullable = api.nullable.get();

  const failure = api.failure.get();

  runtime.__hesperiaR16FailureReady?.push(
    failure.ready.then(
      () => ({ state: "resolved" as const }),
      (error: unknown) => ({ state: "rejected" as const, error }),
    ),
  );

  const subscriptionStatus = api["subscription-status"].get();

  const captureFirst = api.foo({ id: "early" }).bar.get();

  const captureLast = api.foo.bar({ id: "late" }).get();

  const repeatedFirst = api.items({ id: "first-A" }).parents({ id: "same" }).get();

  const repeatedSecond = api.items({ id: "first-B" }).parents({ id: "same" }).get();

  const optionalOmitted = api.files.preview({ fileId: "notes" }).get();

  const optionalPresent = api.files({ version: "v1" }).preview({ fileId: "notes" }).get();

  runtime.__hesperiaR16PathKeys?.push({
    repeatedFirst: repeatedFirst.key,
    repeatedSecond: repeatedSecond.key,
    optionalOmitted: optionalOmitted.key,
    optionalPresent: optionalPresent.key,
  });

  const save = api.save.post();

  const search = api.custom["M-SEARCH"]();

  const emptyMutation = api["empty-mutation"].post();

  const pending = api.pending.post();

  const previewRefresh = api["preview-refresh"].post();

  runtime.__hesperiaR16InitialReady?.push(
    Promise.all([
      user.ready,
      userOther.ready,
      arrayQuery.ready,
      distinctArrayQuery.ready,
      globalHead.ready,
      pathThen.ready,
      pathCatch.ready,
      pathFinally.ready,
      pathToJSON.ready,
      repeatedFirst.ready,
      repeatedSecond.ready,
      optionalOmitted.ready,
      optionalPresent.ready,
    ]),
  );

  // prettier-ignore
  return <main>
      <h1>R16_COMPILED_HTTP_SHELL</h1>
      <output id="user">{user.value()?.id ?? "pending"}|{user.value()?.sort ?? "none"}|{user.value()?.tenant ?? "none"}</output>
      <output id="user-other">{userOther.value()?.id ?? "pending"}|{userOther.value()?.sort ?? "none"}|{userOther.value()?.tenant ?? "none"}</output>
      <output id="query-array">{arrayQuery.value()?.values.join("|") ?? "pending"}|{arrayQuery.value()?.delivery ?? "pending"}</output>
      <output id="query-array-distinct">{distinctArrayQuery.value()?.values.join("|") ?? "pending"}|{distinctArrayQuery.value()?.delivery ?? "pending"}</output>
      <output id="global-head">{globalHead.value()?.head ?? "pending"}</output>
      <output id="nullable">{nullable.value() === null ? "json-null" : "pending"}</output>
      <output id="failure">{failure.error() ? "failed" : "pending"}</output>
      <output id="subscription-status">{subscriptionStatus.value()?.path ?? "pending"}</output>
      <output id="capture-first">{captureFirst.value()?.position ?? "pending"}|{captureFirst.value()?.id ?? "none"}</output>
      <output id="capture-last">{captureLast.value()?.position ?? "pending"}|{captureLast.value()?.id ?? "none"}</output>
      <output id="repeated-first">{repeatedFirst.value()?.path ?? "pending"}</output>
      <output id="repeated-second">{repeatedSecond.value()?.path ?? "pending"}</output>
      <output id="optional-omitted">{optionalOmitted.value()?.path ?? "pending"}</output>
      <output id="optional-omitted-title">{optionalOmitted.value()?.title ?? "pending"}</output>
      <output id="optional-present">{optionalPresent.value()?.path ?? "pending"}</output>
      <output id="optional-present-title">{optionalPresent.value()?.title ?? "pending"}</output>
      <output id="path-then">{pathThen.value()?.path ?? "pending"}</output>
      <output id="path-catch">{pathCatch.value()?.path ?? "pending"}</output>
      <output id="path-finally">{pathFinally.value()?.path ?? "pending"}</output>
      <output id="path-toJSON">{pathToJSON.value()?.path ?? "pending"}</output>
      <output id="saved">{save.value()?.saved ?? "pending"}</output>
      <output id="search-result">{search.value()?.kind ?? "pending"}</output>
      <button id="save" on:click={() => {
        runtime.__hesperiaR16SaveRun = Promise.resolve(save.run({
          body: { name: "tea" },
          query: { source: "button" },
          headers: { "x-save": "save-fixed" },
        }, { abortSignal: runtime.__hesperiaR16SaveSignal }));
      }}>Save</button>
      <button id="search" on:click={() => {
        runtime.__hesperiaR16SearchRun = Promise.resolve(search.run({
          body: { kind: "oolong" },
          query: { source: "button" },
        }));
      }}>M-SEARCH</button>
      <button id="query-array-revalidate" on:click={() => {
        const run = arrayQuery.revalidate();
        runtime.__hesperiaR16ArrayRevalidateRun = run;

        void run.catch(() => undefined);
      }}>Revalidate array query</button>
      <button id="empty-mutation" on:click={() => {
        runtime.__hesperiaR16EmptyMutationRun = Promise.resolve(emptyMutation.run());
      }}>Empty mutation</button>
      <button id="preview-refresh" on:click={() => {
        const run = (async () => {
          const result = await previewRefresh.run({ body: { fileId: "notes", title: "after" } });
          await optionalOmitted.ready;
          return result;
        })();
        runtime.__hesperiaR16PreviewRefreshRun = run;

        void run.catch(() => undefined);
      }}>Refresh preview</button>
      <button id="pending" on:click={() => {
        runtime.__hesperiaR16PendingRun = Promise.resolve(pending.run({ body: { note: "hold" } }));
      }}>Hold</button>
    </main>;
}

export default function AppShell(props: Component.Props<{ children: Rendered }>) {
  return (
    <html>
      <head></head>
      <body>
        <Probe />
        {props.children()}
      </body>
    </html>
  );
}
