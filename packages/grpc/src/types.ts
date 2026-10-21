import type {
  DescMessage,
  DescMethodServerStreaming,
  DescMethodUnary,
  MessageInitShape,
  MessageShape,
} from "@bufbuild/protobuf";
import type { CallOptions, Transport } from "@connectrpc/connect";
import type {
  CallContext,
  CreateMutationInput,
  CreateQueryInput,
  CreateStreamInput,
  FetchOptions,
  OpenOptions,
} from "aeolia";

/**
 * Context passed by Aeolia when a query needs to fetch its keyed value.
 *
 * @see {@link FetchOptions}
 */
export type GrpcQueryContext = FetchOptions;

/**
 * Context passed by Aeolia for one mutation invocation.
 *
 * @see {@link CallContext}
 */
export type GrpcMutationContext = CallContext;

/**
 * Context passed by Aeolia when it opens a shared stream source.
 *
 * @see {@link OpenOptions}
 */
export type GrpcStreamOpenContext = OpenOptions;

/**
 * Per-call options forwarded to Connect's public Transport methods.
 *
 * The operation's cancellation signal is owned by Aeolia and cannot be replaced
 * by this adapter. `headers` and `contextValues` are passed through unchanged.
 * `timeoutMs` also passes through unchanged: an omitted value uses the
 * transport default, and a value less than or equal to zero disables that
 * default. Response callbacks run with Connect's native timing: unary header
 * and trailer callbacks run after response validation; stream headers arrive
 * before messages, and trailers arrive after successful exhaustion. Callback
 * exceptions propagate unchanged. A stream trailer callback is skipped when
 * the response ends with a native error.
 */
export type GrpcNativeCallOptions = Omit<CallOptions, "signal">;

/**
 * Resolves native Connect options for one underlying gRPC invocation.
 *
 * The resolver runs synchronously immediately before the transport call. A
 * stream resolver runs once per opened source, not once per emitted message.
 * Keep credentials in call headers or context values, not in Aeolia store keys.
 *
 * @typeParam Input - Protobuf initialization shape supplied to the operation.
 * @typeParam Context - Aeolia context for the specific operation invocation.
 * @param input - The original operation input.
 * @param context - The graph-owned context, including its cancellation signal.
 * @returns Native call options, or `undefined` to use transport defaults.
 */
export type GrpcNativeOptionsResolver<Input, Context extends CallContext> = (
  /** The original operation input. */
  input: Input,
  /** The Aeolia context for this underlying operation call. */
  context: Context,
) => GrpcNativeCallOptions | undefined;

/**
 * Inputs needed to declare an Aeolia query backed by a unary gRPC method.
 *
 * Query freshness, snapshots, equality and key sharing retain Aeolia behavior.
 * No native call occurs until Aeolia invokes the query's fetch callback.
 *
 * @typeParam Input - Protobuf input message descriptor.
 * @typeParam Output - Protobuf output message descriptor.
 * @typeParam Key - Aeolia query key type.
 */
export type GrpcQueryDescriptor<
  Input extends DescMessage,
  Output extends DescMessage,
  Key extends string = string,
> = Omit<CreateQueryInput<MessageInitShape<Input>, MessageShape<Output>, Key>, "fetch"> & {
  /** Connect protocol transport used for this unary call. */
  readonly transport: Transport;
  /** Unary Protobuf method used to resolve the query value. */
  readonly method: DescMethodUnary<Input, Output>;
  /** Per-fetch options resolver; called once immediately before each native call. */
  readonly nativeOptions?: GrpcNativeOptionsResolver<
    MessageInitShape<Input>,
    GrpcQueryContext
  >;
};

/**
 * Inputs needed to declare an Aeolia mutation backed by a unary gRPC method.
 *
 * The caller explicitly supplies `affects`; method metadata does not determine
 * whether a procedure is a query or mutation. Each Aeolia run invokes the
 * native method once.
 *
 * @typeParam Input - Protobuf input message descriptor.
 * @typeParam Output - Protobuf output message descriptor.
 */
export type GrpcMutationDescriptor<
  Input extends DescMessage,
  Output extends DescMessage,
> = Omit<CreateMutationInput<MessageInitShape<Input>, MessageShape<Output>>, "run"> & {
  /** Connect protocol transport used for this unary call. */
  readonly transport: Transport;
  /** Unary Protobuf method used to perform the mutation. */
  readonly method: DescMethodUnary<Input, Output>;
  /** Per-run options resolver; called once immediately before each native call. */
  readonly nativeOptions?: GrpcNativeOptionsResolver<
    MessageInitShape<Input>,
    GrpcMutationContext
  >;
};

/**
 * Inputs needed to declare an Aeolia stream backed by a server-streaming method.
 *
 * Aeolia key sharing, snapshots and equality remain in effect. The transport
 * receives one request message when the source is first pulled; yielded values
 * and native Connect errors pass through without an adapter envelope.
 *
 * @typeParam Input - Protobuf input message descriptor.
 * @typeParam Output - Protobuf output message descriptor.
 * @typeParam Key - Aeolia stream key type.
 */
export type GrpcStreamDescriptor<
  Input extends DescMessage,
  Output extends DescMessage,
  Key extends string = string,
> = Omit<CreateStreamInput<MessageInitShape<Input>, MessageShape<Output>, Key>, "open"> & {
  /** Connect protocol transport used for this server-streaming call. */
  readonly transport: Transport;
  /** Server-streaming Protobuf method used to open the source. */
  readonly method: DescMethodServerStreaming<Input, Output>;
  /** Per-source options resolver; called once when Aeolia starts this source. */
  readonly nativeOptions?: GrpcNativeOptionsResolver<
    MessageInitShape<Input>,
    GrpcStreamOpenContext
  >;
};
