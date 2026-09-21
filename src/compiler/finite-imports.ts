import {
  isCanonicalChild,
  type CanonicalExpression,
  type CanonicalModule,
  type CanonicalStatement,
} from "./ir.ts";

/** Collect resolved constant initializers, including nested lexical scopes, for import analysis. */
export function collectFiniteImportConstants(
  module: CanonicalModule,
): ReadonlyMap<string, CanonicalExpression> {
  const constants = new Map<string, CanonicalExpression>();
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (typeof value !== "object" || value === null) return;
    const record = value as Record<string, unknown>;
    if (record.kind === "variable" && record.declarationKind === "const") {
      const declaration = value as Extract<CanonicalStatement, { kind: "variable" }>;
      for (const item of declaration.declarations)
        if (
          item.pattern.kind === "identifier" &&
          item.pattern.bindingId &&
          item.initializer &&
          !isCanonicalChild(item.initializer)
        )
          constants.set(item.pattern.bindingId, item.initializer);
    }
    for (const item of Object.values(record)) visit(item);
  };
  visit(module.body);
  return constants;
}

/**
 * Enumerate the complete string set for a finite expression.
 *
 * The caller supplies resolved `const` initializers by binding identity. An absent result means
 * that the expression may produce a value outside a statically enumerable set and must retain
 * native dynamic-import behavior for standalone emission; browser capability analysis must reject
 * an absent result, while browser emission can lower a present result. Emission remains
 * responsible for preserving evaluation order and side effects while selecting targets.
 */
export function enumerateFiniteStrings(
  expression: CanonicalExpression,
  constants: ReadonlyMap<string, CanonicalExpression>,
  seen = new Set<string>(),
): readonly string[] | undefined {
  if (expression.kind === "literal" && typeof expression.value === "string")
    return [expression.value];
  if (expression.kind === "identifier" && expression.referenceId) {
    const id = expression.referenceId;
    if (seen.has(id)) return;
    const initializer = constants.get(id);
    return initializer
      ? enumerateFiniteStrings(initializer, constants, new Set([...seen, id]))
      : undefined;
  }
  if (expression.kind === "conditional") {
    const consequent = enumerateFiniteStrings(expression.consequent, constants, seen);
    const alternate = enumerateFiniteStrings(expression.alternate, constants, seen);
    return consequent && alternate ? unionSpecifiers(consequent, alternate) : undefined;
  }
  if (expression.kind === "binary" && expression.operator === "+") {
    const left = enumerateFiniteStrings(expression.left, constants, seen);
    const right = enumerateFiniteStrings(expression.right, constants, seen);
    return left && right ? concatenateSpecifiers(left, right) : undefined;
  }
  if (expression.kind === "template") {
    const first = expression.quasis[0]?.cooked;
    if (first === null || first === undefined) return;
    let values: readonly string[] = [first];
    for (let index = 0; index < expression.expressions.length; index++) {
      const interpolation = enumerateFiniteStrings(expression.expressions[index]!, constants, seen);
      const suffix = expression.quasis[index + 1]?.cooked;
      if (!interpolation || suffix === null || suffix === undefined) return;
      values = concatenateSpecifiers(concatenateSpecifiers(values, interpolation), [suffix]);
    }
    return values;
  }
}

/** Backward-compatible name for dynamic import lowering and route analysis. */
export function enumerateFiniteImportSpecifiers(
  expression: CanonicalExpression,
  constants: ReadonlyMap<string, CanonicalExpression>,
  seen = new Set<string>(),
): readonly string[] | undefined {
  return enumerateFiniteStrings(expression, constants, seen);
}

function concatenateSpecifiers(
  left: readonly string[],
  right: readonly string[],
): readonly string[] {
  const result: string[] = [];
  for (const prefix of left)
    for (const suffix of right) if (!result.includes(prefix + suffix)) result.push(prefix + suffix);
  return result;
}

function unionSpecifiers(left: readonly string[], right: readonly string[]): readonly string[] {
  const result: string[] = [];
  for (const value of [...left, ...right]) if (!result.includes(value)) result.push(value);
  return result;
}
