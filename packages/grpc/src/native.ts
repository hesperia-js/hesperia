/**
 * Create Connect-Node's native gRPC HTTP/2 transport.
 *
 * Import this Node-only entry point from Node code; the generic package root
 * does not load the Node transport.
 */
export { createGrpcTransport } from "@connectrpc/connect-node";

/** Options accepted by {@link createGrpcTransport}. */
export type { GrpcTransportOptions } from "@connectrpc/connect-node";
