# gRPC fixture provenance

The files in this directory are copied byte-for-byte from the `bufbuild/protobuf-es` repository at commit [`b3b232f7f466eda27c66e8f63c82f930578b6cc6`](https://github.com/bufbuild/protobuf-es/tree/b3b232f7f466eda27c66e8f63c82f930578b6cc6).

| Local file          | Upstream path                                                                                                                                                                                                  | SHA-256                                                            |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `service-all.proto` | [`packages/protobuf-test/extra/service-all.proto`](https://github.com/bufbuild/protobuf-es/blob/b3b232f7f466eda27c66e8f63c82f930578b6cc6/packages/protobuf-test/extra/service-all.proto)                       | `655d31f2f6c6844bec5dbee0c972c34fef9cc0a83f84c8e8bbeed110ce7beb6f` |
| `service-all_pb.ts` | [`packages/protobuf-test/src/gen/ts/extra/service-all_pb.ts`](https://github.com/bufbuild/protobuf-es/blob/b3b232f7f466eda27c66e8f63c82f930578b6cc6/packages/protobuf-test/src/gen/ts/extra/service-all_pb.ts) | `88d7e722b98152e182699e43263d5e7cb75c8eeb52aa8f4ff33cd588e8af3c17` |
| `LICENSE`           | [`LICENSE`](https://github.com/bufbuild/protobuf-es/blob/b3b232f7f466eda27c66e8f63c82f930578b6cc6/LICENSE)                                                                                                     | `c04b4216f1cd4c5a4f7fb2f2a1b0ae70d847e9e0cac7c9dee9bf8cc03177c449` |

The schema and generated descriptor carry the Apache-2.0 notice and Buf Technologies attribution. Keep the generated header and `LICENSE` with these fixture files.

The generated header records `protoc-gen-es v2.16.0` with parameters `target=ts,import_extension=js`. The generated descriptor imports `@bufbuild/protobuf/codegenv2` and `@bufbuild/protobuf/wkt`. The schema imports `google/protobuf/wrappers.proto`. These files were copied from the pinned source tree. This contribution did not run the generator or verify regeneration.

## Fixed wire values

The `.proto` declares `spec.ServiceAll` with unary RPC `/spec.ServiceAll/Unary` and server-streaming RPC `/spec.ServiceAll/ServerStream`. Both accept `google.protobuf.StringValue` and return `google.protobuf.Int32Value`. The wrapper's `value` field has field number 1. For the string `Q`, Protobuf encodes `StringValue` as `0A 01 51`. For integer `7`, it encodes `Int32Value` as `08 07`.

An uncompressed gRPC message frame contains a zero compression flag, a four-byte big-endian message length, then the Protobuf bytes. The expected request frame for `Q` is `00 00 00 00 03 0A 01 51`. The expected response frame for `7` is `00 00 00 00 02 08 07`. A present `Int32Value` wrapper whose value is zero has an empty Protobuf body, so its data frame is `00 00 00 00 00`; that zero-length data message is distinct from a stream ending without another data message. A server-streaming response may carry each response frame as one item. A successful RPC also requires the native terminal status trailer, including `grpc-status: 0`.

These constants follow the schema's field numbers and the Protobuf and gRPC message-frame formats. They are independent expected values, not results produced by the generated codec. This fixture does not prove that the generator, package, Node runtime, Connect transport, gRPC server, browser transport, or complete Hesperia flow works.
