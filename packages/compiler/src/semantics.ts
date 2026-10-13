import { componentFactoryExpression, isComponentBody } from "./component-analysis.ts";
import {
  isCanonicalChild,
  type CanonicalModule,
  type CanonicalPattern,
  type CanonicalStatement,
} from "./ir.ts";

/** Resolved module facts shared by checking, generation, and editor projections. */
export interface ModuleSemantics {
  /** Source identity retained from the canonical module. */
  readonly filename: string;
  /** Local import names mapped to their authored module specifiers. */
  readonly imports: ReadonlyMap<string, string>;
  /** Declaration names collected outside function bodies, including statement blocks. */
  readonly declarations: ReadonlySet<string>;
  /** Explicit exported names; star exports are resolved by dependency analysis. */
  readonly exports: ReadonlySet<string>;
  /** Declaration names recognized as components in this module's statement tree. */
  readonly components: ReadonlySet<string>;
}

/** Build immutable semantic facts from one canonical module snapshot. */
export function resolveModuleSemantics(module: CanonicalModule): ModuleSemantics {
  const imports = new Map<string, string>();
  const declarations = new Set<string>();
  const exports = new Set<string>();
  const components = new Set<string>();

  for (const item of module.body) collect(item, false, imports, declarations, exports, components);

  return { filename: module.filename, imports, declarations, exports, components };
}

function collect(
  statement: CanonicalStatement,
  exported: boolean,
  imports: Map<string, string>,
  declarations: Set<string>,
  exports: Set<string>,
  components: Set<string>,
): void {
  switch (statement.kind) {
    case "switch":
      for (const branch of statement.cases)
        for (const child of branch.consequent)
          collect(child, false, imports, declarations, exports, components);

      return;
    case "class":
      declarations.add(statement.name);

      if (exported) exports.add(statement.name);

      return;
    case "try":
      collect(statement.body, false, imports, declarations, exports, components);

      if (statement.handler)
        collect(statement.handler.body, false, imports, declarations, exports, components);

      if (statement.finalizer)
        collect(statement.finalizer, false, imports, declarations, exports, components);

      return;
    case "import":
      for (const specifier of statement.specifiers) imports.set(specifier.local, statement.source);

      return;
    case "function":
      declarations.add(statement.name);

      if (exported) exports.add(statement.name);

      if (
        !statement.generator &&
        (statement.component === true ||
          statement.props !== undefined ||
          isComponentBody(statement.body))
      )
        components.add(statement.name);

      return;
    case "variable":
      for (const declaration of statement.declarations) {
        for (const name of patternNames(declaration.pattern)) declarations.add(name);

        if (
          declaration.initializer &&
          !isCanonicalChild(declaration.initializer) &&
          componentFactoryExpression(declaration.initializer)
        )
          for (const name of patternNames(declaration.pattern)) components.add(name);
      }

      return;
    case "export":
      collect(statement.declaration, false, imports, declarations, exports, components);

      for (const binding of statement.exportedBindings ?? []) exports.add(binding.exported);

      if (statement.exportKind === "default" && !statement.exportedBindings?.length)
        exports.add("default");

      return;
    case "export-list":
      for (const specifier of statement.specifiers) exports.add(specifier.exported);

      return;
    case "export-all":
      if (statement.exported !== null) exports.add(statement.exported);

      return;
    case "block":
      for (const child of statement.body)
        collect(child, false, imports, declarations, exports, components);

      return;
    case "if":
      collect(statement.consequent, false, imports, declarations, exports, components);

      if (statement.alternate)
        collect(statement.alternate, false, imports, declarations, exports, components);

      return;
    case "return":
    case "expression":
    case "throw":
    case "break":
    case "continue":
      return;
    case "for":
      if (statement.init?.kind === "variable")
        collect(statement.init, false, imports, declarations, exports, components);

      collect(statement.body, false, imports, declarations, exports, components);

      return;
    case "for-of":
    case "for-in":
      if (statement.left.kind === "declaration")
        for (const name of patternNames(statement.left.pattern)) declarations.add(name);

      collect(statement.body, false, imports, declarations, exports, components);

      return;
    case "while":
    case "do-while":
    case "labeled":
      collect(statement.body, false, imports, declarations, exports, components);

      return;
  }
}

function patternNames(pattern: CanonicalPattern): readonly string[] {
  if (pattern.kind === "identifier") return [pattern.name];

  if (pattern.kind === "rest") return patternNames(pattern.argument);

  if (pattern.kind === "default") return patternNames(pattern.left);

  if (pattern.kind === "array")
    return pattern.elements.flatMap((item) => (item ? patternNames(item) : []));

  return [
    ...pattern.properties.flatMap((item) => patternNames(item.value)),
    ...(pattern.rest ? patternNames(pattern.rest) : []),
  ];
}
