import type {
  CanonicalArgument,
  CanonicalAttribute,
  CanonicalCapture,
  CanonicalChild,
  CanonicalComponentProp,
  CanonicalClassElement,
  CanonicalExpression,
  CanonicalForLeft,
  CanonicalModule,
  CanonicalPattern,
  CanonicalProperty,
  CanonicalStatement,
  CanonicalStatementBlock,
} from "./ir.ts";

import { isCanonicalChild } from "./ir.ts";

const isChild = isCanonicalChild;

interface Scope {
  readonly parent?: Scope;
  readonly path: string;
  readonly bindings: Map<string, string>;
  readonly labels: Map<string, string>;
  readonly privateNames: Map<string, string>;
  readonly listParameterBindings: ReadonlySet<string>;
  readonly functionBoundary: boolean;
  next: number;
}

/** Attach deterministic lexical binding and reference IDs to canonical meaning. */
export function resolveCanonicalModule(module: CanonicalModule): CanonicalModule {
  const scope: Scope = {
    path: "m",
    bindings: new Map(),
    labels: new Map(),
    privateNames: new Map(),
    listParameterBindings: new Set(),
    functionBoundary: true,
    next: 0,
  };

  for (const statement of module.body) predeclare(statement, scope);

  predeclareVars(module.body, scope);

  return { ...module, body: module.body.map((statement) => resolveStatement(statement, scope)) };
}

function predeclare(statement: CanonicalStatement, scope: Scope): void {
  if (statement.kind === "function" || statement.kind === "class") bind(scope, statement.name);
  else if (statement.kind === "variable") {
    const declarationScope =
      statement.declarationKind === "var" ? nearestFunctionScope(scope) : scope;

    for (const declaration of statement.declarations)
      predeclarePattern(declaration.pattern, declarationScope);
  } else if (statement.kind === "import")
    for (const specifier of statement.specifiers) bind(scope, specifier.local);
  else if (statement.kind === "export") predeclare(statement.declaration, scope);
}

function bind(scope: Scope, name: string): string {
  const existing = scope.bindings.get(name);

  if (existing) return existing;

  const id = `${scope.path}/b${scope.next++}`;

  scope.bindings.set(name, id);

  return id;
}

function lookup(scope: Scope, name: string): string {
  return (
    scope.bindings.get(name) ?? (scope.parent ? lookup(scope.parent, name) : `unresolved/${name}`)
  );
}

function bindPrivate(scope: Scope, name: string): string {
  const existing = scope.privateNames.get(name);

  if (existing) return existing;

  const id = `${scope.path}/p${scope.privateNames.size}`;

  scope.privateNames.set(name, id);

  return id;
}

function lookupPrivate(scope: Scope, name: string): string {
  return (
    scope.privateNames.get(name) ??
    (scope.parent ? lookupPrivate(scope.parent, name) : `unresolved-private/${name}`)
  );
}

function bindLabel(scope: Scope, name: string): string {
  const existing = scope.labels.get(name);

  if (existing) return existing;

  const id = `${scope.path}/l${scope.labels.size}`;

  scope.labels.set(name, id);

  return id;
}

function lookupLabel(scope: Scope, name: string): string {
  return (
    scope.labels.get(name) ??
    (scope.parent ? lookupLabel(scope.parent, name) : `unresolved-label/${name}`)
  );
}

function nearestFunctionScope(scope: Scope): Scope {
  let current = scope;

  while (current.parent && !current.functionBoundary) current = current.parent;

  return current;
}

function predeclareVars(statements: readonly CanonicalStatement[], scope: Scope): void {
  for (const statement of statements) predeclareVar(statement, scope);
}

function predeclareVar(statement: CanonicalStatement, scope: Scope): void {
  switch (statement.kind) {
    case "variable":
      if (statement.declarationKind === "var")
        for (const declaration of statement.declarations)
          predeclarePattern(declaration.pattern, scope);

      return;
    case "block":
      predeclareVars(statement.body, scope);

      return;
    case "if":
      predeclareVar(statement.consequent, scope);

      if (statement.alternate) predeclareVar(statement.alternate, scope);

      return;
    case "switch":
      for (const item of statement.cases) predeclareVars(item.consequent, scope);

      return;
    case "for":
      if (statement.init?.kind === "variable") predeclareVar(statement.init, scope);

      predeclareVar(statement.body, scope);

      return;
    case "for-of":
    case "for-in":
      if (statement.left.kind === "declaration" && statement.left.declarationKind === "var")
        predeclarePattern(statement.left.pattern, scope);

      predeclareVar(statement.body, scope);

      return;
    case "while":
    case "do-while":
    case "labeled":
      predeclareVar(statement.body, scope);

      return;
    case "try":
      predeclareVar(statement.body, scope);

      if (statement.handler) predeclareVar(statement.handler.body, scope);

      if (statement.finalizer) predeclareVar(statement.finalizer, scope);

      return;
    case "export":
      predeclareVar(statement.declaration, scope);

      return;
    case "function":
      return;
    default:
      return;
  }
}

function predeclarePattern(pattern: CanonicalPattern, scope: Scope): void {
  if (pattern.kind === "identifier") bind(scope, pattern.name);
  else if (pattern.kind === "rest") predeclarePattern(pattern.argument, scope);
  else if (pattern.kind === "default") predeclarePattern(pattern.left, scope);
  else if (pattern.kind === "array") {
    for (const item of pattern.elements) if (item) predeclarePattern(item, scope);
  } else if (pattern.kind === "object") {
    for (const item of pattern.properties) predeclarePattern(item.value, scope);

    if (pattern.rest) predeclarePattern(pattern.rest, scope);
  }
}

function resolvePattern(
  pattern: CanonicalPattern,
  scope: Scope,
  declare: boolean,
): CanonicalPattern {
  if (pattern.kind === "identifier")
    return {
      ...pattern,
      bindingId: declare ? bind(scope, pattern.name) : lookup(scope, pattern.name),
    };

  if (pattern.kind === "rest")
    return { ...pattern, argument: resolvePattern(pattern.argument, scope, declare) };

  if (pattern.kind === "default")
    return {
      ...pattern,
      left: resolvePattern(pattern.left, scope, declare),
      right: resolveExpression(pattern.right, scope),
    };

  if (pattern.kind === "array")
    return {
      ...pattern,
      elements: pattern.elements.map((item) => item && resolvePattern(item, scope, declare)),
    };

  return {
    ...pattern,
    rest: pattern.rest ? resolvePattern(pattern.rest, scope, declare) : undefined,
    properties: pattern.properties.map((item) => ({
      ...item,
      value: resolvePattern(item.value, scope, declare),
    })),
  };
}

function resolveParameters(
  parameters: readonly CanonicalPattern[],
  scope: Scope,
): readonly CanonicalPattern[] {
  // All parameter bindings exist in the parameter environment while defaults
  // are evaluated. A later parameter is visible to name resolution but cannot
  // be read before initialization, while function-body declarations remain in
  // a separate environment.
  for (const parameter of parameters) predeclarePattern(parameter, scope);

  return parameters.map((parameter) => resolvePattern(parameter, scope, false));
}

function hasPatternDefaults(pattern: CanonicalPattern): boolean {
  if (pattern.kind === "default") return true;

  if (pattern.kind === "rest") return hasPatternDefaults(pattern.argument);

  if (pattern.kind === "array")
    return pattern.elements.some((item) => item !== null && hasPatternDefaults(item));

  if (pattern.kind === "object")
    return (
      pattern.properties.some((item) => hasPatternDefaults(item.value)) ||
      (pattern.rest ? hasPatternDefaults(pattern.rest) : false)
    );

  return false;
}

function childScope(parent: Scope, suffix: string, functionBoundary = false): Scope {
  return {
    parent,
    path: `${parent.path}/${suffix}`,
    bindings: new Map(),
    labels: functionBoundary ? new Map() : parent.labels,
    privateNames: parent.privateNames,
    listParameterBindings: parent.listParameterBindings,
    functionBoundary,
    next: 0,
  };
}

function classChildScope(parent: Scope, suffix: string, name: string | null): Scope {
  const scope = {
    ...childScope(parent, suffix),
    privateNames: new Map<string, string>(),
  };

  if (name !== null) bind(scope, name);

  return scope;
}

function resolveClassElements(
  elements: readonly CanonicalClassElement[],
  scope: Scope,
): readonly CanonicalClassElement[] {
  for (const element of elements) {
    if (element.kind === "static-block") continue;

    const key = element.key;

    if (typeof key === "object" && key.kind === "private") bindPrivate(scope, key.name);
  }

  const keyOf = (
    key: string | number | CanonicalExpression,
  ): string | number | CanonicalExpression =>
    typeof key === "object" && key.kind === "private"
      ? { ...key, bindingId: lookupPrivate(scope, key.name) }
      : typeof key === "object"
        ? resolveExpression(key, scope)
        : key;

  return elements.map((element) => {
    if (element.kind === "static-block") {
      const blockScope = childScope(scope, `s${scope.next++}`);
      return { ...element, body: resolveBlock(element.body, blockScope) };
    }

    const key = keyOf(element.key);

    if (element.kind === "field")
      return {
        ...element,
        key,
        initializer: element.initializer ? resolveExpression(element.initializer, scope) : null,
      };

    const methodScope = childScope(scope, `m${scope.next++}`, true);
    const parameters = resolveParameters(element.parameters, methodScope);
    const bodyScope = element.parameters.some(hasPatternDefaults)
      ? childScope(methodScope, "body", true)
      : methodScope;
    return {
      ...element,
      key,
      parameters,
      body: resolveBlock(element.body, bodyScope),
    };
  });
}

function resolveBlock(block: CanonicalStatementBlock, scope: Scope): CanonicalStatementBlock {
  for (const statement of block.body) predeclare(statement, scope);

  predeclareVars(block.body, nearestFunctionScope(scope));

  return { ...block, body: block.body.map((statement) => resolveStatement(statement, scope)) };
}

function resolveStatement(statement: CanonicalStatement, scope: Scope): CanonicalStatement {
  switch (statement.kind) {
    case "import":
      return {
        ...statement,
        specifiers: statement.specifiers.map((specifier) => ({
          ...specifier,
          bindingId: lookup(scope, specifier.local),
        })),
      };
    case "function": {
      const inner = childScope(scope, `f${scope.next++}`, true);
      const parameters = resolveParameters(statement.parameters, inner);
      const bodyScope = statement.parameters.some(hasPatternDefaults)
        ? childScope(inner, "body", true)
        : inner;
      return {
        ...statement,
        bindingId: lookup(scope, statement.name),
        parameters,
        body: resolveBlock(statement.body, bodyScope),
      };
    }
    case "class": {
      const classScope = classChildScope(scope, `c${scope.next++}`, statement.name);
      return {
        ...statement,
        bindingId: lookup(scope, statement.name),
        superClass: statement.superClass
          ? resolveExpression(statement.superClass, classScope)
          : null,
        elements: resolveClassElements(statement.elements, classScope),
      };
    }
    case "variable":
      return {
        ...statement,
        declarations: statement.declarations.map((declaration) => {
          const pattern = resolvePattern(declaration.pattern, scope, false);
          const hoistedBindingIds =
            statement.declarationKind === "var"
              ? patternNames(pattern).map((name) => lookup(nearestFunctionScope(scope), name))
              : [];
          const resolvedBindingIds = patternBindingIds(pattern);
          const hasShadowedBinding =
            hoistedBindingIds.length === resolvedBindingIds.length &&
            hoistedBindingIds.some((bindingId, index) => bindingId !== resolvedBindingIds[index]);
          return {
            ...declaration,
            pattern,
            ...(hasShadowedBinding ? { hoistedBindingIds } : {}),
            initializer: declaration.initializer
              ? resolveValue(declaration.initializer, scope)
              : null,
          };
        }),
      };
    case "return":
      return {
        ...statement,
        argument: statement.argument ? resolveValue(statement.argument, scope) : null,
      };
    case "expression":
      return { ...statement, expression: resolveExpression(statement.expression, scope) };
    case "if": {
      const consequent = resolveStatement(statement.consequent, scope);
      const alternate = statement.alternate ? resolveStatement(statement.alternate, scope) : null;
      return {
        ...statement,
        test: resolveExpression(statement.test, scope),
        consequent,
        alternate,
      };
    }
    case "switch": {
      const switchScope = childScope(scope, `w${scope.next++}`);
      const statements = statement.cases.flatMap((item) => item.consequent);

      for (const item of statements) predeclare(item, switchScope);

      predeclareVars(statements, nearestFunctionScope(switchScope));

      return {
        ...statement,
        discriminant: resolveExpression(statement.discriminant, scope),
        cases: statement.cases.map((item) => ({
          ...item,
          test: item.test ? resolveExpression(item.test, switchScope) : null,
          consequent: item.consequent.map((entry) => resolveStatement(entry, switchScope)),
        })),
      };
    }
    case "for": {
      const loopScope =
        statement.init?.kind === "variable" && statement.init.declarationKind !== "var"
          ? childScope(scope, `l${scope.next++}`)
          : scope;

      if (statement.init?.kind === "variable") predeclare(statement.init, loopScope);

      return {
        ...statement,
        init: statement.init
          ? statement.init.kind === "variable"
            ? (resolveStatement(statement.init, loopScope) as Extract<
                CanonicalStatement,
                { kind: "variable" }
              >)
            : resolveExpression(statement.init, loopScope)
          : null,
        test: statement.test ? resolveExpression(statement.test, loopScope) : null,
        update: statement.update ? resolveExpression(statement.update, loopScope) : null,
        body: resolveStatement(statement.body, loopScope),
      };
    }
    case "for-of":
    case "for-in": {
      const loopScope =
        statement.left.kind === "declaration" && statement.left.declarationKind !== "var"
          ? childScope(scope, `l${scope.next++}`)
          : scope;

      if (statement.left.kind === "declaration")
        predeclarePattern(
          statement.left.pattern,
          statement.left.declarationKind === "var" ? nearestFunctionScope(loopScope) : loopScope,
        );

      return {
        ...statement,
        left: resolveForLeft(statement.left, loopScope, false),
        right: resolveExpression(statement.right, loopScope),
        body: resolveStatement(statement.body, loopScope),
      };
    }
    case "while":
      return {
        ...statement,
        test: resolveExpression(statement.test, scope),
        body: resolveStatement(statement.body, scope),
      };
    case "do-while":
      return {
        ...statement,
        body: resolveStatement(statement.body, scope),
        test: resolveExpression(statement.test, scope),
      };
    case "labeled": {
      const labeledScope: Scope = {
        ...childScope(scope, `label${scope.next++}`),
        labels: new Map(scope.labels),
      };
      const bindingId = bindLabel(labeledScope, statement.label);
      return {
        ...statement,
        bindingId,
        body: resolveStatement(statement.body, labeledScope),
      };
    }
    case "break":
    case "continue":
      return statement.label === null
        ? statement
        : { ...statement, referenceId: lookupLabel(scope, statement.label) };
    case "throw":
      return { ...statement, argument: resolveExpression(statement.argument, scope) };
    case "try": {
      const body = resolveBlock(statement.body, childScope(scope, `t${scope.next++}`));
      let handler = statement.handler;

      if (handler) {
        const catchScope = childScope(scope, `c${scope.next++}`);

        if (handler.param) predeclarePattern(handler.param, catchScope);

        const param = handler.param ? resolvePattern(handler.param, catchScope, false) : null;
        handler = {
          ...handler,
          param,
          body: resolveBlock(handler.body, catchScope),
        };
      }

      const finalizer = statement.finalizer
        ? resolveBlock(statement.finalizer, childScope(scope, `f${scope.next++}`))
        : null;
      return { ...statement, body, handler, finalizer };
    }
    case "block": {
      const inner = childScope(scope, `s${scope.next++}`);

      for (const item of statement.body) predeclare(item, inner);

      predeclareVars(statement.body, nearestFunctionScope(inner));

      return { ...statement, body: statement.body.map((item) => resolveStatement(item, inner)) };
    }
    case "export": {
      const declaration = resolveStatement(statement.declaration, scope);
      const names =
        declaration.kind === "function"
          ? [declaration.name]
          : declaration.kind === "class"
            ? [declaration.name]
            : declaration.kind === "variable"
              ? declaration.declarations.flatMap((item) => patternNames(item.pattern))
              : [];
      return {
        ...statement,
        declaration,
        exportedBindings: names.map((name) => ({
          exported: statement.exportKind === "default" ? "default" : name,
          referenceId: lookup(scope, name),
        })),
      };
    }
    case "export-list":
      return {
        ...statement,
        specifiers: statement.specifiers.map((specifier) => ({
          ...specifier,
          ...(statement.source === null ? { referenceId: lookup(scope, specifier.local) } : {}),
        })),
      };
    case "export-all":
      return statement;
  }
}

function resolveForLeft(left: CanonicalForLeft, scope: Scope, declare: boolean): CanonicalForLeft {
  if (left.kind === "assignment") return { ...left, target: resolveExpression(left.target, scope) };

  const pattern = resolvePattern(left.pattern, scope, declare);
  const hoistedBindingIds =
    left.declarationKind === "var"
      ? patternNames(pattern).map((name) => lookup(nearestFunctionScope(scope), name))
      : [];
  const resolvedBindingIds = patternBindingIds(pattern);
  const hasShadowedBinding =
    hoistedBindingIds.length === resolvedBindingIds.length &&
    hoistedBindingIds.some((bindingId, index) => bindingId !== resolvedBindingIds[index]);
  return {
    ...left,
    pattern,
    ...(hasShadowedBinding ? { hoistedBindingIds } : {}),
  };
}

function resolveValue(
  value: CanonicalExpression | CanonicalChild,
  scope: Scope,
): CanonicalExpression | CanonicalChild {
  return isChild(value) ? resolveChild(value, scope) : resolveExpression(value, scope);
}

function resolveChild(child: CanonicalChild, scope: Scope): CanonicalChild {
  switch (child.kind) {
    case "element":
      return {
        ...child,
        attributes: child.attributes.map((item) => resolveAttribute(item, scope)),
        children: child.children.map((item) => resolveChild(item, scope)),
      };
    case "fragment":
      return { ...child, children: child.children.map((item) => resolveChild(item, scope)) };
    case "text":
      return child;
    case "dynamic-child":
      return { ...child, expression: resolveExpression(child.expression, scope) };
    case "component":
    case "await-child":
      return {
        ...child,
        reference: resolveExpression(child.reference, scope),
        props: child.props.map((item) => resolveProp(item, scope)),
      };
    case "raw-html":
      return {
        ...child,
        host: child.host
          ? (resolveChild(child.host, scope) as Extract<CanonicalChild, { kind: "element" }>)
          : null,
        html: resolveExpression(child.html, scope),
      };
    case "conditional": {
      const consequent = child.consequent ? resolveChild(child.consequent, scope) : null;
      const alternate = child.alternate ? resolveChild(child.alternate, scope) : null;
      const resolved = {
        ...child,
        test: resolveExpression(child.test, scope),
        consequent,
        alternate,
      };
      return {
        ...resolved,
        captures: collectCaptures(resolved, scope.listParameterBindings),
      };
    }
    case "list": {
      const inner = childScope(scope, `l${scope.next++}`);

      predeclarePattern(child.parameter, inner);

      const parameter = resolvePattern(child.parameter, inner, false);
      const listParameterBindings = new Set([
        ...scope.listParameterBindings,
        ...patternBindingIds(parameter),
      ]);
      const listScope: Scope = { ...inner, listParameterBindings };
      const body = resolveChild(child.body, listScope);
      return {
        ...child,
        collection: resolveExpression(child.collection, scope),
        parameter,
        body,
        key: resolveExpression(child.key, listScope),
        captures: collectCaptures(body, listParameterBindings, [parameter]),
      };
    }
  }
}

function resolveProp(prop: CanonicalComponentProp, scope: Scope): CanonicalComponentProp {
  if (prop.kind === "children")
    return { ...prop, children: prop.children.map((item) => resolveChild(item, scope)) };

  if (prop.kind === "fallback") return { ...prop, child: resolveChild(prop.child, scope) };

  return { ...prop, expression: resolveExpression(prop.expression, scope) };
}

function resolveAttribute(attribute: CanonicalAttribute, scope: Scope): CanonicalAttribute {
  return attribute.kind === "static"
    ? attribute
    : { ...attribute, expression: resolveExpression(attribute.expression, scope) };
}

function resolveExpression(expression: CanonicalExpression, scope: Scope): CanonicalExpression {
  switch (expression.kind) {
    case "identifier":
      return { ...expression, referenceId: lookup(scope, expression.name) };
    case "literal":
    case "regexp":
    case "bigint":
    case "undefined":
    case "this":
      return expression;
    case "super":
    case "new-target":
    case "import-meta":
      return expression;
    case "private":
      return { ...expression, bindingId: lookupPrivate(scope, expression.name) };
    case "template":
      return {
        ...expression,
        expressions: expression.expressions.map((item) => resolveExpression(item, scope)),
      };
    case "sequence":
      return {
        ...expression,
        expressions: expression.expressions.map((item) => resolveExpression(item, scope)),
      };
    case "await":
      return { ...expression, expression: resolveExpression(expression.expression, scope) };
    case "yield":
      return {
        ...expression,
        expression: expression.expression ? resolveExpression(expression.expression, scope) : null,
      };
    case "import-expression":
      return {
        ...expression,
        source: resolveExpression(expression.source, scope),
        options: expression.options ? resolveExpression(expression.options, scope) : null,
      };
    case "member":
      return {
        ...expression,
        object: resolveExpression(expression.object, scope),
        property:
          expression.computed || expression.property.kind === "private"
            ? resolveExpression(expression.property, scope)
            : expression.property,
      };
    case "call":
      return {
        ...expression,
        callee: resolveExpression(expression.callee, scope),
        arguments: expression.arguments.map((item) => resolveArgument(item, scope)),
      };
    case "new":
      return {
        ...expression,
        callee: resolveExpression(expression.callee, scope),
        arguments: expression.arguments.map((item) => resolveArgument(item, scope)),
      };
    case "assignment":
      return {
        ...expression,
        left: resolveExpression(expression.left, scope),
        right: resolveExpression(expression.right, scope),
      };
    case "binary":
      return {
        ...expression,
        left: resolveExpression(expression.left, scope),
        right: resolveExpression(expression.right, scope),
      };
    case "unary":
      return { ...expression, argument: resolveExpression(expression.argument, scope) };
    case "conditional":
      return {
        ...expression,
        test: resolveExpression(expression.test, scope),
        consequent: resolveExpression(expression.consequent, scope),
        alternate: resolveExpression(expression.alternate, scope),
      };
    case "arrow": {
      const inner = childScope(scope, `a${scope.next++}`, true);
      const parameters = resolveParameters(expression.parameters, inner);
      const bodyScope = expression.parameters.some(hasPatternDefaults)
        ? childScope(inner, "body", true)
        : inner;
      return {
        ...expression,
        parameters,
        body: isChild(expression.body)
          ? resolveChild(expression.body, inner)
          : expression.body.kind === "block"
            ? resolveBlock(expression.body, bodyScope)
            : resolveExpression(expression.body, inner),
      };
    }
    case "function-expression": {
      const inner = childScope(scope, `f${scope.next++}`, true);

      if (expression.name !== null) bind(inner, expression.name);

      const parameters = resolveParameters(expression.parameters, inner);
      const bodyScope = expression.parameters.some(hasPatternDefaults)
        ? childScope(inner, "body", true)
        : inner;
      return {
        ...expression,
        nameBindingId: expression.name === null ? undefined : lookup(inner, expression.name),
        parameters,
        body: resolveBlock(expression.body, bodyScope),
      };
    }
    case "class": {
      const classScope = classChildScope(
        scope,
        `c${scope.next++}`,
        expression.name === null ? null : expression.name,
      );
      return {
        ...expression,
        nameBindingId: expression.name === null ? undefined : lookup(classScope, expression.name),
        superClass: expression.superClass
          ? resolveExpression(expression.superClass, classScope)
          : null,
        elements: resolveClassElements(expression.elements, classScope),
      };
    }
    case "object":
      return {
        ...expression,
        properties: expression.properties.map((item) => resolveProperty(item, scope)),
      };
    case "array":
      return {
        ...expression,
        elements: expression.elements.map((item) => item && resolveArgument(item, scope)),
      };
  }
}

function resolveArgument(argument: CanonicalArgument, scope: Scope): CanonicalArgument {
  return argument.kind === "spread"
    ? { ...argument, argument: resolveExpression(argument.argument, scope) }
    : resolveExpression(argument, scope);
}

function resolveProperty(property: CanonicalProperty, scope: Scope): CanonicalProperty {
  if (property.kind === "spread")
    return { ...property, argument: resolveExpression(property.argument, scope) };

  return {
    ...property,
    key:
      property.computed && typeof property.key !== "string"
        ? resolveExpression(property.key, scope)
        : property.key,
    value: resolveExpression(property.value, scope),
  };
}

function patternNames(pattern: CanonicalPattern): string[] {
  if (pattern.kind === "identifier") return [pattern.name];

  if (pattern.kind === "rest") return patternNames(pattern.argument);

  if (pattern.kind === "default") return patternNames(pattern.left);

  if (pattern.kind === "array")
    return pattern.elements.flatMap((item) => (item ? patternNames(item) : []));

  return pattern.properties
    .flatMap((item) => patternNames(item.value))
    .concat(pattern.rest ? patternNames(pattern.rest) : []);
}

function patternBindingIds(pattern: CanonicalPattern): string[] {
  if (pattern.kind === "identifier") return pattern.bindingId ? [pattern.bindingId] : [];

  if (pattern.kind === "rest") return patternBindingIds(pattern.argument);

  if (pattern.kind === "default") return patternBindingIds(pattern.left);

  if (pattern.kind === "array")
    return pattern.elements.flatMap((item) => (item ? patternBindingIds(item) : []));

  return pattern.properties
    .flatMap((item) => patternBindingIds(item.value))
    .concat(pattern.rest ? patternBindingIds(pattern.rest) : []);
}

function collectCaptures(
  child: CanonicalChild,
  listParameterBindings: ReadonlySet<string>,
  patterns: readonly CanonicalPattern[] = [],
): readonly CanonicalCapture[] {
  const captures = new Map<string, CanonicalCapture>();

  const add = (bindingId: string | undefined, name: string): void => {
    if (!bindingId || !listParameterBindings.has(bindingId)) return;

    if (!captures.has(bindingId)) captures.set(bindingId, { bindingId, name });
  };

  const expression = (value: CanonicalExpression): void => {
    switch (value.kind) {
      case "identifier":
        add(value.referenceId, value.name);

        return;
      case "literal":
      case "regexp":
      case "bigint":
      case "undefined":
      case "this":
      case "super":
      case "new-target":
      case "import-meta":
      case "private":
        return;
      case "template":
        for (const item of value.expressions) expression(item);

        return;
      case "sequence":
        for (const item of value.expressions) expression(item);

        return;
      case "await":
        expression(value.expression);

        return;
      case "yield":
        if (value.expression) expression(value.expression);

        return;
      case "import-expression":
        expression(value.source);

        if (value.options) expression(value.options);

        return;
      case "member":
        expression(value.object);

        if (value.computed) expression(value.property);

        return;
      case "call":
        expression(value.callee);

        for (const argument of value.arguments)
          expression(argument.kind === "spread" ? argument.argument : argument);

        return;
      case "new":
        expression(value.callee);

        for (const argument of value.arguments)
          expression(argument.kind === "spread" ? argument.argument : argument);

        return;
      case "assignment":
        expression(value.left);

        expression(value.right);

        return;
      case "binary":
        expression(value.left);

        expression(value.right);

        return;
      case "unary":
        expression(value.argument);

        return;
      case "conditional":
        expression(value.test);

        expression(value.consequent);

        expression(value.alternate);

        return;
      case "arrow":
        for (const parameter of value.parameters) pattern(parameter);

        if (isChild(value.body)) childValue(value.body);
        else if (value.body.kind === "block") block(value.body);
        else expression(value.body);

        return;
      case "function-expression":
        for (const parameter of value.parameters) pattern(parameter);

        block(value.body);

        return;
      case "class":
        if (value.superClass) expression(value.superClass);

        for (const element of value.elements) {
          if (element.kind === "static-block") {
            block(element.body);

            continue;
          }

          if (typeof element.key === "object") expression(element.key);

          if (element.kind === "field") {
            if (element.initializer) expression(element.initializer);
          } else {
            for (const parameter of element.parameters) pattern(parameter);

            block(element.body);
          }
        }

        return;
      case "object":
        for (const property of value.properties) {
          if (property.kind === "spread") expression(property.argument);
          else {
            if (property.computed && typeof property.key !== "string") expression(property.key);

            expression(property.value);
          }
        }

        return;
      case "array":
        for (const item of value.elements)
          if (item) expression(item.kind === "spread" ? item.argument : item);

        return;
    }
  };

  const prop = (value: CanonicalComponentProp): void => {
    if (value.kind === "value") expression(value.expression);
    else if (value.kind === "children") for (const item of value.children) childValue(item);
    else childValue(value.child);
  };

  const pattern = (value: CanonicalPattern): void => {
    if (value.kind === "rest") {
      pattern(value.argument);
    } else if (value.kind === "default") {
      pattern(value.left);

      expression(value.right);
    } else if (value.kind === "array") {
      for (const item of value.elements) if (item) pattern(item);
    } else if (value.kind === "object") {
      for (const item of value.properties) pattern(item.value);

      if (value.rest) pattern(value.rest);
    }
  };

  const attribute = (value: CanonicalAttribute): void => {
    if (value.kind !== "static") expression(value.expression);
  };

  const statement = (value: CanonicalStatement): void => {
    switch (value.kind) {
      case "import":
        return;
      case "variable":
        for (const declaration of value.declarations) {
          pattern(declaration.pattern);

          if (declaration.initializer) {
            if (isChild(declaration.initializer)) childValue(declaration.initializer);
            else expression(declaration.initializer);
          }
        }

        return;
      case "function":
        for (const parameter of value.parameters) pattern(parameter);

        block(value.body);

        return;
      case "class":
        if (value.superClass) expression(value.superClass);

        for (const element of value.elements) {
          if (element.kind === "static-block") {
            block(element.body);

            continue;
          }

          if (typeof element.key === "object") expression(element.key);

          if (element.kind === "field") {
            if (element.initializer) expression(element.initializer);
          } else {
            for (const parameter of element.parameters) pattern(parameter);

            block(element.body);
          }
        }

        return;
      case "return":
        if (value.argument) {
          if (isChild(value.argument)) childValue(value.argument);
          else expression(value.argument);
        }

        return;
      case "expression":
        expression(value.expression);

        return;
      case "if":
        expression(value.test);

        statement(value.consequent);

        if (value.alternate) statement(value.alternate);

        return;
      case "switch":
        expression(value.discriminant);

        for (const item of value.cases) {
          if (item.test) expression(item.test);

          for (const entry of item.consequent) statement(entry);
        }

        return;
      case "for":
        if (value.init) {
          if (value.init.kind === "variable") statement(value.init);
          else expression(value.init);
        }

        if (value.test) expression(value.test);

        if (value.update) expression(value.update);

        statement(value.body);

        return;
      case "for-of":
      case "for-in":
        if (value.left.kind === "declaration") pattern(value.left.pattern);
        else expression(value.left.target);

        expression(value.right);

        statement(value.body);

        return;
      case "while":
        expression(value.test);

        statement(value.body);

        return;
      case "do-while":
        statement(value.body);

        expression(value.test);

        return;
      case "labeled":
        statement(value.body);

        return;
      case "break":
      case "continue":
        return;
      case "throw":
        expression(value.argument);

        return;
      case "try":
        block(value.body);

        if (value.handler) {
          if (value.handler.param) pattern(value.handler.param);

          block(value.handler.body);
        }

        if (value.finalizer) block(value.finalizer);

        return;
      case "block":
        for (const item of value.body) statement(item);

        return;
      case "export":
        statement(value.declaration);

        return;
      case "export-list":
      case "export-all":
        return;
    }
  };

  const block = (value: CanonicalStatementBlock): void => {
    for (const item of value.body) statement(item);
  };

  const childValue = (value: CanonicalChild): void => {
    switch (value.kind) {
      case "element":
        for (const item of value.attributes) attribute(item);

        for (const item of value.children) childValue(item);

        return;
      case "fragment":
        for (const item of value.children) childValue(item);

        return;
      case "text":
        return;
      case "dynamic-child":
        expression(value.expression);

        return;
      case "component":
      case "await-child":
        expression(value.reference);

        for (const item of value.props) prop(item);

        return;
      case "raw-html":
        if (value.host) childValue(value.host);

        expression(value.html);

        return;
      case "conditional":
        expression(value.test);

        if (value.consequent) childValue(value.consequent);

        if (value.alternate) childValue(value.alternate);

        for (const capture of value.captures) add(capture.bindingId, capture.name);

        return;
      case "list":
        expression(value.collection);

        expression(value.key);

        for (const capture of value.captures) add(capture.bindingId, capture.name);

        return;
    }
  };

  for (const item of patterns) pattern(item);

  childValue(child);

  return [...captures.values()];
}
