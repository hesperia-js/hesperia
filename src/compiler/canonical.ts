import type { Program } from "oxc-parser";
import { parseFragment } from "parse5";
import type {
  CanonicalArgument,
  CanonicalAttribute,
  CanonicalChild,
  CanonicalComponent,
  CanonicalComponentProp,
  CanonicalCatchClause,
  CanonicalClassElement,
  CanonicalElement,
  CanonicalForLeft,
  CanonicalExpression,
  CanonicalImportSpecifier,
  CanonicalModule,
  CanonicalPattern,
  CanonicalProperty,
  CanonicalTemplateQuasi,
  CanonicalStatement,
  CanonicalStatementBlock,
  CanonicalSwitchCase,
  CanonicalVariableDeclaration,
  CompilerDiagnostic,
  SourceSpan,
} from "./ir.ts";
import { isCanonicalChild } from "./ir.ts";
import { childNamespace, namespaceForTag, type NamespaceContext } from "./namespace.ts";
import { resolveCanonicalModule } from "./resolve.ts";
import { isConventionalComponentFilename } from "./component-analysis.ts";

type AstNode = { readonly type: string; readonly [key: string]: unknown };
interface MarkerImports {
  readonly unsafeFunctions: ReadonlySet<string>;
  readonly clientNamespaces: ReadonlySet<string>;
  readonly documentShell: boolean;
}

function node(value: unknown): AstNode | null {
  return typeof value === "object" && value !== null && "type" in value ? (value as AstNode) : null;
}

function list(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

function span(input: AstNode): SourceSpan {
  return {
    start: typeof input.start === "number" ? input.start : 0,
    end: typeof input.end === "number" ? input.end : 0,
  };
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function exportName(value: unknown): string | null {
  const item = node(value);
  if (!item) return null;
  if (typeof item.name === "string") return item.name;
  return typeof item.value === "string" ? item.value : null;
}

/** Convert an Oxc AST into the tool-independent canonical render module. */
export interface CanonicalizeOptions {
  /** Permit the explicitly validated root document shell shape. */
  readonly documentShell?: boolean;
}

/** Convert an Oxc AST into the tool-independent canonical render module. */
export function canonicalize(
  program: Program,
  filename: string,
  options: CanonicalizeOptions = {},
): CanonicalModule {
  const diagnostics: CompilerDiagnostic[] = [];
  const markers = { ...markerImports(program), documentShell: options.documentShell === true };
  const body = list(program.body)
    .map((item) => statement(node(item), diagnostics, markers))
    .filter((item): item is CanonicalStatement => item !== null);
  const marked = isConventionalComponentFilename(filename)
    ? markConventionalDefaultComponent(body)
    : body;
  const resolved = resolveCanonicalModule({ version: 1, filename, body: marked, diagnostics });
  const validated = markers.documentShell ? validateDocumentShell(resolved) : resolved;
  return assignOccurrences(validated);
}

function markConventionalDefaultComponent(
  body: readonly CanonicalStatement[],
): readonly CanonicalStatement[] {
  const names = new Set<string>();
  for (const statement of body) {
    if (statement.kind === "export" && statement.exportKind === "default") {
      const declaration = statement.declaration;
      if (declaration.kind === "expression" && declaration.expression.kind === "identifier")
        names.add(declaration.expression.name);
    }
    if (statement.kind === "export-list" && statement.source === null)
      for (const specifier of statement.specifiers)
        if (specifier.exported === "default") names.add(specifier.local);
  }
  const declarations = body.map((statement) =>
    statement.kind === "export" ? statement.declaration : statement,
  );
  for (const name of names) {
    for (const statement of declarations) {
      if (statement.kind !== "variable") continue;
      for (const declaration of statement.declarations)
        if (
          declaration.pattern.kind === "identifier" &&
          declaration.pattern.name === name &&
          declaration.initializer?.kind === "identifier"
        )
          names.add(declaration.initializer.name);
    }
  }
  const mark = (statement: CanonicalStatement, isDefault = false): CanonicalStatement => {
    if (statement.kind === "export")
      return {
        ...statement,
        declaration: mark(statement.declaration, statement.exportKind === "default"),
      };
    if (statement.kind === "function" && (isDefault || names.has(statement.name)))
      return { ...statement, component: true };
    if (statement.kind === "expression" && isDefault) {
      const expression = statement.expression;
      if (expression.kind === "arrow" || expression.kind === "function-expression")
        return { ...statement, expression: { ...expression, component: true } };
    }
    if (statement.kind !== "variable") return statement;
    const declarations = statement.declarations.map((item) => {
      if (
        item.pattern.kind !== "identifier" ||
        !names.has(item.pattern.name) ||
        !item.initializer ||
        isCanonicalChild(item.initializer) ||
        (item.initializer.kind !== "arrow" && item.initializer.kind !== "function-expression")
      )
        return item;
      return {
        ...item,
        initializer: { ...item.initializer, component: true },
      };
    });
    return declarations.some((item, index) => item !== statement.declarations[index])
      ? { ...statement, declarations }
      : statement;
  };
  return body.map((statement) => mark(statement));
}

function assignOccurrences(module: CanonicalModule): CanonicalModule {
  return {
    ...module,
    body: module.body.map((item, index) => assignStatement(item, `s${index}`)),
  };
}

function assignStatement(statement: CanonicalStatement, path: string): CanonicalStatement {
  switch (statement.kind) {
    case "import":
      return statement;
    case "variable":
      return {
        ...statement,
        declarations: statement.declarations.map((declaration, index) => ({
          ...declaration,
          pattern: assignPattern(declaration.pattern, `${path}.d${index}.p`),
          initializer:
            declaration.initializer === null
              ? null
              : isCanonicalChild(declaration.initializer)
                ? assignChild(declaration.initializer, `${path}.d${index}`)
                : assignExpression(declaration.initializer, `${path}.d${index}`),
        })),
      };
    case "function":
      return {
        ...statement,
        parameters: statement.parameters.map((item, index) =>
          assignPattern(item, `${path}.p${index}`),
        ),
        body: assignBlock(statement.body, `${path}.b`),
      };
    case "class":
      return {
        ...statement,
        superClass: statement.superClass
          ? assignExpression(statement.superClass, `${path}.s`)
          : null,
        elements: statement.elements.map((item, index) =>
          assignClassElement(item, `${path}.e${index}`),
        ),
      };
    case "return":
      return {
        ...statement,
        argument:
          statement.argument === null
            ? null
            : isCanonicalChild(statement.argument)
              ? assignChild(statement.argument, `${path}.r`)
              : assignExpression(statement.argument, `${path}.r`),
      };
    case "expression":
      return { ...statement, expression: assignExpression(statement.expression, `${path}.e`) };
    case "if":
      return {
        ...statement,
        test: assignExpression(statement.test, `${path}.t`),
        consequent: assignStatement(statement.consequent, `${path}.c`),
        alternate: statement.alternate ? assignStatement(statement.alternate, `${path}.a`) : null,
      };
    case "switch":
      return {
        ...statement,
        discriminant: assignExpression(statement.discriminant, `${path}.d`),
        cases: statement.cases.map((item, index) => ({
          ...item,
          test: item.test ? assignExpression(item.test, `${path}.c${index}.t`) : null,
          consequent: item.consequent.map((entry, entryIndex) =>
            assignStatement(entry, `${path}.c${index}.s${entryIndex}`),
          ),
        })),
      };
    case "for":
      return {
        ...statement,
        init:
          statement.init === null
            ? null
            : statement.init.kind === "variable"
              ? (assignStatement(statement.init, `${path}.i`) as Extract<
                  CanonicalStatement,
                  { kind: "variable" }
                >)
              : assignExpression(statement.init, `${path}.i`),
        test: statement.test ? assignExpression(statement.test, `${path}.t`) : null,
        update: statement.update ? assignExpression(statement.update, `${path}.u`) : null,
        body: assignStatement(statement.body, `${path}.b`),
      };
    case "for-of":
    case "for-in":
      return {
        ...statement,
        left: assignForLeft(statement.left, `${path}.l`),
        right: assignExpression(statement.right, `${path}.r`),
        body: assignStatement(statement.body, `${path}.b`),
      };
    case "while":
      return {
        ...statement,
        test: assignExpression(statement.test, `${path}.t`),
        body: assignStatement(statement.body, `${path}.b`),
      };
    case "do-while":
      return {
        ...statement,
        body: assignStatement(statement.body, `${path}.b`),
        test: assignExpression(statement.test, `${path}.t`),
      };
    case "labeled":
      return { ...statement, body: assignStatement(statement.body, `${path}.b`) };
    case "break":
    case "continue":
      return statement;
    case "throw":
      return { ...statement, argument: assignExpression(statement.argument, `${path}.e`) };
    case "try":
      return {
        ...statement,
        body: assignBlock(statement.body, `${path}.t`),
        handler: statement.handler
          ? {
              ...statement.handler,
              param: statement.handler.param
                ? assignPattern(statement.handler.param, `${path}.c.p`)
                : null,
              body: assignBlock(statement.handler.body, `${path}.c.b`),
            }
          : null,
        finalizer: statement.finalizer ? assignBlock(statement.finalizer, `${path}.f`) : null,
      };
    case "block":
      return {
        ...statement,
        body: statement.body.map((item, index) => assignStatement(item, `${path}.b${index}`)),
      };
    case "export":
      return { ...statement, declaration: assignStatement(statement.declaration, `${path}.x`) };
    case "export-list":
    case "export-all":
      return statement;
  }
}

function assignForLeft(left: CanonicalForLeft, path: string): CanonicalForLeft {
  return left.kind === "declaration"
    ? { ...left, pattern: assignPattern(left.pattern, `${path}.p`) }
    : { ...left, target: assignExpression(left.target, `${path}.t`) };
}

function assignBlock(block: CanonicalStatementBlock, path: string): CanonicalStatementBlock {
  return {
    ...block,
    body: block.body.map((item, index) => assignStatement(item, `${path}${index}`)),
  };
}

function assignPattern(pattern: CanonicalPattern, path: string): CanonicalPattern {
  if (pattern.kind === "identifier") return pattern;
  if (pattern.kind === "rest")
    return { ...pattern, argument: assignPattern(pattern.argument, `${path}.r`) };
  if (pattern.kind === "default") {
    return {
      ...pattern,
      left: assignPattern(pattern.left, `${path}.l`),
      right: assignExpression(pattern.right, `${path}.r`),
    };
  }
  if (pattern.kind === "array") {
    return {
      ...pattern,
      elements: pattern.elements.map((item, index) =>
        item ? assignPattern(item, `${path}.a${index}`) : null,
      ),
    };
  }
  return {
    ...pattern,
    rest: pattern.rest ? assignPattern(pattern.rest, `${path}.r`) : undefined,
    properties: pattern.properties.map((item, index) => ({
      ...item,
      value: assignPattern(item.value, `${path}.p${index}`),
    })),
  };
}

function assignExpression(expression: CanonicalExpression, path: string): CanonicalExpression {
  switch (expression.kind) {
    case "identifier":
    case "literal":
    case "regexp":
    case "bigint":
    case "undefined":
    case "this":
    case "super":
    case "new-target":
    case "private":
      return expression;
    case "template":
      return {
        ...expression,
        expressions: expression.expressions.map((item, index) =>
          assignExpression(item, `${path}.e${index}`),
        ),
      };
    case "await":
      return { ...expression, expression: assignExpression(expression.expression, `${path}.a`) };
    case "yield":
      return {
        ...expression,
        expression: expression.expression
          ? assignExpression(expression.expression, `${path}.y`)
          : null,
      };
    case "member":
      return {
        ...expression,
        object: assignExpression(expression.object, `${path}.o`),
        property: assignExpression(expression.property, `${path}.p`),
      };
    case "call":
      return {
        ...expression,
        callee: assignExpression(expression.callee, `${path}.c`),
        arguments: expression.arguments.map((item, index) =>
          assignArgument(item, `${path}.a${index}`),
        ),
      };
    case "import-expression":
      return {
        ...expression,
        source: assignExpression(expression.source, `${path}.s`),
        options: expression.options ? assignExpression(expression.options, `${path}.o`) : null,
      };
    case "new":
      return {
        ...expression,
        callee: assignExpression(expression.callee, `${path}.c`),
        arguments: expression.arguments.map((item, index) =>
          assignArgument(item, `${path}.a${index}`),
        ),
      };
    case "assignment":
      return {
        ...expression,
        left: assignExpression(expression.left, `${path}.l`),
        right: assignExpression(expression.right, `${path}.r`),
      };
    case "binary":
      return {
        ...expression,
        left: assignExpression(expression.left, `${path}.l`),
        right: assignExpression(expression.right, `${path}.r`),
      };
    case "unary":
      return { ...expression, argument: assignExpression(expression.argument, `${path}.a`) };
    case "conditional":
      return {
        ...expression,
        test: assignExpression(expression.test, `${path}.t`),
        consequent: assignExpression(expression.consequent, `${path}.c`),
        alternate: assignExpression(expression.alternate, `${path}.a`),
      };
    case "arrow":
      return {
        ...expression,
        parameters: expression.parameters.map((item, index) =>
          assignPattern(item, `${path}.p${index}`),
        ),
        body: isCanonicalChild(expression.body)
          ? assignChild(expression.body, `${path}.b`)
          : expression.body.kind === "block"
            ? assignBlock(expression.body, `${path}.b`)
            : assignExpression(expression.body, `${path}.b`),
      };
    case "function-expression":
      return {
        ...expression,
        parameters: expression.parameters.map((item, index) =>
          assignPattern(item, `${path}.p${index}`),
        ),
        body: assignBlock(expression.body, `${path}.f`),
      };
    case "class":
      return {
        ...expression,
        superClass: expression.superClass
          ? assignExpression(expression.superClass, `${path}.s`)
          : null,
        elements: expression.elements.map((item, index) =>
          assignClassElement(item, `${path}.e${index}`),
        ),
      };
    case "object":
      return {
        ...expression,
        properties: expression.properties.map((item, index) =>
          assignProperty(item, `${path}.p${index}`),
        ),
      };
    case "array":
      return {
        ...expression,
        elements: expression.elements.map((item, index) =>
          item === null ? null : assignArgument(item, `${path}.a${index}`),
        ),
      };
  }
}

function assignArgument(argument: CanonicalArgument, path: string): CanonicalArgument {
  return argument.kind === "spread"
    ? { ...argument, argument: assignExpression(argument.argument, `${path}.s`) }
    : assignExpression(argument, path);
}

function assignClassElement(element: CanonicalClassElement, path: string): CanonicalClassElement {
  if (element.kind === "static-block")
    return { ...element, body: assignBlock(element.body, `${path}.b`) };
  const key =
    typeof element.key === "string" || typeof element.key === "number"
      ? element.key
      : assignExpression(element.key, `${path}.k`);
  if (element.kind === "field")
    return {
      ...element,
      key,
      initializer: element.initializer ? assignExpression(element.initializer, `${path}.v`) : null,
    };
  return {
    ...element,
    key,
    parameters: element.parameters.map((item, index) => assignPattern(item, `${path}.p${index}`)),
    body: assignBlock(element.body, `${path}.b`),
  };
}

function assignProperty(property: CanonicalProperty, path: string): CanonicalProperty {
  if (property.kind === "spread")
    return { ...property, argument: assignExpression(property.argument, `${path}.s`) };
  return {
    ...property,
    key:
      property.computed && typeof property.key !== "string"
        ? assignExpression(property.key, `${path}.k`)
        : property.key,
    value: assignExpression(property.value, `${path}.v`),
  };
}

function assignAttribute(attribute: CanonicalAttribute, path: string): CanonicalAttribute {
  return attribute.kind === "static"
    ? attribute
    : { ...attribute, expression: assignExpression(attribute.expression, `${path}.e`) };
}

function assignProp(prop: CanonicalComponentProp, path: string): CanonicalComponentProp {
  if (prop.kind === "value")
    return { ...prop, expression: assignExpression(prop.expression, `${path}.v`) };
  if (prop.kind === "fallback") return { ...prop, child: assignChild(prop.child, `${path}.f`) };
  return {
    ...prop,
    children: prop.children.map((item, index) => assignChild(item, `${path}.c${index}`)),
  };
}

function assignChild(child: CanonicalChild, path: string): CanonicalChild {
  switch (child.kind) {
    case "element":
      return {
        ...child,
        occurrence: path,
        attributes: child.attributes.map((item, index) =>
          assignAttribute(item, `${path}.a${index}`),
        ),
        children: child.children.map((item, index) => assignChild(item, `${path}.c${index}`)),
      };
    case "fragment":
      return {
        ...child,
        occurrence: path,
        children: child.children.map((item, index) => assignChild(item, `${path}.c${index}`)),
      };
    case "text":
    case "dynamic-child":
      return child.kind === "text"
        ? { ...child, occurrence: path }
        : {
            ...child,
            occurrence: path,
            expression: assignExpression(child.expression, `${path}.e`),
          };
    case "component":
    case "await-child":
      return {
        ...child,
        occurrence: path,
        reference: assignExpression(child.reference, `${path}.r`),
        props: child.props.map((item, index) => assignProp(item, `${path}.p${index}`)),
      };
    case "raw-html":
      return {
        ...child,
        occurrence: path,
        host: child.host
          ? (assignChild(child.host, `${path}.h`) as Extract<CanonicalChild, { kind: "element" }>)
          : null,
        html: assignExpression(child.html, `${path}.e`),
      };
    case "conditional":
      return {
        ...child,
        occurrence: path,
        test: assignExpression(child.test, `${path}.t`),
        consequent: child.consequent ? assignChild(child.consequent, `${path}.c`) : null,
        alternate: child.alternate ? assignChild(child.alternate, `${path}.a`) : null,
      };
    case "list":
      return {
        ...child,
        occurrence: path,
        collection: assignExpression(child.collection, `${path}.v`),
        parameter: assignPattern(child.parameter, `${path}.p`),
        body: assignChild(child.body, `${path}.b`),
        key: assignExpression(child.key, `${path}.k`),
      };
  }
}

function markerImports(program: Program): MarkerImports {
  const unsafeFunctions = new Set<string>();
  const clientNamespaces = new Set<string>();
  for (const raw of list((program as unknown as AstNode).body)) {
    const item = node(raw);
    if (!item || item.type !== "ImportDeclaration") continue;
    const source = node(item.source)?.value;
    if (source !== "hesperia/client" && source !== "hesperia") continue;
    if (item.importKind === "type") continue;
    for (const rawSpecifier of list(item.specifiers)) {
      const specifier = node(rawSpecifier);
      if (specifier?.importKind === "type") continue;
      const local = node(specifier?.local)?.name;
      const imported = node(specifier?.imported)?.name;
      if (typeof local !== "string") continue;
      if (
        (source === "hesperia/client" && specifier?.type === "ImportNamespaceSpecifier") ||
        imported === "client"
      )
        clientNamespaces.add(local);
      if (imported === "unsafeHTML") unsafeFunctions.add(local);
    }
  }
  return { unsafeFunctions, clientNamespaces, documentShell: false };
}

function diagnostic(
  diagnostics: CompilerDiagnostic[],
  code: string,
  message: string,
  input: AstNode | null,
): void {
  diagnostics.push({ code, severity: "error", message, ...(input ? { span: span(input) } : {}) });
}

function statement(
  input: AstNode | null,
  diagnostics: CompilerDiagnostic[],
  markers: MarkerImports,
): CanonicalStatement | null {
  if (!input) return null;
  switch (input.type) {
    case "ImportDeclaration": {
      const source = node(input.source);
      const sourceText = source && stringValue(source.value);
      if (sourceText === null) {
        diagnostic(diagnostics, "HES-IMPORT", "Import source must be a string literal.", input);
        return null;
      }
      if (input.phase !== null && input.phase !== undefined) {
        diagnostic(
          diagnostics,
          "HES-IMPORT",
          "Deferred import phases are not supported by this compiler profile.",
          input,
        );
        return null;
      }
      if (list(input.attributes).length) {
        diagnostic(
          diagnostics,
          "HES-IMPORT",
          "Import attributes are not supported by this compiler profile.",
          input,
        );
        return null;
      }
      if (input.importKind === "type") return null;
      const specifiers: CanonicalImportSpecifier[] = [];
      for (const raw of list(input.specifiers)) {
        const item = node(raw);
        if (!item) {
          diagnostic(diagnostics, "HES-IMPORT", "Malformed import specifier.", input);
          continue;
        }
        if (item.importKind === "type") continue;
        const local = node(item.local);
        if (!local || typeof local.name !== "string") {
          diagnostic(
            diagnostics,
            "HES-IMPORT",
            "Import specifier is missing a local binding.",
            item,
          );
          continue;
        }
        if (item.type === "ImportSpecifier") {
          const imported = node(item.imported);
          if (imported && typeof imported.name === "string")
            specifiers.push({ kind: "named", imported: imported.name, local: local.name });
          else
            diagnostic(
              diagnostics,
              "HES-IMPORT",
              "Import specifier is missing its imported name.",
              item,
            );
        } else if (item.type === "ImportDefaultSpecifier") {
          specifiers.push({ kind: "default", local: local.name });
        } else if (item.type === "ImportNamespaceSpecifier") {
          specifiers.push({ kind: "namespace", local: local.name });
        } else {
          diagnostic(diagnostics, "HES-IMPORT", `Unsupported import specifier ${item.type}.`, item);
        }
      }
      return { kind: "import", specifiers, source: sourceText, span: span(input) };
    }
    case "VariableDeclaration": {
      if (input.kind !== "const" && input.kind !== "let" && input.kind !== "var") {
        diagnostic(
          diagnostics,
          "HES-VARIABLE",
          `Unsupported variable declaration kind ${String(input.kind)}.`,
          input,
        );
        return null;
      }
      const kind = input.kind;
      const declarations: CanonicalVariableDeclaration[] = [];
      for (const raw of list(input.declarations)) {
        const item = node(raw);
        if (!item) {
          diagnostic(diagnostics, "HES-VARIABLE", "Malformed variable declaration.", input);
          continue;
        }
        const pattern = patternOf(node(item.id), diagnostics, markers);
        if (!pattern) {
          diagnostic(
            diagnostics,
            "HES-VARIABLE",
            "Variable declaration has no supported binding pattern.",
            item,
          );
          continue;
        }
        const init = node(item.init);
        declarations.push({
          pattern,
          initializer: init ? expressionOrChild(init, diagnostics, markers) : null,
          span: span(item),
        });
      }
      return { kind: "variable", declarationKind: kind, declarations, span: span(input) };
    }
    case "FunctionDeclaration": {
      const id = node(input.id);
      if (!id || typeof id.name !== "string") {
        diagnostic(
          diagnostics,
          "HES-FUNCTION",
          "Anonymous function declarations are not supported in a module body.",
          input,
        );
        return null;
      }
      const parameters: CanonicalPattern[] = [];
      for (const raw of list(input.params)) {
        const parameter = patternOf(node(raw), diagnostics, markers);
        if (parameter) parameters.push(parameter);
        else
          diagnostic(
            diagnostics,
            "HES-PARAMETER",
            "Function parameter has no supported binding pattern.",
            input,
          );
      }
      const block = blockOf(node(input.body), diagnostics, markers);
      if (!block) return null;
      return {
        kind: "function",
        name: id.name,
        parameters,
        body: block,
        async: input.async === true,
        generator: input.generator === true,
        span: span(input),
      };
    }
    case "ClassDeclaration": {
      const id = node(input.id);
      if (!id || typeof id.name !== "string") {
        diagnostic(diagnostics, "HES-CLASS", "Class declaration is missing its name.", input);
        return null;
      }
      const superClass = input.superClass
        ? expressionOf(node(input.superClass), diagnostics, markers)
        : null;
      if (input.superClass && !superClass) return null;
      const elements = classElements(node(input.body), diagnostics, markers);
      if (!elements) return null;
      return { kind: "class", name: id.name, superClass, elements, span: span(input) };
    }
    case "ReturnStatement": {
      const argument = node(input.argument);
      return {
        kind: "return",
        argument: argument ? expressionOrChild(argument, diagnostics, markers) : null,
        span: span(input),
      };
    }
    case "ExpressionStatement": {
      const expr = expressionOf(node(input.expression), diagnostics, markers);
      return expr ? { kind: "expression", expression: expr, span: span(input) } : null;
    }
    case "IfStatement": {
      const test = expressionOf(node(input.test), diagnostics, markers);
      const consequent = statement(node(input.consequent), diagnostics, markers);
      const alternateInput = node(input.alternate);
      const alternate = alternateInput ? statement(alternateInput, diagnostics, markers) : null;
      if (!test || !consequent || (alternateInput && !alternate)) return null;
      return { kind: "if", test, consequent, alternate, span: span(input) };
    }
    case "SwitchStatement": {
      const discriminant = expressionOf(node(input.discriminant), diagnostics, markers);
      const cases: CanonicalSwitchCase[] = [];
      let valid = discriminant !== null;
      for (const rawCase of list(input.cases)) {
        const item = node(rawCase);
        if (!item) {
          diagnostic(diagnostics, "HES-SWITCH", "Malformed switch case.", input);
          valid = false;
          continue;
        }
        const test =
          item.test === null || item.test === undefined
            ? null
            : expressionOf(node(item.test), diagnostics, markers);
        if (item.test !== null && item.test !== undefined && !test) valid = false;
        const consequent: CanonicalStatement[] = [];
        for (const rawStatement of list(item.consequent)) {
          const parsed = node(rawStatement);
          const entry = parsed ? statement(parsed, diagnostics, markers) : null;
          if (entry) consequent.push(entry);
          else valid = false;
        }
        cases.push({ test, consequent, span: span(item) });
      }
      if (!valid) return null;
      return { kind: "switch", discriminant: discriminant!, cases, span: span(input) };
    }
    case "ForStatement": {
      const initInput = node(input.init);
      const parsedInit =
        initInput?.type === "VariableDeclaration"
          ? statement(initInput, diagnostics, markers)
          : null;
      const init =
        initInput === null
          ? null
          : initInput?.type === "VariableDeclaration"
            ? parsedInit?.kind === "variable"
              ? parsedInit
              : null
            : initInput
              ? expressionOf(initInput, diagnostics, markers)
              : null;
      const testInput = node(input.test);
      const updateInput = node(input.update);
      const test = testInput ? expressionOf(testInput, diagnostics, markers) : null;
      const update = updateInput ? expressionOf(updateInput, diagnostics, markers) : null;
      const body = statement(node(input.body), diagnostics, markers);
      if (initInput && !init)
        diagnostic(diagnostics, "HES-FOR", "For initializer is unsupported.", initInput);
      if (testInput && !test)
        diagnostic(diagnostics, "HES-FOR", "For test is unsupported.", testInput);
      if (updateInput && !update)
        diagnostic(diagnostics, "HES-FOR", "For update is unsupported.", updateInput);
      if (!body) return null;
      return { kind: "for", init, test, update, body, span: span(input) };
    }
    case "ForOfStatement":
    case "ForInStatement": {
      const left = forLeft(node(input.left), diagnostics, markers);
      const right = expressionOf(node(input.right), diagnostics, markers);
      const body = statement(node(input.body), diagnostics, markers);
      if (!left || !right || !body) return null;
      if (input.type === "ForInStatement")
        return { kind: "for-in", left, right, body, span: span(input) };
      return { kind: "for-of", await: input.await === true, left, right, body, span: span(input) };
    }
    case "WhileStatement": {
      const test = expressionOf(node(input.test), diagnostics, markers);
      const body = statement(node(input.body), diagnostics, markers);
      if (!test || !body) return null;
      return { kind: "while", test, body, span: span(input) };
    }
    case "DoWhileStatement": {
      const body = statement(node(input.body), diagnostics, markers);
      const test = expressionOf(node(input.test), diagnostics, markers);
      if (!body || !test) return null;
      return { kind: "do-while", body, test, span: span(input) };
    }
    case "LabeledStatement": {
      const label = node(input.label);
      const body = statement(node(input.body), diagnostics, markers);
      if (!label || typeof label.name !== "string" || !body) {
        diagnostic(diagnostics, "HES-LABEL", "Labeled statement is malformed.", input);
        return null;
      }
      return { kind: "labeled", label: label.name, body, span: span(input) };
    }
    case "BreakStatement":
    case "ContinueStatement": {
      const label = node(input.label);
      if (
        input.label !== null &&
        input.label !== undefined &&
        (!label || typeof label.name !== "string")
      ) {
        diagnostic(diagnostics, "HES-LOOP-CONTROL", "Loop control label is malformed.", input);
        return null;
      }
      return {
        kind: input.type === "BreakStatement" ? "break" : "continue",
        label: label && typeof label.name === "string" ? label.name : null,
        span: span(input),
      };
    }
    case "ThrowStatement": {
      const argument = expressionOf(node(input.argument), diagnostics, markers);
      if (!argument) {
        diagnostic(diagnostics, "HES-THROW", "Throw statement is missing its value.", input);
        return null;
      }
      return { kind: "throw", argument, span: span(input) };
    }
    case "TryStatement": {
      const body = blockOf(node(input.block), diagnostics, markers);
      const handlerInput = node(input.handler);
      const finalizerInput = node(input.finalizer);
      let handler: CanonicalCatchClause | null = null;
      if (handlerInput) {
        const paramInput = node(handlerInput.param);
        const param = paramInput ? patternOf(paramInput, diagnostics, markers) : null;
        if (paramInput && !param)
          diagnostic(diagnostics, "HES-CATCH", "Catch binding pattern is unsupported.", paramInput);
        const handlerBody = blockOf(node(handlerInput.body), diagnostics, markers);
        if (!handlerBody) return null;
        handler = { param, body: handlerBody, span: span(handlerInput) };
      }
      const finalizer = finalizerInput ? blockOf(finalizerInput, diagnostics, markers) : null;
      if (!body || (finalizerInput && !finalizer)) return null;
      return { kind: "try", body, handler, finalizer, span: span(input) };
    }
    case "BlockStatement": {
      const items = list(input.body)
        .map((item) => {
          const parsed = node(item);
          if (!parsed) {
            diagnostic(diagnostics, "HES-STATEMENT", "Malformed statement in block.", input);
            return null;
          }
          return statement(parsed, diagnostics, markers);
        })
        .filter((item): item is CanonicalStatement => item !== null);
      return { kind: "block", body: items, span: span(input) };
    }
    case "ExportNamedDeclaration": {
      // Empty and type-only export declarations affect module classification but
      // have no runtime meaning in the generated module.
      if (input.exportKind === "type") return null;
      const rawSpecifiers = list(input.specifiers);
      if (rawSpecifiers.length === 0 && !input.declaration && input.source == null) return null;
      const declaration = statement(node(input.declaration), diagnostics, markers);
      if (declaration)
        return { kind: "export", exportKind: "named", declaration, span: span(input) };
      const sourceNode = node(input.source);
      const source = sourceNode ? stringValue(sourceNode.value) : null;
      if (input.source != null && source === null) {
        diagnostic(diagnostics, "HES-EXPORT", "Export source must be a string literal.", input);
        return null;
      }
      if (list(input.attributes).length) {
        diagnostic(
          diagnostics,
          "HES-EXPORT",
          "Export attributes are not supported by this compiler profile.",
          input,
        );
        return null;
      }
      const specifiers: { local: string; exported: string }[] = [];
      for (const raw of rawSpecifiers) {
        const item = node(raw);
        if (!item || item.type !== "ExportSpecifier") {
          diagnostic(diagnostics, "HES-EXPORT", "Malformed export specifier.", input);
          continue;
        }
        if (item.exportKind === "type" || item.importKind === "type") continue;
        const local = exportName(item.local);
        const exported = exportName(item.exported);
        if (local === null || exported === null) {
          diagnostic(diagnostics, "HES-EXPORT", "Export specifier is missing a name.", item);
          continue;
        }
        specifiers.push({ local, exported });
      }
      return specifiers.length || source !== null
        ? { kind: "export-list", source, specifiers, span: span(input) }
        : null;
    }
    case "ExportAllDeclaration": {
      const sourceNode = node(input.source);
      const source = sourceNode ? stringValue(sourceNode.value) : null;
      if (source === null) {
        diagnostic(diagnostics, "HES-EXPORT", "Export source must be a string literal.", input);
        return null;
      }
      if (list(input.attributes).length) {
        diagnostic(
          diagnostics,
          "HES-EXPORT",
          "Export attributes are not supported by this compiler profile.",
          input,
        );
        return null;
      }
      const exported =
        input.exported === null || input.exported === undefined ? null : exportName(input.exported);
      if (input.exported !== null && input.exported !== undefined && exported === null) {
        diagnostic(diagnostics, "HES-EXPORT", "Namespace export is missing a name.", input);
        return null;
      }
      return { kind: "export-all", source, exported, span: span(input) };
    }
    case "ExportDefaultDeclaration": {
      const declarationInput = node(input.declaration);
      const declaration =
        declarationInput &&
        (declarationInput.type === "FunctionDeclaration" ||
          declarationInput.type === "ClassDeclaration" ||
          declarationInput.type === "VariableDeclaration")
          ? statement(declarationInput, diagnostics, markers)
          : null;
      if (declaration)
        return { kind: "export", exportKind: "default", declaration, span: span(input) };
      const expression = expressionOrChild(node(input.declaration), diagnostics, markers);
      if (expression && !isCanonicalChild(expression))
        return {
          kind: "export",
          exportKind: "default",
          declaration: { kind: "expression", expression, span: span(input) },
          span: span(input),
        };
      if (expression)
        diagnostic(
          diagnostics,
          "HES-EXPORT-JSX",
          "Default-exported JSX must be returned by a component function in this profile.",
          input,
        );
      return null;
    }
    default:
      diagnostic(diagnostics, "HES-STATEMENT", `Unsupported statement kind ${input.type}.`, input);
      return null;
  }
}

function forLeft(
  input: AstNode | null,
  diagnostics: CompilerDiagnostic[],
  markers: MarkerImports,
): CanonicalForLeft | null {
  if (!input) return null;
  if (input.type === "VariableDeclaration") {
    if (input.kind !== "const" && input.kind !== "let" && input.kind !== "var") {
      diagnostic(diagnostics, "HES-FOR", "Loop declaration kind is unsupported.", input);
      return null;
    }
    const declarations = list(input.declarations)
      .map(node)
      .filter((item): item is AstNode => item !== null);
    if (declarations.length !== 1) {
      diagnostic(
        diagnostics,
        "HES-FOR",
        "A loop declaration must contain exactly one binding.",
        input,
      );
      return null;
    }
    const declaration = declarations[0]!;
    if (declaration.init !== null && declaration.init !== undefined) {
      diagnostic(
        diagnostics,
        "HES-FOR",
        "A for-in/of binding cannot have an initializer.",
        declaration,
      );
      return null;
    }
    const pattern = patternOf(node(declaration.id), diagnostics, markers);
    if (!pattern) return null;
    return { kind: "declaration", declarationKind: input.kind, pattern, span: span(input) };
  }
  const target = expressionOf(input, diagnostics, markers);
  if (!target || (target.kind !== "identifier" && target.kind !== "member")) {
    diagnostic(
      diagnostics,
      "HES-FOR",
      "Loop assignment targets must be identifiers or members.",
      input,
    );
    return null;
  }
  return { kind: "assignment", target, span: span(input) };
}

function blockOf(
  input: AstNode | null,
  diagnostics: CompilerDiagnostic[],
  markers: MarkerImports,
): CanonicalStatementBlock | null {
  if (!input || input.type !== "BlockStatement") {
    diagnostic(diagnostics, "HES-BLOCK", "Expected a block statement.", input);
    return null;
  }
  return {
    kind: "block",
    body: list(input.body)
      .map((item) => {
        const parsed = node(item);
        if (!parsed) {
          diagnostic(diagnostics, "HES-STATEMENT", "Malformed statement in block.", input);
          return null;
        }
        return statement(parsed, diagnostics, markers);
      })
      .filter((item): item is CanonicalStatement => item !== null),
    span: span(input),
  };
}

function classElements(
  input: AstNode | null,
  diagnostics: CompilerDiagnostic[],
  markers: MarkerImports,
): CanonicalClassElement[] | null {
  if (!input || input.type !== "ClassBody") {
    diagnostic(diagnostics, "HES-CLASS", "Expected a class body.", input);
    return null;
  }
  const elements: CanonicalClassElement[] = [];
  for (const raw of list(input.body)) {
    const item = node(raw);
    if (!item) {
      diagnostic(diagnostics, "HES-CLASS", "Malformed class element.", input);
      return null;
    }
    if (item.type === "StaticBlock") {
      const body: CanonicalStatementBlock = {
        kind: "block",
        body: list(item.body)
          .map((rawStatement) => {
            const parsed = node(rawStatement);
            if (!parsed) {
              diagnostic(
                diagnostics,
                "HES-STATEMENT",
                "Malformed statement in static block.",
                item,
              );
              return null;
            }
            return statement(parsed, diagnostics, markers);
          })
          .filter((entry): entry is CanonicalStatement => entry !== null),
        span: span(item),
      };
      elements.push({ kind: "static-block", body, span: span(item) });
      continue;
    }
    const decorators = list(item.decorators);
    if (decorators.length || item.declare === true || item.abstract === true) {
      diagnostic(
        diagnostics,
        "HES-CLASS",
        "Decorated, abstract, and ambient class elements are unsupported.",
        item,
      );
      return null;
    }
    if (item.type === "MethodDefinition") {
      const value = node(item.value);
      const key = classKey(node(item.key), item.computed === true, diagnostics, markers);
      if (!value || value.type !== "FunctionExpression" || key === null) {
        diagnostic(diagnostics, "HES-CLASS", "Class method is malformed.", item);
        return null;
      }
      if (value.generator === true) {
        diagnostic(
          diagnostics,
          "HES-CLASS",
          "Generator class methods are unsupported by this profile.",
          item,
        );
        return null;
      }
      const parameters: CanonicalPattern[] = [];
      let valid = true;
      for (const rawParameter of list(value.params)) {
        const parameter = patternOf(node(rawParameter), diagnostics, markers);
        if (parameter) parameters.push(parameter);
        else valid = false;
      }
      const body = blockOf(node(value.body), diagnostics, markers);
      const methodKind = item.kind;
      if (
        !valid ||
        !body ||
        (methodKind !== "constructor" &&
          methodKind !== "method" &&
          methodKind !== "get" &&
          methodKind !== "set")
      )
        return null;
      elements.push({
        kind: "method",
        key,
        computed: item.computed === true,
        static: item.static === true,
        methodKind,
        parameters,
        body,
        async: value.async === true,
        span: span(item),
      });
      continue;
    }
    if (item.type === "PropertyDefinition") {
      const key = classKey(node(item.key), item.computed === true, diagnostics, markers);
      const value = node(item.value);
      const initializer = value ? expressionOf(value, diagnostics, markers) : null;
      if (key === null || (value && !initializer)) return null;
      elements.push({
        kind: "field",
        key,
        computed: item.computed === true,
        static: item.static === true,
        initializer,
        span: span(item),
      });
      continue;
    }
    diagnostic(diagnostics, "HES-CLASS", `Unsupported class element ${item.type}.`, item);
    return null;
  }
  return elements;
}

function classKey(
  input: AstNode | null,
  computed: boolean,
  diagnostics: CompilerDiagnostic[],
  markers: MarkerImports,
): string | number | CanonicalExpression | null {
  if (!input) return null;
  if (input.type === "PrivateIdentifier" && typeof input.name === "string")
    return { kind: "private", name: input.name, span: span(input) };
  if (!computed && input.type === "Identifier" && typeof input.name === "string") return input.name;
  if (!computed && input.type === "Literal") {
    if (typeof input.value === "string" || typeof input.value === "number") return input.value;
  }
  return expressionOf(input, diagnostics, markers);
}

function patternOf(
  input: AstNode | null,
  diagnostics: CompilerDiagnostic[],
  markers: MarkerImports,
): CanonicalPattern | null {
  if (!input) return null;
  if (input.type === "Identifier" && typeof input.name === "string")
    return { kind: "identifier", name: input.name, span: span(input) };
  if (input.type === "AssignmentPattern") {
    const left = patternOf(node(input.left), diagnostics, markers);
    const right = expressionOf(node(input.right), diagnostics, markers);
    return left && right ? { kind: "default", left, right, span: span(input) } : null;
  }
  if (input.type === "RestElement") {
    const argument = patternOf(node(input.argument), diagnostics, markers);
    return argument ? { kind: "rest", argument, span: span(input) } : null;
  }
  if (input.type === "ObjectPattern") {
    const properties: {
      key: string;
      value: CanonicalPattern;
      computed: boolean;
      span: SourceSpan;
    }[] = [];
    let rest: CanonicalPattern | undefined;
    let valid = true;
    for (const raw of list(input.properties)) {
      const item = node(raw);
      if (!item) {
        diagnostic(diagnostics, "HES-PATTERN", "Malformed object binding entry.", input);
        valid = false;
        continue;
      }
      if (item.type === "RestElement") {
        const argument = patternOf(node(item.argument), diagnostics, markers);
        if (!argument || rest) valid = false;
        else rest = argument;
        continue;
      }
      if (item.type !== "Property") {
        diagnostic(
          diagnostics,
          "HES-PATTERN",
          `Unsupported object binding entry ${item.type}.`,
          item,
        );
        valid = false;
        continue;
      }
      const key = node(item.key);
      const value = patternOf(node(item.value), diagnostics, markers);
      const keyName =
        key && typeof key.name === "string"
          ? key.name
          : key && typeof key.value === "string"
            ? key.value
            : key && typeof key.value === "number"
              ? String(key.value)
              : null;
      if (item.computed === true) {
        diagnostic(
          diagnostics,
          "HES-PATTERN",
          "Computed object binding keys are not supported by this compiler profile.",
          item,
        );
        valid = false;
        continue;
      }
      if (keyName === null || !value) {
        if (keyName === null)
          diagnostic(
            diagnostics,
            "HES-PATTERN",
            "Object binding keys must be identifiers or string literals.",
            item,
          );
        else
          diagnostic(
            diagnostics,
            "HES-PATTERN",
            "Object binding property is missing a supported value pattern.",
            item,
          );
        valid = false;
        continue;
      }
      properties.push({ key: keyName, value, computed: item.computed === true, span: span(item) });
    }
    if (!valid) return null;
    return { kind: "object", properties, ...(rest ? { rest } : {}), span: span(input) };
  }
  if (input.type === "ArrayPattern") {
    const elements: (CanonicalPattern | null)[] = [];
    let valid = true;
    for (const raw of list(input.elements)) {
      // A null array entry is an authored elision and is part of the pattern.
      if (raw === null || raw === undefined) {
        elements.push(null);
        continue;
      }
      const item = node(raw);
      if (item?.type === "RestElement") {
        const rest = patternOf(item, diagnostics, markers);
        if (!rest) valid = false;
        elements.push(rest);
        continue;
      }
      if (!item) {
        diagnostic(diagnostics, "HES-PATTERN", "Malformed array binding entry.", input);
        valid = false;
        continue;
      }
      const element = patternOf(item, diagnostics, markers);
      if (!element) valid = false;
      elements.push(element);
    }
    if (!valid) return null;
    return {
      kind: "array",
      elements,
      span: span(input),
    };
  }
  diagnostic(diagnostics, "HES-PATTERN", `Unsupported binding pattern ${input.type}.`, input);
  return null;
}

function expressionOrChild(
  input: AstNode | null,
  diagnostics: CompilerDiagnostic[],
  markers: MarkerImports,
  namespace: NamespaceContext = { namespace: "html" },
): CanonicalExpression | CanonicalChild | null {
  if (!input) return null;
  if (input.type === "JSXEmptyExpression") return null;
  const rawHTML = unsafeHTMLChild(input, diagnostics, markers, namespace);
  if (rawHTML) return rawHTML;
  if (
    input.type === "AwaitExpression" &&
    (node(input.argument)?.type === "JSXElement" || node(input.argument)?.type === "JSXFragment")
  ) {
    const awaited = expressionOrChild(node(input.argument), diagnostics, markers, namespace);
    if (awaited?.kind === "component")
      return {
        kind: "await-child",
        occurrence: "",
        reference: awaited.reference,
        props: awaited.props,
        span: span(input),
      };
    diagnostic(
      diagnostics,
      "HES-AWAIT-CHILD",
      "Only a component JSX render can be awaited in an async component body.",
      input,
    );
    return null;
  }
  const listChild = keyedList(input, diagnostics, markers, namespace);
  if (listChild) return listChild;
  if (input.type === "JSXElement") return jsxElement(input, diagnostics, markers, namespace);
  if (input.type === "JSXFragment")
    return {
      kind: "fragment",
      occurrence: "",
      children: jsxChildren(input, diagnostics, markers, namespace),
      span: span(input),
    };
  if (input.type === "ConditionalExpression") {
    const test = expressionOf(node(input.test), diagnostics, markers);
    const consequentValue = expressionOrChild(
      node(input.consequent),
      diagnostics,
      markers,
      namespace,
    );
    const alternateValue = expressionOrChild(
      node(input.alternate),
      diagnostics,
      markers,
      namespace,
    );
    const consequent = isNullLiteral(consequentValue) ? null : consequentValue;
    const alternate = isNullLiteral(alternateValue) ? null : alternateValue;
    if (test && isChildOrNull(consequent) && isChildOrNull(alternate)) {
      return {
        kind: "conditional",
        occurrence: "",
        test,
        consequent,
        alternate,
        captures: [],
        span: span(input),
      };
    }
  }
  return expressionOf(input, diagnostics, markers);
}

function keyedList(
  input: AstNode,
  diagnostics: CompilerDiagnostic[],
  markers: MarkerImports,
  namespace: NamespaceContext,
): CanonicalChild | null {
  if (input.type !== "CallExpression") return null;
  const callee = node(input.callee);
  if (!callee || callee.type !== "MemberExpression" || node(callee.property)?.name !== "map")
    return null;
  const collection = expressionOf(node(callee.object), diagnostics, markers);
  const callback = node(list(input.arguments)[0]);
  if (
    !collection ||
    !callback ||
    (callback.type !== "ArrowFunctionExpression" && callback.type !== "FunctionExpression")
  )
    return null;
  const bodyNode = node(callback.body);
  const structuralBody =
    bodyNode?.type === "JSXElement" ||
    bodyNode?.type === "JSXFragment" ||
    (bodyNode?.type === "BlockStatement" &&
      list(bodyNode.body).some((raw) => {
        const item = node(raw);
        return (
          item?.type === "ReturnStatement" &&
          (node(item.argument)?.type === "JSXElement" ||
            node(item.argument)?.type === "JSXFragment")
        );
      }));
  if (!structuralBody) return null;
  if (list(input.arguments).length !== 1) {
    diagnostic(
      diagnostics,
      "HES-LIST",
      "Keyed JSX list callbacks cannot be accompanied by extra map arguments.",
      input,
    );
    return null;
  }
  if (list(callback.params).length !== 1) {
    diagnostic(
      diagnostics,
      "HES-LIST",
      "Keyed JSX list callbacks must declare exactly one item parameter.",
      callback,
    );
    return null;
  }
  const parameter = patternOf(node(list(callback.params)[0]), diagnostics, markers);
  if (!parameter || !bodyNode) {
    diagnostic(
      diagnostics,
      "HES-LIST",
      "Keyed JSX list callback is missing its item body.",
      callback,
    );
    return null;
  }
  const childNode =
    bodyNode.type === "BlockStatement"
      ? (() => {
          const statements = list(bodyNode.body).map(node);
          if (statements.length !== 1 || statements[0]?.type !== "ReturnStatement") {
            diagnostic(
              diagnostics,
              "HES-LIST",
              "Keyed JSX list callbacks must contain one return statement.",
              bodyNode,
            );
            return null;
          }
          return node(statements[0].argument);
        })()
      : bodyNode;
  const body = expressionOrChild(childNode, diagnostics, markers, namespace);
  if (!body || !isCanonicalChild(body)) return null;
  const key = jsxKey(childNode ?? bodyNode, diagnostics, markers);
  if (!key) {
    diagnostic(diagnostics, "HES-KEY", "Every JSX list item needs an explicit key.", bodyNode);
    return null;
  }
  return {
    kind: "list",
    occurrence: "",
    collection,
    parameter,
    body,
    key,
    captures: [],
    span: span(input),
  };
}

function unsafeHTMLChild(
  input: AstNode,
  diagnostics: CompilerDiagnostic[],
  markers: MarkerImports,
  namespace: NamespaceContext,
): CanonicalChild | null {
  if (input.type !== "CallExpression") return null;
  const callee = node(input.callee);
  if (!callee) return null;
  const property =
    callee.type === "MemberExpression"
      ? node(callee.property)
      : callee.type === "Identifier"
        ? callee
        : null;
  const propertyName = property?.name ?? property?.value;
  const isDirect = callee.type === "Identifier" && markers.unsafeFunctions.has(String(callee.name));
  const isMember =
    callee.type === "MemberExpression" &&
    node(callee.object)?.type === "Identifier" &&
    markers.clientNamespaces.has(String(node(callee.object)?.name)) &&
    propertyName === "unsafeHTML";
  if (!isDirect && !isMember) return null;
  const args = list(input.arguments).map(node);
  if (args.length !== 2 || !args[0] || !args[1]) {
    diagnostic(
      diagnostics,
      "HES-RAW",
      "unsafeHTML requires exactly a JSX host or fragment and an HTML expression.",
      input,
    );
    return null;
  }
  const hostInput = args[0];
  const html = expressionOf(args[1], diagnostics, markers);
  if (!html || !hostInput) return null;
  if (hostInput.type === "JSXFragment")
    return { kind: "raw-html", occurrence: "", host: null, html, span: span(input) };
  if (hostInput.type !== "JSXElement") {
    diagnostic(
      diagnostics,
      "HES-RAW-HOST",
      "unsafeHTML requires an intrinsic JSX host element or fragment as its first argument.",
      hostInput,
    );
    return null;
  }
  const host = jsxElement(hostInput, diagnostics, markers, namespace);
  if (!host || host.kind !== "element") {
    diagnostic(
      diagnostics,
      "HES-RAW-HOST",
      "unsafeHTML requires an intrinsic JSX host element or fragment as its first argument.",
      hostInput,
    );
    return null;
  }
  if (host.children.length) {
    diagnostic(
      diagnostics,
      "HES-RAW-HOST",
      "An unsafeHTML host must be empty; its children would be discarded on replacement.",
      hostInput,
    );
    return null;
  }
  return { kind: "raw-html", occurrence: "", host, html, span: span(input) };
}

function jsxKey(
  input: AstNode,
  diagnostics: CompilerDiagnostic[],
  markers: MarkerImports,
): CanonicalExpression | null {
  if (input.type !== "JSXElement") return null;
  const opening = node(input.openingElement);
  if (!opening) return null;
  for (const raw of list(opening.attributes)) {
    const attr = node(raw);
    if (!attr || attr.type === "JSXSpreadAttribute") continue;
    const name = jsxAttributeName(node(attr.name));
    if (name !== "key") continue;
    const value = node(attr.value);
    if (!value) {
      diagnostic(diagnostics, "HES-KEY", "List keys must be string or number values.", attr);
      return null;
    }
    if (value.type === "JSXExpressionContainer") {
      const expression = expressionOf(node(value.expression), diagnostics, markers);
      if (
        expression?.kind === "literal" &&
        typeof expression.value !== "string" &&
        typeof expression.value !== "number"
      ) {
        diagnostic(diagnostics, "HES-KEY", "List keys must be string or number values.", value);
        return null;
      }
      return expression;
    }
    if (
      value.type === "Literal" &&
      (typeof value.value === "string" || typeof value.value === "number")
    )
      return { kind: "literal", value: value.value, span: span(value) };
    diagnostic(diagnostics, "HES-KEY", "List keys must be string or number values.", value);
    return null;
  }
  return null;
}

function isChildOrNull(
  value: CanonicalExpression | CanonicalChild | null,
): value is CanonicalChild | null {
  return value === null || isCanonicalChild(value);
}

function isNullLiteral(
  value: CanonicalExpression | CanonicalChild | null,
): value is Extract<CanonicalExpression, { kind: "literal" }> {
  return value?.kind === "literal" && value.value === null;
}

function expressionOf(
  input: AstNode | null,
  diagnostics: CompilerDiagnostic[],
  markers: MarkerImports,
): CanonicalExpression | null {
  if (!input) return null;
  if (input.type === "ChainExpression")
    return expressionOf(node(input.expression), diagnostics, markers);
  if (input.type === "ParenthesizedExpression")
    return expressionOf(node(input.expression), diagnostics, markers);
  if (input.type === "AwaitExpression") {
    const expression = expressionOf(node(input.argument), diagnostics, markers);
    if (expression) return { kind: "await", expression, span: span(input) };
    diagnostic(
      diagnostics,
      "HES-EXPRESSION",
      "Await expression is missing a supported argument.",
      input,
    );
    return null;
  }
  if (input.type === "YieldExpression") {
    const argument = input.argument
      ? expressionOf(node(input.argument), diagnostics, markers)
      : null;
    if (input.argument && !argument) {
      diagnostic(diagnostics, "HES-YIELD", "Yield expression has no supported operand.", input);
      return null;
    }
    return {
      kind: "yield",
      expression: argument,
      delegate: input.delegate === true,
      span: span(input),
    };
  }
  if (input.type === "Identifier" && typeof input.name === "string") {
    return input.name === "undefined"
      ? { kind: "undefined", span: span(input) }
      : { kind: "identifier", name: input.name, span: span(input) };
  }
  if (input.type === "PrivateIdentifier" && typeof input.name === "string")
    return { kind: "private", name: input.name, span: span(input) };
  if (input.type === "Super") return { kind: "super", span: span(input) };
  if (input.type === "MetaProperty") {
    const meta = node(input.meta);
    const property = node(input.property);
    if (meta?.name === "new" && property?.name === "target")
      return { kind: "new-target", span: span(input) };
    diagnostic(
      diagnostics,
      "HES-EXPRESSION",
      "Only new.target is supported as a meta property.",
      input,
    );
    return null;
  }
  if (input.type === "ThisExpression") return { kind: "this", span: span(input) };
  if (input.type === "Literal") {
    const bigint = input.bigint;
    if (typeof bigint === "string") return { kind: "bigint", value: bigint, span: span(input) };
    const regex = input.regex;
    if (
      typeof regex === "object" &&
      regex !== null &&
      typeof (regex as { pattern?: unknown }).pattern === "string" &&
      typeof (regex as { flags?: unknown }).flags === "string"
    )
      return {
        kind: "regexp",
        pattern: (regex as { pattern: string }).pattern,
        flags: (regex as { flags: string }).flags,
        span: span(input),
      };
    const value = input.value;
    if (
      value === null ||
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
    )
      return { kind: "literal", value, span: span(input) };
  }
  if (input.type === "TemplateLiteral") {
    const quasis: CanonicalTemplateQuasi[] = [];
    let valid = true;
    for (const rawQuasi of list(input.quasis)) {
      const quasi = node(rawQuasi);
      const value = quasi?.value;
      if (
        !quasi ||
        typeof value !== "object" ||
        value === null ||
        typeof (value as { raw?: unknown }).raw !== "string"
      ) {
        diagnostic(diagnostics, "HES-TEMPLATE", "Template segment is malformed.", quasi ?? input);
        valid = false;
        continue;
      }
      const cooked = (value as { cooked?: unknown }).cooked;
      quasis.push({
        raw: (value as { raw: string }).raw,
        cooked: typeof cooked === "string" ? cooked : null,
        span: span(quasi),
      });
    }
    const expressions: CanonicalExpression[] = [];
    for (const rawExpression of list(input.expressions)) {
      const expression = expressionOf(node(rawExpression), diagnostics, markers);
      if (expression) expressions.push(expression);
      else valid = false;
    }
    if (quasis.length !== expressions.length + 1) {
      diagnostic(
        diagnostics,
        "HES-TEMPLATE",
        "Template segments and interpolations do not match.",
        input,
      );
      valid = false;
    }
    if (valid) return { kind: "template", quasis, expressions, span: span(input) };
  }
  if (input.type === "ImportExpression") {
    if (input.phase !== null && input.phase !== undefined) {
      diagnostic(
        diagnostics,
        "HES-EXPRESSION",
        "Import phases are not supported by this compiler profile.",
        input,
      );
      return null;
    }
    const source = expressionOf(node(input.source), diagnostics, markers);
    const optionsInput = node(input.options);
    const options = optionsInput ? expressionOf(optionsInput, diagnostics, markers) : null;
    if (!source || (optionsInput && !options)) return null;
    return { kind: "import-expression", source, options, span: span(input) };
  }
  if (input.type === "MemberExpression") {
    const object = expressionOf(node(input.object), diagnostics, markers);
    const property = expressionOf(node(input.property), diagnostics, markers);
    if (object && property)
      return {
        kind: "member",
        object,
        property,
        computed: input.computed === true,
        optional: input.optional === true,
        span: span(input),
      };
  }
  if (input.type === "NewExpression") {
    const callee = expressionOf(node(input.callee), diagnostics, markers);
    const args: CanonicalArgument[] = [];
    let valid = callee !== null;
    for (const raw of list(input.arguments)) {
      const argument = node(raw);
      if (!argument) {
        diagnostic(diagnostics, "HES-NEW", "Malformed constructor argument.", input);
        valid = false;
        continue;
      }
      if (argument.type === "JSXElement" || argument.type === "JSXFragment") {
        diagnostic(
          diagnostics,
          "HES-NEW",
          "JSX constructor arguments are not supported by this compiler profile.",
          argument,
        );
        valid = false;
        continue;
      }
      if (argument.type === "SpreadElement") {
        const spread = expressionOf(node(argument.argument), diagnostics, markers);
        if (spread) args.push({ kind: "spread", argument: spread, span: span(argument) });
        else valid = false;
        continue;
      }
      const arrowBody =
        argument.type === "ArrowFunctionExpression" || argument.type === "FunctionExpression"
          ? node(argument.body)
          : null;
      if (arrowBody && (arrowBody.type === "JSXElement" || arrowBody.type === "JSXFragment")) {
        diagnostic(
          diagnostics,
          "HES-NEW",
          "JSX returned from a constructor callback requires an explicit structural profile.",
          arrowBody,
        );
        valid = false;
      }
      const expression = expressionOf(argument, diagnostics, markers);
      if (expression) args.push(expression);
      else valid = false;
    }
    if (valid && callee) return { kind: "new", callee, arguments: args, span: span(input) };
    return null;
  }
  if (input.type === "CallExpression") {
    const callee = expressionOf(node(input.callee), diagnostics, markers);
    const args = list(input.arguments).map((item) => {
      const arg = node(item);
      const arrowBody =
        arg && (arg.type === "ArrowFunctionExpression" || arg.type === "FunctionExpression")
          ? node(arg.body)
          : null;
      if (arrowBody && (arrowBody.type === "JSXElement" || arrowBody.type === "JSXFragment"))
        diagnostic(
          diagnostics,
          "HES-LIST",
          "JSX returned from an expression callback requires keyed structural list lowering.",
          arrowBody,
        );
      if (arg?.type === "SpreadElement") {
        const spread = expressionOf(node(arg.argument), diagnostics, markers);
        return spread ? ({ kind: "spread", argument: spread, span: span(arg) } as const) : null;
      }
      if (!arg) {
        diagnostic(diagnostics, "HES-CALL", "Malformed call argument.", input);
        return null;
      }
      return expressionOf(arg, diagnostics, markers);
    });
    if (callee && args.every((item): item is CanonicalExpression => item !== null))
      return {
        kind: "call",
        callee,
        arguments: args,
        optional: input.optional === true,
        span: span(input),
      };
  }
  if (input.type === "AssignmentExpression") {
    const leftInput = node(input.left);
    if (!leftInput || (leftInput.type !== "Identifier" && leftInput.type !== "MemberExpression")) {
      diagnostic(
        diagnostics,
        "HES-ASSIGN",
        "Only identifier and member assignment targets are supported by this compiler profile.",
        leftInput ?? input,
      );
      return null;
    }
    const left = expressionOf(leftInput, diagnostics, markers);
    const right = expressionOf(node(input.right), diagnostics, markers);
    if (!left || !right || (left.kind !== "identifier" && left.kind !== "member")) {
      diagnostic(diagnostics, "HES-ASSIGN", "Assignment target or value is unsupported.", input);
      return null;
    }
    if (left.kind === "member" && left.optional) {
      diagnostic(
        diagnostics,
        "HES-ASSIGN",
        "Optional member assignment is unsupported.",
        leftInput,
      );
      return null;
    }
    if (typeof input.operator !== "string") {
      diagnostic(diagnostics, "HES-ASSIGN", "Assignment operator is missing.", input);
      return null;
    }
    return { kind: "assignment", operator: input.operator, left, right, span: span(input) };
  }
  if (input.type === "BinaryExpression" || input.type === "LogicalExpression") {
    const left = expressionOf(node(input.left), diagnostics, markers);
    const right = expressionOf(node(input.right), diagnostics, markers);
    if (left && right && typeof input.operator === "string")
      return { kind: "binary", operator: input.operator, left, right, span: span(input) };
  }
  if (input.type === "UnaryExpression" || input.type === "UpdateExpression") {
    const argument = expressionOf(node(input.argument), diagnostics, markers);
    if (argument && typeof input.operator === "string")
      return {
        kind: "unary",
        operator: input.operator,
        argument,
        prefix: input.prefix !== false,
        span: span(input),
      };
  }
  if (input.type === "ConditionalExpression") {
    const test = expressionOf(node(input.test), diagnostics, markers);
    const consequent = expressionOf(node(input.consequent), diagnostics, markers);
    const alternate = expressionOf(node(input.alternate), diagnostics, markers);
    if (test && consequent && alternate)
      return { kind: "conditional", test, consequent, alternate, span: span(input) };
  }
  if (input.type === "FunctionExpression") {
    const parameters: CanonicalPattern[] = [];
    let validParameters = true;
    for (const raw of list(input.params)) {
      const parameter = patternOf(node(raw), diagnostics, markers);
      if (parameter) parameters.push(parameter);
      else {
        validParameters = false;
        diagnostic(
          diagnostics,
          "HES-PARAMETER",
          "Function parameter has no supported binding pattern.",
          input,
        );
      }
    }
    const body = blockOf(node(input.body), diagnostics, markers);
    if (!validParameters || !body) return null;
    const id = node(input.id);
    return {
      kind: "function-expression",
      name: id && typeof id.name === "string" ? id.name : null,
      parameters,
      body,
      async: input.async === true,
      generator: input.generator === true,
      span: span(input),
    };
  }
  if (input.type === "ClassExpression") {
    const id = node(input.id);
    if (input.superClass === null || input.superClass === undefined) {
      const elements = classElements(node(input.body), diagnostics, markers);
      if (!elements) return null;
      return {
        kind: "class",
        name: id && typeof id.name === "string" ? id.name : null,
        superClass: null,
        elements,
        span: span(input),
      };
    }
    const superClass = expressionOf(node(input.superClass), diagnostics, markers);
    const elements = classElements(node(input.body), diagnostics, markers);
    if (!superClass || !elements) return null;
    return {
      kind: "class",
      name: id && typeof id.name === "string" ? id.name : null,
      superClass,
      elements,
      span: span(input),
    };
  }
  if (input.type === "ArrowFunctionExpression") {
    const parameters: CanonicalPattern[] = [];
    let validParameters = true;
    for (const raw of list(input.params)) {
      const parameter = patternOf(node(raw), diagnostics, markers);
      if (parameter) parameters.push(parameter);
      else {
        validParameters = false;
        diagnostic(
          diagnostics,
          "HES-PARAMETER",
          "Function parameter has no supported binding pattern.",
          input,
        );
      }
    }
    if (!validParameters) return null;
    if (input.generator === true) {
      diagnostic(
        diagnostics,
        "HES-FUNCTION",
        "Generator functions are not supported by this compiler profile.",
        input,
      );
      return null;
    }
    const bodyNode = node(input.body);
    if (bodyNode) {
      const body =
        bodyNode.type === "BlockStatement"
          ? blockOf(bodyNode, diagnostics, markers)
          : expressionOrChild(bodyNode, diagnostics, markers);
      if (body)
        return {
          kind: "arrow",
          parameters,
          body,
          expressionBody: bodyNode.type !== "BlockStatement",
          async: input.async === true,
          span: span(input),
        };
    } else diagnostic(diagnostics, "HES-ARROW", "Function expression is missing its body.", input);
    return null;
  }
  if (input.type === "ObjectExpression") {
    const properties: CanonicalProperty[] = [];
    for (const raw of list(input.properties)) {
      const item = node(raw);
      if (!item) {
        diagnostic(diagnostics, "HES-OBJECT", "Malformed object entry.", input);
        continue;
      }
      if (item.type === "SpreadElement") {
        const argument = expressionOf(node(item.argument), diagnostics, markers);
        if (argument) properties.push({ kind: "spread", argument, span: span(item) });
        else
          diagnostic(
            diagnostics,
            "HES-OBJECT",
            "Object spread is missing a supported argument.",
            item,
          );
        continue;
      }
      if (item.type !== "Property") {
        diagnostic(diagnostics, "HES-OBJECT", `Unsupported object entry ${item.type}.`, item);
        continue;
      }
      const value = expressionOf(node(item.value), diagnostics, markers);
      const key = node(item.key);
      if (!value || !key) {
        diagnostic(diagnostics, "HES-OBJECT", "Object property is missing its key or value.", item);
        continue;
      }
      const keyValue =
        item.computed === true
          ? expressionOf(key, diagnostics, markers)
          : typeof key.name === "string"
            ? key.name
            : typeof key.value === "string"
              ? key.value
              : null;
      if (keyValue === null) {
        diagnostic(
          diagnostics,
          "HES-OBJECT",
          "Object key cannot be represented in the supported expression profile.",
          item,
        );
        continue;
      }
      const propertyKind =
        item.kind === "get" || item.kind === "set" ? item.kind : ("init" as const);
      if (propertyKind === "get" && list(node(item.value)?.params).length !== 0) {
        diagnostic(diagnostics, "HES-OBJECT", "Object getter must not declare parameters.", item);
        continue;
      }
      if (propertyKind === "set" && list(node(item.value)?.params).length !== 1) {
        diagnostic(diagnostics, "HES-OBJECT", "Object setter must declare one parameter.", item);
        continue;
      }
      properties.push({
        kind: "property",
        key: keyValue,
        value,
        computed: item.computed === true,
        shorthand: item.shorthand === true,
        ...(propertyKind === "init" ? {} : { propertyKind }),
        ...(item.method === true ? { method: true } : {}),
        span: span(item),
      });
    }
    return { kind: "object", properties, span: span(input) };
  }
  if (input.type === "ArrayExpression") {
    const elements: (CanonicalArgument | null)[] = [];
    for (const raw of list(input.elements)) {
      if (raw === null || raw === undefined) {
        elements.push(null);
        continue;
      }
      const item = node(raw);
      if (!item) {
        diagnostic(diagnostics, "HES-ARRAY", "Malformed array expression entry.", input);
        continue;
      }
      if (item.type === "SpreadElement") {
        const argument = expressionOf(node(item.argument), diagnostics, markers);
        if (argument) elements.push({ kind: "spread", argument, span: span(item) });
        else
          diagnostic(
            diagnostics,
            "HES-ARRAY",
            "Array spread is missing a supported argument.",
            item,
          );
        continue;
      }
      const element = expressionOf(item, diagnostics, markers);
      if (element) elements.push(element);
    }
    return {
      kind: "array",
      elements,
      span: span(input),
    };
  }
  diagnostic(diagnostics, "HES-EXPRESSION", `Unsupported expression kind ${input.type}.`, input);
  return null;
}

function jsxElement(
  input: AstNode,
  diagnostics: CompilerDiagnostic[],
  markers: MarkerImports,
  parentNamespace: NamespaceContext = { namespace: "html" },
): CanonicalElement | CanonicalComponent | null {
  const opening = node(input.openingElement);
  if (!opening) {
    diagnostic(diagnostics, "HES-JSX-NAME", "JSX element is missing its opening element.", input);
    return null;
  }
  const name = jsxName(node(opening.name));
  if (!name) {
    diagnostic(diagnostics, "HES-JSX-NAME", "JSX element name is not supported.", input);
    return null;
  }
  const attributes: CanonicalAttribute[] = [];
  const props: CanonicalComponentProp[] = [];
  for (const raw of list(opening.attributes)) {
    const attr = node(raw);
    if (!attr) {
      diagnostic(diagnostics, "HES-JSX-ATTRIBUTE", "Malformed JSX attribute.", opening);
      continue;
    }
    if (attr.type === "JSXSpreadAttribute") {
      diagnostic(
        diagnostics,
        "HES-SPREAD",
        "JSX spread attributes are deferred until the props ABI is finalized.",
        attr,
      );
      continue;
    }
    const attrName = jsxAttributeName(node(attr.name));
    if (!attrName) {
      diagnostic(diagnostics, "HES-JSX-ATTRIBUTE", "JSX attribute name is not supported.", attr);
      continue;
    }
    if (!(/^[A-Z]/.test(name) || name.includes(".")) && attrName === "key") continue;
    const value = node(attr.value);
    const isAsyncFallback =
      name === "AsyncBoundary" &&
      attrName === "fallback" &&
      value?.type === "JSXExpressionContainer";
    const expression =
      value?.type === "JSXExpressionContainer" && !isAsyncFallback
        ? expressionOf(node(value.expression), diagnostics, markers)
        : null;
    if (/^[A-Z]/.test(name) || name.includes(".")) {
      if (
        name === "AsyncBoundary" &&
        attrName === "fallback" &&
        value?.type === "JSXExpressionContainer"
      ) {
        const fallback = expressionOrChild(
          node(value.expression),
          diagnostics,
          markers,
          parentNamespace,
        );
        if (fallback && isCanonicalChild(fallback)) {
          props.push({ kind: "fallback", child: fallback, span: span(attr) });
          continue;
        }
      }
      if (value === null || value === undefined)
        props.push({
          kind: "value",
          name: attrName,
          expression: { kind: "literal", value: true, span: span(attr) },
          lazy: false,
          span: span(attr),
        });
      else if (
        value.type === "Literal" &&
        (typeof value.value === "string" ||
          typeof value.value === "number" ||
          typeof value.value === "boolean")
      )
        props.push({
          kind: "value",
          name: attrName,
          expression: { kind: "literal", value: value.value, span: span(value) },
          lazy: false,
          span: span(attr),
        });
      else if (expression)
        props.push({
          kind: "value",
          name: attrName,
          expression,
          lazy: attrName !== "bind" && !isLiteral(expression) && expression.kind !== "arrow",
          span: span(attr),
        });
      continue;
    }
    if (attrName.startsWith("on:")) {
      if (expression)
        attributes.push({ kind: "event", name: attrName.slice(3), expression, span: span(attr) });
      continue;
    }
    if (value === null || value === undefined) {
      attributes.push({ kind: "static", name: attrName, value: true, span: span(attr) });
    } else if (
      value.type === "Literal" &&
      (typeof value.value === "string" || typeof value.value === "boolean")
    ) {
      attributes.push({ kind: "static", name: attrName, value: value.value, span: span(attr) });
    } else if (expression) {
      attributes.push({
        kind: "dynamic",
        name: attrName,
        expression,
        mode: attrName === "bind" ? "binding" : propertyName(attrName) ? "property" : "attribute",
        span: span(attr),
      });
    }
  }
  const namespaceContext = namespaceForTag(parentNamespace, name);
  const encodingAttribute = attributes.find(
    (attribute) => attribute.kind === "static" && attribute.name.toLowerCase() === "encoding",
  );
  const encoding = encodingAttribute?.kind === "static" ? encodingAttribute.value : undefined;
  if (
    namespaceContext.namespace === "mathml" &&
    name.toLowerCase() === "annotation-xml" &&
    attributes.some(
      (attribute) => attribute.kind === "dynamic" && attribute.name.toLowerCase() === "encoding",
    ) &&
    list(input.children).some(annotationChildHasUnknownNamespace)
  )
    diagnostic(
      diagnostics,
      "HES-HTML-CONTEXT",
      "Dynamic annotation-xml encoding cannot determine the namespace of its JSX children.",
      input,
    );
  const elementContext =
    typeof encoding === "string" ? { ...namespaceContext, encoding } : namespaceContext;
  const elementChildrenNamespace = childNamespace(elementContext);
  const children = jsxChildren(
    input,
    diagnostics,
    markers,
    /^[A-Z]/.test(name) || name.includes(".") ? parentNamespace : elementChildrenNamespace,
  );
  if (/^[A-Z]/.test(name) || name.includes(".")) {
    if (name === "AsyncBoundary" && !props.some((prop) => prop.kind === "fallback"))
      diagnostic(
        diagnostics,
        "HES-ASYNC-BOUNDARY",
        "AsyncBoundary requires a JSX fallback prop.",
        input,
      );
    if (children.length) props.push({ kind: "children", children, span: span(input) });
    return {
      kind: "component",
      occurrence: "",
      reference: jsxReference(name, input),
      props,
      span: span(input),
    };
  }
  validateParserShape(name, input, diagnostics, markers.documentShell);
  return {
    kind: "element",
    occurrence: "",
    tag: name,
    namespace: elementContext.namespace,
    attributes,
    children,
    span: span(input),
  };
}

function annotationChildHasUnknownNamespace(raw: unknown): boolean {
  const child = node(raw);
  if (!child) return false;
  if (child.type === "JSXElement" || child.type === "JSXFragment") return true;
  if (child.type !== "JSXExpressionContainer") return false;
  const expression = node(child.expression);
  return expression !== null && expression.type !== "Literal";
}

function jsxChildren(
  input: AstNode,
  diagnostics: CompilerDiagnostic[],
  markers: MarkerImports,
  parentNamespace: NamespaceContext = { namespace: "html" },
): CanonicalChild[] {
  return list(input.children).flatMap((raw): CanonicalChild[] => {
    const child = node(raw);
    if (!child) {
      diagnostic(diagnostics, "HES-JSX-CHILD", "Malformed JSX child.", input);
      return [];
    }
    if (child.type === "JSXText") {
      const value = typeof child.value === "string" ? cleanJsxText(child.value) : "";
      return value ? [{ kind: "text", occurrence: "", value, span: span(child) }] : [];
    }
    if (child.type === "JSXEmptyExpression") return [];
    if (child.type === "JSXExpressionContainer") {
      const expression = expressionOrChild(
        node(child.expression),
        diagnostics,
        markers,
        parentNamespace,
      );
      if (expression && isCanonicalChild(expression)) return [expression];
      return expression
        ? [{ kind: "dynamic-child", occurrence: "", expression, span: span(child) }]
        : [];
    }
    const nested = expressionOrChild(child, diagnostics, markers, parentNamespace);
    return nested && isCanonicalChild(nested) ? [nested] : [];
  });
}

function validateParserShape(
  name: string,
  input: AstNode,
  diagnostics: CompilerDiagnostic[],
  documentShell = false,
): void {
  // parse5 is used only as a browser-tree oracle during lowering. The emitted
  // program still creates native nodes directly and never embeds this string.
  const fragment = parseFragment(`<${name}></${name}>`);
  const shellIntrinsic = new Set(["html", "head", "body", "meta", "title", "link"]).has(
    name.toLowerCase(),
  );
  const paragraphSafe = name.toLowerCase() !== "p" || parserShapeMatches(name, input);
  if (
    (!documentShell || !shellIntrinsic) &&
    ((!parserVoidElements.has(name.toLowerCase()) && fragment.childNodes.length !== 1) ||
      parserSensitive(name) ||
      !paragraphSafe)
  ) {
    diagnostic(
      diagnostics,
      "HES-HTML-CONTEXT",
      `<${name}> is rejected because HTML parser insertion rules are not modeled by this direct-DOM profile.`,
      input,
    );
  }
}

interface ParserShape {
  readonly name: string;
  readonly children: readonly ParserShape[];
}

/**
 * Compare paragraph markup with parse5's fragment tree. Paragraphs have an
 * optional end tag and the browser closes them before block content; checking
 * the authored shape keeps valid phrasing content while rejecting a tree that
 * the browser would rearrange.
 */
function parserShapeMatches(name: string, input: AstNode): boolean {
  const children = parserChildren(input.children);
  if (!children) return false;
  const markup = `<${name}>${children.markup}</${name}>`;
  const expected: ParserShape = {
    name: name.toLowerCase(),
    children: children.shapes,
  };
  const parsed = parseFragment(markup) as unknown as { readonly childNodes?: readonly unknown[] };
  const actual = parserShapes(parsed.childNodes ?? []);
  return actual.length === 1 && sameParserShape(actual[0]!, expected);
}

interface ParserFragment {
  readonly markup: string;
  readonly shapes: readonly ParserShape[];
}

const parserVoidElements = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);

function parserChildren(raw: unknown): ParserFragment | null {
  let markup = "";
  const shapes: ParserShape[] = [];
  for (const value of list(raw)) {
    const child = parserChild(node(value));
    if (!child) return null;
    markup += child.markup;
    shapes.push(...child.shapes);
  }
  return { markup, shapes };
}

function parserChild(child: AstNode | null): ParserFragment | null {
  if (!child) return null;
  if (child.type === "JSXText")
    return { markup: escapeParserText(stringValue(child.value) ?? ""), shapes: [] };
  if (child.type === "JSXEmptyExpression") return { markup: "", shapes: [] };
  if (child.type === "JSXFragment") return parserChildren(child.children);
  if (child.type === "JSXExpressionContainer") {
    // Expressions become direct DOM values at runtime and never pass through
    // the HTML parser. A text marker models their parser-independent shape.
    return { markup: "x", shapes: [] };
  }
  if (child.type !== "JSXElement") return null;
  const opening = node(child.openingElement);
  const name = jsxName(node(opening?.name));
  if (!name || /^[A-Z]/.test(name) || name.includes(".")) return null;
  const nested = parserChildren(child.children);
  const lowerName = name.toLowerCase();
  if (!nested || (parserVoidElements.has(lowerName) && nested.markup !== "")) return null;
  const markup = parserVoidElements.has(lowerName)
    ? `<${name}>`
    : `<${name}>${nested.markup}</${name}>`;
  return { markup, shapes: [{ name: lowerName, children: nested.shapes }] };
}

function parserShapes(nodes: readonly unknown[]): ParserShape[] {
  return nodes.flatMap((raw) => {
    const item = raw as { readonly nodeName?: unknown; readonly childNodes?: readonly unknown[] };
    if (typeof item.nodeName !== "string" || item.nodeName === "#text") return [];
    return [{ name: item.nodeName.toLowerCase(), children: parserShapes(item.childNodes ?? []) }];
  });
}

function sameParserShape(actual: ParserShape, expected: ParserShape): boolean {
  return (
    actual.name === expected.name &&
    actual.children.length === expected.children.length &&
    actual.children.every((child, index) => sameParserShape(child, expected.children[index]!))
  );
}

function escapeParserText(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function validateDocumentShell(module: CanonicalModule): CanonicalModule {
  const parents = new Map<CanonicalElement, CanonicalElement | null>();
  const visit = (value: unknown, parent: CanonicalElement | null): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item, parent);
      return;
    }
    if (typeof value !== "object" || value === null) return;
    const record = value as Record<string, unknown>;
    const current = record.kind === "element" ? (record as unknown as CanonicalElement) : parent;
    if (record.kind === "element") {
      parents.set(current as CanonicalElement, parent);
    }
    for (const [key, nested] of Object.entries(record)) {
      if (key !== "span" && key !== "diagnostics")
        visit(nested, current as CanonicalElement | null);
    }
  };
  visit(module.body, null);

  const htmlRoots = defaultRenderRoots(module).filter(
    (element) => element.tag.toLowerCase() === "html",
  );
  if (htmlRoots.length === 0) {
    return withShellDiagnostics(module, [
      shellDiagnostic(
        "HES-DOCUMENT-SHELL",
        "Document-shell mode requires one root <html> element.",
        module.body[0]?.span,
      ),
    ]);
  }
  const errors: CompilerDiagnostic[] = [];
  const add = (code: string, message: string, sourceSpan: SourceSpan | undefined): void => {
    errors.push(shellDiagnostic(code, message, sourceSpan));
  };
  if (htmlRoots.length > 1) {
    for (const element of htmlRoots.slice(1))
      add(
        "HES-DOCUMENT-SHELL",
        "Document-shell mode permits only one root <html> element.",
        element.span,
      );
  }
  const root = htmlRoots[0]!;
  const directChildren = root.children.filter(isElement);
  for (const child of root.children)
    if (!isElement(child))
      add(
        "HES-DOCUMENT-SHELL",
        "The root <html> element may contain only direct <head> and <body> children.",
        child.span,
      );
  const heads = directChildren.filter((element) => element.tag.toLowerCase() === "head");
  const bodies = directChildren.filter((element) => element.tag.toLowerCase() === "body");
  if (heads.length !== 1)
    add(
      "HES-DOCUMENT-SHELL",
      "The root <html> element must contain exactly one direct <head> element.",
      (heads[1] ?? root).span,
    );
  if (bodies.length !== 1)
    add(
      "HES-DOCUMENT-SHELL",
      "The root <html> element must contain exactly one direct <body> element.",
      (bodies[1] ?? root).span,
    );
  if (heads.length === 1 && bodies.length === 1) {
    const headIndex = directChildren.indexOf(heads[0]!);
    const bodyIndex = directChildren.indexOf(bodies[0]!);
    if (headIndex > bodyIndex)
      add(
        "HES-DOCUMENT-SHELL",
        "The direct <head> element must precede the direct <body> element.",
        heads[0]!.span,
      );
  }
  for (const element of directChildren) {
    const tag = element.tag.toLowerCase();
    if (tag !== "head" && tag !== "body")
      add(
        "HES-DOCUMENT-SHELL",
        `Only direct <head> and <body> children are allowed under <html>; found <${element.tag}>.`,
        element.span,
      );
  }
  if (heads.length === 1) validateDocumentHead(heads[0]!, add);

  for (const [element, parent] of parents) {
    const tag = element.tag.toLowerCase();
    if (tag === "html" && element !== root)
      add(
        "HES-DOCUMENT-SHELL",
        "Nested or duplicate <html> elements are not allowed in document-shell mode.",
        element.span,
      );
    if ((tag === "head" || tag === "body") && !directChildren.includes(element))
      add(
        "HES-DOCUMENT-SHELL",
        `<${tag}> must be a direct child of the root <html> element.`,
        element.span,
      );
    if (["meta", "title", "link"].includes(tag) && parent !== heads[0])
      add(
        "HES-DOCUMENT-SHELL",
        `<${tag}> is only allowed as a direct child of <head>.`,
        element.span,
      );
  }
  return withShellDiagnostics(module, errors);
}

function defaultRenderRoots(module: CanonicalModule): CanonicalElement[] {
  const exported = module.body.find(
    (item) => item.kind === "export" && item.exportKind === "default",
  );
  if (!exported || exported.kind !== "export" || exported.declaration.kind !== "function")
    return [];
  const children = returnedChildren(exported.declaration.body);
  return children.filter(isElement);
}

function returnedChildren(block: CanonicalStatementBlock): CanonicalChild[] {
  const children: CanonicalChild[] = [];
  for (const statement of block.body) {
    if (statement.kind === "return" && statement.argument && isCanonicalChild(statement.argument))
      children.push(statement.argument);
    else if (statement.kind === "block") children.push(...returnedChildren(statement));
  }
  return children;
}

function validateDocumentHead(
  head: CanonicalElement,
  add: (code: string, message: string, sourceSpan: SourceSpan | undefined) => void,
): void {
  const titles = head.children.filter(
    (child): child is CanonicalElement => isElement(child) && child.tag.toLowerCase() === "title",
  );
  for (const title of titles.slice(1))
    add("HES-DOCUMENT-SHELL", "Document-shell mode permits only one <title> element.", title.span);
  for (const child of head.children) {
    if (!isElement(child)) {
      add(
        "HES-DOCUMENT-SHELL",
        "The document <head> may contain only <meta>, <title>, and <link> elements.",
        child.span,
      );
      continue;
    }
    const tag = child.tag.toLowerCase();
    if (!["meta", "title", "link"].includes(tag))
      add(
        "HES-DOCUMENT-SHELL",
        `Unsupported <${child.tag}> in document <head>; use <meta>, <title>, or <link>.`,
        child.span,
      );
    if ((tag === "meta" || tag === "link") && child.children.length)
      add(
        "HES-DOCUMENT-SHELL",
        `<${tag}> cannot contain children in document-shell mode.`,
        child.span,
      );
    if (
      tag === "title" &&
      child.children.some((nested) => nested.kind !== "text" && nested.kind !== "dynamic-child")
    )
      add(
        "HES-DOCUMENT-SHELL",
        "Document <title> content must be text or a scalar dynamic expression.",
        child.span,
      );
  }
}

function isElement(value: CanonicalChild): value is CanonicalElement {
  return value.kind === "element";
}

function shellDiagnostic(
  code: string,
  message: string,
  sourceSpan: SourceSpan | undefined,
): CompilerDiagnostic {
  return { code, severity: "error", message, ...(sourceSpan ? { span: sourceSpan } : {}) };
}

function withShellDiagnostics(
  module: CanonicalModule,
  diagnostics: readonly CompilerDiagnostic[],
): CanonicalModule {
  return diagnostics.length
    ? { ...module, diagnostics: [...module.diagnostics, ...diagnostics] }
    : module;
}

function jsxReference(name: string, input: AstNode): CanonicalExpression {
  const parts = name.split(".");
  let result: CanonicalExpression = { kind: "identifier", name: parts[0]!, span: span(input) };
  for (const property of parts.slice(1))
    result = {
      kind: "member",
      object: result,
      property: { kind: "identifier", name: property, span: span(input) },
      computed: false,
      optional: false,
      span: span(input),
    };
  return result;
}

function jsxName(input: AstNode | null): string | null {
  if (!input) return null;
  if (input.type === "JSXIdentifier" && typeof input.name === "string") return input.name;
  if (input.type === "JSXMemberExpression") {
    const object = jsxName(node(input.object));
    const property = jsxName(node(input.property));
    return object && property ? `${object}.${property}` : null;
  }
  return null;
}

function jsxAttributeName(input: AstNode | null): string | null {
  if (!input) return null;
  if (input.type === "JSXIdentifier" && typeof input.name === "string") return input.name;
  if (input.type === "JSXNamespacedName") {
    const namespace = node(input.namespace);
    const name = node(input.name);
    return namespace && name && typeof namespace.name === "string" && typeof name.name === "string"
      ? `${namespace.name}:${name.name}`
      : null;
  }
  return null;
}

function cleanJsxText(raw: string): string {
  const leading = /^[ \t]+(?=[^\r\n])/.test(raw);
  const trailing = /[^\r\n][ \t]+$/.test(raw);
  const value = raw
    .split(/\r\n|\n|\r/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join(" ");
  if (!value) return "";
  return `${leading ? " " : ""}${value}${trailing ? " " : ""}`;
}

function isLiteral(expression: CanonicalExpression): boolean {
  return expression.kind === "literal" || expression.kind === "undefined";
}

function propertyName(name: string): boolean {
  return new Set([
    "value",
    "checked",
    "selected",
    "muted",
    "disabled",
    "textContent",
    "className",
    "htmlFor",
  ]).has(name);
}

function parserSensitive(name: string): boolean {
  return new Set([
    "table",
    "tr",
    "td",
    "th",
    "template",
    "textarea",
    "title",
    "script",
    "style",
  ]).has(name.toLowerCase());
}
