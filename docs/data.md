# Data members

Reader: a junior engineer familiar with TypeScript, promises, and Hesperia accessors.

Data members connect a component to shared Aeolia state. A **query** reads one
keyed resource and can refresh it. A **feed** reads a live stream and may keep
an accumulated or otherwise projected value. Both expose owner-bound views:
their reads stop being valid when the component owner is released.

An adapter module constructs an Aeolia graph and its matching contract, then
exports the adapted API. Components import that value directly from the module.
There is no startup registration step and no `client.api` property.

```tsx
import { AsyncBoundary, type Component } from "hesperia";
import { api } from "./api.ts";

async function User(props: Component.Props<{ id: string }>) {
  const view = api.users.get(props.id());
  const user = await view;
  return <span>{user().name}</span>;
}

export function App() {
  return (
    <AsyncBoundary fallback={<span>Loading...</span>}>
      <User id="ada" />
    </AsyncBoundary>
  );
}
```

`view.value()` is the synchronous live read and may be absent while the first
request is pending. `await view` is different: it waits for usable data when
the view has no committed value, then returns a callable live accessor. Calling
that accessor reads the current owner-bound value; it is not a frozen snapshot.
The component body above therefore calls `user()` after the await. An async
component using this form needs an `AsyncBoundary` around it. If the view is
already ready, stale, or revalidating, the await resolves immediately and
starts a refresh when no request is running.

`view.ready` remains the original Aeolia readiness promise. Awaiting it keeps
Aeolia's semantics and does not return Hesperia's live accessor. Use it when
interoperating with Aeolia directly; use `await view` for the Hesperia query
wait described above.

Query waits have explicit failure behavior. An initial request failure rejects
with the backend error. If a view is already in `failed` status, awaiting it
rejects immediately with `{ status: "failed", error }` and starts one shared
recovery attempt. A failed recovery stays disarmed until the author explicitly
calls `view.revalidate()`.

The public Hesperia adapter accepts the graph and contract produced by the
application's Aeolia setup:

```ts
import { createGraph, createQuery, defineContract } from "aeolia";
import { withAeolia } from "hesperia/aeolia";

async function loadUser(id: string, signal: AbortSignal): Promise<{ id: string; name: string }> {
  const response = await fetch(`/api/users/${encodeURIComponent(id)}`, { signal });
  if (!response.ok) throw new Error(`User request failed: ${response.status}`);
  return (await response.json()) as { id: string; name: string };
}

const getUser = createQuery({
  name: "users.get",
  key: (id: string) => `users/${id}`,
  fetch: (id, { abortSignal }) => loadUser(id, abortSignal),
});
const operations = { users: { get: getUser } };
const contract = defineContract({ namespace: "app", operations });
const graph = createGraph({ contract });
export const api = withAeolia(graph, contract);
```

Define `operations` with Aeolia's `createQuery`, `createMutation`, and/or
`createStream`; those definitions own the backend callbacks and I/O. Hesperia
only adapts the resulting graph and matching contract to owner-bound views. The
example above shows a query definition and adapter setup; the sections below
describe query options, owner-bound reads, and reset behavior. Import the
adapter from the published `hesperia/aeolia` subpath as shown above.

The graph and stores stay shared by the adapter. The compiler binds each
imported API to the current component owner, so query views, feeds, and task
handles retain separate cancellation and read lifetimes. Disposing one owner
revokes only that owner's projection and work; it does not dispose the shared
graph. Ordinary imported values keep their native identity.

### Query and mutation options

Import `queryOptions` from `hesperia/aeolia` when supplying query or mutation
options. It is the same constructor exported by Aeolia. It returns a frozen,
shallowly readonly copy with a private brand; nested option values keep their
original references. The operation validates its option values when called.

For an input-bearing query, supply the input and options separately:

```ts
import { queryOptions } from "hesperia/aeolia";
import { api } from "./api.ts";

const user = api.users.get("ada", queryOptions({ revalidateAfterMs: 5_000 }));
```

A query whose key and fetch callbacks both have zero parameters infers `void`
input. A mutation with a zero-parameter run callback and no effects also infers
`void`. Those operations accept `queryOptions(...)` in the first argument
position, including `queryOptions({})`. Callbacks with an optional object
parameter remain input-bearing.

For example, assume `api.notes.list` is a no-input query returning a readonly
array of strings, and `api.session.refresh` is a no-input mutation:

```ts
const notes = api.notes.list(
  queryOptions({ initial: ["First note"] as readonly string[], revalidateAfterMs: 5_000 }),
);
const refresh = api.session.refresh();
```

Acquire the mutation controller in the component body, then dispatch it from
an event handler or task:

```ts
const controller = new AbortController();
await refresh.run(queryOptions({ abortSignal: controller.signal }));
```

`queryOptions` does not remove an operation's declared input. Hesperia checks
single-argument operation calls against their concrete input and options
types. An argument that fits both produces `HES-API-CALL`; supply both
positions explicitly, such as `api.lookup(input, queryOptions({}))` or
`api.lookup(input, undefined)`. A typed input with a field such as
`revalidateAfterMs: string` remains input when it does not fit the options
type.

### Resetting an adapted graph

Call the named `reset` helper with the API returned by `withAeolia` when the
application needs to reset shared query state:

```ts
import { reset } from "hesperia/aeolia";
import { api } from "./api.ts";

await reset(api);
```

The helper forwards the graph's reset promise unchanged. Calling
`graph.reset()` directly has the same Hesperia recovery behavior. A reset keeps
the graph, adapted API, query stores, and saved raw `view.source` objects; it
advances the graph's reset version and clears the old query state. Existing
`QueryView` objects and awaited accessors remain tied to their creating owner.
After that owner is released, they fault as disposed. A still-live awaited
accessor drops its pre-reset cached value and faults while the new query has no
fresh committed value.

An affected `AsyncBoundary` tracks sources read while rendering content or
awaited by a component body. It retires the old content owner, shows its
fallback, and builds fresh content after those consumed sources have reached a
fresh terminal state. A callback that reads one of those sources from a
still-live owner while recovery is pending faults immediately and is not
queued or replayed. Merely obtaining `view.source` does not make the query a
rendered dependency. `view.ready` keeps Aeolia's original promise semantics
without joining the boundary's fresh-data wait. Both a render read of
`value()`, `pending()`, `status()`, or `error()` and awaiting the view in a
component body consume the query.
The ordinary same-identity refresh behavior is unchanged: a live
accessor may keep its cached value while that query is revalidating without a
graph reset.

The reset promise covers query work that was active when reset began. It
resolves after those fresh requests succeed, rejects with the original error
for one failed request, or rejects with an `AggregateError` when several fail.
It does not wait for stream emissions or for Hesperia's later DOM and effect
activation. A page parked in the history cache keeps its reset observation but
does not keep its query active. If it is restored after a reset, stale content
stays retired while its consumed sources fetch fresh data.

Hesperia adapts an Aeolia contract to owner-bound views. Query and stream
members keep their input at construction because that input identifies the
shared resource. A mutation member has a different lifetime: calling the
member creates a dormant task controller, and each `run` supplies the payload
for that invocation.

```ts
const save = api.profile.save();

const first = save.run({ name: "Ada" });
const second = save.run({ name: "Grace" });
```

The second invocation becomes the current run and cancels the first through
its owner-bound signal. A late result from the first operation cannot replace
the second run's `value`, `status`, or `error`. Constructing the controller
does not call the backend, which lets components create task handles during
their body without dispatching work. Dispatch is rejected if `run` is called
while a component body is executing.

The optional second argument to `run` carries the underlying Aeolia mutation
options for that invocation. In particular, `abortSignal` is combined with
the task-run and owner signals, so caller cancellation rejects that run and
does not become the task's ordinary failure value. Other Aeolia options are
forwarded unchanged.

When a graph reset cancels a pending adapted mutation, its run handle rejects
with an `AbortError`, while the controller reports `cancelled`, has no pending
work or error, and keeps its last successful value. Starting another run
clears that retained value as the new invocation becomes pending. The
controller remains tied to its creating owner; resetting its graph does not
cancel a generic task created with `client.task` by the same owner.

```ts
const caller = new AbortController();
const run = save.run({ name: "Ada" }, { abortSignal: caller.signal });
caller.abort();
```

The controller exposes `run`, `value`, `pending`, `error`, and `status`. The
per-run handle returned by `run` is directly awaitable and also provides its
`id`, `signal`, and `cancel` method. Disposing the owning component cancels
its current run and revokes the controller's reads.

### Generic client tasks

`client.task` infers its input from the operation returned by the factory. A
zero-argument operation has `void` input, so you can call `run()` or pass
`undefined`. An optional parameter, such as `input?: string`, and a parameter
with a default value, such as `input = "all"`, also allow `run()` without an
argument. A required parameter keeps its type and stays required on `run`, even
when its type includes `undefined`: call `run(undefined)` for
`input: string | undefined`.

Let the callback's parameter annotation supply the input type when you want
this inference. Explicit type arguments, such as `client.task<string, number>`,
declare a required input instead.

Create task controllers in the component body, then start their work from an
event handler or an effect. Each `run` calls the factory again with a fresh
`signal` and uses the new operation it returns. Do not call `run` while the
component body executes.

```tsx
import * as client from "hesperia/client";

function TaskButtons() {
  const refresh = client.task(({ signal }) => async (scope?: string) => {
    const path =
      scope === undefined ? "/api/refresh" : `/api/refresh?scope=${encodeURIComponent(scope)}`;
    const response = await fetch(path, { signal });
    if (!response.ok) throw new Error("Refresh failed");
  });
  const save = client.task(({ signal }) => async (input: { name: string }) => {
    const response = await fetch("/api/profile", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
      signal,
    });
    if (!response.ok) throw new Error("Save failed");
  });

  return (
    <section>
      <button
        on:click={() => {
          void refresh.run();
        }}
      >
        Refresh all
      </button>
      <button
        on:click={() => {
          void refresh.run("profile");
        }}
      >
        Refresh profile
      </button>
      <button
        on:click={() => {
          void save.run({ name: "Ada" });
        }}
      >
        Save profile
      </button>
      <output>
        {refresh.status()}:{save.status()}
      </output>
    </section>
  );
}
```

## Feeds

A feed is a live owner-bound view over a shared Aeolia stream. Its `value`,
`pending`, `error`, and `status` accessors report the source or its configured
projection. A feed is dormant while a component is being prepared: its status
is `"empty"`, and reading `source` is invalid. The feed activates after the
owner commits, which is when it obtains the source and attaches a projection.
Reads made by rendered content during preparation observe that activation and
subsequent emissions without rerunning the component body.

The current `withAeolia` stream member exposes a latest-value view. Call
`feed.project(policy)` when a component needs an independent accumulated or
reduced value from that same shared stream:

```tsx
function Activity() {
  const events = api.activity.events("all");
  const recent = events.project({
    kind: "accumulate",
    max: 100,
    onOverflow: "drop-oldest",
  });
  const count = events.project({
    kind: "reduce",
    initial: 0,
    step: (total, event) => total + (event.kind === "view" ? 1 : 0),
  });

  return (
    <output>
      {recent.value().length} recent events, {count.value()} views
    </output>
  );
}
```

Each call returns a separate view with its own projection state. The latest
view and every projection consume the same keyed source, so equal emissions
still reach every projection while the backend opens only one shared stream.
The source stays cold until the component owner commits. Accumulation starts
with an empty readonly array. Reduction starts with its `initial` value.

`onOverflow` defaults to `"fail"`; an accumulated view enters `failed` and
keeps its last successful value when the next emission would exceed `max`.
Use `onOverflow: "drop-oldest"` to keep the most recent `max` events. A reducer that throws
also fails only its own view, and its error is exposed through that view's
`error()` accessor.

The returned projected view has the same `value`, `pending`, `error`, and `status`
accessors and `source` getter as the latest view. You can create several projections
from the original stream handle. Projected views do not expose another `.project`
method.

When the router parks a page in its history cache, Hesperia suspends that
page's feed listeners and keeps each current projected value. Restoring the
page reconnects the listeners and resumes each projection without running the
component body again. A graph reset clears accumulated history and restores
each reducer's authored `initial` value, including while the page is parked.
Live projections build on that fresh state after reset. Reset also clears
projection errors, but failed or completed projections remain terminal and
ignore later stream emissions. A source factory lets the
restored view reacquire the keyed source after Aeolia collects an unobserved
session. Releasing the owner
removes the feed listeners and drops the views' source references. The shared
stream's continued lifetime and collection are governed by Aeolia's stream
policy: other owners can keep it alive, and the source may be collected after
its listeners leave.

See [History page cache](routing-cache.md) for the page-level retention limit,
FIFO eviction, task behavior, and shared-layout rules.
