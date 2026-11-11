import type { StandardSchemaV1 } from "@standard-schema/spec";

type RuntimeSchema = StandardSchemaV1<unknown, unknown>;

/** Exact schema identities retained for one native query or operation. @internal */
export interface ValidationProfile {
  readonly input: RuntimeSchema | undefined;
  readonly output: RuntimeSchema | undefined;
}

const pairs = new WeakMap<RuntimeSchema, WeakMap<RuntimeSchema, ValidationProfile>>();
const inputs = new WeakMap<RuntimeSchema, ValidationProfile>();
const outputs = new WeakMap<RuntimeSchema, ValidationProfile>();
const empty: ValidationProfile = Object.freeze({ input: undefined, output: undefined });

/** Retain one stable profile identity for the exact schema references. @internal */
export function internValidationProfile(
  input: RuntimeSchema | undefined,
  output: RuntimeSchema | undefined,
): ValidationProfile {
  if (input === undefined && output === undefined) return empty;

  if (input !== undefined && output !== undefined) {
    let byOutput = pairs.get(input);

    if (!byOutput) {
      byOutput = new WeakMap();
      pairs.set(input, byOutput);
    }

    const existing = byOutput.get(output);
    if (existing) return existing;

    const profile = Object.freeze({ input, output });
    byOutput.set(output, profile);
    return profile;
  }

  const schema = input ?? output!;
  const table = input === undefined ? outputs : inputs;
  const existing = table.get(schema);
  if (existing) return existing;

  const profile = Object.freeze({ input, output });
  table.set(schema, profile);
  return profile;
}
