# GraphQL operations

`createGraphQLClient` builds public Aeolia query, mutation and stream definitions over
an adapter-owned Apollo Client. Supplying a link or declaring an operation does
not dispatch a request. Put those definitions in a contract, create a graph
with `createGraph({ contract })`, and adapt that same graph/contract pair with
`withAeolia` from `hesperia/aeolia`.

## Native transport and context

Pass the native Apollo link chain explicitly. A response-capture link runs ahead
of that chain to retain successful query extensions before Apollo transforms
the result. This factory does not modify an existing Apollo Client or infer its
defaults, authentication configuration or error policy.

The optional `context` supplies the factory's fixed native security and
representation scope. Include headers and other native options explicitly.
Keep response-relevant context stable while its graphs can reuse queries. When
authority changes, dispose/rebuild or reset the affected graph under its ordinary
source rules. Separate authority scopes need separately scoped graphs. Neither
Apollo's request deduplication nor its cache supplies Hesperia's query identity.

The query `key` must be nonempty and distinguish all response-relevant variables
within that context. Inputs with the same key share Aeolia value, errors,
requests, freshness and predictions. This adapter preserves ordinary borrowing:
keep reusable query variables stable while the graph can use them for refresh.

Native calls use `fetchPolicy: "no-cache"` and disable Apollo query deduplication.
The required native cache object does not become a second result-cache owner.
The graph's operation signal supplies the native HTTP fetch signal; a signal in
the configured native context cannot replace that operation authority.

## Incremental query progress

Incremental delivery is disabled unless the factory opts in with the selected
experimental profile:

```ts
const graphql = createGraphQLClient({
  link: new HttpLink({ uri: "/graphql" }),
  experimentalIncremental: { profile: "graphql17-v0.2" },
});
```

This profile uses Apollo Client 4.3.5's `GraphQL17Alpha9Handler` with the
GraphQL.js 17.0.2 `pending`/`incremental`/`completed` multipart format. The
exact Apollo Client 4.3.5 and GraphQL.js 17.0.2 pairing is an experimental
source target awaiting qualification; it is not a qualified compatibility
claim. The server must implement that format and the corresponding `@defer`
and `@stream` directives. The adapter sends the profile's Accept value only
for documents that select those directives. It does not fall back to another
incremental wire format. When an `experimentalIncremental` object is supplied,
a missing or unsupported profile throws a `TypeError` before the Apollo Client
is constructed. Incremental clients also require the effective query fetch
policy to be `no-cache`. Omitting the option keeps the existing finite query
path and does not add a progress type to the query.

For an opted-in query, the owner-bound Hesperia query view exposes `project()`.
It reports the latest Apollo result state. Accumulation and reduction policies
create independent projections over the same query execution. A prepared view
can be projected while its asynchronous input schema is validating. Its reducer
shows the declared initializer and its accumulator shows an empty array while
pending. Input rejection ends those projections without acquiring a native
query.

```tsx
const board = api.board({});
const progress = board.project();
const phase = progress.value()?.dataState ?? "pending";
```

`GraphQLProgress.dataState` comes from Apollo's public result observation. A
`streaming` value may contain `DeepPartial<TData>` because selected fields or
list items can still be missing. Apollo can also type a streaming emission as
`TData` before assembly completes, so the data shape alone does not mean the
response is complete. The adapter reports Apollo's result; it does not convert
wire patches into typed data.

The retained `ObservableQuery.reobserve()` promise supplies the returned data
and errors. Apollo Client 4.3.5 strips `dataState` and `loading` from that
promise result. After the same promise fulfills, Hesperia reads
`getCurrentResult()` from the same locally owned no-cache query. That public
observation supplies Apollo's actual final assembly state. Hesperia accepts a
successful result only when the observation is not loading, the same request's
Link completes without an error, and any observed `hasNext` is exactly `false`.
A response with no `hasNext` field is finite. Hesperia also rejects a second
entry into the same request capture. Downstream Link retries remain inside one
capture entry.

Apollo may retain `dataState: "streaming"` when its GraphQL 17 handler sees a
completed entry with errors. Hesperia reports terminal streaming only when the
same Link capture records an error-bearing `completed` entry, the Link completes
with explicit `hasNext: false`, and Apollo's non-loading final observation
remains streaming. Under `all`, the original promise must also expose
CombinedGraphQLErrors. Under `ignore`, the capture retains raw error evidence
while the returned envelope omits errors. The adapter preserves Apollo's final
state. It does not correlate completed IDs with pending IDs, so it does not
certify identifier consistency in the incremental wire protocol.

The Hesperia progress status becomes `complete` only after the result and
any bound output validation succeed. Under `none`, Apollo rejects GraphQL errors.
Apollo Client 4.3.5 uses `dataState: "empty"` for both `data: null` and
undefined data. Hesperia reports terminal empty progress only when the original
reobserve promise and the same query's final non-loading observation both contain
strict `data: null`, the observation state is `empty`, and the same captured
Link completes without an error. If any frame has `hasNext`, its latest value
must be exactly `false`. The adapter does not treat `dataState: "empty"`
alone as proof of null data.

The final progress value is `{ dataState: "empty", data: null }`. It retains
the response's `errors` and `extensions` under the selected native query
error policy. Missing or undefined data, a transport failure, or a truncated
stream does not produce terminal empty progress. Incremental cache hits and
cache-only misses are unavailable because incremental clients require no-cache.
If output validation rejects, the raw empty value remains available while
progress status is `failed`.

Progress metadata comes from the response frames. `errors` preserves the errors
captured from the top-level frame, incremental entries and completion entries
in frame order, subject to the selected native error policy. `extensions`
uses the latest actual top-level extension object. Nested incremental
extensions are not promoted or merged into it.

The native progress snapshot remains active until the retained query promise
and any bound output schema validation succeed. If validation fails, progress
status becomes `failed` while the last raw value remains available, including
streaming, complete or empty assembly. Cancellation detaches the progress
observer promptly and forwards the query's abort signal through the native
context. Local cancellation does not establish remote resolver completion or
acknowledgement.

## Incoming subscriptions

Supply an Apollo subscription link and declare an ordinary keyed stream with
`graphql.subscription()`. For the experimental `graphql-transport-ws` profile,
use `graphql-ws@6.4.1` with Apollo Client 4.3.5 and GraphQL 17.0.2. Add
`graphql-ws` to the application that configures the socket:

```ts
import { GraphQLWsLink } from "@apollo/client/link/subscriptions";
import type { TypedDocumentNode } from "@apollo/client";
import { createGraphQLClient } from "@hesperia/graphql/client";
import { createGraph, defineContract } from "aeolia";
import { parse } from "graphql";
import { createClient } from "graphql-ws";
import { withAeolia } from "hesperia/aeolia";

const socket = createClient({ url: "wss://example.com/graphql" });
const graphql = createGraphQLClient({ link: new GraphQLWsLink(socket) });
const document = parse(`
  subscription Events($room: ID!) {
    event(room: $room) { message }
  }
`) as TypedDocumentNode<{ event: { message: string } }, { room: string }>;
const events = graphql.subscription({
  name: "events",
  document,
  key: ({ room }) => room,
});
const contract = defineContract({ namespace: "chat", operations: { events } });
const graph = createGraph({ contract });

export const api = withAeolia(graph, contract);

export async function disposeChat(): Promise<void> {
  graph.dispose();
  graphql.stop();

  await socket.dispose();
}
```

Declaring a subscription performs no native work. An owner-bound Feed activates
through the ordinary Hesperia component lifecycle. Inputs with the same key in
the same graph share one stream source and its native operation. Include all
response-relevant variables in the key and scope graphs to the factory's fixed
authority context, as for queries. Each Feed's projection has its own state;
removing one consumer does not dispose the caller's socket.

```tsx
import { api } from "../chat.ts";

export default function Messages() {
  const events = api.events({ room: "general" });

  return <p>{events.value()?.data?.event.message ?? "Waiting for an event"}</p>;
}
```

Each emitted value is a `GraphQLResult<TData>`. The subscription error policy
defaults to `none`; set `subscriptionErrorPolicy` on the factory or `errorPolicy`
on a declaration to change it. An execution-error `Next` event stays
nonterminal. Under `none`, its data is omitted while its available errors and
extensions remain. Under `all`, partial data and errors remain together. Under
`ignore`, execution errors are omitted; an error-only event without data is
suppressed. A later valid event can update the same Feed under all three
policies. An explicit `data: null` execution value remains distinct from absent
data, including when Apollo filters its public notification.

An errors-only raw `Next` without defined data also follows the native event
policy: `none` and `all` emit its available errors/extensions without a data
field, while `ignore` suppresses it. It remains nonterminal. The adapter does
not classify a `Next` as a finite request failure merely because data is absent.

A protocol `Error` or Link error fails the stream under every policy, including
`ignore`. A normal protocol `Complete` closes it. The adapter captures these
Link notifications per operation before Apollo transforms errors into value
notifications or completion. A supplied native link can also complete after
caller socket disposal; graphql-ws 6.4.1 does so without a server `Complete`
message. Feed status describes the ordinary stream lifecycle. A closed Feed
does not establish a successful remote terminal result or acknowledge server
cleanup.

Graph retirement aborts the open operation's signal and returns its iterator.
Iterator return and `graphql.stop()` unsubscribe the native operation and fence
later callbacks. Cancellation drops queued values; natural completion and
failure preserve earlier queued events in order. These local cleanup calls do
not await a server acknowledgement or dispose a shared socket. The caller owns
authentication, reconnect configuration and `socket.dispose()`. A factory does
not dispose a socket supplied through an Apollo link.

Subscription calls use `fetchPolicy: "no-cache"` and independent operation
dispatch. Incoming subscriptions use the
ordinary receive-only StreamDefinition/Feed API, including its existing latest,
accumulation and reduction views.

## Query results and errors

The query definition returns `GraphQLResult<TData>`, with available `data`,
`errors` and `extensions`. Execution can produce partial data with field errors,
or `data: null`. The default query policy is Apollo's `all`, so those execution
results resolve as one ordinary query value. Request errors without an execution
data field reject. Transport, response decoding and cancellation failures remain
failures under the applicable native policy and graph lifecycle.

Set `queryErrorPolicy` on the factory or `errorPolicy` on a query declaration to
choose an explicit native policy. `none` rejects GraphQL errors; `all` preserves
them with the available data; `ignore` omits deliberately ignored errors. An
ignored-error policy does not turn a missing execution result into valid data.
The adapter does not reconstruct information discarded by the native transport.

When a rejection has a captured GraphQL envelope, an ordinary Error carries it
in the optional `result` property. Its native failure is retained as `cause`.
This does not introduce another Aeolia status. Failed refresh follows the
existing query behavior, including retention of a previously committed value.

## Mutation effects and optimistic state

Declare a mutation with `graphql.mutation({ name, document, affects })`. `affects`
is the ordinary public Aeolia effect list. Use `affects(query, { select, on,
optimistic })` from `aeolia` to select existing query stores, choose settled
invalidation/revalidation, and provide any optimistic prediction explicitly.
The adapter never infers effects from a document or normalized entity identifier.

The default mutation policy is `none`: GraphQL execution errors reject even if
the response contains some data. Available response fields remain on the
ordinary Error's `result`. Aeolia removes that attempt's predictions and skips
ordinary successful effects. The server may already have written data; rejection
does not imply rollback or authorize automatic retry, replay or invalidation.

An explicitly selected `mutationErrorPolicy`, or a declaration's `errorPolicy`,
keeps its native meaning. Under `all`, a completed envelope containing errors
can be an authored successful native outcome. Under `ignore`, ignored errors
are omitted. Native optimistic responses, cache update callbacks and automatic
refetches are not configured by this factory. Aeolia remains the prediction and
declared-effect owner.

## Ownership and shutdown

Public `withAeolia` supplies Hesperia's ordinary QueryView and dormant mutation
Task. Component/query retention, caller cancellation, graph reset, prediction
settlement and late-publication authority remain with those existing lifecycles.
A callback forwards its graph-owned signal to the native call and checks it
again before returning a result. Canceling local authority does not prove a
remote resolver or an already-applied backend write stopped.

Dispose every graph using the factory before calling `graphql.stop()`. That
method stops its owned Apollo Client, is idempotent, and prevents later callbacks
from starting native work. It does not dispose graphs on the caller's behalf.

## Typed declarations and native compatibility

Use a `TypedDocumentNode<TData, TVariables>` from Apollo's public types or a
compatible native generator. Query keys, mutation inputs, effect selectors and
predictions retain those variable/result types. For an operation with no
variables, use the document's empty variable object with its normal definition.

This entry handles finite operations with the selected Apollo 4.3.5,
GraphQL 17.0.2 and RxJS 7.8.2 profile. A native link is still responsible for
wire encoding, headers and reaching the corresponding server schema. Document
types cannot verify a deployed endpoint. Additional validation is not enabled
by discovering a GraphQL schema.
