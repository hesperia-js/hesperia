/**
 * A half-open range measured in JavaScript string offsets (UTF-16 code units).
 * The producing API determines which source the range addresses: canonical
 * nodes use the parsed source, while compile-result diagnostics and debug spans
 * map back to authored source. Locations never contribute to semantic identity.
 */
export interface SourceSpan {
  /** Inclusive offset in the source associated with this span. */
  readonly start: number;
  /** Exclusive offset in the same source. */
  readonly end: number;
}

/** A diagnostic produced while parsing, checking, or lowering one module. */
export interface CompilerDiagnostic {
  /** Machine-readable diagnostic identifier, suitable for filtering editor results. */
  readonly code: string;
  /** Errors prevent executable emission; warnings and information do not. */
  readonly severity: "error" | "warning" | "info";
  /** Human-readable explanation of the rejected construct or reported condition. */
  readonly message: string;
  /** Location in the producing stage's source; compile results map it to authored source. */
  readonly span?: SourceSpan;
}

/** Schema version of Hesperia's canonical intermediate representation (IR). */
export const HESPERIA_IR_VERSION = 1 as const;

/** Debug-only source map for canonical nodes; semantic encoding excludes it. */
export interface CanonicalDebugSidecar {
  /** Canonical schema version required to interpret the node identifiers. */
  readonly version: typeof HESPERIA_IR_VERSION;
  /**
   * Locations keyed by deterministic traversal IDs such as `n000000`. These
   * identify nodes in this snapshot, not declarations or persistent editor IDs.
   */
  readonly spans: Readonly<Record<string, SourceSpan>>;
}

/**
 * A serializable JavaScript expression understood by the supported compiler profile.
 * `kind` selects the expression form; child arrays preserve evaluation order.
 * Identifier spellings support emission, while resolved IDs distinguish lexical
 * declarations even when two scopes use the same name. See {@link CanonicalModule}
 * for source-location and identity conventions shared by canonical nodes.
 */
export type CanonicalExpression =
  | {
      readonly kind: "identifier";
      /** Source spelling; a non-computed property name does not resolve as a variable read. */
      readonly name: string;
      /** Declaration identity when this identifier introduces a binding. */
      readonly bindingId?: string;
      /** Referenced declaration, or `unresolved/<name>` for a name outside the lexical scopes. */
      readonly referenceId?: string;
      readonly span: SourceSpan;
    }
  | {
      readonly kind: "literal";
      readonly value: string | number | boolean | null;
      readonly span: SourceSpan;
    }
  | {
      /** A native regular expression represented by source pattern and flags. */
      readonly kind: "regexp";
      /** Source pattern without delimiter slashes. */
      readonly pattern: string;
      /** Native regular expression flags in authored order. */
      readonly flags: string;
      readonly span: SourceSpan;
    }
  | {
      /** A native bigint represented by its source digit text. */
      readonly kind: "bigint";
      /** Digits and radix prefix without the trailing `n`. */
      readonly value: string;
      readonly span: SourceSpan;
    }
  | { readonly kind: "undefined"; readonly span: SourceSpan }
  | { readonly kind: "this"; readonly span: SourceSpan }
  | { readonly kind: "super"; readonly span: SourceSpan }
  | {
      /** The `new.target` meta property, retained as explicit native meaning. */
      readonly kind: "new-target";
      readonly span: SourceSpan;
    }
  | { readonly kind: "import-meta"; readonly span: SourceSpan }
  | {
      /** A private class name; `bindingId` is assigned within its declaring class. */
      readonly kind: "private";
      readonly name: string;
      readonly bindingId?: string;
      readonly span: SourceSpan;
    }
  | {
      readonly kind: "template";
      /** Raw and cooked template segments preserve native escape semantics. */
      readonly quasis: readonly CanonicalTemplateQuasi[];
      /** Interpolations are evaluated left-to-right between the quasis. */
      readonly expressions: readonly CanonicalExpression[];
      readonly span: SourceSpan;
    }
  | {
      /** A native comma expression; operands run left-to-right and the last value is returned. */
      readonly kind: "sequence";
      readonly expressions: readonly CanonicalExpression[];
      readonly span: SourceSpan;
    }
  | { readonly kind: "await"; readonly expression: CanonicalExpression; readonly span: SourceSpan }
  | {
      /** A native generator suspension. The operand is evaluated when iteration reaches it. */
      readonly kind: "yield";
      /** `null` preserves a bare `yield`; delegate preserves native `yield*`. */
      readonly expression: CanonicalExpression | null;
      readonly delegate: boolean;
      readonly span: SourceSpan;
    }
  | {
      readonly kind: "member";
      readonly object: CanonicalExpression;
      /** Evaluated as a key only when computed; otherwise a literal property or private name. */
      readonly property: CanonicalExpression;
      /** True for bracket access; false for dot or private-name access. */
      readonly computed: boolean;
      /** This access uses optional chaining; it does not make the whole expression optional. */
      readonly optional: boolean;
      readonly span: SourceSpan;
    }
  | {
      readonly kind: "call";
      readonly callee: CanonicalExpression;
      readonly arguments: readonly CanonicalArgument[];
      readonly optional: boolean;
      readonly span: SourceSpan;
    }
  | {
      /** A native dynamic import; source and import options retain authored evaluation order. */
      readonly kind: "import-expression";
      /** Module specifier expression evaluated by native dynamic import. */
      readonly source: CanonicalExpression;
      /** Import attributes/options expression, or `null` when omitted. */
      readonly options: CanonicalExpression | null;
      readonly span: SourceSpan;
    }
  | {
      readonly kind: "new";
      /** Constructor expression; generated with native `new` semantics. */
      readonly callee: CanonicalExpression;
      /** Arguments are evaluated left-to-right before construction. */
      readonly arguments: readonly CanonicalArgument[];
      readonly span: SourceSpan;
    }
  | {
      /** Native assignment expression, including compound and logical assignment. */
      readonly kind: "assignment";
      readonly operator: string;
      readonly left: CanonicalExpression;
      readonly right: CanonicalExpression;
      readonly span: SourceSpan;
    }
  | {
      readonly kind: "binary";
      readonly operator: string;
      readonly left: CanonicalExpression;
      readonly right: CanonicalExpression;
      readonly span: SourceSpan;
    }
  | {
      readonly kind: "unary";
      readonly operator: string;
      readonly argument: CanonicalExpression;
      readonly prefix: boolean;
      readonly span: SourceSpan;
    }
  | {
      readonly kind: "conditional";
      readonly test: CanonicalExpression;
      readonly consequent: CanonicalExpression;
      readonly alternate: CanonicalExpression;
      readonly span: SourceSpan;
    }
  | {
      readonly kind: "arrow";
      /** Trusted component role supplied by conventional route or checker metadata. */
      readonly component?: boolean;
      /** Native-checker prop contract attached after authored type checking. */
      readonly props?: Readonly<Record<string, import("hesperia/runtime").PropSchema>>;
      readonly parameters: readonly CanonicalPattern[];
      readonly body: CanonicalExpression | CanonicalChild | CanonicalStatementBlock;
      readonly expressionBody: boolean;
      readonly async: boolean;
      readonly span: SourceSpan;
    }
  | {
      readonly kind: "function-expression";
      /** Local self-reference spelling, or null for an anonymous function. */
      readonly name: string | null;
      /** Identity of the name visible inside this function, separate from any outer assignment. */
      readonly nameBindingId?: string;
      /** Trusted component role supplied by conventional route or checker metadata. */
      readonly component?: boolean;
      /** Native-checker prop contract attached after authored type checking. */
      readonly props?: Readonly<Record<string, import("hesperia/runtime").PropSchema>>;
      readonly parameters: readonly CanonicalPattern[];
      readonly body: CanonicalStatementBlock;
      readonly async: boolean;
      /** Native generator functions remain ordinary functions, never component factories. */
      readonly generator: boolean;
      readonly span: SourceSpan;
    }
  | {
      /** A native class expression with definition-time heritage and keys. */
      readonly kind: "class";
      /** Local class spelling, or null for an anonymous class expression. */
      readonly name: string | null;
      /** Identity of the class expression's self-reference in its class scope. */
      readonly nameBindingId?: string;
      /** Heritage expression evaluated during class definition, or null without `extends`. */
      readonly superClass: CanonicalExpression | null;
      readonly elements: readonly CanonicalClassElement[];
      readonly span: SourceSpan;
    }
  | {
      readonly kind: "object";
      readonly properties: readonly CanonicalProperty[];
      readonly span: SourceSpan;
    }
  | {
      readonly kind: "array";
      /** Entries preserve native spread evaluation and null array holes. */
      readonly elements: readonly (CanonicalArgument | null)[];
      readonly span: SourceSpan;
    };

/** A native class body member retained in source order. */
export type CanonicalClassElement =
  | {
      readonly kind: "method";
      /** Identifier, literal, computed expression, or private name key. */
      readonly key: string | number | CanonicalExpression;
      readonly computed: boolean;
      readonly static: boolean;
      readonly methodKind: "constructor" | "method" | "get" | "set";
      readonly parameters: readonly CanonicalPattern[];
      readonly body: CanonicalStatementBlock;
      readonly async: boolean;
      readonly span: SourceSpan;
    }
  | {
      readonly kind: "field";
      /** Identifier, literal, computed expression, or private name key. */
      readonly key: string | number | CanonicalExpression;
      readonly computed: boolean;
      readonly static: boolean;
      /** Null preserves an uninitialized native field. */
      readonly initializer: CanonicalExpression | null;
      readonly span: SourceSpan;
    }
  | {
      /** A native static initialization block, evaluated when the class is defined. */
      readonly kind: "static-block";
      readonly body: CanonicalStatementBlock;
      readonly span: SourceSpan;
    };

/** One untagged template segment retained as semantic data and debug span. */
export interface CanonicalTemplateQuasi {
  /** Segment text with escapes retained, excluding template delimiters and interpolations. */
  readonly raw: string;
  /** Escape-decoded value, or null when the parser supplies no cooked value. */
  readonly cooked: string | null;
  readonly span: SourceSpan;
}

/** A serializable binding pattern supported in generated callbacks and declarations. */
export type CanonicalPattern =
  | {
      readonly kind: "identifier";
      /** Source spelling used when emitting the declaration. */
      readonly name: string;
      /** Lexical declaration identity assigned by canonical name resolution. */
      readonly bindingId?: string;
      readonly span: SourceSpan;
    }
  | {
      readonly kind: "object";
      readonly properties: readonly CanonicalPatternProperty[];
      /** Native object rest binding, evaluated after the keyed properties. */
      readonly rest?: CanonicalPattern;
      readonly span: SourceSpan;
    }
  | {
      readonly kind: "array";
      /** Binding positions in iterator order; null consumes a position without binding it. */
      readonly elements: readonly (CanonicalPattern | null)[];
      readonly span: SourceSpan;
    }
  | {
      /** A native rest binding that consumes the remaining iterator or properties. */
      readonly kind: "rest";
      readonly argument: CanonicalPattern;
      readonly span: SourceSpan;
    }
  | {
      /** A native default initializer evaluated only when the bound value is undefined. */
      readonly kind: "default";
      readonly left: CanonicalPattern;
      readonly right: CanonicalExpression;
      readonly span: SourceSpan;
    };

/** The binding or assignment target on the left side of a native loop. */
export type CanonicalForLeft =
  | {
      readonly kind: "declaration";
      /** Declaration initialized by each native iteration; `let` and `const` retain per-iteration bindings. */
      readonly declarationKind: "const" | "let" | "var";
      readonly pattern: CanonicalPattern;
      /** Enclosing function bindings when a `var` loop pattern is shadowed by a catch binding. */
      readonly hoistedBindingIds?: readonly string[];
      readonly span: SourceSpan;
    }
  | {
      readonly kind: "assignment";
      /** Existing identifier or member target assigned by each native iteration. */
      readonly target: CanonicalExpression;
      readonly span: SourceSpan;
    };

/** An ordered object initializer entry; spread retains native copy semantics. */
export type CanonicalProperty = CanonicalKeyedProperty | CanonicalSpreadProperty;

/** A named or computed object property in canonical meaning. */
export interface CanonicalKeyedProperty {
  readonly kind: "property";
  /** Static property name, or the expression evaluated for a computed property. */
  readonly key: string | CanonicalExpression;
  readonly value: CanonicalExpression;
  readonly computed: boolean;
  /** Preserve the native shorthand form such as `{ value }`. */
  readonly shorthand: boolean;
  /** Native descriptor kind; omitted for ordinary initializer properties. */
  readonly propertyKind?: "init" | "get" | "set";
  /** Whether the value is emitted as an object method. */
  readonly method?: boolean;
  readonly span: SourceSpan;
}

/** A native object spread evaluated at this position in the initializer. */
export interface CanonicalSpreadProperty {
  readonly kind: "spread";
  readonly argument: CanonicalExpression;
  readonly span: SourceSpan;
}

/** One call or constructor argument, preserving native spread evaluation. */
export type CanonicalArgument =
  | CanonicalExpression
  | {
      readonly kind: "spread";
      readonly argument: CanonicalExpression;
      readonly span: SourceSpan;
    };

/** A destructuring property in canonical meaning. */
export interface CanonicalPatternProperty {
  /** Static property name read from the destructured value. */
  readonly key: string;
  /** Destination binding, including any nested pattern or default initializer. */
  readonly value: CanonicalPattern;
  /** Always false in successfully lowered modules; computed binding keys are rejected. */
  readonly computed: boolean;
  readonly span: SourceSpan;
}

/** A switch case retains its nullable test and fallthrough statement order. */
export interface CanonicalSwitchCase {
  /** Null denotes the default case. */
  readonly test: CanonicalExpression | null;
  readonly consequent: readonly CanonicalStatement[];
  readonly span: SourceSpan;
}

/** A statement block used by block-bodied callbacks. */
export interface CanonicalStatementBlock {
  readonly kind: "block";
  readonly body: readonly CanonicalStatement[];
  readonly span: SourceSpan;
}

/** A static host element in the canonical render tree. */
export interface CanonicalElement {
  readonly kind: "element";
  /** Deterministic semantic occurrence assigned during canonicalization. */
  readonly occurrence: string;
  /** Native tag spelling; namespace determines which DOM creation operation is used. */
  readonly tag: string;
  readonly namespace: "html" | "svg" | "mathml";
  /** Attribute, property, binding, and listener operations in source order. */
  readonly attributes: readonly CanonicalAttribute[];
  /** Children in rendered order, including structural regions. */
  readonly children: readonly CanonicalChild[];
  readonly span: SourceSpan;
}

/** A JSX fragment whose children occupy one structural native range. */
export interface CanonicalFragment {
  readonly kind: "fragment";
  /** Deterministic semantic occurrence assigned during canonicalization. */
  readonly occurrence: string;
  readonly children: readonly CanonicalChild[];
  readonly span: SourceSpan;
}

/** A text child whose contents are known at compile time. */
export interface CanonicalText {
  readonly kind: "text";
  /** Deterministic semantic occurrence assigned during canonicalization. */
  readonly occurrence: string;
  readonly value: string;
  readonly span: SourceSpan;
}

/** A reactive or structural expression in a render tree. */
export interface CanonicalDynamicChild {
  readonly kind: "dynamic-child";
  /** Deterministic semantic occurrence assigned during canonicalization. */
  readonly occurrence: string;
  readonly expression: CanonicalExpression;
  readonly span: SourceSpan;
}

/** A component invocation in JSX. */
export interface CanonicalComponent {
  readonly kind: "component";
  /** Deterministic semantic occurrence assigned during canonicalization. */
  readonly occurrence: string;
  /** Component factory expression; resolved references retain lexical identity. */
  readonly reference: CanonicalExpression;
  /** Caller inputs in source order, with deferred reads and children represented explicitly. */
  readonly props: readonly CanonicalComponentProp[];
  readonly span: SourceSpan;
}

/** A component render explicitly awaited by an async component body. */
export interface CanonicalAwaitChild {
  readonly kind: "await-child";
  /** Deterministic semantic occurrence assigned during canonicalization. */
  readonly occurrence: string;
  /** Child factory awaited within the enclosing component's preparation. */
  readonly reference: CanonicalExpression;
  /** Caller inputs with the same evaluation rules as an ordinary component invocation. */
  readonly props: readonly CanonicalComponentProp[];
  readonly span: SourceSpan;
}

/** An explicitly permitted raw HTML replacement with an authored host or fragment. */
export interface CanonicalRawHTMLChild {
  readonly kind: "raw-html";
  /** Deterministic semantic occurrence assigned during canonicalization. */
  readonly occurrence: string;
  /** Authored host replaced with its contents on updates; null inserts a hostless fragment. */
  readonly host: CanonicalElement | null;
  /** Reactive HTML input for replacement of the complete owned region. */
  readonly html: CanonicalExpression;
  readonly span: SourceSpan;
}

/** The first profile's complete child set. */
export type CanonicalChild =
  | CanonicalElement
  | CanonicalFragment
  | CanonicalText
  | CanonicalDynamicChild
  | CanonicalComponent
  | CanonicalAwaitChild
  | CanonicalRawHTMLChild
  | CanonicalConditionalChild
  | CanonicalListChild;

/** A reactive single-item branch with one stable region identity. */
export interface CanonicalConditionalChild {
  readonly kind: "conditional";
  /** Deterministic semantic occurrence assigned during canonicalization. */
  readonly occurrence: string;
  readonly test: CanonicalExpression;
  /** Region content for a truthy test; null represents an empty branch. */
  readonly consequent: CanonicalChild | null;
  /** Region content for a falsy test; null represents an empty branch. */
  readonly alternate: CanonicalChild | null;
  /** Resolved enclosing list bindings read by native branch factories. */
  readonly captures: readonly CanonicalCapture[];
  readonly span: SourceSpan;
}

/** A keyed collection whose row factory is hoisted and receives a scope accessor. */
export interface CanonicalListChild {
  readonly kind: "list";
  /** Deterministic semantic occurrence assigned during canonicalization. */
  readonly occurrence: string;
  /** Reactive collection read when reconciling this list. */
  readonly collection: CanonicalExpression;
  /** Row binding made available to the body and key expressions. */
  readonly parameter: CanonicalPattern;
  readonly body: CanonicalChild;
  /** Per-row identity expression used to retain and move existing row lifetimes. */
  readonly key: CanonicalExpression;
  /** Resolved list bindings read by the hoisted body factory. */
  readonly captures: readonly CanonicalCapture[];
  readonly span: SourceSpan;
}

/** A hoisted factory's lexical read transported through a native-item scope. */
export interface CanonicalCapture {
  /** The resolved declaration read by the factory body. */
  readonly bindingId: string;
  /** The authored spelling used as the generated scope property. */
  readonly name: string;
}

/** Distinguish render-tree children from ordinary expressions with the same kind tag. */
export function isCanonicalChild(
  value: CanonicalExpression | CanonicalChild | CanonicalStatementBlock,
): value is CanonicalChild {
  if (value.kind === "block") return false;

  if (value.kind === "conditional") return "captures" in value;

  return (
    value.kind === "element" ||
    value.kind === "fragment" ||
    value.kind === "text" ||
    value.kind === "dynamic-child" ||
    value.kind === "component" ||
    value.kind === "await-child" ||
    value.kind === "raw-html" ||
    value.kind === "list"
  );
}

/** An intrinsic-element prop and its lowering category. */
export type CanonicalAttribute =
  | {
      readonly kind: "static";
      readonly name: string;
      readonly value: string | boolean;
      readonly span: SourceSpan;
    }
  | {
      readonly kind: "dynamic";
      readonly name: string;
      readonly expression: CanonicalExpression;
      /** Selects native attribute assignment, DOM property assignment, or binding attachment. */
      readonly mode: "attribute" | "property" | "binding";
      readonly span: SourceSpan;
    }
  | {
      readonly kind: "event";
      /** Native event name after removing the authored `on:` prefix. */
      readonly name: string;
      /** Listener expression, retaining the native event and receiver contract. */
      readonly expression: CanonicalExpression;
      readonly span: SourceSpan;
    };

/** A component prop retains whether its caller expression must remain lazy. */
export type CanonicalComponentProp =
  | {
      readonly kind: "value";
      readonly name: string;
      readonly expression: CanonicalExpression;
      /** Defer the caller expression through a prop accessor instead of evaluating it eagerly. */
      readonly lazy: boolean;
      readonly span: SourceSpan;
    }
  | {
      readonly kind: "children";
      readonly children: readonly CanonicalChild[];
      readonly span: SourceSpan;
    }
  | {
      readonly kind: "fallback";
      readonly child: CanonicalChild;
      readonly span: SourceSpan;
    };

/** A declaration or control-flow statement retained by the module generator. */
export type CanonicalStatement =
  | {
      readonly kind: "import";
      readonly specifiers: readonly CanonicalImportSpecifier[];
      readonly source: string;
      readonly span: SourceSpan;
    }
  | {
      readonly kind: "variable";
      readonly declarationKind: "const" | "let" | "var";
      readonly declarations: readonly CanonicalVariableDeclaration[];
      readonly span: SourceSpan;
    }
  | {
      readonly kind: "function";
      readonly name: string;
      readonly bindingId?: string;
      /** Trusted component role supplied by conventional route or checker metadata. */
      readonly component?: boolean;
      /** Native-checker prop contract attached after authored type checking. */
      readonly props?: Readonly<Record<string, import("hesperia/runtime").PropSchema>>;
      readonly parameters: readonly CanonicalPattern[];
      readonly body: CanonicalStatementBlock;
      readonly async: boolean;
      /** Native generator declarations remain ordinary functions, never component factories. */
      readonly generator: boolean;
      readonly span: SourceSpan;
    }
  | {
      /** A native class declaration whose binding is visible in its enclosing scope. */
      readonly kind: "class";
      readonly name: string;
      readonly bindingId?: string;
      readonly superClass: CanonicalExpression | null;
      readonly elements: readonly CanonicalClassElement[];
      readonly span: SourceSpan;
    }
  | {
      readonly kind: "return";
      readonly argument: CanonicalExpression | CanonicalChild | null;
      readonly span: SourceSpan;
    }
  | {
      readonly kind: "expression";
      readonly expression: CanonicalExpression;
      readonly span: SourceSpan;
    }
  | {
      readonly kind: "if";
      /** Evaluate the test once in order, then execute only the selected branch. */
      readonly test: CanonicalExpression;
      /** The statement selected when `test` is truthy. */
      readonly consequent: CanonicalStatement;
      /** The statement selected when `test` is falsy, or null for an if-only form. */
      readonly alternate: CanonicalStatement | null;
      readonly span: SourceSpan;
    }
  | {
      /** Native switch dispatch with shared case lexical scope and fallthrough. */
      readonly kind: "switch";
      /** The discriminant is evaluated before the switch case environment is entered. */
      readonly discriminant: CanonicalExpression;
      readonly cases: readonly CanonicalSwitchCase[];
      readonly span: SourceSpan;
    }
  | {
      readonly kind: "for";
      /** The initializer executes once before the first test. */
      readonly init: Extract<CanonicalStatement, { kind: "variable" }> | CanonicalExpression | null;
      /** The test executes before each iteration; null preserves an infinite native loop. */
      readonly test: CanonicalExpression | null;
      /** The update follows a completed body or a continue targeting this loop; break skips it. */
      readonly update: CanonicalExpression | null;
      readonly body: CanonicalStatement;
      readonly span: SourceSpan;
    }
  | {
      readonly kind: "for-of";
      /** Preserve native async-iterator selection for `for await...of`. */
      readonly await: boolean;
      /** Binding declaration or existing assignment target updated from each iterator result. */
      readonly left: CanonicalForLeft;
      /** Iterable expression evaluated once before iteration starts. */
      readonly right: CanonicalExpression;
      readonly body: CanonicalStatement;
      readonly span: SourceSpan;
    }
  | {
      readonly kind: "for-in";
      /** Binding declaration or existing assignment target updated from each enumerable key. */
      readonly left: CanonicalForLeft;
      /** Object expression evaluated once before key enumeration starts. */
      readonly right: CanonicalExpression;
      readonly body: CanonicalStatement;
      readonly span: SourceSpan;
    }
  | {
      readonly kind: "while";
      readonly test: CanonicalExpression;
      readonly body: CanonicalStatement;
      readonly span: SourceSpan;
    }
  | {
      readonly kind: "do-while";
      readonly body: CanonicalStatement;
      readonly test: CanonicalExpression;
      readonly span: SourceSpan;
    }
  | {
      readonly kind: "labeled";
      /** Authored spelling retained for generated control flow; bindingId gives alpha-stable identity. */
      readonly label: string;
      readonly bindingId?: string;
      readonly body: CanonicalStatement;
      readonly span: SourceSpan;
    }
  | {
      readonly kind: "break";
      /** Authored target spelling; referenceId identifies the resolved enclosing label. */
      readonly label: string | null;
      readonly referenceId?: string;
      readonly span: SourceSpan;
    }
  | {
      readonly kind: "continue";
      /** Authored target spelling; referenceId identifies the resolved enclosing label. */
      readonly label: string | null;
      readonly referenceId?: string;
      readonly span: SourceSpan;
    }
  | {
      readonly kind: "throw";
      /** Preserve the exact evaluated value passed to JavaScript throw. */
      readonly argument: CanonicalExpression;
      readonly span: SourceSpan;
    }
  | {
      /** Native try/catch/finally control flow with lexical catch binding semantics. */
      readonly kind: "try";
      /** Statements evaluated before catch or finalizer dispatch. */
      readonly body: CanonicalStatementBlock;
      /** Optional native catch clause, including its optional binding. */
      readonly handler: CanonicalCatchClause | null;
      /** Statements that run after either normal or abrupt completion. */
      readonly finalizer: CanonicalStatementBlock | null;
      readonly span: SourceSpan;
    }
  | {
      readonly kind: "block";
      readonly body: readonly CanonicalStatement[];
      readonly span: SourceSpan;
    }
  | {
      readonly kind: "export";
      readonly exportKind: "named" | "default";
      /** Public export names and their local bindings; public names remain semantic. */
      readonly exportedBindings?: readonly {
        readonly exported: string;
        readonly referenceId: string;
      }[];
      readonly declaration: CanonicalStatement;
      readonly span: SourceSpan;
    }
  | {
      /** A named export list, optionally forwarding names from another module. */
      readonly kind: "export-list";
      readonly source: string | null;
      readonly specifiers: readonly CanonicalExportSpecifier[];
      readonly span: SourceSpan;
    }
  | {
      /** A native `export *` or `export * as namespace` forwarding declaration. */
      readonly kind: "export-all";
      readonly source: string;
      readonly exported: string | null;
      readonly span: SourceSpan;
    };

/** One named export, preserving authored aliases and resolved local identity. */
export interface CanonicalExportSpecifier {
  /** Local name for a direct export, or the imported name for a re-export. */
  readonly local: string;
  /** Public name exposed by this module; retained in semantic encoding. */
  readonly exported: string;
  /** Resolved local declaration for direct exports; absent for re-exports from another module. */
  readonly referenceId?: string;
}

/**
 * One imported binding. `local` is the emitting module's spelling and `bindingId`
 * is its resolved lexical identity; named imports also retain the dependency's
 * public `imported` name. Type-only imports are erased before canonicalization.
 */
export type CanonicalImportSpecifier =
  | {
      readonly kind: "named";
      readonly imported: string;
      readonly local: string;
      readonly bindingId?: string;
    }
  | { readonly kind: "default"; readonly local: string; readonly bindingId?: string }
  | { readonly kind: "namespace"; readonly local: string; readonly bindingId?: string };

/** A variable declaration. */
export interface CanonicalVariableDeclaration {
  /** Declared names and destructuring operations in their evaluation order. */
  readonly pattern: CanonicalPattern;
  /**
   * Enclosing function bindings for `var` declarations whose pattern is
   * shadowed by a lexical catch binding. Entries follow identifier order in
   * the pattern and are omitted when they equal the resolved pattern bindings.
   */
  readonly hoistedBindingIds?: readonly string[];
  /** Initial value or render expression; null preserves an omitted initializer. */
  readonly initializer: CanonicalExpression | CanonicalChild | null;
  readonly span: SourceSpan;
}

/** Native catch clause; a null parameter represents optional catch binding. */
export interface CanonicalCatchClause {
  /** Destructuring or identifier binding, or null for `catch {}`. */
  readonly param: CanonicalPattern | null;
  /** Catch body statements evaluated with the catch lexical environment. */
  readonly body: CanonicalStatementBlock;
  readonly span: SourceSpan;
}

/**
 * Read-only snapshot of a module's canonical meaning.
 *
 * Node `span` fields address the source parsed by canonicalization. In a compile
 * result, that is normalized JavaScript after TypeScript erasure; use the result's
 * `debug` and `diagnostics` for authored
 * positions. `filename`, spans, and diagnostics are excluded from semantic encoding.
 *
 * Resolved declaration and reference IDs are local to this module snapshot.
 * They preserve scope relationships across spelling-only changes, but are not
 * stable identities across arbitrary edits or runtime component lifetimes.
 * Render `occurrence` fields identify structural positions in the canonical tree;
 * debug traversal IDs are assigned separately.
 */
export interface CanonicalModule {
  /** Version required to interpret this module's node forms. */
  readonly version: typeof HESPERIA_IR_VERSION;
  /** Source label for diagnostics and generated source maps. */
  readonly filename: string;
  /** Resolved top-level statements in source order. */
  readonly body: readonly CanonicalStatement[];
  /** Canonicalization diagnostics; the compile result also includes other stages' diagnostics. */
  readonly diagnostics: readonly CompilerDiagnostic[];
}

/**
 * Encode canonical meaning as stable JSON for cache keys and frontend comparison.
 * Excludes source locations and resolved local spellings, but preserves public
 * import/export names and statement order. This does not validate the module;
 * callers must inspect diagnostics before treating it as executable input.
 */
export function encodeCanonicalModule(module: CanonicalModule): string {
  // Spans belong to the debug sidecar. Removing them here means comments,
  // indentation, CRLF choice, and source relocation cannot change semantic
  // identity or the reproducibility hash.
  return JSON.stringify(stripDebugFields({ version: module.version, body: module.body }));
}

/**
 * Collect canonical spans under deterministic traversal IDs without changing the module.
 * Locations retain the module's source coordinates; this function does not map
 * normalized offsets back to authored source as the compile result does.
 */
export function canonicalDebugSidecar(module: CanonicalModule): CanonicalDebugSidecar {
  const spans: Record<string, SourceSpan> = {};
  let nextId = 0;

  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);

      return;
    }

    if (typeof value !== "object" || value === null) return;

    const nodeValue = value as Record<string, unknown>;

    if (typeof nodeValue.kind === "string" && isSourceSpan(nodeValue.span)) {
      spans[`n${String(nextId++).padStart(6, "0")}`] = nodeValue.span;
    }

    for (const key of Object.keys(nodeValue).sort()) {
      if (key !== "span" && key !== "diagnostics") visit(nodeValue[key]);
    }
  };

  visit(module.body);

  return { version: HESPERIA_IR_VERSION, spans };
}

function isSourceSpan(value: unknown): value is SourceSpan {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { start?: unknown }).start === "number" &&
    typeof (value as { end?: unknown }).end === "number"
  );
}

function stripDebugFields(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => stripDebugFields(item));

  if (typeof value !== "object" || value === null) return value;

  const record = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};

  for (const [key, nested] of Object.entries(value)) {
    if (key === "span" || key === "diagnostics") continue;

    if (key === "name" || key === "local" || key === "label") {
      if (
        typeof record.bindingId === "string" ||
        typeof record.referenceId === "string" ||
        typeof record.nameBindingId === "string"
      )
        continue;
    }

    Object.defineProperty(result, key, {
      configurable: true,
      enumerable: true,
      value:
        key === "props" &&
        (record.kind === "function" ||
          record.kind === "arrow" ||
          record.kind === "function-expression")
          ? Object.fromEntries(
              Object.entries(nested as Record<string, unknown>).sort(([left], [right]) =>
                left < right ? -1 : left > right ? 1 : 0,
              ),
            )
          : stripDebugFields(nested),
      writable: true,
    });
  }

  return result;
}
