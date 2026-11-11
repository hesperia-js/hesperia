import type { StandardSchemaV1 } from "@standard-schema/spec";
import { internValidationProfile, type ValidationProfile } from "./profiles.ts";
import { requireOperationValue } from "./operation.ts";
import { mapStandardSchema, type ValidationWorkTracker } from "./standard-schema.ts";

type RuntimeSchema = StandardSchemaV1<unknown, unknown>;

/** Prepared query input and the exact schema identities retained for the call. @internal */
export interface PreparedProfileQueryInput<Input> {
  /** Validated input, or the original input when no input schema is selected. */
  readonly input: Input;
  /** Exact retained input and output schema identities. */
  readonly profile: ValidationProfile;
}

/** Validate input before native acquisition without reselecting the schemas. @internal */
export function prepareProfileQueryInput(
  input: unknown,
  profile: ValidationProfile,
  track?: ValidationWorkTracker,
): PreparedProfileQueryInput<unknown> | PromiseLike<PreparedProfileQueryInput<unknown>> {
  if (profile.input === undefined) return { input, profile };

  return mapStandardSchema(
    profile.input,
    input,
    (result) => ({ input: requireOperationValue(result), profile }),
    track,
  );
}

/** Complete a request using the output schema retained with its input. @internal */
export function completeProfileQueryValue(
  value: unknown,
  profile: ValidationProfile,
  track?: ValidationWorkTracker,
): unknown {
  if (profile.output === undefined) return value;

  return mapStandardSchema(profile.output, value, requireOperationValue, track);
}

/** Schema references selected by an adapter for one operation. @internal */
export interface OperationSchemaSelection {
  /** Input schema selected for this invocation. */
  readonly input?: RuntimeSchema | undefined;
  /** Output schema selected for this invocation. */
  readonly output?: RuntimeSchema | undefined;
}

/** Result completion capability supplied to the adapter. @internal */
export interface NativeOperationCompletion {
  /** Identity of the exact retained schema pair, local to this runtime. */
  readonly profile: object;
  /** Validate and unwrap the native result using the selected output schema. */
  readonly complete: (value: unknown) => unknown | PromiseLike<unknown>;
}

/** Adapter-owned invocation details, captured once before validation. @internal */
export interface NativeCallSelection {
  /** Borrowed input before validation. */
  readonly input: unknown;
  /** Schema references selected once for this call. */
  readonly schemas: OperationSchemaSelection;
  /** Rebuild the adapter's nonthenable envelope with validated input and completion. */
  readonly replace: (input: unknown, completion: NativeOperationCompletion) => unknown;
}

/** Adapter-independent preparation policy for one native operation. @internal */
export interface NativeOperationPolicy {
  /** Prepare an adapter envelope, preserving synchronous completion when possible. */
  readonly prepare: (
    envelope: unknown,
    track?: ValidationWorkTracker,
  ) => unknown | PromiseLike<unknown>;
}

/**
 * Create a schema preparation policy for adapter-owned invocation envelopes.
 * Absent schemas return the original envelope. Validator failures retain their
 * original cause or issue array; the adapter owns its envelope and native call.
 * @param readCall - Snapshot the input, schemas, and replacement callback for a call.
 * @returns A frozen preparation policy.
 * @internal
 */
export function createNativeOperationPolicy(
  readCall: (envelope: unknown) => NativeCallSelection,
): NativeOperationPolicy {
  return Object.freeze({
    prepare(envelope: unknown, track?: ValidationWorkTracker): unknown | PromiseLike<unknown> {
      const { input, schemas, replace } = readCall(envelope);
      if (schemas.input === undefined && schemas.output === undefined) return envelope;

      const profile = internValidationProfile(schemas.input, schemas.output);
      const output = schemas.output;
      const completion: NativeOperationCompletion = Object.freeze({
        profile,
        complete(value: unknown): unknown {
          if (output === undefined) return value;

          return mapStandardSchema(output, value, requireOperationValue);
        },
      });

      if (schemas.input === undefined) return replace(input, completion);

      return mapStandardSchema(
        schemas.input,
        input,
        (result) => replace(requireOperationValue(result), completion),
        track,
      );
    },
  });
}
