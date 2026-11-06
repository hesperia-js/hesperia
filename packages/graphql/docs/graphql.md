# GraphQL operations

`createGraphQLClient` builds public Aeolia query and mutation definitions over
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
