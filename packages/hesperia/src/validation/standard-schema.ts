import type { StandardSchemaV1 } from "@standard-schema/spec";

/**
 * Invoke one Standard Schema validator and preserve its sync or async result.
 * Provider issues and their paths pass through unchanged.
 *
 * @param schema - The provider-neutral schema selected by the caller.
 * @param input - The value passed to the schema's validation method.
 * @returns The provider's success or issue result.
 * @throws Synchronous provider exceptions pass through to the caller; a
 * rejected provider promise remains rejected.
 */
export function validateStandardSchema<Input, Output>(
  schema: StandardSchemaV1<Input, Output>,
  input: unknown,
): StandardSchemaV1.Result<Output> | Promise<StandardSchemaV1.Result<Output>> {
  return schema["~standard"].validate(input);
}
