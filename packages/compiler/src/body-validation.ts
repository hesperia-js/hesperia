import type {
  CanonicalAttribute,
  CanonicalChild,
  CanonicalExpression,
  CanonicalModule,
  CanonicalPattern,
  CanonicalStatement,
  CanonicalStatementBlock,
  CompilerDiagnostic,
} from "./ir.ts";
import { isCanonicalChild } from "./ir.ts";
import { componentFactoryExpression, isComponentBody } from "./component-analysis.ts";

const CLIENT_MODULE = /(?:^|\/)hesperia\/client$/;
const BINDING_FACTORIES = new Set(["bind", "unsafeBind"]);

/** Diagnose native async iteration before generating the component's synchronous await driver. */
export function validateComponentAsyncIteration(
  module: CanonicalModule,
): readonly CompilerDiagnostic[] {
  const diagnostics: CompilerDiagnostic[] = [];

  const visit = (value: unknown, component: boolean): void => {
    if (!value || typeof value !== "object") return;

    if (Array.isArray(value)) {
      for (const item of value) visit(item, component);

      return;
    }

    const record = value as Record<string, unknown>;

    if (record.kind === "function") {
      const declaration = value as Extract<CanonicalStatement, { kind: "function" }>;
      component =
        declaration.async &&
        !declaration.generator &&
        (declaration.component === true ||
          declaration.props !== undefined ||
          isComponentBody(declaration.body));
    } else if (record.kind === "arrow" || record.kind === "function-expression") {
      const expression = value as Extract<
        CanonicalExpression,
        { kind: "arrow" | "function-expression" }
      >;
      component = expression.async && componentFactoryExpression(expression) !== undefined;
    }

    if (component && record.kind === "for-of" && record.await === true)
      diagnostics.push({
        code: "HES-ASYNC-ITERATION",
        severity: "error",
        message:
          "This compiler does not support for-await-of directly in component bodies. Native async iteration is supported in ordinary async functions.",
        span: (value as Extract<CanonicalStatement, { kind: "for-of" }>).span,
      });

    for (const [name, child] of Object.entries(record))
      if (name !== "span") visit(child, component);
  };

  visit(module.body, false);

  return diagnostics;
}

/**
 * Validate the binding-read rule for resolved component bodies.
 *
 * This intentionally follows only lexical IDs produced by `resolveCanonicalModule`. It recognizes
 * bindings returned directly by imported Hesperia client factories, then checks reads in the
 * component's own render body. Nested function and arrow bodies are deferred callbacks and are
 * skipped; structural render children remain part of the owning component body.
 */
export function validateComponentBindingReads(
  module: CanonicalModule,
): readonly CompilerDiagnostic[] {
  const client = clientBindings(module);
  const diagnostics: CompilerDiagnostic[] = [];

  for (const statement of module.body) visitTopLevel(statement, client, diagnostics);

  return diagnostics;
}

/** Reject writes that the current extracted list factories cannot preserve as lexical bindings. */
export function validateStructuralAssignments(
  module: CanonicalModule,
): readonly CompilerDiagnostic[] {
  const diagnostics: CompilerDiagnostic[] = [];

  const visit = (value: unknown, captures: ReadonlySet<string>): void => {
    if (!value || typeof value !== "object") return;

    if (Array.isArray(value)) {
      for (const item of value) visit(item, captures);

      return;
    }

    const record = value as Record<string, unknown>;

    if (record.kind === "list") {
      const list = value as Extract<CanonicalChild, { kind: "list" }>;

      visit(list.collection, captures);

      visit(list.parameter, captures);

      visit(list.key, captures);

      visit(list.body, new Set([...captures, ...list.captures.map((item) => item.bindingId)]));

      return;
    }

    const target =
      record.kind === "assignment"
        ? ((record.left ?? record.target) as CanonicalExpression | undefined)
        : record.kind === "unary" && (record.operator === "++" || record.operator === "--")
          ? (value as Extract<CanonicalExpression, { kind: "unary" }>).argument
          : undefined;

    if (target?.kind === "identifier" && captures.has(target.referenceId ?? ""))
      diagnostics.push({
        code: "HES-ASSIGN-CAPTURE",
        severity: "error",
        message:
          "Assignment to an extracted list parameter is not supported by this compiler profile.",
        span: target.span,
      });

    for (const [name, child] of Object.entries(record)) if (name !== "span") visit(child, captures);
  };

  visit(module.body, new Set());

  return diagnostics;
}

interface ClientBindings {
  readonly namespaces: ReadonlySet<string>;
  readonly factories: ReadonlySet<string>;
}

function clientBindings(module: CanonicalModule): ClientBindings {
  const namespaces = new Set<string>();
  const factories = new Set<string>();

  for (const statement of module.body) {
    if (
      statement.kind !== "import" ||
      (!CLIENT_MODULE.test(statement.source) && statement.source !== "hesperia")
    )
      continue;

    for (const specifier of statement.specifiers) {
      if (specifier.kind === "namespace") namespaces.add(specifier.bindingId ?? "");
      else if (
        specifier.kind === "named" &&
        ((CLIENT_MODULE.test(statement.source) && BINDING_FACTORIES.has(specifier.imported)) ||
          (statement.source === "hesperia" && specifier.imported === "client"))
      ) {
        if (statement.source === "hesperia" && specifier.imported === "client")
          namespaces.add(specifier.bindingId ?? "");
        else factories.add(specifier.bindingId ?? "");
      }
    }
  }

  namespaces.delete("");

  factories.delete("");

  return { namespaces, factories };
}

function visitTopLevel(
  statement: CanonicalStatement,
  client: ClientBindings,
  diagnostics: CompilerDiagnostic[],
): void {
  if (statement.kind === "function") {
    if (
      statement.component === true ||
      statement.props !== undefined ||
      isComponentBody(statement.body)
    ) {
      const bindings = new Set<string>();

      for (const parameter of statement.parameters)
        visitPattern(parameter, bindings, client, diagnostics);

      visitComponentBlock(statement.body, client, diagnostics, bindings);
    }

    return;
  }

  if (statement.kind === "variable") {
    for (const declaration of statement.declarations) {
      const initializer = declaration.initializer;
      const component =
        initializer && !isChild(initializer) ? componentFactoryExpression(initializer) : undefined;

      if (initializer && !isChild(initializer) && component) {
        const bindings = new Set<string>();

        for (const parameter of component.parameters)
          visitPattern(parameter, bindings, client, diagnostics);

        visitComponentValue(component.body, client, diagnostics, bindings);
      }
    }

    return;
  }

  if (statement.kind === "export") {
    if (statement.declaration.kind === "expression") {
      const expression = statement.declaration.expression;
      const component = componentFactoryExpression(expression);

      if (component && !isChild(component.body)) {
        const bindings = new Set<string>();

        for (const parameter of component.parameters)
          visitPattern(parameter, bindings, client, diagnostics);

        visitComponentValue(component.body, client, diagnostics, bindings);
      }

      return;
    }

    visitTopLevel(statement.declaration, client, diagnostics);
  }
}

function visitClassDefinition(
  value: Pick<Extract<CanonicalExpression, { kind: "class" }>, "superClass" | "elements">,
  bindings: Set<string>,
  client: ClientBindings,
  diagnostics: CompilerDiagnostic[],
): void {
  if (value.superClass) visitExpression(value.superClass, bindings, client, diagnostics);

  for (const element of value.elements) {
    if (element.kind === "static-block") {
      visitComponentBlock(element.body, client, diagnostics, bindings);

      continue;
    }

    if (element.computed && typeof element.key === "object")
      visitExpression(element.key, bindings, client, diagnostics);

    if (element.kind === "field" && element.static && element.initializer)
      visitExpression(element.initializer, bindings, client, diagnostics);
  }
}

function visitComponentValue(
  value: CanonicalExpression | CanonicalChild | CanonicalStatementBlock,
  client: ClientBindings,
  diagnostics: CompilerDiagnostic[],
  bindings = new Set<string>(),
): void {
  if (value.kind === "block") visitComponentBlock(value, client, diagnostics, bindings);
  else if (isChild(value)) visitChild(value, bindings, client, diagnostics);
}

function visitComponentBlock(
  block: CanonicalStatementBlock,
  client: ClientBindings,
  diagnostics: CompilerDiagnostic[],
  bindings = new Set<string>(),
): void {
  for (const statement of block.body) visitStatement(statement, bindings, client, diagnostics);
}

function visitStatement(
  statement: CanonicalStatement,
  bindings: Set<string>,
  client: ClientBindings,
  diagnostics: CompilerDiagnostic[],
): void {
  switch (statement.kind) {
    case "switch":
      visitExpression(statement.discriminant, bindings, client, diagnostics);

      for (const branch of statement.cases) {
        if (branch.test) visitExpression(branch.test, bindings, client, diagnostics);

        for (const child of branch.consequent) visitStatement(child, bindings, client, diagnostics);
      }

      return;
    case "class":
      visitClassDefinition(statement, bindings, client, diagnostics);

      return;
    case "try":
      visitStatement(statement.body, bindings, client, diagnostics);

      if (statement.handler) {
        if (statement.handler.param)
          visitPattern(statement.handler.param, bindings, client, diagnostics);

        visitStatement(statement.handler.body, bindings, client, diagnostics);
      }

      if (statement.finalizer) visitStatement(statement.finalizer, bindings, client, diagnostics);

      return;
    case "variable":
      for (const declaration of statement.declarations) {
        if (
          declaration.initializer &&
          !isChild(declaration.initializer) &&
          isBindingFactoryCall(declaration.initializer, client)
        ) {
          for (const id of patternBindingIds(declaration.pattern)) bindings.add(id);
        }

        if (declaration.initializer)
          visitValue(declaration.initializer, bindings, client, diagnostics);

        visitPattern(declaration.pattern, bindings, client, diagnostics);
      }

      return;
    case "return":
      if (statement.argument) visitValue(statement.argument, bindings, client, diagnostics);

      return;
    case "expression":
      visitExpression(statement.expression, bindings, client, diagnostics);

      return;
    case "if": {
      visitExpression(statement.test, bindings, client, diagnostics);

      const consequentBindings = new Set(bindings);

      visitStatement(statement.consequent, consequentBindings, client, diagnostics);

      for (const id of consequentBindings) bindings.add(id);

      if (statement.alternate) {
        const alternateBindings = new Set(bindings);

        visitStatement(statement.alternate, alternateBindings, client, diagnostics);

        for (const id of alternateBindings) bindings.add(id);
      }

      return;
    }
    case "throw":
      visitExpression(statement.argument, bindings, client, diagnostics);

      return;
    case "for":
      if (statement.init?.kind === "variable")
        visitStatement(statement.init, bindings, client, diagnostics);
      else if (statement.init) visitExpression(statement.init, bindings, client, diagnostics);

      if (statement.test) visitExpression(statement.test, bindings, client, diagnostics);

      visitStatement(statement.body, bindings, client, diagnostics);

      if (statement.update) visitExpression(statement.update, bindings, client, diagnostics);

      return;
    case "for-of":
    case "for-in":
      visitExpression(statement.right, bindings, client, diagnostics);

      if (statement.left.kind === "declaration")
        visitPattern(statement.left.pattern, bindings, client, diagnostics);
      else visitExpression(statement.left.target, bindings, client, diagnostics);

      visitStatement(statement.body, bindings, client, diagnostics);

      return;
    case "while":
      visitExpression(statement.test, bindings, client, diagnostics);

      visitStatement(statement.body, bindings, client, diagnostics);

      return;
    case "do-while":
      visitStatement(statement.body, bindings, client, diagnostics);

      visitExpression(statement.test, bindings, client, diagnostics);

      return;
    case "labeled":
      visitStatement(statement.body, bindings, client, diagnostics);

      return;
    case "block": {
      const blockBindings = new Set(bindings);

      for (const child of statement.body) visitStatement(child, blockBindings, client, diagnostics);

      for (const id of blockBindings) bindings.add(id);

      return;
    }
    default:
      // Imports, nested declarations, and exports are outside the owning render body profile.
      return;
  }
}

function visitValue(
  value: CanonicalExpression | CanonicalChild,
  bindings: Set<string>,
  client: ClientBindings,
  diagnostics: CompilerDiagnostic[],
): void {
  if (isChild(value)) visitChild(value, bindings, client, diagnostics);
  else visitExpression(value, bindings, client, diagnostics);
}

function visitChild(
  child: CanonicalChild,
  bindings: Set<string>,
  client: ClientBindings,
  diagnostics: CompilerDiagnostic[],
): void {
  switch (child.kind) {
    case "element":
      for (const attribute of child.attributes)
        visitAttribute(attribute, bindings, client, diagnostics);

      for (const nested of child.children) visitChild(nested, bindings, client, diagnostics);

      return;
    case "fragment":
      for (const nested of child.children) visitChild(nested, bindings, client, diagnostics);

      return;
    case "dynamic-child":
      visitExpression(child.expression, bindings, client, diagnostics);

      return;
    case "component":
    case "await-child":
      visitExpression(child.reference, bindings, client, diagnostics);

      for (const prop of child.props) {
        if (prop.kind === "value") visitExpression(prop.expression, bindings, client, diagnostics);
        else if (prop.kind === "children")
          for (const nested of prop.children) visitChild(nested, bindings, client, diagnostics);
        else visitChild(prop.child, bindings, client, diagnostics);
      }

      return;
    case "raw-html":
      if (child.host) visitChild(child.host, bindings, client, diagnostics);

      visitExpression(child.html, bindings, client, diagnostics);

      return;
    case "conditional":
      visitExpression(child.test, bindings, client, diagnostics);

      if (child.consequent) visitChild(child.consequent, bindings, client, diagnostics);

      if (child.alternate) visitChild(child.alternate, bindings, client, diagnostics);

      return;
    case "list":
      visitExpression(child.collection, bindings, client, diagnostics);

      visitPattern(child.parameter, bindings, client, diagnostics);

      visitExpression(child.key, bindings, client, diagnostics);

      visitChild(child.body, bindings, client, diagnostics);

      return;
    case "text":
      return;
  }
}

function visitAttribute(
  attribute: CanonicalAttribute,
  bindings: Set<string>,
  client: ClientBindings,
  diagnostics: CompilerDiagnostic[],
): void {
  if (attribute.kind === "static") return;

  visitExpression(attribute.expression, bindings, client, diagnostics);
}

function visitExpression(
  expression: CanonicalExpression,
  bindings: Set<string>,
  client: ClientBindings,
  diagnostics: CompilerDiagnostic[],
): void {
  if (isBindingRead(expression, bindings, client)) {
    diagnostics.push({
      code: "HES-BIND-BODY",
      severity: "error",
      message: "A binding cannot be read in a component body; read it from an effect or callback.",
      span: expression.span,
    });

    return;
  }

  switch (expression.kind) {
    case "class":
      visitClassDefinition(expression, bindings, client, diagnostics);

      return;
    case "identifier":
    case "literal":
    case "regexp":
    case "bigint":
    case "undefined":
    case "this":
    case "super":
    case "private":
    case "new-target":
    case "import-meta":
      return;
    case "template":
      for (const item of expression.expressions)
        visitExpression(item, bindings, client, diagnostics);

      return;
    case "sequence":
      for (const item of expression.expressions)
        visitExpression(item, bindings, client, diagnostics);

      return;
    case "await":
      visitExpression(expression.expression, bindings, client, diagnostics);

      return;
    case "yield":
      if (expression.expression)
        visitExpression(expression.expression, bindings, client, diagnostics);

      return;
    case "import-expression":
      visitExpression(expression.source, bindings, client, diagnostics);

      if (expression.options) visitExpression(expression.options, bindings, client, diagnostics);

      return;
    case "member":
      visitExpression(expression.object, bindings, client, diagnostics);

      if (expression.computed) visitExpression(expression.property, bindings, client, diagnostics);

      return;
    case "call":
      visitExpression(expression.callee, bindings, client, diagnostics);

      for (const argument of expression.arguments)
        visitExpression(
          argument.kind === "spread" ? argument.argument : argument,
          bindings,
          client,
          diagnostics,
        );

      return;
    case "new":
      visitExpression(expression.callee, bindings, client, diagnostics);

      for (const argument of expression.arguments)
        visitExpression(
          argument.kind === "spread" ? argument.argument : argument,
          bindings,
          client,
          diagnostics,
        );

      return;
    case "assignment":
      visitExpression(expression.left, bindings, client, diagnostics);

      visitExpression(expression.right, bindings, client, diagnostics);

      if (
        expression.left.kind === "identifier" &&
        expression.left.referenceId &&
        isBindingFactoryCall(expression.right, client)
      )
        bindings.add(expression.left.referenceId);

      return;
    case "binary":
      visitExpression(expression.left, bindings, client, diagnostics);

      visitExpression(expression.right, bindings, client, diagnostics);

      return;
    case "unary":
      visitExpression(expression.argument, bindings, client, diagnostics);

      return;
    case "conditional":
      visitExpression(expression.test, bindings, client, diagnostics);

      visitExpression(expression.consequent, bindings, client, diagnostics);

      visitExpression(expression.alternate, bindings, client, diagnostics);

      return;
    case "arrow":
    case "function-expression":
      // Effect, event, and other callback bodies are not component-body reads.
      return;
    case "object":
      for (const property of expression.properties) {
        if (property.kind === "spread")
          visitExpression(property.argument, bindings, client, diagnostics);
        else {
          if (typeof property.key !== "string")
            visitExpression(property.key, bindings, client, diagnostics);

          visitExpression(property.value, bindings, client, diagnostics);
        }
      }

      return;
    case "array":
      for (const item of expression.elements)
        if (item)
          visitExpression(
            item.kind === "spread" ? item.argument : item,
            bindings,
            client,
            diagnostics,
          );

      return;
  }
}

function isBindingFactoryCall(value: CanonicalExpression, client: ClientBindings): boolean {
  if (value.kind !== "call" || value.optional) return false;

  if (value.callee.kind === "identifier")
    return client.factories.has(value.callee.referenceId ?? "");

  return (
    value.callee.kind === "member" &&
    !value.callee.computed &&
    !value.callee.optional &&
    value.callee.object.kind === "identifier" &&
    client.namespaces.has(value.callee.object.referenceId ?? "") &&
    value.callee.property.kind === "identifier" &&
    BINDING_FACTORIES.has(value.callee.property.name)
  );
}

function visitPattern(
  pattern: CanonicalPattern,
  bindings: Set<string>,
  client: ClientBindings,
  diagnostics: CompilerDiagnostic[],
): void {
  if (pattern.kind === "identifier") return;

  if (pattern.kind === "rest") return visitPattern(pattern.argument, bindings, client, diagnostics);

  if (pattern.kind === "default") {
    visitExpression(pattern.right, bindings, client, diagnostics);

    if (isBindingFactoryCall(pattern.right, client))
      for (const id of patternBindingIds(pattern.left)) bindings.add(id);

    visitPattern(pattern.left, bindings, client, diagnostics);
  } else if (pattern.kind === "array") {
    for (const element of pattern.elements)
      if (element) visitPattern(element, bindings, client, diagnostics);
  } else {
    for (const property of pattern.properties)
      visitPattern(property.value, bindings, client, diagnostics);

    if (pattern.rest) visitPattern(pattern.rest, bindings, client, diagnostics);
  }
}

function isBindingRead(
  value: CanonicalExpression,
  bindings: ReadonlySet<string>,
  client: ClientBindings,
): boolean {
  if (value.kind !== "call" || value.optional) return false;

  if (value.callee.kind === "identifier") return bindings.has(value.callee.referenceId ?? "");

  return value.callee.kind === "call" && isBindingFactoryCall(value.callee, client);
}

function patternBindingIds(pattern: CanonicalPattern): readonly string[] {
  if (pattern.kind === "identifier") return pattern.bindingId ? [pattern.bindingId] : [];

  if (pattern.kind === "rest") return patternBindingIds(pattern.argument);

  if (pattern.kind === "default") return patternBindingIds(pattern.left);

  if (pattern.kind === "array")
    return pattern.elements.flatMap((item) => (item ? patternBindingIds(item) : []));

  return [
    ...pattern.properties.flatMap((item) => patternBindingIds(item.value)),
    ...(pattern.rest ? patternBindingIds(pattern.rest) : []),
  ];
}

const isChild = isCanonicalChild;
