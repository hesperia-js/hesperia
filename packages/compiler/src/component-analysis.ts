import {
  isCanonicalChild,
  type CanonicalExpression,
  type CanonicalStatement,
  type CanonicalStatementBlock,
} from "./ir.ts";

export type ComponentFactoryExpression =
  | Extract<CanonicalExpression, { kind: "arrow" }>
  | Extract<CanonicalExpression, { kind: "function-expression" }>;

/** Whether a resolved function body produces a native render value. */
export function isComponentBody(block: CanonicalStatementBlock, trusted = false): boolean {
  return trusted || hasRenderedReturn(block.body, new Set<string>());
}

function hasRenderedReturn(
  statements: readonly CanonicalStatement[],
  renderedBindings: Set<string>,
): boolean {
  for (const statement of statements) {
    if (statement.kind === "switch") {
      for (const branch of statement.cases) {
        const branchBindings = new Set(renderedBindings);

        if (hasRenderedReturn(branch.consequent, branchBindings)) return true;

        for (const id of branchBindings) renderedBindings.add(id);
      }

      continue;
    }

    if (statement.kind === "try") {
      for (const block of [statement.body, statement.handler?.body, statement.finalizer]) {
        if (!block) continue;

        const blockBindings = new Set(renderedBindings);

        if (hasRenderedReturn(block.body, blockBindings)) return true;

        for (const id of blockBindings) renderedBindings.add(id);
      }

      continue;
    }

    if (statement.kind === "variable") {
      for (const declaration of statement.declarations) {
        if (declaration.pattern.kind !== "identifier" || !declaration.pattern.bindingId) continue;

        if (declaration.initializer && isCanonicalChild(declaration.initializer))
          renderedBindings.add(declaration.pattern.bindingId);
        else if (
          declaration.initializer?.kind === "identifier" &&
          declaration.initializer.referenceId !== undefined &&
          renderedBindings.has(declaration.initializer.referenceId)
        )
          renderedBindings.add(declaration.pattern.bindingId);
      }

      continue;
    }

    if (statement.kind === "return") {
      if (statement.argument === null) continue;

      if (isCanonicalChild(statement.argument)) return true;

      if (
        statement.argument.kind === "identifier" &&
        statement.argument.referenceId !== undefined &&
        renderedBindings.has(statement.argument.referenceId)
      )
        return true;

      continue;
    }

    if (statement.kind === "if") {
      const consequentBindings = new Set(renderedBindings);

      if (hasRenderedReturn([statement.consequent], consequentBindings)) return true;

      for (const id of consequentBindings) renderedBindings.add(id);

      if (statement.alternate) {
        const alternateBindings = new Set(renderedBindings);

        if (hasRenderedReturn([statement.alternate], alternateBindings)) return true;

        for (const id of alternateBindings) renderedBindings.add(id);
      }

      continue;
    }

    if (statement.kind === "block") {
      const blockBindings = new Set(renderedBindings);

      if (hasRenderedReturn(statement.body, blockBindings)) return true;

      for (const id of blockBindings) renderedBindings.add(id);
    }

    if (
      statement.kind === "for" ||
      statement.kind === "for-of" ||
      statement.kind === "for-in" ||
      statement.kind === "while" ||
      statement.kind === "do-while" ||
      statement.kind === "labeled"
    ) {
      const bodyBindings = new Set(renderedBindings);

      if (hasRenderedReturn([statement.body], bodyBindings)) return true;

      for (const id of bodyBindings) renderedBindings.add(id);
    }
  }

  return false;
}

/** Whether a resolved arrow expression is a component factory. */
export function isComponentArrow(
  expression: CanonicalExpression,
): expression is Extract<CanonicalExpression, { kind: "arrow" }> {
  if (expression.kind !== "arrow") return false;

  if (expression.component === true || expression.props !== undefined) return true;

  if (isCanonicalChild(expression.body)) return true;

  return expression.body.kind === "block" && isComponentBody(expression.body);
}

/** Whether a resolved function expression is a component factory. */
export function isComponentFunctionExpression(
  expression: CanonicalExpression,
): expression is Extract<CanonicalExpression, { kind: "function-expression" }> {
  return (
    expression.kind === "function-expression" &&
    !expression.generator &&
    (expression.component === true ||
      expression.props !== undefined ||
      isComponentBody(expression.body))
  );
}

/** Return the component factory that supplies an expression's final value. */
export function componentFactoryExpression(
  expression: CanonicalExpression,
): ComponentFactoryExpression | undefined {
  while (expression.kind === "sequence") {
    const final = expression.expressions.at(-1);

    if (!final) return;

    expression = final;
  }

  if (isComponentArrow(expression) || isComponentFunctionExpression(expression)) return expression;
}

/** Whether a source file is a conventional browser component entry. */
export function isConventionalComponentFilename(filename: string): boolean {
  const normalized = filename.replaceAll("\\", "/").toLowerCase();
  return (
    normalized === "app.tsx" ||
    /(?:^|\/)(?:\+page|\+layout|\+loading|\+error|\+not-found)\.tsx$/u.test(normalized)
  );
}
