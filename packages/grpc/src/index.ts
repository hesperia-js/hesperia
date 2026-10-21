/**
 * Adapters that declare Aeolia operations backed by Connect transports.
 *
 * Import the Node HTTP/2 transport from the separate `@hesperia/grpc/native`
 * entry point so the generic adapter root stays free of Node-only imports.
 */
export { grpcMutation, grpcQuery } from "./operations.ts";
export { grpcStream } from "./stream.ts";
export type {
  GrpcMutationContext,
  GrpcMutationDescriptor,
  GrpcNativeCallOptions,
  GrpcNativeOptionsResolver,
  GrpcQueryContext,
  GrpcQueryDescriptor,
  GrpcStreamDescriptor,
  GrpcStreamOpenContext,
} from "./types.ts";
