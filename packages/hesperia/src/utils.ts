export function isObjectLike(value: unknown): value is object {
  return (typeof value === "object" && value !== null) || typeof value === "function";
}

export function isNonNullObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

export function isNonArrayObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
