# @hesperia/grpc

`@hesperia/grpc` adapts generated Protobuf service methods to Aeolia query, mutation, and server-stream definitions.

The root entry accepts a caller-supplied Connect `Transport`; it does not select one. This Node-only example imports `createGrpcTransport` from `@hesperia/grpc/native`, which uses Node HTTP/2 and requires Node.js 22 or later. Keep that import out of browser code. The package supplies no browser transport or SSR path.

Assume your generated service descriptor contains unary `getAccount` and `updateAccount` methods and a server-streaming `watchAccount` method:

```ts
import { affects, createGraph, defineContract } from "aeolia";
import { grpcMutation, grpcQuery, grpcStream } from "@hesperia/grpc";
import { createGrpcTransport } from "@hesperia/grpc/native";
import { AccountService } from "./gen/account/v1/account_pb.js";

const transport = createGrpcTransport({ baseUrl: "https://api.example.com" });

const getAccount = grpcQuery({
  transport,
  method: AccountService.method.getAccount,
  name: "accounts.get",
  key: (request) => `account:${request.accountId ?? ""}`,
});

const updateAccount = grpcMutation({
  transport,
  method: AccountService.method.updateAccount,
  name: "accounts.update",
  affects: [
    affects(getAccount, {
      select: (request) => ({ accountId: request.accountId }),
      on: "revalidate",
    }),
  ],
});

const accountEvents = grpcStream({
  transport,
  method: AccountService.method.watchAccount,
  name: "accounts.watch",
  key: (request) => `account-events:${request.accountId ?? ""}`,
});

const contract = defineContract({
  namespace: "app.accounts",
  operations: { getAccount, updateAccount, accountEvents },
});

export const accountsGraph = createGraph({ contract });
```

Choose query or mutation explicitly. Protobuf idempotency options and method names do not make that choice for you. The adapter returns the generated message values and keeps errors in Connect's native form.

To expose the graph to Hesperia components, bind it with `withAeolia`. Aeolia owns operation identity and state. Component and browser integrations must provide and qualify a transport compatible with their execution environment.

## Choose a transport

Pass a transport to each operation definition:

```ts
import { grpcQuery } from "@hesperia/grpc";
import type { Transport } from "@connectrpc/connect";
import { AccountService } from "./gen/account/v1/account_pb.js";

declare const transport: Transport;

const lookup = grpcQuery({
  transport,
  method: AccountService.method.getAccount,
  name: "accounts.lookup",
  key: (request) => `account:${request.accountId ?? ""}`,
});
```

`Transport` is the protocol boundary from `@connectrpc/connect`. The root export does not create one or choose a protocol. The `@hesperia/grpc/native` subpath re-exports `createGrpcTransport` and `GrpcTransportOptions` from `@connectrpc/connect-node`:

```ts
import { createGrpcTransport } from "@hesperia/grpc/native";

const transport = createGrpcTransport({ baseUrl: "https://api.example.com" });
```

The native subpath uses Node's HTTP/2 API and requires Node.js 22 or later. Keep that import in Node code. This package does not provide a browser transport or claim that a caller-supplied transport supports every gRPC method kind.

Applications must provide `@connectrpc/connect` and `@bufbuild/protobuf`. Node applications using `./native` must also provide `@connectrpc/connect-node`. The package does not install a code generator, Buf CLI, or browser transport.

## Declare operations

`grpcQuery` accepts a unary descriptor and returns an Aeolia `QueryDefinition`. `grpcMutation` accepts a unary descriptor and returns a `MutationDefinition`. `grpcStream` accepts a server-streaming descriptor and returns a `StreamDefinition`.

Each descriptor contains the Connect `transport` and generated `method`. Query and stream descriptors also require a `name` and nonempty `key`. Mutation descriptors require a `name` and an explicit `affects` array. Supply `affects: []` when the mutation has no declared query effects.

The input and output types follow the generated Protobuf descriptors. Unary inputs use `MessageInitShape<Input>`, and results use `MessageShape<Output>`. A unary call returns the response message directly. A server-streaming operation yields each response message directly. The adapter adds no response envelope.

The builders validate method kind before declaring the operation. A query or mutation requires a unary method. A stream requires a server-streaming method. A mismatch throws `TypeError` synchronously, including when JavaScript bypasses TypeScript checks. Client-streaming and bidirectional descriptors are not accepted by these builders.

Choose query or mutation from the operation's application behavior. The adapter does not infer that choice from the RPC name or Protobuf idempotency metadata. An `IDEMPOTENT` method may still change state. A `NO_SIDE_EFFECTS` annotation describes the method, but the caller still chooses which Aeolia definition to declare.

Aeolia applies the existing query freshness and mutation effect rules. A successful mutation applies its declared effects. A failed native call does not prove that the server rolled back work. Aeolia handles the local mutation failure and skips its successful-settlement effects.

## Compose the Aeolia graph

Create definitions, place them in an Aeolia contract, then bind the graph to component owners through Hesperia's existing entry point. This example uses a public generated service descriptor and a caller-supplied transport compatible with the execution environment:

```ts
import { createGraph, defineContract } from "aeolia";
import { grpcQuery } from "@hesperia/grpc";
import type { Transport } from "@connectrpc/connect";
import { withAeolia } from "hesperia/aeolia";
import { AccountService } from "./gen/account/v1/account_pb.js";

declare const transport: Transport;

const getAccount = grpcQuery({
  transport,
  method: AccountService.method.getAccount,
  name: "accounts.get",
  key: (request) => `account:${request.accountId ?? ""}`,
});

const contract = defineContract({
  namespace: "app.accounts",
  operations: { getAccount },
});

const graph = createGraph({ contract });
export const accounts = withAeolia(graph, contract);
```

Pass the same contract used to create the graph. Hesperia binds the existing Aeolia handles to each component owner. Queries, mutations, and streams keep their standard Hesperia and Aeolia behavior; this package adds no graph factory or projection registry.

Creating a definition does not perform network I/O. Aeolia controls query fetches, mutation dispatch, and stream opening through its existing operation lifecycle. A mutation runs for each explicit invocation. An incoming stream remains a server-streaming operation projected through Hesperia's existing feed.

## Preserve operation identity and security context

Aeolia shares query and stream state by key within a graph. The inputs and native options used for a key must represent the same logical data and security context. Include each nonsecret value that changes the response representation in the query or stream key, or use a separate graph and transport for the other context.

Do not put credentials in a key. Supply authorization metadata through the transport or a per-call `nativeOptions` resolver. Do not change credentials or representation options behind an existing key and expect Aeolia to distinguish the results. This package adds no credential registry or context cache.

The resolver receives the original Aeolia context. Query callbacks receive `FetchOptions`, which includes `abortSignal`, `graph`, and `key`. Mutation callbacks receive `CallContext`, which includes `abortSignal` and `graph`. Stream-opening callbacks receive `OpenOptions`, which extends the query context with `reportGap`. `graph` is an opaque graph identity, not a `Graph` instance or an authorization principal.

Use a transport, contract, and graph for a stable security context. If the security context changes, use the application's existing graph replacement or reset lifecycle. Do not rely on this adapter to isolate different credentials that share the same graph and key.

## Resolve native call options

Each descriptor may include `nativeOptions(input, context)`. The resolver runs synchronously once immediately before an actual native call. It does not run when the definition is created or when an unused member is acquired.

The resolver may return Connect `CallOptions` except for `signal`. It can set `headers`, `timeoutMs`, `contextValues`, `onHeader`, and `onTrailer`. The adapter forwards `headers`, `timeoutMs`, and `contextValues` to the native RPC and invokes the metadata callbacks at the phases described below. It always supplies its owned signal to the RPC; it does not pass the full `CallOptions` object through to `Transport` unchanged.

Connect's `timeoutMs` applies to the native RPC. `undefined` uses the transport default. A value less than or equal to zero disables that default. A positive value sets the RPC timeout. This package adds no timeout default or second deadline.

The resolver context is the Aeolia context for that operation. Do not use it as a place to store call-global credentials or mutable identity. Close over credentials that belong to the stable transport context, and keep representation identity in the key.

## Observe headers, trailers, and errors

For a unary call, Connect resolves after it reads and validates the native response. The adapter calls `onHeader`, then `onTrailer`, then returns `response.message`. If `onHeader` throws, `onTrailer` does not run. If `onTrailer` throws, that error rejects the operation even though the RPC has already completed.

For a server stream, the adapter calls `onHeader` before yielding messages. It calls `onTrailer` only after normal response exhaustion and successful terminal validation. A late native failure propagates after any messages already yielded, and `onTrailer` is skipped. The adapter records native completion before calling `onTrailer`, so a callback exception after completion does not cancel a completed RPC.

The adapter does not wrap errors. Connect `ConnectError` instances retain their code and details and expose response metadata through `metadata`. Errors from the resolver, transport, or callbacks propagate unchanged. A callback error can occur after the server has completed a mutation; it does not prove remote rollback.

## Cancel a server stream

`grpcStream` uses the parent operation's abort signal through a linked child signal. The adapter returns an `AsyncIterableIterator` that can stop an outstanding native read when the consumer calls `return()` or `throw()`.

The adapter aborts the child signal synchronously before it waits for iterator delegation. This lets early return cancel a pending read without waiting for another `next()` call. Returning before the first `next()` does not start the native RPC. The adapter observes an already-aborted parent and removes the parent listener exactly once on normal end, failure, early return, or throw.

Native cancellation is best effort. Local iterator cleanup does not prove successful server completion. Normal stream completion removes the abort listener without reporting local cancellation. Trailer callback failure after normal completion propagates without aborting the finished RPC.

The adapter does not reconnect, replay, or synthesize a data gap on ordinary completion or transport failure. Aeolia and Hesperia retain their existing stream demand, retention, and feed projection behavior. Reading a feed does not control native transport capacity.
