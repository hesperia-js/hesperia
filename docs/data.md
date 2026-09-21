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
only adapts the resulting graph and matching contract to owner-bound views. See
Aeolia's [managed-state guide](../../aeolia/docs/managed-state.md) for the
operation definitions and callback options. Import the adapter from the
published `hesperia/aeolia` subpath as shown above.

The graph and stores stay shared by the adapter. The compiler binds each
imported API to the current component owner, so query views, feeds, and task
handles retain separate cancellation and read lifetimes. Disposing one owner
revokes only that owner's projection and work; it does not dispose the shared
graph. Ordinary imported values keep their native identity.

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

```ts
const caller = new AbortController();
const run = save.run({ name: "Ada" }, { abortSignal: caller.signal });
caller.abort();
```

The controller exposes `run`, `value`, `pending`, `error`, and `status`. The
per-run handle returned by `run` is directly awaitable and also provides its
`id`, `signal`, and `cancel` method. Disposing the owning component cancels
its current run and revokes the controller's reads.

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
method in this milestone.

When the router parks a page in its history cache, Hesperia suspends that
page's feed listeners and keeps each current projected value. Restoring the
page reconnects the listeners and resumes each projection without running the
component body again. A source factory lets the restored view reacquire the
keyed source after Aeolia collects an unobserved session. Releasing the owner
removes the feed listeners and drops the views' source references. The shared
stream's continued lifetime and collection are governed by Aeolia's stream
policy: other owners can keep it alive, and the source may be collected after
its listeners leave.

See [History page cache](routing-cache.md) for the page-level retention limit,
FIFO eviction, task behavior, and shared-layout rules.
