import { print } from "esrap";
import ts from "esrap/languages/ts";
import { isCanonicalChild } from "./ir.ts";
import { collectFiniteImportConstants, enumerateFiniteImportSpecifiers } from "./finite-imports.ts";
import {
  componentFactoryExpression,
  isComponentArrow,
  isComponentBody,
  isComponentFunctionExpression,
} from "./component-analysis.ts";
import type {
  CanonicalArgument,
  CanonicalAttribute,
  CanonicalCapture,
  CanonicalChild,
  CanonicalExpression,
  CanonicalForLeft,
  CanonicalModule,
  CanonicalPattern,
  CanonicalProperty,
  CanonicalStatement,
  CanonicalStatementBlock,
  CanonicalVariableDeclaration,
  SourceSpan,
} from "./ir.ts";

interface GeneratedNode {
  readonly type: string;
  readonly loc?: { readonly start: Position; readonly end: Position };
  readonly [key: string]: unknown;
}

interface Position {
  readonly line: number;
  readonly column: number;
}

/** One authored client import rewritten to an owner-bound generated local. */
export type ClientBinding =
  | { readonly bindingId: string; readonly local: string; readonly kind: "namespace" }
  | {
      readonly bindingId: string;
      readonly local: string;
      readonly kind: "import";
      readonly mode: "direct" | "namespace";
    }
  | {
      readonly bindingId: string;
      readonly local: string;
      readonly kind: "navigation-marker" | "navigation-namespace";
    }
  | {
      readonly bindingId: string;
      readonly local: string;
      readonly kind: "operation";
      readonly operation: string;
    };

interface GeneratedOptions {
  readonly runtimeModule: string;
  readonly filename: string;
  readonly source: string;
  readonly clientBindings: ReadonlyMap<string, ClientBinding>;
  readonly clientCapabilityName?: string;
  readonly asyncBody?: boolean;
  readonly nativeFactories?: Map<string, GeneratedNode>;
  readonly nativeFactoryDeclarations?: GeneratedNode[];
  readonly captureScope?: ReadonlySet<string>;
  readonly nativeContextTag?: string;
  readonly nativeContextNamespace?: string;
  readonly ownerName?: string;
  readonly captureScopeName?: string;
  /** Inline owner-bound client creation for component parameter defaults, which run before the body. */
  readonly clientCapabilityInline?: boolean;
  /** Generated aliases for resolved bindings whose runtime identity differs from authored syntax. */
  readonly bindingAliases?: ReadonlyMap<string, string>;
  /** Lower finite dynamic imports only for browser project emission. */
  readonly browserTarget?: boolean;
  /** Register a permissive embedded-document policy on this project's definitions. */
  readonly allowUnsafeEmbed?: boolean;
  readonly styleRuntimeModule?: string;
  readonly styleEntryId?: string;
  readonly stylePreloadEntry?: boolean;
  readonly styleIdentity?: string;
  readonly styleRuntimeName?: string;
  readonly styleOwners?: Map<string, string | undefined>;
  readonly styleComponentName?: string;
  readonly finiteImportConstants?: ReadonlyMap<string, CanonicalExpression>;
  readonly generatedNames?: Set<string>;
  readonly importOperandContext?: {
    readonly captures: Map<"this" | "arguments" | "new.target", string>;
    readonly names: Set<string>;
  };
}

interface SourcePositions {
  readonly source: string;
  readonly lineStarts: readonly number[];
}

type IndexedGeneratedOptions = Omit<GeneratedOptions, "source"> & {
  readonly source: SourcePositions;
};

const EMPTY_SOURCE_POSITIONS: SourcePositions = { source: "", lineStarts: [0] };

/** Generate fresh JavaScript ESTree nodes from canonical Hesperia meaning. */
export function generateModule(
  module: CanonicalModule,
  options: GeneratedOptions,
): { code: string; map: unknown; styleOwners: readonly { id: string; name?: string }[] } {
  const sourcePositions = createSourcePositions(options.source);
  const runtime = identifier("_$", { start: 0, end: 0 }, sourcePositions);
  const styleOwners = new Map<string, string | undefined>();
  let generationOptions: IndexedGeneratedOptions =
    options.browserTarget === true
      ? {
          ...options,
          source: sourcePositions,
          styleOwners,
          finiteImportConstants: collectFiniteImportConstants(module),
          generatedNames: collectNames(module),
        }
      : {
          ...options,
          source: sourcePositions,
          styleOwners,
        };
  const body: GeneratedNode[] = [importNamespace(runtime, options.runtimeModule)];

  if (options.styleRuntimeModule && options.styleEntryId) {
    const usedNames = collectNames(module);
    const styleRuntimeName = uniqueName("__hesperiaStyle", usedNames);

    body.push(
      importNamespace(
        identifier(styleRuntimeName, emptySpan(), sourcePositions),
        options.styleRuntimeModule,
      ),
    );

    if (options.stylePreloadEntry !== false) {
      const leaseName = uniqueName("__hesperiaStyleLease", usedNames);

      body.push({
        type: "VariableDeclaration",
        kind: "const",
        declarations: [
          {
            type: "VariableDeclarator",
            id: identifier(leaseName, emptySpan(), sourcePositions),
            init: {
              type: "AwaitExpression",
              argument: call(
                styleRuntime({ ...generationOptions, styleRuntimeName }),
                "preloadEntry",
                [
                  literal(options.styleEntryId, emptySpan(), sourcePositions),
                  {
                    type: "MemberExpression",
                    object: identifier("document", emptySpan(), sourcePositions),
                    property: identifier("head", emptySpan(), sourcePositions),
                    computed: false,
                    optional: false,
                  },
                ],
                emptySpan(),
                sourcePositions,
              ),
            },
          },
        ],
      });
    }

    generationOptions = { ...generationOptions, styleRuntimeName };
  }

  for (const statement of module.body) {
    if (statement.kind === "import") {
      const specifiers = statement.specifiers.filter((specifier) => {
        const binding = generationOptions.clientBindings.get(specifier.bindingId ?? "");
        return (
          binding === undefined ||
          binding.kind === "import" ||
          binding.kind === "navigation-marker" ||
          binding.kind === "navigation-namespace"
        );
      });

      if (specifiers.length === 0 && statement.specifiers.length !== 0) continue;

      body.push(generateStatement({ ...statement, specifiers }, generationOptions, runtime));

      continue;
    }

    body.push(generateStatement(statement, generationOptions, runtime));
  }

  const result = print(
    { type: "Program", sourceType: "module", body } as GeneratedNode,
    ts({ boundaryTokens: true }),
    { sourceMapSource: options.filename, sourceMapContent: options.source },
  );
  return {
    code: result.code,
    map: result.map,
    styleOwners: [...styleOwners].map(([id, name]) => ({ id, ...(name ? { name } : {}) })),
  };
}

function generateStatement(
  statement: CanonicalStatement,
  options: IndexedGeneratedOptions,
  runtime: GeneratedNode,
): GeneratedNode {
  switch (statement.kind) {
    case "import":
      return {
        type: "ImportDeclaration",
        specifiers: statement.specifiers.map((specifier) =>
          specifier.kind === "named"
            ? {
                type: "ImportSpecifier",
                imported: identifier(specifier.imported, emptySpan(), options.source),
                local: identifier(specifier.local, emptySpan(), options.source),
              }
            : specifier.kind === "default"
              ? {
                  type: "ImportDefaultSpecifier",
                  local: identifier(specifier.local, emptySpan(), options.source),
                }
              : {
                  type: "ImportNamespaceSpecifier",
                  local: identifier(specifier.local, emptySpan(), options.source),
                },
        ),
        source: literal(statement.source, statement.span, options.source),
        ...loc(statement.span, options.source),
      };
    case "variable":
      return variable(
        statement.declarationKind,
        statement.declarations,
        options,
        runtime,
        statement.span,
      );
    case "function":
      return generateFunction(statement, options, runtime, false);
    case "class":
      return generateClassDeclaration(statement, options, runtime);
    case "return":
      return returnStatement(
        statement.argument
          ? isCanonicalChild(statement.argument)
            ? generateChild(statement.argument, options, runtimeOwner(options, statement.span))
            : generateExpression(statement.argument, options)
          : null,
        statement.span,
        options.source,
      );
    case "expression":
      return {
        type: "ExpressionStatement",
        expression: generateExpression(statement.expression, options),
        ...loc(statement.span, options.source),
      };
    case "if":
      return {
        type: "IfStatement",
        test: generateExpression(statement.test, options),
        consequent: generateStatement(statement.consequent, options, runtime),
        alternate: statement.alternate
          ? generateStatement(statement.alternate, options, runtime)
          : null,
        ...loc(statement.span, options.source),
      };
    case "switch":
      return {
        type: "SwitchStatement",
        discriminant: generateExpression(statement.discriminant, options),
        cases: statement.cases.map((item) => ({
          type: "SwitchCase",
          test: item.test ? generateExpression(item.test, options) : null,
          consequent: item.consequent.map((entry) => generateStatement(entry, options, runtime)),
          ...loc(item.span, options.source),
        })),
        ...loc(statement.span, options.source),
      };
    case "for":
      return {
        type: "ForStatement",
        init: statement.init
          ? statement.init.kind === "variable"
            ? variable(
                statement.init.declarationKind,
                statement.init.declarations,
                options,
                runtime,
                statement.init.span,
              )
            : generateExpression(statement.init, options)
          : null,
        test: statement.test ? generateExpression(statement.test, options) : null,
        update: statement.update ? generateExpression(statement.update, options) : null,
        body: generateStatement(statement.body, options, runtime),
        ...loc(statement.span, options.source),
      };
    case "for-of":
      return {
        type: "ForOfStatement",
        await: statement.await,
        left: generateForLeft(statement.left, options, runtime),
        right: generateExpression(statement.right, options),
        body: generateStatement(statement.body, options, runtime),
        ...loc(statement.span, options.source),
      };
    case "for-in":
      return {
        type: "ForInStatement",
        left: generateForLeft(statement.left, options, runtime),
        right: generateExpression(statement.right, options),
        body: generateStatement(statement.body, options, runtime),
        ...loc(statement.span, options.source),
      };
    case "while":
      return {
        type: "WhileStatement",
        test: generateExpression(statement.test, options),
        body: generateStatement(statement.body, options, runtime),
        ...loc(statement.span, options.source),
      };
    case "do-while":
      return {
        type: "DoWhileStatement",
        body: generateStatement(statement.body, options, runtime),
        test: generateExpression(statement.test, options),
        ...loc(statement.span, options.source),
      };
    case "labeled":
      return {
        type: "LabeledStatement",
        label: identifier(statement.label, statement.span, options.source),
        body: generateStatement(statement.body, options, runtime),
        ...loc(statement.span, options.source),
      };
    case "break":
      return {
        type: "BreakStatement",
        label: statement.label ? identifier(statement.label, statement.span, options.source) : null,
        ...loc(statement.span, options.source),
      };
    case "continue":
      return {
        type: "ContinueStatement",
        label: statement.label ? identifier(statement.label, statement.span, options.source) : null,
        ...loc(statement.span, options.source),
      };
    case "throw":
      return {
        type: "ThrowStatement",
        argument: generateExpression(statement.argument, options),
        ...loc(statement.span, options.source),
      };
    case "try":
      return {
        type: "TryStatement",
        block: block(statement.body, options, runtime),
        handler: statement.handler
          ? {
              type: "CatchClause",
              param: statement.handler.param
                ? generatePattern(statement.handler.param, options)
                : null,
              body: block(statement.handler.body, options, runtime),
              ...loc(statement.handler.span, options.source),
            }
          : null,
        finalizer: statement.finalizer ? block(statement.finalizer, options, runtime) : null,
        ...loc(statement.span, options.source),
      };
    case "block":
      return block(statement, options, runtime);
    case "export":
      if (statement.declaration.kind === "function")
        return generateFunction(statement.declaration, options, runtime, statement.exportKind);

      if (statement.declaration.kind === "class") {
        const declaration = generateClassDeclaration(statement.declaration, options, runtime);
        return statement.exportKind === "default"
          ? {
              type: "ExportDefaultDeclaration",
              declaration,
              ...loc(statement.span, options.source),
            }
          : {
              type: "ExportNamedDeclaration",
              declaration,
              specifiers: [],
              source: null,
              ...loc(statement.span, options.source),
            };
      }

      if (statement.declaration.kind === "variable") {
        const declaration = variable(
          statement.declaration.declarationKind,
          statement.declaration.declarations,
          options,
          runtime,
          statement.declaration.span,
        );

        if (statement.exportKind === "default") {
          const declarations = declaration["declarations"];
          const first = Array.isArray(declarations) ? declarations[0] : null;
          const initializer =
            typeof first === "object" && first !== null && "init" in first
              ? (first as { readonly init?: GeneratedNode }).init
              : undefined;
          return {
            type: "ExportDefaultDeclaration",
            declaration: initializer ?? identifier("undefined", statement.span, options.source),
            ...loc(statement.span, options.source),
          };
        }

        return {
          type: "ExportNamedDeclaration",
          declaration,
          specifiers: [],
          source: null,
          ...loc(statement.span, options.source),
        };
      }

      if (statement.declaration.kind === "expression") {
        const expression = statement.declaration.expression;
        const component = componentFactoryExpression(expression);
        const generated =
          component && (component.component === true || component.props !== undefined)
            ? generateComponentValue(expression, {
                ...options,
                styleComponentName: statement.exportKind === "default" ? "default" : undefined,
              })!
            : generateExpression(expression, options);
        return {
          type:
            statement.exportKind === "default"
              ? "ExportDefaultDeclaration"
              : "ExportNamedDeclaration",
          declaration: generated,
          ...(statement.exportKind === "named" ? { specifiers: [], source: null } : {}),
          ...loc(statement.span, options.source),
        };
      }

      return {
        type: "ExportNamedDeclaration",
        declaration: generateStatement(statement.declaration, options, runtime),
        specifiers: [],
        source: null,
        ...loc(statement.span, options.source),
      };
    case "export-list":
      return {
        type: "ExportNamedDeclaration",
        declaration: null,
        specifiers: statement.specifiers.map((specifier) => ({
          type: "ExportSpecifier",
          local: exportNameNode(specifier.local, statement.span, options.source),
          exported: exportNameNode(specifier.exported, statement.span, options.source),
        })),
        source:
          statement.source === null
            ? null
            : literal(statement.source, statement.span, options.source),
        ...loc(statement.span, options.source),
      };
    case "export-all":
      return {
        type: "ExportAllDeclaration",
        exported:
          statement.exported === null
            ? null
            : exportNameNode(statement.exported, statement.span, options.source),
        source: literal(statement.source, statement.span, options.source),
        ...loc(statement.span, options.source),
      };
  }
}

function generateForLeft(
  left: CanonicalForLeft,
  options: IndexedGeneratedOptions,
  runtime: GeneratedNode,
): GeneratedNode {
  if (left.kind === "assignment") return generateAssignmentTarget(left.target, options);

  return variable(
    left.declarationKind,
    [{ pattern: left.pattern, initializer: null, span: left.span }],
    options,
    runtime,
    left.span,
  );
}

function generateFunction(
  statement: Extract<CanonicalStatement, { kind: "function" }>,
  options: IndexedGeneratedOptions,
  runtime: GeneratedNode,
  exported: boolean | "named" | "default",
): GeneratedNode {
  const component =
    !statement.generator && (statement.component === true || statement.props !== undefined)
      ? true
      : !statement.generator && isComponentBody(statement.body);

  if (!component) {
    const functionOptions = { ...options, asyncBody: false, importOperandContext: undefined };
    const declaration: GeneratedNode = {
      type: "FunctionDeclaration",
      id: identifier(statement.name, statement.span, options.source),
      generator: statement.generator,
      async: statement.async,
      expression: false,
      params: statement.parameters.map((pattern) => generatePattern(pattern, functionOptions)),
      body: block(statement.body, functionOptions, runtime),
      ...loc(statement.span, options.source),
    };
    return exported === "default"
      ? { type: "ExportDefaultDeclaration", declaration, ...loc(statement.span, options.source) }
      : exported
        ? {
            type: "ExportNamedDeclaration",
            declaration,
            specifiers: [],
            source: null,
            ...loc(statement.span, options.source),
          }
        : declaration;
  }

  const usedNames = collectNames(statement);
  const ownerName = uniqueName("owner", usedNames);
  const owner = identifier(ownerName, statement.span, options.source);
  const clientCapability = generateClientCapability(
    options.clientBindings,
    ownerName,
    usedNames,
    statement.span,
    options,
    runtime,
  );
  const clients = clientCapability?.declarations ?? [];
  const bodyOptions = {
    ...options,
    asyncBody: statement.async,
    nativeFactories: new Map<string, GeneratedNode>(),
    nativeFactoryDeclarations: [] as GeneratedNode[],
    ownerName,
    clientCapabilityName: clientCapability?.name,
  };
  const statements = statement.body.body.map((item) =>
    generateStatement(item, bodyOptions, runtime),
  );
  const body = [...clients, ...bodyOptions.nativeFactoryDeclarations, ...statements];
  const factoryBody = statement.async
    ? call(
        runtime,
        "runAsyncBody",
        [
          owner,
          {
            type: "FunctionExpression",
            id: null,
            generator: true,
            async: false,
            expression: false,
            params: [],
            body: { type: "BlockStatement", body, ...loc(statement.body.span, options.source) },
            ...loc(statement.span, options.source),
          },
        ],
        statement.span,
        options.source,
      )
    : {
        type: "BlockStatement",
        body: [...styleOwnerBinding(owner, statement.span, options, statement.name), ...body],
        ...loc(statement.body.span, options.source),
      };
  const definition = projectPolicyDefinition(
    call(
      runtime,
      "defineComponent",
      [
        {
          type: "ArrowFunctionExpression",
          id: null,
          generator: false,
          async: false,
          expression: false,
          params: [
            owner,
            ...statement.parameters.map((pattern) =>
              generatePattern(pattern, {
                ...options,
                ownerName,
                clientCapabilityName: clientCapability?.name,
                clientCapabilityInline: true,
              }),
            ),
          ],
          body: statement.async
            ? {
                type: "BlockStatement",
                body: [
                  ...styleOwnerBinding(owner, statement.span, options, statement.name),
                  { type: "ReturnStatement", argument: factoryBody },
                ],
                ...loc(statement.body.span, options.source),
              }
            : factoryBody,
          ...loc(statement.span, options.source),
        },
        ...componentOptions(statement.props, statement.async, statement.span, options),
      ],
      statement.span,
      options.source,
    ),
    options,
    statement.span,
  );
  const declaration: GeneratedNode = {
    type: "VariableDeclaration",
    kind: "const",
    declarations: [
      {
        type: "VariableDeclarator",
        id: identifier(statement.name, statement.span, options.source),
        init: definition,
        ...loc(statement.span, options.source),
      },
    ],
    ...loc(statement.span, options.source),
  };
  return exported === "default"
    ? {
        type: "ExportDefaultDeclaration",
        declaration: definition,
        ...loc(statement.span, options.source),
      }
    : exported
      ? {
          type: "ExportNamedDeclaration",
          declaration,
          specifiers: [],
          source: null,
          ...loc(statement.span, options.source),
        }
      : declaration;
}

function generateClassDeclaration(
  statement: Extract<CanonicalStatement, { kind: "class" }>,
  options: IndexedGeneratedOptions,
  runtime: GeneratedNode,
): GeneratedNode {
  return {
    type: "ClassDeclaration",
    id: identifier(statement.name, statement.span, options.source),
    superClass: statement.superClass ? generateExpression(statement.superClass, options) : null,
    body: generateClassBody(statement.elements, options, runtime),
    ...loc(statement.span, options.source),
  };
}

function generateClassBody(
  elements: readonly import("./ir.ts").CanonicalClassElement[],
  options: IndexedGeneratedOptions,
  runtime: GeneratedNode,
): GeneratedNode {
  return {
    type: "ClassBody",
    body: elements.map((element) => generateClassElement(element, options, runtime)),
    ...loc(elements[0]?.span ?? emptySpan(), options.source),
  };
}

function generateClassElement(
  element: import("./ir.ts").CanonicalClassElement,
  options: IndexedGeneratedOptions,
  runtime: GeneratedNode,
): GeneratedNode {
  if (element.kind === "static-block")
    return {
      type: "StaticBlock",
      body: block(
        element.body,
        { ...options, asyncBody: false, importOperandContext: undefined },
        runtime,
      ).body,
      ...loc(element.span, options.source),
    };

  const key = classKeyNode(element.key, element.computed, options);

  if (element.kind === "field")
    return {
      type: "PropertyDefinition",
      key,
      computed: element.computed,
      static: element.static,
      value: element.initializer
        ? generateExpression(element.initializer, { ...options, importOperandContext: undefined })
        : null,
      ...loc(element.span, options.source),
    };

  return {
    type: "MethodDefinition",
    key,
    computed: element.computed,
    static: element.static,
    kind: element.methodKind,
    value: {
      type: "FunctionExpression",
      id: null,
      generator: false,
      async: element.async,
      expression: false,
      params: element.parameters.map((item) =>
        generatePattern(item, { ...options, importOperandContext: undefined }),
      ),
      body: block(
        element.body,
        { ...options, asyncBody: false, importOperandContext: undefined },
        runtime,
      ),
      ...loc(element.span, options.source),
    },
    ...loc(element.span, options.source),
  };
}

function classKeyNode(
  key: string | number | CanonicalExpression,
  computed: boolean,
  options: IndexedGeneratedOptions,
): GeneratedNode {
  if (typeof key === "object") return generateExpression(key, options);

  if (typeof key === "number") return literal(key, emptySpan(), options.source);

  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key)
    ? identifier(key, emptySpan(), options.source)
    : literal(key, emptySpan(), options.source);
}

function block(
  value: CanonicalStatementBlock,
  options: IndexedGeneratedOptions,
  runtime: GeneratedNode,
): GeneratedNode {
  return {
    type: "BlockStatement",
    body: value.body.map((item) => generateStatement(item, options, runtime)),
    ...loc(value.span, options.source),
  };
}

function variable(
  kind: "const" | "let" | "var",
  declarations: readonly CanonicalVariableDeclaration[],
  options: IndexedGeneratedOptions,
  runtime: GeneratedNode,
  sourceSpan: SourceSpan,
): GeneratedNode {
  const owner = runtimeOwner(options, sourceSpan);
  return {
    type: "VariableDeclaration",
    kind,
    declarations: declarations.map((declaration) => ({
      type: "VariableDeclarator",
      id: generatePattern(declaration.pattern, options),
      init:
        declaration.initializer === null
          ? null
          : isCanonicalChild(declaration.initializer)
            ? generateChild(declaration.initializer, options, owner)
            : componentFactoryExpression(declaration.initializer)
              ? generateComponentValue(declaration.initializer, {
                  ...options,
                  styleComponentName:
                    declaration.pattern.kind === "identifier"
                      ? declaration.pattern.name
                      : undefined,
                })!
              : generateExpression(declaration.initializer, options),
      ...loc(declaration.span, options.source),
    })),
    ...loc(sourceSpan, options.source),
  };
}

function returnStatement(
  argument: GeneratedNode | null,
  sourceSpan: SourceSpan,
  source: SourcePositions,
): GeneratedNode {
  return { type: "ReturnStatement", argument, ...loc(sourceSpan, source) };
}

function nativeFactoryFor(
  child: CanonicalChild,
  options: IndexedGeneratedOptions,
  identity: string,
  captures: readonly CanonicalCapture[] = [],
): string {
  const safeIdentity = identity.replace(/[^a-zA-Z0-9_$]/g, "_");
  const baseName = `__hesperia_native_${safeIdentity}`;
  let factoryName = baseName;
  let suffix = 0;

  while (options.nativeFactories?.has(factoryName)) factoryName = `${baseName}_${++suffix}`;

  options.nativeFactories?.set(factoryName, identifier(factoryName, child.span, options.source));

  const names = collectNames(child);
  const factoryOwnerName = uniqueName("itemOwner", names);
  const captureScopeName = uniqueName("scope", names);
  const captureScope: ReadonlySet<string> = new Set(captures.map((capture) => capture.bindingId));
  const factoryOwner = identifier(factoryOwnerName, child.span, options.source);
  const scope = identifier(captureScopeName, child.span, options.source);
  const factory = arrow(
    [factoryOwner, scope],
    generateChild(child, { ...options, captureScope, captureScopeName }, factoryOwner),
    child.span,
    options.source,
  );

  options.nativeFactories?.set(factoryName, factory);

  options.nativeFactoryDeclarations?.push({
    type: "VariableDeclaration",
    kind: "const",
    declarations: [
      {
        type: "VariableDeclarator",
        id: identifier(factoryName, child.span, options.source),
        init: factory,
        ...loc(child.span, options.source),
      },
    ],
    ...loc(child.span, options.source),
  });

  return factoryName;
}

function generateAsyncBoundary(
  child: Extract<CanonicalChild, { kind: "component" }>,
  options: IndexedGeneratedOptions,
  owner: GeneratedNode,
): GeneratedNode {
  const fallback = child.props.find((prop) => prop.kind === "fallback");
  const content = child.props.find((prop) => prop.kind === "children");
  const boundaryOptions = options.asyncBody ? { ...options, asyncBody: false } : options;
  const loadingOwner = identifier("loadingOwner", child.span, options.source);
  const contentOwner = identifier("contentOwner", child.span, options.source);
  const loading =
    fallback && fallback.kind === "fallback"
      ? generateChild(fallback.child, boundaryOptions, loadingOwner)
      : literal(null, child.span, options.source);
  const contentValue =
    content && content.kind === "children"
      ? array(
          content.children.map((item) => generateChild(item, boundaryOptions, contentOwner)),
          child.span,
          options.source,
        )
      : literal(null, child.span, options.source);
  return call(
    optionsRuntime(options),
    "asyncBoundary",
    [
      owner,
      literal(`async:${child.occurrence}`, child.span, options.source),
      arrow([loadingOwner], loading, child.span, options.source),
      arrow([contentOwner], contentValue, child.span, options.source),
    ],
    child.span,
    options.source,
  );
}

function generateChild(
  child: CanonicalChild,
  options: IndexedGeneratedOptions,
  owner: GeneratedNode,
): GeneratedNode {
  if (child.kind === "fragment")
    return array(
      child.children.map((item) => generateChild(item, options, owner)),
      child.span,
      options.source,
    );

  if (child.kind === "text")
    return call(
      optionsRuntime(options),
      "text",
      [
        owner,
        arrow([], literal(child.value, child.span, options.source), child.span, options.source),
      ],
      child.span,
      options.source,
    );

  if (child.kind === "dynamic-child")
    return call(
      optionsRuntime(options),
      "child",
      [owner, arrow([], generateExpression(child.expression, options), child.span, options.source)],
      child.span,
      options.source,
    );

  if (
    child.kind === "component" &&
    child.reference.kind === "identifier" &&
    child.reference.name === "AsyncBoundary"
  )
    return generateAsyncBoundary(child, options, owner);

  if (child.kind === "component")
    return call(
      optionsRuntime(options),
      "component",
      [
        owner,
        generateExpression(child.reference, options),
        componentProps(child.props, options, owner),
      ],
      child.span,
      options.source,
    );

  if (child.kind === "raw-html") {
    const rawOwner = identifier("rawOwner", child.span, options.source);
    const host = child.host
      ? arrow(
          [rawOwner],
          generateChild(child.host, options, rawOwner),
          child.host.span,
          options.source,
        )
      : literal(null, child.span, options.source);
    const args: GeneratedNode[] = [
      owner,
      literal(`raw:${child.occurrence}`, child.span, options.source),
      arrow([], generateExpression(child.html, options), child.span, options.source),
      host,
    ];

    if (child.host) {
      args.push(literal(child.host.tag, child.host.span, options.source));

      if (child.host.namespace !== "html")
        args.push(
          literal(
            child.host.namespace === "svg"
              ? "http://www.w3.org/2000/svg"
              : "http://www.w3.org/1998/Math/MathML",
            child.host.span,
            options.source,
          ),
        );
    } else if (options.nativeContextTag) {
      args.push(literal(options.nativeContextTag, child.span, options.source));

      if (options.nativeContextNamespace)
        args.push(literal(options.nativeContextNamespace, child.span, options.source));
    }

    return call(optionsRuntime(options), "rawHTML", args, child.span, options.source);
  }

  if (child.kind === "await-child") {
    const awaited = call(
      optionsRuntime(options),
      "awaitComponent",
      [
        owner,
        generateExpression(child.reference, options),
        componentProps(child.props, options, owner),
        literal(`await:${child.occurrence}`, child.span, options.source),
      ],
      child.span,
      options.source,
    );
    return options.asyncBody
      ? {
          type: "YieldExpression",
          argument: awaited,
          delegate: false,
          ...loc(child.span, options.source),
        }
      : { type: "AwaitExpression", argument: awaited, ...loc(child.span, options.source) };
  }

  if (child.kind === "list") {
    const ownBindingIds = new Set(patternBindingIds(child.parameter));
    const captures = child.captures;
    const keyOptions = options.captureScope
      ? {
          ...options,
          captureScope: new Set(
            [...options.captureScope].filter((bindingId) => !ownBindingIds.has(bindingId)),
          ),
        }
      : options;
    const factoryName = nativeFactoryFor(child.body, options, `list_${child.occurrence}`, captures);
    const mapped = {
      type: "ArrowFunctionExpression",
      id: null,
      generator: false,
      async: false,
      expression: true,
      params: [generatePattern(child.parameter, options)],
      body: call(
        optionsRuntime(options),
        "nativeItem",
        [
          identifier(factoryName, child.span, options.source),
          object(
            captures.map((capture) =>
              property(
                capture.name,
                ownBindingIds.has(capture.bindingId)
                  ? identifier(capture.name, child.parameter.span, options.source)
                  : generateExpression(
                      {
                        kind: "identifier",
                        name: capture.name,
                        referenceId: capture.bindingId,
                        span: child.parameter.span,
                      },
                      options,
                    ),
                child.span,
                options.source,
              ),
            ),
            child.span,
            options.source,
          ),
          literal(`list:${child.occurrence}`, child.span, options.source),
          generateExpression(child.key, keyOptions),
        ],
        child.span,
        options.source,
      ),
      ...loc(child.span, options.source),
    };
    return call(
      optionsRuntime(options),
      "region",
      [
        owner,
        literal(`list:${child.occurrence}`, child.span, options.source),
        arrow(
          [],
          {
            type: "CallExpression",
            callee: {
              type: "MemberExpression",
              object: generateExpression(child.collection, options),
              property: identifier("map", child.span, options.source),
              computed: false,
              optional: false,
              ...loc(child.span, options.source),
            },
            arguments: [mapped],
            optional: false,
            ...loc(child.span, options.source),
          },
          child.span,
          options.source,
        ),
      ],
      child.span,
      options.source,
    );
  }

  if (child.kind === "conditional") {
    const branch = (
      value: CanonicalChild | null,
      arm: "consequent" | "alternate",
    ): GeneratedNode =>
      value && value.kind === "component"
        ? call(
            optionsRuntime(options),
            "componentItem",
            [
              generateExpression(value.reference, options),
              componentProps(value.props, options, owner),
              literal(`conditional:${child.occurrence}`, child.span, options.source),
            ],
            value.span,
            options.source,
          )
        : value
          ? call(
              optionsRuntime(options),
              "nativeItem",
              [
                identifier(
                  nativeFactoryFor(
                    value,
                    options,
                    `conditional_${child.occurrence}_${arm}`,
                    child.captures,
                  ),
                  value.span,
                  options.source,
                ),
                object(
                  child.captures.map((capture) =>
                    property(
                      capture.name,
                      generateExpression(
                        {
                          kind: "identifier",
                          name: capture.name,
                          referenceId: capture.bindingId,
                          span: value.span,
                        },
                        options,
                      ),
                      value.span,
                      options.source,
                    ),
                  ),
                  value.span,
                  options.source,
                ),
                literal(`conditional:${child.occurrence}`, value.span, options.source),
              ],
              value.span,
              options.source,
            )
          : literal(null, child.span, options.source);

    return call(
      optionsRuntime(options),
      "region",
      [
        owner,
        literal(`conditional:${child.occurrence}`, child.span, options.source),
        arrow(
          [],
          {
            type: "ConditionalExpression",
            test: generateExpression(child.test, options),
            consequent: branch(child.consequent, "consequent"),
            alternate: branch(child.alternate, "alternate"),
            ...loc(child.span, options.source),
          },
          child.span,
          options.source,
        ),
      ],
      child.span,
      options.source,
    );
  }

  const props = child.attributes.length
    ? object(
        child.attributes.map((attribute) => attributeDescriptor(attribute, options)),
        child.span,
        options.source,
      )
    : object([], child.span, options.source);
  const childOptions: IndexedGeneratedOptions = {
    ...options,
    nativeContextTag: child.tag,
    nativeContextNamespace:
      child.namespace === "svg"
        ? "http://www.w3.org/2000/svg"
        : child.namespace === "mathml"
          ? "http://www.w3.org/1998/Math/MathML"
          : "http://www.w3.org/1999/xhtml",
  };
  const children = array(
    child.children.map((item) => generateChild(item, childOptions, owner)),
    child.span,
    options.source,
  );
  const args: GeneratedNode[] = [
    owner,
    literal(child.tag, child.span, options.source),
    props,
    children,
  ];

  if (child.namespace !== "html")
    args.push(
      literal(
        child.namespace === "svg"
          ? "http://www.w3.org/2000/svg"
          : "http://www.w3.org/1998/Math/MathML",
        child.span,
        options.source,
      ),
    );

  return call(optionsRuntime(options), "element", args, child.span, options.source);
}

function componentProps(
  props: readonly import("./ir.ts").CanonicalComponentProp[],
  options: IndexedGeneratedOptions,
  owner: GeneratedNode,
): GeneratedNode {
  return object(
    props.map((prop) =>
      prop.kind === "children"
        ? property(
            "children",
            call(
              optionsRuntime(options),
              "dynamic",
              [
                arrow(
                  [],
                  array(
                    prop.children.map((child) => generateChild(child, options, owner)),
                    prop.span,
                    options.source,
                  ),
                  prop.span,
                  options.source,
                ),
              ],
              prop.span,
              options.source,
            ),
            prop.span,
            options.source,
          )
        : prop.kind === "fallback"
          ? property(
              "fallback",
              generateChild(prop.child, options, owner),
              prop.span,
              options.source,
            )
          : ownProperty(
              prop.name,
              prop.lazy
                ? call(
                    optionsRuntime(options),
                    "dynamic",
                    [
                      arrow(
                        [],
                        generateExpression(prop.expression, options),
                        prop.span,
                        options.source,
                      ),
                    ],
                    prop.span,
                    options.source,
                  )
                : generateExpression(prop.expression, options),
              prop.span,
              options.source,
            ),
    ),
    emptySpan(),
    options.source,
  );
}

function attributeDescriptor(
  attribute: CanonicalAttribute,
  options: IndexedGeneratedOptions,
): GeneratedNode {
  if (attribute.kind === "static")
    return property(
      attribute.name,
      literal(attribute.value, attribute.span, options.source),
      attribute.span,
      options.source,
    );

  if (attribute.kind === "event")
    return property(
      `on:${attribute.name}`,
      generateExpression(attribute.expression, options),
      attribute.span,
      options.source,
    );

  if (attribute.mode === "binding")
    return property(
      attribute.name,
      generateExpression(attribute.expression, options),
      attribute.span,
      options.source,
    );

  return property(
    attribute.name,
    call(
      optionsRuntime(options),
      "dynamic",
      [
        arrow(
          [],
          generateExpression(attribute.expression, options),
          attribute.span,
          options.source,
        ),
      ],
      attribute.span,
      options.source,
    ),
    attribute.span,
    options.source,
  );
}

function generateExpression(
  expression: CanonicalExpression,
  options: IndexedGeneratedOptions,
): GeneratedNode {
  switch (expression.kind) {
    case "identifier":
      if (
        expression.name === "arguments" &&
        (!expression.referenceId || expression.referenceId === "unresolved/arguments") &&
        options.importOperandContext
      )
        return importOperandCapture("arguments", expression.span, options);

      {
        const bindingAlias = expression.referenceId
          ? options.bindingAliases?.get(expression.referenceId)
          : undefined;

        if (bindingAlias) return identifier(bindingAlias, expression.span, options.source);

        if (options.ownerName && isBeforeLeaveReference(expression, options.clientBindings))
          return ownerBoundBeforeLeaveValue(expression, options);

        const clientBinding = expression.referenceId
          ? options.clientBindings.get(expression.referenceId)
          : undefined;

        if (clientBinding && options.clientCapabilityName) {
          const capability =
            options.clientCapabilityInline && options.ownerName
              ? call(
                  optionsRuntime(options),
                  "createClient",
                  [identifier(options.ownerName, expression.span, options.source)],
                  expression.span,
                  options.source,
                )
              : identifier(options.clientCapabilityName, expression.span, options.source);

          if (clientBinding.kind === "namespace") return capability;

          if (clientBinding.kind === "operation")
            return {
              type: "MemberExpression",
              object: capability,
              property: identifier(clientBinding.operation, expression.span, options.source),
              computed: false,
              optional: false,
              ...loc(expression.span, options.source),
            };
        }

        if (clientBinding?.kind === "import" && options.ownerName) {
          return call(
            optionsRuntime(options),
            "bindImported",
            [
              identifier(options.ownerName, expression.span, options.source),
              identifier(clientBinding.local, expression.span, options.source),
              ...(clientBinding.mode === "namespace"
                ? [literal("namespace", expression.span, options.source)]
                : []),
            ],
            expression.span,
            options.source,
          );
        }
      }
      return options.captureScope?.has(expression.referenceId ?? "")
        ? call(
            identifier(options.captureScopeName ?? "scope", expression.span, options.source),
            expression.name,
            [],
            expression.span,
            options.source,
          )
        : identifier(expression.name, expression.span, options.source);
    case "undefined":
      return identifier("undefined", expression.span, options.source);
    case "this":
      if (options.importOperandContext)
        return importOperandCapture("this", expression.span, options);

      return { type: "ThisExpression", ...loc(expression.span, options.source) };
    case "super":
      return { type: "Super", ...loc(expression.span, options.source) };
    case "new-target":
      if (options.importOperandContext)
        return importOperandCapture("new.target", expression.span, options);

      return {
        type: "MetaProperty",
        meta: identifier("new", expression.span, options.source),
        property: identifier("target", expression.span, options.source),
        ...loc(expression.span, options.source),
      };
    case "import-meta":
      return {
        type: "MetaProperty",
        meta: identifier("import", expression.span, options.source),
        property: identifier("meta", expression.span, options.source),
        ...loc(expression.span, options.source),
      };
    case "private":
      return {
        type: "PrivateIdentifier",
        name: expression.name,
        ...loc(expression.span, options.source),
      };
    case "await":
      return options.asyncBody
        ? {
            type: "YieldExpression",
            argument: generateExpression(expression.expression, options),
            delegate: false,
            ...loc(expression.span, options.source),
          }
        : {
            type: "AwaitExpression",
            argument: generateExpression(expression.expression, options),
            ...loc(expression.span, options.source),
          };
    case "yield":
      return {
        type: "YieldExpression",
        argument: expression.expression ? generateExpression(expression.expression, options) : null,
        delegate: expression.delegate,
        ...loc(expression.span, options.source),
      };
    case "import-expression":
      return call(
        identifier("_$", expression.span, options.source),
        "registerModuleImport",
        [generateImportExpression(expression, options)],
        expression.span,
        options.source,
      );
    case "literal":
      return literal(expression.value, expression.span, options.source);
    case "regexp":
      return {
        type: "Literal",
        value: null,
        raw: `/${expression.pattern}/${expression.flags}`,
        regex: { pattern: expression.pattern, flags: expression.flags },
        ...loc(expression.span, options.source),
      };
    case "bigint":
      return {
        type: "Literal",
        value: expression.value,
        bigint: expression.value,
        raw: `${expression.value}n`,
        ...loc(expression.span, options.source),
      };
    case "template":
      return {
        type: "TemplateLiteral",
        quasis: expression.quasis.map((quasi, index) => ({
          type: "TemplateElement",
          value: { raw: quasi.raw, cooked: quasi.cooked },
          tail: index === expression.quasis.length - 1,
          ...loc(quasi.span, options.source),
        })),
        expressions: expression.expressions.map((item) => generateExpression(item, options)),
        ...loc(expression.span, options.source),
      };
    case "sequence":
      return {
        type: "SequenceExpression",
        expressions: expression.expressions.map((item) => generateExpression(item, options)),
        ...loc(expression.span, options.source),
      };
    case "member":
      if (options.ownerName && isBeforeLeaveReference(expression, options.clientBindings))
        return ownerBoundBeforeLeaveValue(expression, options);

      return {
        type: "MemberExpression",
        object: generateExpression(expression.object, options),
        property: generateExpression(expression.property, options),
        computed: expression.computed,
        optional: expression.optional,
        ...loc(expression.span, options.source),
      };
    case "call":
      if (options.ownerName && isBeforeLeaveCall(expression, options.clientBindings)) {
        return call(
          optionsRuntime(options),
          "registerDeparture",
          [
            identifier(options.ownerName, expression.span, options.source),
            ...expression.arguments.map((item) => generateArgument(item, options)),
          ],
          expression.span,
          options.source,
        );
      }

      return {
        type: "CallExpression",
        callee: generateExpression(expression.callee, options),
        arguments: expression.arguments.map((item) => generateArgument(item, options)),
        optional: expression.optional,
        ...loc(expression.span, options.source),
      };
    case "new":
      return {
        type: "NewExpression",
        callee: generateExpression(expression.callee, options),
        arguments: expression.arguments.map((item) => generateArgument(item, options)),
        ...loc(expression.span, options.source),
      };
    case "assignment":
      return {
        type: "AssignmentExpression",
        operator: expression.operator,
        left: generateAssignmentTarget(expression.left, options),
        right: generateExpression(expression.right, options),
        ...loc(expression.span, options.source),
      };
    case "binary":
      return {
        type:
          expression.operator === "&&" ||
          expression.operator === "||" ||
          expression.operator === "??"
            ? "LogicalExpression"
            : "BinaryExpression",
        operator: expression.operator,
        left: generateExpression(expression.left, options),
        right: generateExpression(expression.right, options),
        ...loc(expression.span, options.source),
      };
    case "unary":
      return {
        type:
          expression.kind === "unary" && ["++", "--"].includes(expression.operator)
            ? "UpdateExpression"
            : "UnaryExpression",
        operator: expression.operator,
        argument: generateExpression(expression.argument, options),
        prefix: expression.prefix,
        ...loc(expression.span, options.source),
      };
    case "conditional":
      return {
        type: "ConditionalExpression",
        test: generateExpression(expression.test, options),
        consequent: generateExpression(expression.consequent, options),
        alternate: generateExpression(expression.alternate, options),
        ...loc(expression.span, options.source),
      };
    case "arrow":
      return arrow(
        expression.parameters.map((item) => generatePattern(item, options)),
        generateArrowBody(expression, { ...options, asyncBody: false }),
        expression.span,
        options.source,
        expression.async,
      );
    case "function-expression":
      return generateFunctionExpression(expression, options);
    case "class":
      return {
        type: "ClassExpression",
        id: expression.name ? identifier(expression.name, expression.span, options.source) : null,
        superClass: expression.superClass
          ? generateExpression(expression.superClass, options)
          : null,
        body: generateClassBody(expression.elements, options, {
          type: "Identifier",
          name: "_$",
          ...loc(expression.span, options.source),
        }),
        ...loc(expression.span, options.source),
      };
    case "object":
      return object(
        expression.properties.map((item) => propertyNode(item, options)),
        expression.span,
        options.source,
      );
    case "array":
      return array(
        expression.elements.map((item) => (item ? generateArgument(item, options) : null)),
        expression.span,
        options.source,
      );
  }
}

function generateArgument(
  argument: CanonicalArgument,
  options: IndexedGeneratedOptions,
): GeneratedNode {
  if (argument.kind === "spread")
    return {
      type: "SpreadElement",
      argument: generateExpression(argument.argument, options),
      ...loc(argument.span, options.source),
    };

  return generateExpression(argument, options);
}

function generateImportExpression(
  expression: Extract<CanonicalExpression, { kind: "import-expression" }>,
  options: IndexedGeneratedOptions,
): GeneratedNode {
  const constants = options.finiteImportConstants;

  if (!options.browserTarget || !constants) return generateNativeImport(expression, options);

  const specifiers = enumerateFiniteImportSpecifiers(expression.source, constants);

  if (!specifiers?.length) return generateNativeImport(expression, options);

  const usedNames = options.generatedNames ?? new Set<string>();
  const sourceName = uniqueName("__hesperiaImportSource", usedNames);
  const optionsName = expression.options
    ? uniqueName("__hesperiaImportOptions", usedNames)
    : undefined;
  const errorName = uniqueName("__hesperiaImportError", usedNames);
  const hasAwait =
    containsAwaitExpression(expression.source) ||
    (expression.options !== null && containsAwaitExpression(expression.options));
  const componentOperands = hasAwait && options.asyncBody === true;
  const operandContext = componentOperands
    ? { captures: new Map<"this" | "arguments" | "new.target", string>(), names: usedNames }
    : undefined;
  const operandOptions = {
    ...options,
    asyncBody: componentOperands,
    ...(operandContext ? { importOperandContext: operandContext } : {}),
  };
  const sourceSpan = expression.source.span;
  const sourceDeclaration: GeneratedNode = {
    type: "VariableDeclaration",
    kind: "const",
    declarations: [
      {
        type: "VariableDeclarator",
        id: identifier(sourceName, sourceSpan, options.source),
        init: generateExpression(expression.source, operandOptions),
        ...loc(sourceSpan, options.source),
      },
    ],
    ...loc(sourceSpan, options.source),
  };
  const optionsDeclaration = expression.options
    ? {
        type: "VariableDeclaration",
        kind: "const",
        declarations: [
          {
            type: "VariableDeclarator",
            id: identifier(optionsName!, expression.options.span, options.source),
            init: generateExpression(expression.options, operandOptions),
            ...loc(expression.options.span, options.source),
          },
        ],
        ...loc(expression.options.span, options.source),
      }
    : null;
  const optionsValue = optionsName
    ? identifier(optionsName, expression.options!.span, options.source)
    : null;
  const branches = finiteImportBranches(
    specifiers,
    sourceName,
    optionsValue,
    expression.span,
    options,
  );
  const statements: GeneratedNode[] = [];

  if (hasAwait && !componentOperands) {
    statements.push(sourceDeclaration);

    if (optionsDeclaration) statements.push(optionsDeclaration);

    statements.push({
      type: "ReturnStatement",
      argument: branches,
      ...loc(expression.span, options.source),
    });
  } else {
    statements.push({
      type: "TryStatement",
      block: {
        type: "BlockStatement",
        body: [
          sourceDeclaration,
          ...(optionsDeclaration ? [optionsDeclaration] : []),
          { type: "ReturnStatement", argument: branches, ...loc(expression.span, options.source) },
        ],
        ...loc(expression.span, options.source),
      },
      handler: {
        type: "CatchClause",
        param: identifier(errorName, expression.span, options.source),
        body: {
          type: "BlockStatement",
          body: [
            {
              type: "ReturnStatement",
              argument: rejectedPromise(errorName, expression.span, options),
              ...loc(expression.span, options.source),
            },
          ],
          ...loc(expression.span, options.source),
        },
        ...loc(expression.span, options.source),
      },
      finalizer: null,
      ...loc(expression.span, options.source),
    });
  }

  const captures = [...(operandContext?.captures ?? [])];
  const invocation: GeneratedNode = {
    type: "CallExpression",
    callee: {
      type: componentOperands ? "FunctionExpression" : "ArrowFunctionExpression",
      id: null,
      generator: componentOperands,
      async: hasAwait && !componentOperands,
      expression: false,
      params: captures.map(([, name]) => identifier(name, expression.span, options.source)),
      body: { type: "BlockStatement", body: statements, ...loc(expression.span, options.source) },
      ...loc(expression.span, options.source),
    },
    arguments: captures.map(([capture]) =>
      generateExpression(
        capture === "arguments"
          ? { kind: "identifier", name: "arguments", span: expression.span }
          : { kind: capture === "this" ? "this" : "new-target", span: expression.span },
        options,
      ),
    ),
    optional: false,
    ...loc(expression.span, options.source),
  };
  return componentOperands
    ? {
        type: "YieldExpression",
        argument: invocation,
        delegate: true,
        ...loc(expression.span, options.source),
      }
    : invocation;
}

function importOperandCapture(
  capture: "this" | "arguments" | "new.target",
  span: SourceSpan,
  options: IndexedGeneratedOptions,
): GeneratedNode {
  const context = options.importOperandContext!;
  let name = context.captures.get(capture);

  if (!name) {
    name = uniqueName(`__hesperiaImport_${capture.replace(".", "_")}`, context.names);

    context.captures.set(capture, name);
  }

  return identifier(name, span, options.source);
}

function generateNativeImport(
  expression: Extract<CanonicalExpression, { kind: "import-expression" }>,
  options: IndexedGeneratedOptions,
): GeneratedNode {
  return {
    type: "ImportExpression",
    source: generateExpression(expression.source, options),
    options: expression.options ? generateExpression(expression.options, options) : null,
    phase: null,
    ...loc(expression.span, options.source),
  };
}

function finiteImportBranches(
  specifiers: readonly string[],
  sourceName: string,
  optionsValue: GeneratedNode | null,
  span: SourceSpan,
  options: IndexedGeneratedOptions,
): GeneratedNode {
  const fallback = rejectedPromiseWithMessage(
    "Dynamic import source escaped its finite target set.",
    span,
    options,
  );
  let alternate = fallback;

  for (let index = specifiers.length - 1; index >= 0; index--) {
    const specifier = specifiers[index]!;
    alternate = {
      type: "ConditionalExpression",
      test: {
        type: "BinaryExpression",
        operator: "===",
        left: identifier(sourceName, span, options.source),
        right: literal(specifier, span, options.source),
        ...loc(span, options.source),
      },
      consequent: {
        type: "ImportExpression",
        source: literal(specifier, span, options.source),
        options: optionsValue,
        phase: null,
        ...loc(span, options.source),
      },
      alternate,
      ...loc(span, options.source),
    };
  }

  return alternate;
}

function rejectedPromise(
  errorName: string,
  span: SourceSpan,
  options: IndexedGeneratedOptions,
): GeneratedNode {
  return {
    type: "CallExpression",
    callee: {
      type: "ArrowFunctionExpression",
      id: null,
      generator: false,
      async: true,
      expression: false,
      params: [],
      body: {
        type: "BlockStatement",
        body: [
          {
            type: "ThrowStatement",
            argument: identifier(errorName, span, options.source),
            ...loc(span, options.source),
          },
        ],
        ...loc(span, options.source),
      },
      ...loc(span, options.source),
    },
    arguments: [],
    optional: false,
    ...loc(span, options.source),
  };
}

function rejectedPromiseWithMessage(
  message: string,
  span: SourceSpan,
  options: IndexedGeneratedOptions,
): GeneratedNode {
  return {
    type: "CallExpression",
    callee: {
      type: "ArrowFunctionExpression",
      id: null,
      generator: false,
      async: true,
      expression: false,
      params: [],
      body: {
        type: "BlockStatement",
        body: [
          {
            type: "ThrowStatement",
            argument: {
              type: "NewExpression",
              callee: identifier("TypeError", span, options.source),
              arguments: [literal(message, span, options.source)],
              ...loc(span, options.source),
            },
            ...loc(span, options.source),
          },
        ],
        ...loc(span, options.source),
      },
      ...loc(span, options.source),
    },
    arguments: [],
    optional: false,
    ...loc(span, options.source),
  };
}

function containsAwaitExpression(value: CanonicalExpression): boolean {
  if (value.kind === "await") return true;

  if (value.kind === "yield")
    return value.expression ? containsAwaitExpression(value.expression) : false;

  if (value.kind === "arrow" || value.kind === "function-expression") return false;

  if (value.kind === "template") return value.expressions.some(containsAwaitExpression);

  if (value.kind === "sequence") return value.expressions.some(containsAwaitExpression);

  if (value.kind === "member")
    return (
      containsAwaitExpression(value.object) ||
      (value.computed && containsAwaitExpression(value.property))
    );

  if (value.kind === "call" || value.kind === "new")
    return (
      containsAwaitExpression(value.callee) ||
      value.arguments.some((item) =>
        containsAwaitExpression(item.kind === "spread" ? item.argument : item),
      )
    );

  if (value.kind === "assignment" || value.kind === "binary")
    return containsAwaitExpression(value.left) || containsAwaitExpression(value.right);

  if (value.kind === "unary") return containsAwaitExpression(value.argument);

  if (value.kind === "conditional")
    return (
      containsAwaitExpression(value.test) ||
      containsAwaitExpression(value.consequent) ||
      containsAwaitExpression(value.alternate)
    );

  if (value.kind === "object")
    return value.properties.some((item) =>
      item.kind === "spread"
        ? containsAwaitExpression(item.argument)
        : (item.computed && typeof item.key !== "string" && containsAwaitExpression(item.key)) ||
          containsAwaitExpression(item.value),
    );

  if (value.kind === "array")
    return value.elements.some(
      (item) =>
        item !== null && containsAwaitExpression(item.kind === "spread" ? item.argument : item),
    );

  return false;
}

function generateAssignmentTarget(
  expression: CanonicalExpression,
  options: IndexedGeneratedOptions,
): GeneratedNode {
  if (expression.kind !== "identifier" && expression.kind !== "member")
    return generateExpression(expression, options);

  if (expression.kind === "identifier") {
    const alias = expression.referenceId
      ? options.bindingAliases?.get(expression.referenceId)
      : undefined;
    return identifier(alias ?? expression.name, expression.span, options.source);
  }

  return {
    type: "MemberExpression",
    object: generateExpression(expression.object, options),
    property: generateExpression(expression.property, options),
    computed: expression.computed,
    optional: false,
    ...loc(expression.span, options.source),
  };
}

function isBeforeLeaveCall(
  expression: Extract<CanonicalExpression, { kind: "call" }>,
  bindings: ReadonlyMap<string, ClientBinding>,
): boolean {
  return isBeforeLeaveReference(expression.callee, bindings);
}

function isBeforeLeaveReference(
  expression: CanonicalExpression,
  bindings: ReadonlyMap<string, ClientBinding>,
): boolean {
  if (expression.kind === "identifier" && expression.referenceId)
    return bindings.get(expression.referenceId)?.kind === "navigation-marker";

  if (
    expression.kind !== "member" ||
    expression.computed ||
    expression.property.kind !== "identifier" ||
    expression.property.name !== "beforeLeave"
  )
    return false;

  const namespace = expression.object;
  return (
    namespace.kind === "identifier" &&
    namespace.referenceId !== undefined &&
    bindings.get(namespace.referenceId)?.kind === "navigation-namespace"
  );
}

function ownerBoundBeforeLeaveValue(
  expression: CanonicalExpression,
  options: IndexedGeneratedOptions,
): GeneratedNode {
  const checkName = "__hesperiaDepartureCheck";
  const check = identifier(checkName, expression.span, options.source);
  return arrow(
    [check],
    call(
      optionsRuntime(options),
      "registerDeparture",
      [
        identifier(options.ownerName ?? "owner", expression.span, options.source),
        identifier(checkName, expression.span, options.source),
      ],
      expression.span,
      options.source,
    ),
    expression.span,
    options.source,
  );
}

function propertyNode(
  propertyValue: CanonicalProperty,
  options: IndexedGeneratedOptions,
): GeneratedNode {
  if (propertyValue.kind === "spread")
    return {
      type: "SpreadElement",
      argument: generateExpression(propertyValue.argument, options),
      ...loc(propertyValue.span, options.source),
    };

  const value = generateExpression(
    propertyValue.value,
    propertyValue.method === true ? { ...options, asyncBody: false } : options,
  );
  const result = property(
    typeof propertyValue.key === "string" ? propertyValue.key : "",
    value,
    propertyValue.span,
    options.source,
  );
  const withKey =
    typeof propertyValue.key === "string"
      ? result
      : {
          ...result,
          key: generateExpression(propertyValue.key, options),
          computed: propertyValue.computed,
        };
  return {
    ...withKey,
    kind: propertyValue.propertyKind ?? "init",
    method: propertyValue.method === true,
  };
}

function generateFunctionExpression(
  expression: Extract<CanonicalExpression, { kind: "function-expression" }>,
  options: IndexedGeneratedOptions,
): GeneratedNode {
  const functionOptions = { ...options, asyncBody: false, importOperandContext: undefined };
  return {
    type: "FunctionExpression",
    id:
      expression.name === null
        ? null
        : identifier(expression.name, expression.span, options.source),
    generator: expression.generator,
    async: expression.async,
    expression: false,
    params: expression.parameters.map((item) => generatePattern(item, functionOptions)),
    body: block(expression.body, functionOptions, optionsRuntime(options)),
    ...loc(expression.span, options.source),
  };
}

function generateArrowBody(
  value: Extract<CanonicalExpression, { kind: "arrow" }>,
  options: IndexedGeneratedOptions,
): GeneratedNode {
  if (!value.expressionBody)
    return block(value.body as CanonicalStatementBlock, options, optionsRuntime(options));

  if (isCanonicalChild(value.body))
    return generateChild(value.body, options, runtimeOwner(options, value.span));

  return generateExpression(value.body as CanonicalExpression, options);
}

function generateArrowComponent(
  value: Extract<CanonicalExpression, { kind: "arrow" }>,
  options: IndexedGeneratedOptions,
): GeneratedNode {
  return generateComponentExpression(value, options);
}

function generateFunctionExpressionComponent(
  value: Extract<CanonicalExpression, { kind: "function-expression" }>,
  options: IndexedGeneratedOptions,
): GeneratedNode {
  return generateComponentExpression(value, options);
}

function generateComponentValue(
  expression: CanonicalExpression,
  options: IndexedGeneratedOptions,
): GeneratedNode | undefined {
  if (!componentFactoryExpression(expression)) return;

  const lowerFinal = (value: CanonicalExpression): GeneratedNode => {
    if (value.kind === "sequence") {
      const finalIndex = value.expressions.length - 1;
      return {
        type: "SequenceExpression",
        expressions: value.expressions.map((item, index) =>
          index === finalIndex ? lowerFinal(item) : generateExpression(item, options),
        ),
        ...loc(value.span, options.source),
      };
    }

    if (isComponentArrow(value)) return generateArrowComponent(value, options);

    if (isComponentFunctionExpression(value))
      return generateFunctionExpressionComponent(value, options);

    return generateExpression(value, options);
  };

  return lowerFinal(expression);
}

type ComponentExpression =
  | Extract<CanonicalExpression, { kind: "arrow" }>
  | Extract<CanonicalExpression, { kind: "function-expression" }>;

function generateComponentExpression(
  value: ComponentExpression,
  options: IndexedGeneratedOptions,
): GeneratedNode {
  const usedNames = collectNames(value);
  const ownerName = uniqueName("owner", usedNames);
  const owner = identifier(ownerName, value.span, options.source);
  const selfName =
    value.kind === "function-expression" && value.name !== null
      ? uniqueName("__component", usedNames)
      : undefined;
  const bindingAliases = new Map(options.bindingAliases ?? []);

  if (value.kind === "function-expression" && selfName && value.nameBindingId)
    bindingAliases.set(value.nameBindingId, selfName);

  const clientCapability = generateClientCapability(
    options.clientBindings,
    ownerName,
    usedNames,
    value.span,
    options,
    optionsRuntime(options),
  );
  const clients = clientCapability?.declarations ?? [];
  const bodyOptions: IndexedGeneratedOptions = {
    ...options,
    asyncBody: value.async,
    nativeFactories: new Map<string, GeneratedNode>(),
    nativeFactoryDeclarations: [],
    ownerName,
    clientCapabilityName: clientCapability?.name,
    ...(bindingAliases.size ? { bindingAliases } : {}),
  };
  const generatedStatements =
    value.kind === "arrow" && value.expressionBody
      ? [
          returnStatement(
            isCanonicalChild(value.body)
              ? generateChild(value.body, bodyOptions, owner)
              : generateExpression(value.body as CanonicalExpression, bodyOptions),
            value.span,
            options.source,
          ),
        ]
      : ((block(value.body as CanonicalStatementBlock, bodyOptions, optionsRuntime(options))
          .body as GeneratedNode[]) ?? []);
  const body = {
    type: "BlockStatement",
    body: [
      ...(!value.async
        ? styleOwnerBinding(
            owner,
            value.span,
            options,
            options.styleComponentName ??
              (value.kind === "function-expression" ? (value.name ?? undefined) : undefined),
          )
        : []),
      ...clients,
      ...(bodyOptions.nativeFactoryDeclarations ?? []),
      ...generatedStatements,
    ],
    ...loc(value.span, options.source),
  };
  const factoryBody = value.async
    ? call(
        optionsRuntime(options),
        "runAsyncBody",
        [
          owner,
          {
            type: "FunctionExpression",
            id: null,
            generator: true,
            async: false,
            expression: false,
            params: [],
            body,
            ...loc(value.span, options.source),
          },
        ],
        value.span,
        options.source,
      )
    : body;
  const definition = projectPolicyDefinition(
    call(
      optionsRuntime(options),
      "defineComponent",
      [
        {
          type: "ArrowFunctionExpression",
          id: null,
          generator: false,
          async: false,
          expression: false,
          params: [
            owner,
            ...value.parameters.map((item) =>
              generatePattern(item, {
                ...options,
                bindingAliases,
                ownerName,
                clientCapabilityName: clientCapability?.name,
                clientCapabilityInline: true,
              }),
            ),
          ],
          body: value.async
            ? {
                type: "BlockStatement",
                body: [
                  ...styleOwnerBinding(
                    owner,
                    value.span,
                    options,
                    options.styleComponentName ??
                      (value.kind === "function-expression"
                        ? (value.name ?? undefined)
                        : undefined),
                  ),
                  returnStatement(factoryBody, value.span, options.source),
                ],
                ...loc(value.span, options.source),
              }
            : factoryBody,
          ...loc(value.span, options.source),
        },
        ...componentOptions(value.props, value.async, value.span, options),
      ],
      value.span,
      options.source,
    ),
    options,
    value.span,
  );

  if (!selfName) return definition;

  const self = identifier(selfName, value.span, options.source);
  const defineSelf: GeneratedNode = {
    type: "VariableDeclaration",
    kind: "const",
    declarations: [
      {
        type: "VariableDeclarator",
        id: self,
        init: definition,
        ...loc(value.span, options.source),
      },
    ],
    ...loc(value.span, options.source),
  };
  const factory = arrow(
    [],
    {
      type: "BlockStatement",
      body: [defineSelf, returnStatement(self, value.span, options.source)],
      ...loc(value.span, options.source),
    },
    value.span,
    options.source,
  );
  return {
    type: "CallExpression",
    callee: factory,
    arguments: [],
    optional: false,
    ...loc(value.span, options.source),
  };
}

function optionsRuntime(options: IndexedGeneratedOptions): GeneratedNode {
  return identifier("_$", emptySpan(), options.source);
}

function projectPolicyDefinition(
  definition: GeneratedNode,
  options: IndexedGeneratedOptions,
  span: SourceSpan,
): GeneratedNode {
  const policy = options.allowUnsafeEmbed
    ? call(
        optionsRuntime(options),
        "registerProjectPolicy",
        [
          definition,
          object(
            [
              property(
                "allowUnsafeEmbed",
                literal(true, span, options.source),
                span,
                options.source,
              ),
            ],
            span,
            options.source,
          ),
        ],
        span,
        options.source,
      )
    : definition;

  if (!options.styleRuntimeName || !options.styleEntryId) return policy;

  const local = identifier("__definition", span, options.source);
  return {
    type: "CallExpression",
    callee: arrow(
      [local],
      {
        type: "BlockStatement",
        body: [
          {
            type: "ExpressionStatement",
            expression: call(
              styleRuntime(options),
              "bindEntry",
              [local, literal(options.styleEntryId, span, options.source)],
              span,
              options.source,
            ),
          },
          returnStatement(local, span, options.source),
        ],
      },
      span,
      options.source,
    ),
    arguments: [policy],
    optional: false,
    ...loc(span, options.source),
  };
}

function styleRuntime(options: IndexedGeneratedOptions): GeneratedNode {
  if (!options.styleRuntimeName) throw new TypeError("Missing generated style runtime name");

  return {
    type: "MemberExpression",
    object: identifier(options.styleRuntimeName, emptySpan(), options.source),
    property: identifier("styles", emptySpan(), options.source),
    computed: false,
    optional: false,
  };
}

function styleOwnerBinding(
  owner: GeneratedNode,
  span: SourceSpan,
  options: IndexedGeneratedOptions,
  name?: string,
): GeneratedNode[] {
  const ownerId = `${options.styleIdentity ?? options.filename}#${span.start}`;

  options.styleOwners?.set(ownerId, name);

  if (!options.styleRuntimeName) return [];

  return [
    {
      type: "ExpressionStatement",
      expression: call(
        styleRuntime(options),
        "bindStyles",
        [owner, literal(ownerId, span, options.source)],
        span,
        options.source,
      ),
      ...loc(span, options.source),
    },
  ];
}

function componentOptions(
  propsSchema: Readonly<Record<string, import("hesperia/runtime").PropSchema>> | undefined,
  async: boolean,
  span: SourceSpan,
  options: IndexedGeneratedOptions,
): GeneratedNode[] {
  const entries: GeneratedNode[] = [];

  if (async)
    entries.push(property("async", literal(true, span, options.source), span, options.source));

  if (propsSchema) {
    entries.push(
      property(
        "props",
        object(
          Object.entries(propsSchema).map(([name, schema]) =>
            ownProperty(
              name,
              object(
                [
                  property(
                    "kind",
                    literal(schema.kind, span, options.source),
                    span,
                    options.source,
                  ),
                  property(
                    "optional",
                    literal(schema.optional, span, options.source),
                    span,
                    options.source,
                  ),
                ],
                span,
                options.source,
              ),
              span,
              options.source,
            ),
          ),
          span,
          options.source,
        ),
        span,
        options.source,
      ),
    );
  }

  return entries.length ? [object(entries, span, options.source)] : [];
}

function runtimeOwner(options: IndexedGeneratedOptions, sourceSpan: SourceSpan): GeneratedNode {
  return identifier(options.ownerName ?? "owner", sourceSpan, options.source);
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

function collectNames(value: unknown, names = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) collectNames(item, names);

    return names;
  }

  if (typeof value !== "object" || value === null) return names;

  const record = value as Record<string, unknown>;

  if (record.kind === "identifier" && typeof record.name === "string") names.add(record.name);

  for (const item of Object.values(record)) collectNames(item, names);

  return names;
}

function uniqueName(base: string, used: Set<string>): string {
  let name = base;
  let suffix = 0;

  while (used.has(name)) name = `${base}_${++suffix}`;

  used.add(name);

  return name;
}

function generateClientCapability(
  bindings: ReadonlyMap<string, ClientBinding>,
  ownerName: string,
  usedNames: Set<string>,
  sourceSpan: SourceSpan,
  options: IndexedGeneratedOptions,
  runtime: GeneratedNode,
): { readonly name: string; readonly declarations: readonly GeneratedNode[] } | null {
  if (
    ![...bindings.values()].some(
      (binding) => binding.kind === "namespace" || binding.kind === "operation",
    )
  )
    return null;

  const capabilityName = uniqueName("__client", usedNames);
  return {
    name: capabilityName,
    declarations: [
      {
        type: "VariableDeclaration",
        kind: "const",
        declarations: [
          {
            type: "VariableDeclarator",
            id: identifier(capabilityName, sourceSpan, options.source),
            init: call(
              runtime,
              "createClient",
              [identifier(ownerName, sourceSpan, options.source)],
              sourceSpan,
              options.source,
            ),
            ...loc(sourceSpan, options.source),
          },
        ],
        ...loc(sourceSpan, options.source),
      },
    ],
  };
}

function call(
  objectNode: GeneratedNode,
  name: string,
  args: readonly GeneratedNode[],
  sourceSpan: SourceSpan,
  source: SourcePositions,
): GeneratedNode {
  return {
    type: "CallExpression",
    callee: {
      type: "MemberExpression",
      object: objectNode,
      property: identifier(name, sourceSpan, source),
      computed: false,
      optional: false,
    },
    arguments: args,
    optional: false,
    ...loc(sourceSpan, source),
  };
}

function arrow(
  params: readonly GeneratedNode[],
  body: GeneratedNode,
  sourceSpan: SourceSpan,
  source: SourcePositions,
  async = false,
): GeneratedNode {
  return {
    type: "ArrowFunctionExpression",
    id: null,
    generator: false,
    async,
    expression: body.type !== "BlockStatement",
    params,
    body,
    ...loc(sourceSpan, source),
  };
}

function array(
  elements: readonly (GeneratedNode | null)[],
  sourceSpan: SourceSpan,
  source: SourcePositions,
): GeneratedNode {
  return { type: "ArrayExpression", elements, ...loc(sourceSpan, source) };
}

function object(
  properties: readonly GeneratedNode[],
  sourceSpan: SourceSpan,
  source: SourcePositions,
): GeneratedNode {
  return { type: "ObjectExpression", properties, ...loc(sourceSpan, source) };
}

function property(
  name: string,
  value: GeneratedNode,
  sourceSpan: SourceSpan,
  source: SourcePositions,
): GeneratedNode {
  return {
    type: "Property",
    key: /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name)
      ? identifier(name, sourceSpan, source)
      : literal(name, sourceSpan, source),
    value,
    kind: "init",
    method: false,
    shorthand: false,
    computed: false,
    ...loc(sourceSpan, source),
  };
}

function ownProperty(
  name: string,
  value: GeneratedNode,
  sourceSpan: SourceSpan,
  source: SourcePositions,
): GeneratedNode {
  const result = property(name, value, sourceSpan, source);
  return name === "__proto__"
    ? { ...result, computed: true, key: literal(name, sourceSpan, source) }
    : result;
}

function literal(
  value: string | number | boolean | null,
  sourceSpan: SourceSpan,
  source: SourcePositions,
): GeneratedNode {
  return {
    type: "Literal",
    value,
    raw: typeof value === "string" ? JSON.stringify(value) : String(value),
    ...loc(sourceSpan, source),
  };
}

function identifier(name: string, sourceSpan: SourceSpan, source: SourcePositions): GeneratedNode {
  return { type: "Identifier", name, ...loc(sourceSpan, source) };
}

function exportNameNode(
  name: string,
  sourceSpan: SourceSpan,
  source: SourcePositions,
): GeneratedNode {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name)
    ? identifier(name, sourceSpan, source)
    : literal(name, sourceSpan, source);
}

function generatePattern(
  pattern: CanonicalPattern,
  options: IndexedGeneratedOptions,
): GeneratedNode {
  if (pattern.kind === "identifier") return identifier(pattern.name, pattern.span, options.source);

  if (pattern.kind === "rest")
    return {
      type: "RestElement",
      argument: generatePattern(pattern.argument, options),
      ...loc(pattern.span, options.source),
    };

  if (pattern.kind === "default")
    return {
      type: "AssignmentPattern",
      left: generatePattern(pattern.left, options),
      right: generateExpression(pattern.right, options),
      ...loc(pattern.span, options.source),
    };

  if (pattern.kind === "array")
    return array(
      pattern.elements.map((item) => (item ? generatePattern(item, options) : null)),
      pattern.span,
      options.source,
    );

  const properties: GeneratedNode[] = pattern.properties.map((item) =>
    property(item.key, generatePattern(item.value, options), item.span, options.source),
  );

  if (pattern.rest)
    properties.push({
      type: "RestElement",
      argument: generatePattern(pattern.rest, options),
      ...loc(pattern.rest.span, options.source),
    });

  return object(properties, pattern.span, options.source);
}

function importNamespace(namespace: GeneratedNode, source: string): GeneratedNode {
  return {
    type: "ImportDeclaration",
    specifiers: [{ type: "ImportNamespaceSpecifier", local: namespace }],
    source: literal(source, emptySpan(), EMPTY_SOURCE_POSITIONS),
    phase: null,
    attributes: [],
  };
}

function createSourcePositions(source: string): SourcePositions {
  const lineStarts = [0];

  for (let index = 0; index < source.length; index++) {
    const code = source.charCodeAt(index);

    if (code === 13) {
      if (source.charCodeAt(index + 1) === 10) index++;

      lineStarts.push(index + 1);
    } else if (code === 10) {
      lineStarts.push(index + 1);
    }
  }

  return { source, lineStarts };
}

function loc(
  sourceSpan: SourceSpan,
  source: SourcePositions,
): { loc: { start: Position; end: Position } } {
  return {
    loc: { start: position(sourceSpan.start, source), end: position(sourceSpan.end, source) },
  };
}

function position(offset: number, positions: SourcePositions): Position {
  const requestedEnd = Math.max(0, offset);
  const end = Number.isNaN(requestedEnd)
    ? 0
    : Math.min(positions.source.length, Math.trunc(requestedEnd));

  if (
    end > 0 &&
    end < positions.source.length &&
    positions.source.charCodeAt(end - 1) === 13 &&
    positions.source.charCodeAt(end) === 10
  ) {
    return { line: lineStartIndexAtOrBefore(positions.lineStarts, end - 1) + 2, column: 0 };
  }

  const lineIndex = lineStartIndexAtOrBefore(positions.lineStarts, end);
  return { line: lineIndex + 1, column: end - positions.lineStarts[lineIndex]! };
}

function lineStartIndexAtOrBefore(lineStarts: readonly number[], offset: number): number {
  let low = 0;
  let high = lineStarts.length;

  while (low < high) {
    const middle = Math.floor((low + high) / 2);

    if (lineStarts[middle]! <= offset) low = middle + 1;
    else high = middle;
  }

  return low - 1;
}

function emptySpan(): SourceSpan {
  return { start: 0, end: 0 };
}
