# Elysia HTTP routes and Eden clients

Reader: a TypeScript application author using Elysia, Eden, and Hesperia components.

The Elysia integration connects four parts of an application:

- **Elysia** defines the server's HTTP routes.
- **Eden** creates the typed Treaty client for those routes.
- **Aeolia** owns query and mutation state for calls made by components.
- **Hesperia** checks that the client refers to the configured server App, extracts browser-safe route facts, and gives each consuming component its own query views and mutation tasks.

The server module is analyzed for types. Hesperia does not execute it in the browser or import its runtime values into the client bundle. At runtime, `treaty<App>(url)` is an Eden proxy configured with a URL; the generic `App` parameter supplies types, while the URL supplies the request destination.

The integration is part of Hesperia's alpha release channel. Use matching Hesperia alpha packages, Eden 1.4.10, and Aeolia 1.0.0-alpha.1.

## Select the server App

Configure the Elysia plugin in `hesperia.config.ts`. `serverModule` is resolved from the project root, and `appExport` names the Elysia App value to inspect.

```ts
import { elysia } from "@hesperia/elysia";
import { defineConfig } from "@hesperia/tooling";

export default defineConfig({
  plugins: [
    elysia({
      serverModule: "./src/server.ts",
      appExport: "app",
      serverEffectsExport: "effects",
    }),
  ],
});
```

For example, the Elysia server can serve both application requests and API routes:

```ts
import { Elysia, t } from "elysia";
import { defineEdenEffect } from "@hesperia/elysia/effects";
import { handleHesperiaRequest } from "./server-internals.ts";

const notes: { id: number; text: string }[] = [];
let nextNoteId = 1;

export const app = new Elysia()
  .onRequest(({ request }) => handleHesperiaRequest(request))
  .get("/api/notes", () => notes)
  .post(
    "/api/notes",
    ({ body }) => {
      const note = { id: nextNoteId++, text: body.text };
      notes.push(note);
      return note;
    },
    { body: t.Object({ text: t.String({ minLength: 1 }) }) },
  );

export type App = typeof app;

export const effects = [
  defineEdenEffect<App>()(
    { method: "POST", path: "/api/notes" },
    { method: "GET", path: "/api/notes" },
    () => ({}),
    "revalidate",
  ),
];
```

The Elysia starter generates `src/server-internals.ts`, including `handleHesperiaRequest`, and initializes its host from `src/server-entry.ts`. The import above refers to that generated support module. A hand-written server needs its own initialized Hesperia host and request handler; see [application hosting](https://github.com/hesperia-js/hesperia/blob/main/packages/tooling/docs/project-configuration.md#application-mount-and-generated-assets).

The `onRequest` hook lets the server pass Hesperia-owned document and asset requests to its host. It can also widen Eden's checked route result: the response type may include `Response` or `undefined` in addition to the route's returned data. The client code must handle those cases.

## Create the browser client

In a browser module, import `withAeolia` from the browser-safe `@hesperia/elysia/client` subpath. Pass it the one-argument native Eden client. Keep the `App` import type-only so the server module is not loaded at runtime.

```ts
import { treaty } from "@elysia/eden";
import { withAeolia } from "@hesperia/elysia/client";
import type { App } from "./server.ts";

export const api = withAeolia(treaty<App>(globalThis.location.origin));
```

The configured server App and the `App` type used for `treaty<App>` must refer to the same checked export. Hesperia verifies that association during project analysis. The URL passed to `treaty` is a separate runtime value that determines where HTTP requests go. The type check cannot verify that the application deployed at that URL implements the selected App.

Configure shared Eden headers, fetch defaults, and hooks in `treaty(url, config)` before passing the client to `withAeolia`. The adapter keeps that native client and supplies the current task's cancellation signal for each request. Adapted calls expose route-specific body, query, and header fields; Eden's per-call `fetch` and `throwHttpError` options are not part of their request object. Task options belong in the separate options argument shown below.

## Acquire and use operations in a component

Access routes through Eden's path builder. For `/api/notes`, the Treaty path is `api.api.notes`; a route component can acquire the query and mutation there:

```tsx
import { api } from "../client.ts";

function formatNotes(value: { id: number; text: string }[] | Response | undefined) {
  if (value === undefined) return "Loading notes…";
  if (value instanceof Response) return "The host handled this request.";
  return value.map((note) => `${note.id}: ${note.text}`).join("\n");
}

export default function NotesPage() {
  const notes = api.api.notes.get();
  const createNote = api.api.notes.post();

  return (
    <main>
      <output>{formatNotes(notes.value())}</output>
      <button
        type="button"
        on:click={async () => {
          await createNote.run({ body: { text: "A new note" } });
        }}
      >
        Create note
      </button>
    </main>
  );
}
```

For a route such as `/users/:id`, Treaty uses a path builder for the captured parameter, then a request object for query values and explicit headers. This separate example assumes your App declares that GET route with a `sort` query field and an `x-tenant` header; those fields are absent from the notes server above:

```ts
const user = api.users({ id: "42" }).get({
  query: { sort: "latest" },
  headers: { "x-tenant": "acme" },
});
```

Calls through one exported `api` share its Aeolia graph. A query's identity includes its route, captured path parameters, query values, and explicit headers: equivalent calls share the same query state, while different request variants stay distinct. Hesperia projects that state to each consuming component owner.

Queries and mutations are acquired while the component owner is active. Acquiring a mutation does not send a request; `run(...)` dispatches it. Destroying the component cancels its task, and a later run on the same task supersedes its previous run. A cached page keeps its component owner: reactivity pauses, but an existing task may settle while the page is cached. Keep calls inside the component that owns their lifetime.

Mutation request fields follow the native route: use `body`, `query`, and `headers` for the HTTP request. Pass task options separately as the second argument. For example, `abortSignal` is an option, not a request field. The following example assumes a separate POST `/save` route accepting these fields; it is not a call to the notes server above. Acquire its task in the component body:

```ts
const save = api.save.post();
```

Then invoke it from an event handler or task:

```ts
const controller = new AbortController();

await save.run(
  {
    body: { name: "tea" },
    query: { source: "button" },
    headers: { "x-save": "save-fixed" },
  },
  { abortSignal: controller.signal },
);
```

The query result can be `undefined` while it is pending and can be a `Response` when the host handles the request. A mutation result can also be a `Response`. Narrow these values before reading route-specific fields. For the notes route, the data branches are an array of `{ id, text }` records and a single `{ id, text }` record respectively.

## Query options

Use `queryOptions` from `hesperia/aeolia` for the query's Aeolia options. Keep the native request in the first position and options in the second:

```ts
import { queryOptions } from "hesperia/aeolia";

const notes = api.api.notes.get(
  undefined,
  queryOptions({ initial: [] as { id: number; text: string }[], revalidateAfterMs: 5_000 }),
);
```

Eden's optional query/header request object remains an input even when `.get()` accepts no argument. Supplying `undefined` explicitly keeps the query options in their own position. The constructor returns a frozen, shallowly readonly copy and preserves the option value types. See [query and mutation options](https://github.com/hesperia-js/hesperia/blob/main/docs/data.md#query-and-mutation-options) for no-input Aeolia operations and checked input/options overlap.

## Declare query effects

The notes server above exports an effects array, selected by `serverEffectsExport: "effects"`. Its POST-to-GET declaration refreshes the existing notes query after a successful native mutation. With that declaration configured, the component's event handler only dispatches the mutation. A mutation with no configured declaration can use an explicit `notes.revalidate()` call.

`defineEdenEffect<App>()` is an inert declaration helper from `@hesperia/elysia/effects`. Its first two arguments select a non-GET/HEAD mutation and a GET/HEAD query from the configured App. The selector receives the mutation's inferred `params`, `body`, `query`, and explicit `headers`, and returns the target query's inferred `params`, `query`, and explicit `headers`. Required fields follow the native schemas. Keep the selector synchronous and pure: Aeolia evaluates it before invocation and again when applying the effect after a successful response.

For example, a selector can map a POST body identifier to a GET path parameter:

```ts
defineEdenEffect<App>()(
  { method: "POST", path: "/notes/rename" },
  { method: "GET", path: "/notes/:id" },
  ({ body }) => ({ params: { id: body.id } }),
  "revalidate",
);
```

This separate example assumes the App declares those routes and a POST body with an `id` field. Captured path parameters, query values, and explicit headers select a particular query variant. An omitted optional path parameter remains omitted; another variant with that parameter present keeps its own state. `"revalidate"` requests fresh data for the selected query; `"invalidate"` marks its data stale under Aeolia's normal liveness rules. Failed native mutations do not apply the settled query effect.

Effects can also come from a browser module. Export another const array of `defineEdenEffect<App>()` declarations with a type-only App import, then configure both client fields:

```ts
elysia({
  serverModule: "./src/server.ts",
  appExport: "app",
  serverEffectsExport: "effects",
  clientEffectsModule: "./src/client-effects.ts",
  clientEffectsExport: "effects",
});
```

`serverEffectsExport` is optional. The two client fields must be supplied together. The compiler resolves each configured export statically and verifies its App against the configured server value.

For each mutation-to-query route pair:

- Within one side's array, aliases of the same selector function share its identity. Duplicate declarations with the same action are deduplicated; the same function with both actions retains both declarations.
- Different selector functions on the same side conflict, including functions with identical source text. The conflict rejects the configured set.
- Client declarations replace server declarations for the same route pair. A changed selector or action set produces a build warning and a browser `console.warn`.

Hesperia publishes the selected selectors and their used dependencies after checking browser capabilities. Unused server handlers, bindings, and effect declarations are omitted. A server selector's used browser-safe captures become part of the browser output, including captures reached through imported helpers. Keep server-only capabilities out of that dependency closure.

The current static declaration format supports const arrays and resolved aliases, and rejects array spreads. Selected declarations and dependencies must match their unchanged captured source; transformed selector code is rejected when the checked interpretation cannot be preserved. Dynamic dependency access that would require unresolved or unselected exports is also rejected. The compiler emits maps back to authored selector sources without copying those sources' contents into the map.

## Current limits

Use this adapter for ordinary HTTP query and mutation results. WebSocket and streaming operations require a later transport design. The compiler reports work-in-progress errors when a checked successful response branch contains a native `Generator`, `AsyncGenerator`, or `ReadableStream`, including type aliases and unions with ordinary response types. A generator that yields nothing and returns an ordinary completion value remains an ordinary data result. A stream returned only at an error status does not trigger the successful-response guard.

Ordinary opaque `Response` values remain permitted. The compiler does not infer streaming or server-sent events from response contents or headers. Successful compilation does not establish support for a streaming transport hidden behind an opaque response type.

Eden reserves the exact lowercase `subscribe` property throughout its checked path tree. The compiler rejects HTTP routes with a literal `subscribe` path segment, including nested and intermediate segments and methods other than GET. A custom HTTP `SUBSCRIBE` route is separately rejected because Eden dispatches `.subscribe()` as WebSocket transport. A parameter named `:subscribe` and a path such as `/subscription-status` do not have the reserved literal segment.

Custom HTTP methods require support from both Eden's client transport and the server runtime. In the pinned Elysia and Bun setup, the `M-SEARCH` example carries a JSON body through to the route handler. Bun's `Request` constructor changes `BREW` to `GET`, and its listener rejects raw `BREW` before the handler runs. See [project configuration](https://github.com/hesperia-js/hesperia/blob/main/packages/tooling/docs/project-configuration.md) for the tested runtime context.

The `create-hesperia` CLI defaults to the Elysia starter. Pass `--host elysia` to select it explicitly, or `--host none` to create the frontend starter without an Elysia host. When the flag is omitted in an interactive terminal, choose option 2 for no host.

The generated Elysia starter still opens on its counter page. It also provides the explicit server plugin configuration and a typed `src/client.ts` entry for route components to use; adding that client does not replace the starter page.

The starter's server loads `.hesperia/build` with `readBuild` from
`@hesperia/hosting`, then passes the captured record and Blob map to `createHost`.
The published browser build can be served without the application source tree.
See [project configuration](https://github.com/hesperia-js/hesperia/blob/main/packages/tooling/docs/project-configuration.md) for capture validation and
publication behavior.
