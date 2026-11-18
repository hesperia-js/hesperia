import type { StandardSchemaV1 } from "@standard-schema/spec";

class OperationValidationError extends Error {
  readonly issues: StandardSchemaV1.FailureResult["issues"];

  constructor(issues: StandardSchemaV1.FailureResult["issues"]) {
    super("Operation value did not satisfy its schema");
    this.name = "OperationValidationError";
    this.issues = issues;
  }
}

/** Preserve the provider's issue objects or return its transformed value. @internal */
export function requireOperationValue<Output>(result: StandardSchemaV1.Result<Output>): Output {
  if (result.issues !== undefined) throw new OperationValidationError(result.issues);
  return result.value;
}
