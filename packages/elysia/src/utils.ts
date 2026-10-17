export function isNonNullObject(value: unknown): value is object {
  return value !== null && typeof value === "object";
}

export function isNonArrayObject(value: unknown): value is object {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
