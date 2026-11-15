import { createMutation, createQuery } from "aeolia";
import type {
  DescMessage,
  DescMethodUnary,
  MessageInitShape,
  MessageShape,
} from "@bufbuild/protobuf";
import type { Transport } from "@connectrpc/connect";
import type { CallContext, MutationDefinition, QueryDefinition } from "aeolia";
import type {
  GrpcMutationDescriptor,
  GrpcNativeOptionsResolver,
  GrpcQueryDescriptor,
} from "./types.ts";

/**
 * Declare an Aeolia query whose fetch callback invokes a unary gRPC method.
 *
 * Aeolia controls fetch timing, key sharing and freshness. The native options
 * resolver runs once for each underlying fetch. The Connect response message is
 * returned unchanged; native errors and callback exceptions pass through.
 *
 * @typeParam Input - Protobuf input message descriptor.
 * @typeParam Output - Protobuf output message descriptor.
 * @typeParam Key - Aeolia query key type.
 * @param descriptor - Aeolia query settings and the unary transport binding.
 * @returns An actual Aeolia query definition for use in a contract.
 * @throws {TypeError} If the descriptor is not a unary method.
 */
export function grpcQuery<
  Input extends DescMessage,
  Output extends DescMessage,
  Key extends string,
>(
  descriptor: GrpcQueryDescriptor<Input, Output, Key>,
): QueryDefinition<MessageInitShape<Input>, MessageShape<Output>, Key> {
  assertMethodKind(descriptor.method, "unary");

  const { transport, method, nativeOptions, ...definition } = descriptor;

  return createQuery<MessageInitShape<Input>, MessageShape<Output>, Key>({
    ...definition,
    fetch: (input, context) => invokeUnary(transport, method, input, context, nativeOptions),
  });
}

/**
 * Declare an Aeolia mutation whose run callback invokes a unary gRPC method.
 *
 * The caller supplies explicit `affects` metadata, including an empty array
 * when the mutation has no declared query effects. Each Aeolia run starts one
 * native invocation; this is not a rerunnable channel or retained call handle.
 * The response message, native errors and callback exceptions pass through.
 *
 * @typeParam Input - Protobuf input message descriptor.
 * @typeParam Output - Protobuf output message descriptor.
 * @param descriptor - Aeolia mutation settings and the unary transport binding.
 * @returns An actual Aeolia mutation definition for use in a contract.
 * @throws {TypeError} If the descriptor is not a unary method.
 */
export function grpcMutation<Input extends DescMessage, Output extends DescMessage>(
  descriptor: GrpcMutationDescriptor<Input, Output>,
): MutationDefinition<MessageInitShape<Input>, MessageShape<Output>> {
  assertMethodKind(descriptor.method, "unary");

  const { transport, method, nativeOptions, ...definition } = descriptor;

  return createMutation<MessageInitShape<Input>, MessageShape<Output>>({
    ...definition,
    run: (input, context) => invokeUnary(transport, method, input, context, nativeOptions),
  });
}

/** Validate the runtime descriptor kind for JavaScript and cast callers. */
export function assertMethodKind(
  method: { readonly methodKind?: unknown } | undefined,
  expected: "unary" | "server_streaming",
): void {
  if (method?.methodKind !== expected) {
    throw new TypeError(`Expected a ${expected} gRPC method descriptor`);
  }
}

/** Invoke a unary method and preserve Connect's response callback ordering. */
async function invokeUnary<
  Input extends DescMessage,
  Output extends DescMessage,
  Context extends CallContext,
>(
  transport: Transport,
  method: DescMethodUnary<Input, Output>,
  input: MessageInitShape<Input>,
  context: Context,
  resolver: GrpcNativeOptionsResolver<MessageInitShape<Input>, Context> | undefined,
): Promise<MessageShape<Output>> {
  const { timeoutMs, headers, contextValues, onHeader, onTrailer } =
    resolver?.(input, context) ?? {};
  const response = await transport.unary(
    method,
    context.abortSignal,
    timeoutMs,
    headers,
    input,
    contextValues,
  );

  onHeader?.(response.header);
  onTrailer?.(response.trailer);

  return response.message;
}
