import type { StandardSchemaV1 } from "@standard-schema/spec";

const nativePromiseThen = Promise.prototype.then;
const nativeApply = Reflect.apply;

/** Retain validation work until the original return is observed. @internal */
export type ValidationWorkTracker = (completion: Promise<void>) => void;

/** Validate and map one result while retaining the original return separately. @internal */
export function mapStandardSchema<Input, Output, Mapped>(
  schema: StandardSchemaV1<Input, Output>,
  input: unknown,
  map: (result: StandardSchemaV1.Result<Output>) => Mapped,
  track?: ValidationWorkTracker,
): Mapped | PromiseLike<Mapped> {
  let resolve!: () => void;
  let reject!: (cause: unknown) => void;
  const completion = new Promise<void>((success, failure) => {
    resolve = success;
    reject = failure;
  });

  void completion.catch(() => undefined);
  track?.(completion);

  let result: StandardSchemaV1.Result<Output> | Promise<StandardSchemaV1.Result<Output>>;

  try {
    result = validateStandardSchema(schema, input);
  } catch (cause) {
    resolve();

    throw cause;
  }

  const original = result;
  const incomplete = (cause: unknown): void => {
    reject(
      Object.assign(
        new Error("Validation observation failed; retirement is incomplete", { cause }),
        {
          incomplete: true,
          original,
        },
      ),
    );
  };
  let then: unknown;

  try {
    then =
      original !== null && (typeof original === "object" || typeof original === "function")
        ? Reflect.get(original, "then")
        : undefined;
  } catch (cause) {
    incomplete(cause);

    throw cause;
  }

  if (typeof then !== "function") {
    resolve();

    return map(original as StandardSchemaV1.Result<Output>);
  }

  try {
    nativeApply(nativePromiseThen, original, [resolve, resolve]);
  } catch (cause) {
    incomplete(cause);
  }

  return nativeApply(then, original, [map]) as PromiseLike<Mapped>;
}

/** Invoke the selected validator without changing its result or failure. @internal */
export function validateStandardSchema<Input, Output>(
  schema: StandardSchemaV1<Input, Output>,
  input: unknown,
): StandardSchemaV1.Result<Output> | Promise<StandardSchemaV1.Result<Output>> {
  return schema["~standard"].validate(input);
}
