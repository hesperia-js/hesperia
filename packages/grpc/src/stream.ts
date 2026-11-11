import { createStream } from "aeolia";
import type {
  DescMessage,
  DescMethodServerStreaming,
  MessageInitShape,
  MessageShape,
} from "@bufbuild/protobuf";
import type { Transport } from "@connectrpc/connect";
import type { StreamDefinition } from "aeolia";
import { assertMethodKind } from "./operations.ts";
import type {
  GrpcNativeOptionsResolver,
  GrpcStreamDescriptor,
  GrpcStreamOpenContext,
} from "./types.ts";

/**
 * Declare an Aeolia stream whose source invokes a server-streaming gRPC method.
 *
 * The source is opened according to Aeolia's shared key and demand lifecycle.
 * It sends one request message, yields original Protobuf output values, and
 * preserves native Connect failures. Early return, throw or graph cancellation
 * aborts the call before iterator teardown can wait behind a pending pull.
 *
 * @typeParam Input - Protobuf input message descriptor.
 * @typeParam Output - Protobuf output message descriptor.
 * @typeParam Key - Aeolia stream key type.
 * @param descriptor - Aeolia stream settings and the server-stream transport binding.
 * @returns An actual Aeolia stream definition for use in a contract.
 * @throws {TypeError} If the descriptor is not a server-streaming method.
 */
export function grpcStream<
  Input extends DescMessage,
  Output extends DescMessage,
  Key extends string,
>(
  descriptor: GrpcStreamDescriptor<Input, Output, Key>,
): StreamDefinition<MessageInitShape<Input>, MessageShape<Output>, Key> {
  assertMethodKind(descriptor.method, "server_streaming");

  const { transport, method, nativeOptions, ...definition } = descriptor;

  return createStream<MessageInitShape<Input>, MessageShape<Output>, Key>({
    ...definition,
    open: (input, context) =>
      createStreamIterator(transport, method, input, context, nativeOptions),
  });
}

function createStreamIterator<Input extends DescMessage, Output extends DescMessage>(
  transport: Transport,
  method: DescMethodServerStreaming<Input, Output>,
  input: MessageInitShape<Input>,
  context: GrpcStreamOpenContext,
  resolver: GrpcNativeOptionsResolver<MessageInitShape<Input>, GrpcStreamOpenContext> | undefined,
): AsyncIterableIterator<MessageShape<Output>, void, unknown> {
  const controller = new AbortController();
  const parentSignal = context.abortSignal;
  let nativeComplete = false;
  let linked = false;

  const unlink = (): void => {
    if (!linked) return;

    linked = false;
    parentSignal.removeEventListener("abort", abortFromParent);
  };

  const abort = (reason?: unknown): void => {
    if (!controller.signal.aborted) controller.abort(reason);
  };

  const abortFromParent = (): void => {
    if (!nativeComplete) abort(parentSignal.reason);

    unlink();
  };

  if (parentSignal.aborted) {
    abortFromParent();
  } else {
    linked = true;
    parentSignal.addEventListener("abort", abortFromParent, { once: true });

    if (parentSignal.aborted) abortFromParent();
  }

  const source = (async function* (): AsyncGenerator<MessageShape<Output>, void, unknown> {
    try {
      if (controller.signal.aborted) throw controller.signal.reason;

      const { timeoutMs, headers, contextValues, onHeader, onTrailer } =
        resolver?.(input, context) ?? {};
      const response = await transport.stream(
        method,
        controller.signal,
        timeoutMs,
        headers,
        singleRequest<Input>(input),
        contextValues,
      );

      onHeader?.(response.header);

      for await (const message of response.message) {
        yield message;
      }

      nativeComplete = true;
      onTrailer?.(response.trailer);
    } catch (error) {
      if (!nativeComplete) abort(error);

      throw error;
    } finally {
      if (!nativeComplete) abort();

      unlink();
    }
  })();

  return {
    next(value?: unknown): Promise<IteratorResult<MessageShape<Output>, void>> {
      return source.next(value);
    },

    return(value?: void | PromiseLike<void>): Promise<IteratorResult<MessageShape<Output>, void>> {
      if (!nativeComplete) abort();

      unlink();

      return source.return(value);
    },

    throw(error?: unknown): Promise<IteratorResult<MessageShape<Output>, void>> {
      if (!nativeComplete) abort(error);

      unlink();

      return source.throw(error);
    },

    [Symbol.asyncIterator](): AsyncIterableIterator<MessageShape<Output>, void, unknown> {
      return this;
    },
  };
}

async function* singleRequest<Input extends DescMessage>(
  input: MessageInitShape<Input>,
): AsyncGenerator<MessageInitShape<Input>, void, unknown> {
  yield input;
}
