import { createHash } from "node:crypto";
import { version as typeScriptVersion } from "typescript";
import {
  SignatureKind,
  SymbolFlags,
  TypeFlags,
  type Project,
  type Symbol,
  type Type,
  type TypeParameter,
  type TupleType,
} from "typescript/unstable/async";
import type {
  CheckingSession,
  ProjectCheckingOptions,
  ProjectCheckingResult,
  VirtualModule,
} from "./checking.ts";
import type { CheckingInputSnapshot } from "./checking-inputs.ts";
import type { CompileResult, ModuleAnalysis } from "./compilation.ts";
import type { ProjectCompilation } from "./project-compilation.ts";
import { encodeCanonicalModule, type CanonicalModule } from "./ir.ts";
import { normalizeFilename as normalizePath } from "./utils.ts";
import {
  isIdentifier,
  isInterfaceDeclaration,
  isPropertySignatureDeclaration,
  isSourceFile,
  isTypeOperatorNode,
  isTypeParameterDeclaration,
  SyntaxKind,
  type InterfaceDeclaration,
  type Node,
  type PropertySignatureDeclaration,
} from "typescript/unstable/ast";
export type CheckerTypeAbi =
  | { readonly kind: "resolved"; readonly shape: CheckerTypeShape }
  | {
      readonly kind: "unresolved";
      readonly reason:
        | "checker-error"
        | "recursive-depth"
        | "type-parameter"
        | "index-signature"
        | "nominal-member"
        | "symbol-member"
        | "unsupported-type";
    };

/** Structural type facts emitted by the native checker without retaining checker objects. */
export type CheckerTypeShape =
  | {
      readonly kind: "primitive";
      readonly name:
        | "any"
        | "unknown"
        | "never"
        | "void"
        | "undefined"
        | "null"
        | "string"
        | "number"
        | "boolean";
    }
  | {
      readonly kind: "literal";
      readonly base: "string" | "number" | "boolean";
      readonly value: string | number | boolean;
    }
  | { readonly kind: "union" | "intersection"; readonly types: readonly CheckerTypeShape[] }
  | {
      readonly kind: "keyof";
      /** Type whose keys form this type. */ readonly target: CheckerTypeShape;
    }
  | {
      readonly kind: "indexed-access";
      /** Object side of the native `T[K]` access. */
      readonly object: CheckerTypeShape;
      /** Index side of the native `T[K]` access. */
      readonly index: CheckerTypeShape;
    }
  | {
      readonly kind: "conditional";
      /** Type tested by the conditional. */
      readonly check: CheckerTypeShape;
      /** Type required by the conditional constraint. */
      readonly extends: CheckerTypeShape;
      /** Resolved true branch. */
      readonly whenTrue: CheckerTypeShape;
      /** Resolved false branch. */
      readonly whenFalse: CheckerTypeShape;
    }
  | {
      readonly kind: "substitution";
      /** Original checker type before substitution. */
      readonly base: CheckerTypeShape;
      /** Constraint applied by the checker. */
      readonly constraint: CheckerTypeShape;
    }
  | {
      readonly kind: "template-literal";
      /** Literal text segments between the type spans. */
      readonly texts: readonly string[];
      /** Resolved type spans interspersed between text segments. */
      readonly types: readonly CheckerTypeShape[];
    }
  | {
      readonly kind: "string-mapping";
      /** Exact built-in string transformation represented by the checker type. */
      readonly operation: "Uppercase" | "Lowercase" | "Capitalize" | "Uncapitalize";
      /** Mapped string type's checker target. */
      readonly target: CheckerTypeShape;
    }
  | {
      readonly kind: "array";
      /** Whether the checker type is a readonly array. */
      readonly readonly: boolean;
      /** Resolved array element type. */
      readonly element: CheckerTypeShape;
      /** Exact declarations for the native Array or ReadonlyArray type. */
      readonly declarations: readonly CheckerTypeDeclarationShape[];
      /** Complete checker-visible array surface, including inherited and iterator members. */
      readonly surface: CheckerObjectShape;
    }
  | {
      readonly kind: "tuple";
      /** Whether the checker tuple rejects writes. */
      readonly readonly: boolean;
      /** Number of initial required tuple elements. */
      readonly fixedLength: number;
      /** Checker flags for required, optional, rest, and variadic tuple elements. */
      readonly elementFlags: readonly number[];
      /** Resolved tuple elements in source order. */
      readonly elements: readonly CheckerTypeShape[];
      /** Exact declarations for the tuple type and target. */
      readonly declarations: readonly CheckerTypeDeclarationShape[];
      /** Complete checker-visible tuple surface, including inherited and iterator members. */
      readonly surface: CheckerObjectShape;
    }
  | {
      readonly kind: "recursive";
      /** Structural path of the generic surface or recursive type definition. */
      readonly path: string;
      /** Actual checker type arguments at a recursive generic reference, when present. */
      readonly arguments?: readonly CheckerTypeShape[];
    }
  | {
      readonly kind: "reference";
      /** Exact type or alias declarations selected by the checker. */
      readonly declarations: readonly CheckerTypeDeclarationShape[];
      /** Resolved generic arguments or type-alias arguments. */
      readonly arguments: readonly CheckerTypeShape[];
      /** Resolved class/interface bases, when present. */
      readonly bases: readonly CheckerTypeShape[];
      /** Fully resolved public surface, including inherited and symbol-keyed members. */
      readonly surface: CheckerObjectShape;
    }
  | {
      readonly kind: "type-parameter";
      /** Stable structural identity shared by the parameter declaration and each use in its signature. */
      readonly identity: string;
      /** Exact type-parameter declarations and scope identity. */
      readonly declarations: readonly CheckerTypeDeclarationShape[];
      /** Resolved declared constraint, when present. */
      readonly constraint?: CheckerTypeShape;
      /** Resolved declared default, when present. */
      readonly default?: CheckerTypeShape;
    }
  | {
      readonly kind: "this";
      /** Checker-proven constraint of a synthetic polymorphic this type. */
      readonly constraint: CheckerTypeShape;
    }
  | CheckerObjectShape;

/** Complete resolved properties, signatures, and indexes of a checker object type. */
export interface CheckerObjectShape {
  /** Property members, including inherited, nominal, and computed-symbol declarations. */
  readonly kind: "object";
  readonly properties: readonly CheckerPropertyShape[];
  /** Callable surface of the object type. */
  readonly calls: readonly CheckerSignatureShape[];
  /** Constructable surface of the object type. */
  readonly constructs: readonly CheckerSignatureShape[];
  /** String or numeric index signatures, with their recursively resolved value types. */
  readonly indexes: readonly {
    /** Resolved key type of the index signature. */
    readonly key: CheckerTypeShape;
    /** Whether callers can write through this index. */
    readonly readonly: boolean;
    /** Resolved value type of the index signature. */
    readonly type: CheckerTypeShape;
    /** Exact syntax declaration for the index signature. */
    readonly declaration?: CheckerTypeDeclarationShape;
  }[];
}

/** Exact resolved declaration source that owns a referenced checker type. */
export interface CheckerTypeDeclarationShape {
  /** Source identity from the native checker project. */
  readonly filename: string;
  /** Declaration syntax kind from the native checker AST. */
  readonly kind: number;
  /** Exact start and end offsets within the owning source file. */
  readonly start: number;
  /** Exclusive end offset within the owning source file. */
  readonly end: number;
  /** Exact declaration text returned by the owning source node. */
  readonly source: string;
}

/** One named member of a resolved object type. */
export interface CheckerPropertyShape {
  /** Stable source spelling for string keys or computed member syntax for symbol keys. */
  readonly name: string;
  /** Exact checker declarations that establish this member's identity. */
  readonly declarations: readonly CheckerTypeDeclarationShape[];
  /** Whether the property can be omitted. */
  readonly optional: boolean;
  /** Whether the property declaration prevents writes. */
  readonly readonly: boolean;
  /** Resolved type of the property value. */
  readonly type: CheckerTypeShape;
}

/** One resolved call or construct signature. */
export interface CheckerSignatureShape {
  /** Signature declaration identity from the native checker program. */
  readonly declarations: readonly CheckerTypeDeclarationShape[];
  /** Fully resolved generic parameters declared by this signature. */
  readonly typeParameters: readonly CheckerTypeShape[];
  /** Explicit `this` parameter contract, when the signature declares one. */
  readonly thisType?: CheckerTypeShape;
  readonly parameters: readonly {
    /** Whether callers may omit this parameter. */
    readonly optional: boolean;
    /** Whether this parameter receives a rest argument list. */
    readonly rest: boolean;
    /** Resolved parameter type. */
    readonly type: CheckerTypeShape;
  }[];
  /** Type-predicate or assertion return semantics, when present. */
  readonly predicate?: {
    /** Native checker predicate or assertion kind. */
    readonly kind: number;
    /** Named parameter guarded by a predicate. */
    readonly parameterName?: string;
    /** Parameter position guarded by a predicate. */
    readonly parameterIndex?: number;
    /** Resolved predicate type, when declared. */
    readonly type?: CheckerTypeShape;
  };
  /** Resolved return type. */
  readonly returns: CheckerTypeShape;
}

type CheckerObjectAbiResult =
  | Extract<CheckerTypeAbi, { readonly kind: "unresolved" }>
  | { readonly kind: "resolved"; readonly shape: CheckerObjectShape };

/** Native-checker results keyed by the authored first-parameter start offset. */

interface FunctionLikeNode extends Node {
  readonly parameters?: readonly Node[];
}

interface TypeMemberNode extends Node {
  readonly name?: Node;
  readonly modifiers?: readonly Node[];
  readonly questionToken?: Node;
  readonly dotDotDotToken?: Node;
  readonly initializer?: Node;
}

interface ComputedNameNode extends Node {
  readonly expression?: Node;
}

interface PropertyAccessNode extends Node {
  readonly expression?: Node;
  readonly name?: Node;
}

interface ClassLikeNode extends Node {
  readonly members?: readonly Node[];
}

interface NamedTypeDeclarationNode extends Node {
  readonly name?: Node;
}

function semanticStructuralShape(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(semanticStructuralShape);

  if (typeof value !== "object" || value === null) return value;

  const record = value as Record<string, unknown>;
  const normalized = Object.fromEntries(
    Object.keys(record)
      .filter((key) => key !== "declaration" && key !== "declarations")
      .sort()
      .map((key) => [key, semanticStructuralShape(record[key])]),
  );

  if (record.kind === "union" || record.kind === "intersection") {
    const types = (normalized as { types?: unknown }).types;

    if (Array.isArray(types))
      (normalized as { types: unknown[] }).types = [...types].sort((left, right) =>
        JSON.stringify(left).localeCompare(JSON.stringify(right)),
      );
  } else if (record.kind === "object") {
    const shape = normalized as { indexes?: unknown[]; properties?: { name?: string }[] };

    if (Array.isArray(shape.properties))
      shape.properties = [...shape.properties].sort((left, right) =>
        String(left.name).localeCompare(String(right.name)),
      );

    if (Array.isArray(shape.indexes))
      shape.indexes = [...shape.indexes].sort((left, right) =>
        JSON.stringify(left).localeCompare(JSON.stringify(right)),
      );
  }

  return normalized;
}

async function checkerTypeAbi(
  project: Project,
  type: Type,
  path = "$",
  active: ReadonlyMap<number, string> = new Map(),
  depth = 0,
  boundTypeParameters: ReadonlyMap<number, string> = new Map(),
  budget: { remaining: number } = { remaining: 8192 },
): Promise<CheckerTypeAbi> {
  budget.remaining--;

  if (budget.remaining < 0) return { kind: "unresolved", reason: "recursive-depth" };
  if (type.isErrorType()) return { kind: "unresolved", reason: "checker-error" };
  if (depth > 64) return { kind: "unresolved", reason: "recursive-depth" };

  const prior = active.get(type.id);

  if (prior !== undefined) {
    if (type.isTypeReference())
      return checkerRecursiveReferenceAbi(
        project,
        type,
        path,
        prior,
        active,
        depth,
        boundTypeParameters,
        budget,
      );

    return { kind: "resolved", shape: { kind: "recursive", path: prior } };
  }

  if (type.isTypeReference()) {
    const target = await type.getTarget();
    const targetPath = active.get(target.id);

    if (targetPath !== undefined)
      return checkerRecursiveReferenceAbi(
        project,
        type,
        path,
        targetPath,
        active,
        depth,
        boundTypeParameters,
        budget,
      );
  }

  const flags = type.flags;
  const primitive: ReadonlyArray<
    readonly [
      number,
      "any" | "unknown" | "never" | "void" | "undefined" | "null" | "string" | "number" | "boolean",
    ]
  > = [
    [TypeFlags.Any, "any"],
    [TypeFlags.Unknown, "unknown"],
    [TypeFlags.Never, "never"],
    [TypeFlags.Void, "void"],
    [TypeFlags.Undefined, "undefined"],
    [TypeFlags.Null, "null"],
    [TypeFlags.String, "string"],
    [TypeFlags.Number, "number"],
    [TypeFlags.Boolean, "boolean"],
  ];

  for (const [flag, name] of primitive)
    if (flags & flag) return { kind: "resolved", shape: { kind: "primitive", name } };

  if (type.isStringLiteralType())
    return { kind: "resolved", shape: { kind: "literal", base: "string", value: type.value } };

  if (type.isNumberLiteralType())
    return { kind: "resolved", shape: { kind: "literal", base: "number", value: type.value } };

  if (type.isBooleanLiteralType())
    return { kind: "resolved", shape: { kind: "literal", base: "boolean", value: type.value } };

  if (type.isIndexType()) {
    const target = await checkerTypeAbi(
      project,
      await type.getTarget(),
      `${path}/target`,
      active,
      depth + 1,
      boundTypeParameters,
      budget,
    );

    return target.kind === "resolved"
      ? { kind: "resolved", shape: { kind: "keyof", target: target.shape } }
      : target;
  }

  if (type.isIndexedAccessType()) {
    const object = await checkerTypeAbi(
      project,
      await type.getObjectType(),
      `${path}/object`,
      active,
      depth + 1,
      boundTypeParameters,
      budget,
    );
    const index = await checkerTypeAbi(
      project,
      await type.getIndexType(),
      `${path}/index`,
      active,
      depth + 1,
      boundTypeParameters,
      budget,
    );

    if (object.kind === "unresolved" || index.kind === "unresolved")
      return object.kind === "unresolved" ? object : index;

    return {
      kind: "resolved",
      shape: { kind: "indexed-access", object: object.shape, index: index.shape },
    };
  }

  if (type.isConditionalType()) {
    const check = await checkerTypeAbi(
      project,
      await type.getCheckType(),
      `${path}/check`,
      active,
      depth + 1,
      boundTypeParameters,
      budget,
    );
    const extendsType = await checkerTypeAbi(
      project,
      await type.getExtendsType(),
      `${path}/extends`,
      active,
      depth + 1,
      boundTypeParameters,
      budget,
    );
    const whenTrue = await checkerTypeAbi(
      project,
      await type.getTrueType(),
      `${path}/true`,
      active,
      depth + 1,
      boundTypeParameters,
      budget,
    );
    const whenFalse = await checkerTypeAbi(
      project,
      await type.getFalseType(),
      `${path}/false`,
      active,
      depth + 1,
      boundTypeParameters,
      budget,
    );

    if (check.kind === "unresolved") return check;
    if (extendsType.kind === "unresolved") return extendsType;
    if (whenTrue.kind === "unresolved") return whenTrue;
    if (whenFalse.kind === "unresolved") return whenFalse;

    return {
      kind: "resolved",
      shape: {
        kind: "conditional",
        check: check.shape,
        extends: extendsType.shape,
        whenTrue: whenTrue.shape,
        whenFalse: whenFalse.shape,
      },
    };
  }

  if (type.isSubstitutionType()) {
    const base = await checkerTypeAbi(
      project,
      await type.getBaseType(),
      `${path}/base`,
      active,
      depth + 1,
      boundTypeParameters,
      budget,
    );
    const constraint = await checkerTypeAbi(
      project,
      await type.getConstraint(),
      `${path}/constraint`,
      active,
      depth + 1,
      boundTypeParameters,
      budget,
    );

    if (base.kind === "unresolved" || constraint.kind === "unresolved")
      return base.kind === "unresolved" ? base : constraint;

    return {
      kind: "resolved",
      shape: { kind: "substitution", base: base.shape, constraint: constraint.shape },
    };
  }

  if (type.isTemplateLiteralType()) {
    const types: CheckerTypeShape[] = [];

    for (const [index, member] of (await type.getTypes()).entries()) {
      const result = await checkerTypeAbi(
        project,
        member,
        `${path}/span/${index}`,
        active,
        depth + 1,
        boundTypeParameters,
        budget,
      );

      if (result.kind === "unresolved") return result;

      types.push(result.shape);
    }

    return { kind: "resolved", shape: { kind: "template-literal", texts: type.texts, types } };
  }

  if (type.isStringMappingType()) {
    const operation = await checkerStringMappingOperation(project, type);

    if (!operation) return { kind: "unresolved", reason: "unsupported-type" };

    const target = await checkerTypeAbi(
      project,
      await type.getTarget(),
      `${path}/target`,
      active,
      depth + 1,
      boundTypeParameters,
      budget,
    );

    return target.kind === "resolved"
      ? { kind: "resolved", shape: { kind: "string-mapping", operation, target: target.shape } }
      : target;
  }

  if (type.isTypeParameter()) {
    const identity = boundTypeParameters.get(type.id);

    if (!identity && !type.isThisType) return { kind: "unresolved", reason: "type-parameter" };

    return checkerTypeParameterAbi(
      project,
      type,
      identity ?? `${path}/this`,
      path,
      active,
      depth,
      boundTypeParameters,
      budget,
    );
  }

  if (type.isUnionType() || type.isIntersectionType()) {
    const members = await type.getTypes();

    if (!members?.length) return { kind: "unresolved", reason: "checker-error" };

    const nextActive = new Map(active).set(type.id, path);
    const shapes: CheckerTypeShape[] = [];

    for (const [index, member] of members.entries()) {
      const result = await checkerTypeAbi(
        project,
        member,
        `${path}/${index}`,
        nextActive,
        depth + 1,
        boundTypeParameters,
        budget,
      );

      if (result.kind === "unresolved") return result;

      shapes.push(result.shape);
    }

    return {
      kind: "resolved",
      shape: { kind: type.isUnionType() ? "union" : "intersection", types: shapes },
    };
  }

  if (!(flags & TypeFlags.Object)) return { kind: "unresolved", reason: "unsupported-type" };

  const symbol = await type.getSymbol();
  const symbolName = symbol?.name;

  if (type.isTupleType()) {
    const tuple = type as TupleType;
    const target = await tuple.getTarget();
    const nextActive = new Map(active).set(type.id, path);
    const elements: CheckerTypeShape[] = [];

    for (const [index, element] of (await project.checker.getTypeArguments(tuple)).entries()) {
      const result = await checkerTypeAbi(
        project,
        element,
        `${path}/element/${index}`,
        nextActive,
        depth + 1,
        boundTypeParameters,
        budget,
      );

      if (result.kind === "unresolved") return result;

      elements.push(result.shape);
    }

    const targetSymbol = await target.getSymbol();
    const declarations = await checkerDeclarationShapes(project, [
      ...(symbol?.declarations ?? []),
      ...(targetSymbol?.declarations ?? []),
    ]);
    const surface = await checkerGenericObjectSurface(
      project,
      target,
      `${path}/surface`,
      active,
      depth + 1,
      boundTypeParameters,
      budget,
    );

    if (surface.kind === "unresolved") return surface;

    return {
      kind: "resolved",
      shape: {
        kind: "tuple",
        readonly: tuple.readonly,
        fixedLength: tuple.fixedLength,
        elementFlags: tuple.elementFlags,
        elements,
        declarations,
        surface: surface.shape,
      },
    };
  }

  if (await project.checker.isArrayType(type)) {
    if (!type.isTypeReference())
      return (
        (await checkerReferenceAbi(
          project,
          type,
          path,
          active,
          depth,
          boundTypeParameters,
          budget,
        )) ?? { kind: "unresolved", reason: "unsupported-type" }
      );

    const arguments_ = await project.checker.getTypeArguments(type);

    if (arguments_.length !== 1 || (symbolName !== "Array" && symbolName !== "ReadonlyArray"))
      return (
        (await checkerReferenceAbi(
          project,
          type,
          path,
          active,
          depth,
          boundTypeParameters,
          budget,
        )) ?? { kind: "unresolved", reason: "unsupported-type" }
      );

    const nextActive = new Map(active).set(type.id, path);
    const element = await checkerTypeAbi(
      project,
      arguments_[0]!,
      `${path}/element`,
      nextActive,
      depth + 1,
      boundTypeParameters,
      budget,
    );

    if (element.kind === "unresolved") return element;

    const declarations = await checkerDeclarationShapes(project, symbol?.declarations ?? []);

    if (!declarations.length) return { kind: "unresolved", reason: "checker-error" };

    const target = await type.getTarget();
    const surface = await checkerGenericObjectSurface(
      project,
      target,
      `${path}/surface`,
      active,
      depth + 1,
      boundTypeParameters,
      budget,
    );

    if (surface.kind === "unresolved") return surface;

    return {
      kind: "resolved",
      shape: {
        kind: "array",
        readonly: symbolName === "ReadonlyArray",
        element: element.shape,
        declarations,
        surface: surface.shape,
      },
    };
  }

  const reference = await checkerReferenceAbi(
    project,
    type,
    path,
    active,
    depth,
    boundTypeParameters,
    budget,
  );

  if (reference) return reference;

  return checkerObjectAbi(project, type, path, active, depth, boundTypeParameters, budget);
}

async function checkerRecursiveReferenceAbi(
  project: Project,
  type: Type,
  path: string,
  recursivePath: string,
  active: ReadonlyMap<number, string>,
  depth: number,
  boundTypeParameters: ReadonlyMap<number, string>,
  budget: { remaining: number },
): Promise<CheckerTypeAbi> {
  if (!type.isTypeReference())
    return { kind: "resolved", shape: { kind: "recursive", path: recursivePath } };

  const referenceArguments = await project.checker.getTypeArguments(type);
  const aliasArguments = await type.getAliasTypeArguments();
  const arguments_ = referenceArguments.length ? referenceArguments : aliasArguments;
  const argumentShapes: CheckerTypeShape[] = [];
  const nextActive = new Map(active).set(type.id, path);

  for (const [index, argument] of arguments_.entries()) {
    const result = await checkerTypeAbi(
      project,
      argument,
      `${path}/typearg/${index}`,
      nextActive,
      depth + 1,
      boundTypeParameters,
      budget,
    );

    if (result.kind === "unresolved") return result;

    argumentShapes.push(result.shape);
  }

  return {
    kind: "resolved",
    shape: {
      kind: "recursive",
      path: recursivePath,
      ...(argumentShapes.length ? { arguments: argumentShapes } : {}),
    },
  };
}

async function checkerReferenceAbi(
  project: Project,
  type: Type,
  path: string,
  active: ReadonlyMap<number, string>,
  depth: number,
  boundTypeParameters: ReadonlyMap<number, string>,
  budget: { remaining: number },
): Promise<CheckerTypeAbi | undefined> {
  const symbol = await type.getSymbol();

  const alias = await type.getAliasSymbol();

  if (!symbol && !alias) return undefined;

  const target =
    symbol && symbol.flags & SymbolFlags.Alias
      ? await project.checker.getAliasedSymbol(symbol)
      : symbol;
  const aliasTarget =
    alias && alias.flags & SymbolFlags.Alias
      ? await project.checker.getAliasedSymbol(alias)
      : alias;
  const declarations = [
    ...new Set([
      ...(symbol?.declarations ?? []),
      ...(target?.declarations ?? []),
      ...(alias?.declarations ?? []),
      ...(aliasTarget?.declarations ?? []),
    ]),
  ];

  if (!declarations.length) return undefined;

  if (await hasNominalDeclarationMembers(project, declarations))
    return { kind: "unresolved", reason: "nominal-member" };

  const declarationShapes = await checkerDeclarationShapes(project, declarations);

  if (declarationShapes.length !== declarations.length)
    return { kind: "unresolved", reason: "checker-error" };

  const referenceArguments = type.isTypeReference()
    ? await project.checker.getTypeArguments(type)
    : [];
  const arguments_ = referenceArguments.length
    ? referenceArguments
    : await type.getAliasTypeArguments();
  const argumentShapes: CheckerTypeShape[] = [];
  const nextActive = new Map(active).set(type.id, path);

  const referenceTarget = type.isTypeReference() ? await type.getTarget() : undefined;
  const genericTarget =
    referenceTarget && (referenceTarget.isTupleType() || referenceTarget.isClassOrInterface())
      ? referenceTarget
      : undefined;

  if (genericTarget) nextActive.set(genericTarget.id, `${path}/surface`);

  for (const [index, argument] of arguments_.entries()) {
    const result = await checkerTypeAbi(
      project,
      argument,
      `${path}/typearg/${index}`,
      nextActive,
      depth + 1,
      boundTypeParameters,
      budget,
    );

    if (result.kind === "unresolved") return result;

    argumentShapes.push(result.shape);
  }

  const bases: CheckerTypeShape[] = [];

  if (type.isClassOrInterface()) {
    for (const [index, base] of ((await type.getBaseTypes()) ?? []).entries()) {
      const baseShape = await checkerTypeAbi(
        project,
        base,
        `${path}/base/${index}`,
        nextActive,
        depth + 1,
        boundTypeParameters,
        budget,
      );

      if (baseShape.kind === "unresolved") return baseShape;

      bases.push(baseShape.shape);
    }
  }

  const surface = genericTarget
    ? await checkerGenericObjectSurface(
        project,
        genericTarget,
        `${path}/surface`,
        nextActive,
        depth + 1,
        boundTypeParameters,
        budget,
      )
    : await checkerObjectAbi(
        project,
        type,
        path,
        nextActive,
        depth + 1,
        boundTypeParameters,
        budget,
      );

  if (surface.kind === "unresolved") return surface;

  return {
    kind: "resolved",
    shape: {
      kind: "reference",
      declarations: declarationShapes.sort(
        (left, right) => left.filename.localeCompare(right.filename) || left.start - right.start,
      ),
      arguments: argumentShapes,
      bases,
      surface: surface.shape,
    },
  };
}

async function checkerGenericObjectSurface(
  project: Project,
  target: Type,
  path: string,
  active: ReadonlyMap<number, string>,
  depth: number,
  boundTypeParameters: ReadonlyMap<number, string>,
  budget: { remaining: number },
): Promise<CheckerObjectAbiResult> {
  let typeParameters: readonly TypeParameter[];

  if (target.isTupleType()) typeParameters = await target.getTypeParameters();
  else if (target.isClassOrInterface()) typeParameters = await target.getTypeParameters();
  else return { kind: "unresolved", reason: "unsupported-type" };

  const surfaceParameters = new Map(boundTypeParameters);

  for (const [index, parameter] of typeParameters.entries())
    surfaceParameters.set(parameter.id, `${path}/typeparam/${index}`);

  return checkerObjectAbi(project, target, path, active, depth, surfaceParameters, budget);
}

async function checkerTypeParameterAbi(
  project: Project,
  type: TypeParameter,
  identity: string,
  path: string,
  active: ReadonlyMap<number, string>,
  depth: number,
  boundTypeParameters: ReadonlyMap<number, string>,
  budget: { remaining: number },
): Promise<CheckerTypeAbi> {
  if (type.isThisType) {
    const constraint = await project.checker.getConstraintOfTypeParameter(type);

    if (!constraint) return { kind: "unresolved", reason: "type-parameter" };

    const constraintShape = await checkerTypeAbi(
      project,
      constraint,
      `${path}/this-constraint`,
      active,
      depth + 1,
      boundTypeParameters,
      budget,
    );

    if (constraintShape.kind === "unresolved") return constraintShape;

    return { kind: "resolved", shape: { kind: "this", constraint: constraintShape.shape } };
  }

  const symbol = await type.getSymbol();
  const declarations = await checkerDeclarationShapes(project, symbol?.declarations ?? []);

  if (!declarations.length) return { kind: "unresolved", reason: "checker-error" };

  const nextActive = new Map(active).set(type.id, path);
  const constraint = await project.checker.getConstraintOfTypeParameter(type);
  const constraintShape = constraint
    ? await checkerTypeAbi(
        project,
        constraint,
        `${path}/constraint`,
        nextActive,
        depth + 1,
        boundTypeParameters,
        budget,
      )
    : undefined;

  if (constraintShape?.kind === "unresolved") return constraintShape;

  let defaultShape: CheckerTypeAbi | undefined;

  for (const handle of symbol?.declarations ?? []) {
    const declaration = await handle.resolve(project);

    if (!declaration || !isTypeParameterDeclaration(declaration)) continue;

    const defaultTypeNode = declaration.defaultType;

    if (!defaultTypeNode) continue;

    const defaultType = await project.checker.getTypeFromTypeNode(defaultTypeNode);

    if (!defaultType) return { kind: "unresolved", reason: "checker-error" };

    defaultShape = await checkerTypeAbi(
      project,
      defaultType,
      `${path}/default`,
      nextActive,
      depth + 1,
      boundTypeParameters,
      budget,
    );
    break;
  }

  if (defaultShape?.kind === "unresolved") return defaultShape;

  return {
    kind: "resolved",
    shape: {
      kind: "type-parameter",
      identity,
      declarations,
      ...(constraintShape?.kind === "resolved" ? { constraint: constraintShape.shape } : {}),
      ...(defaultShape?.kind === "resolved" ? { default: defaultShape.shape } : {}),
    },
  };
}

async function checkerObjectAbi(
  project: Project,
  type: Type,
  path: string,
  active: ReadonlyMap<number, string>,
  depth: number,
  boundTypeParameters: ReadonlyMap<number, string>,
  budget: { remaining: number },
): Promise<CheckerObjectAbiResult> {
  const properties = await project.checker.getPropertiesOfType(type);
  const nextActive = new Map(active).set(type.id, path);
  const propertyShapes: CheckerPropertyShape[] = [];

  for (const property of properties) {
    const resolved = await Promise.all(
      property.declarations.map((declaration) => declaration.resolve(project)),
    );
    const declarations = await checkerDeclarationShapes(project, property.declarations);
    const declarationNodes = resolved.filter(
      (declaration): declaration is Node => declaration !== undefined,
    );

    if (
      declarationNodes.some((declaration) => {
        const member = declaration as TypeMemberNode;

        return (
          member.name?.kind === SyntaxKind.PrivateIdentifier ||
          member.modifiers?.some(
            (modifier) =>
              modifier.kind === SyntaxKind.PrivateKeyword ||
              modifier.kind === SyntaxKind.ProtectedKeyword,
          ) === true
        );
      })
    )
      return { kind: "unresolved", reason: "nominal-member" };

    const name =
      declarationNodes
        .map((declaration) =>
          (declaration as TypeMemberNode).name?.getText(declaration.getSourceFile()),
        )
        .find((value) => value !== undefined) ?? String(property.name);

    if (String(property.name).startsWith("__#") || name.startsWith("#"))
      return { kind: "unresolved", reason: "nominal-member" };

    if (
      (name.startsWith("__@") || name.startsWith("[")) &&
      !(await isTrustedWellKnownSymbolMember(project, declarationNodes))
    )
      return { kind: "unresolved", reason: "symbol-member" };

    const memberType = await project.checker.getTypeOfSymbol(property);

    if (!memberType || declarations.length !== property.declarations.length)
      return { kind: "unresolved", reason: "checker-error" };

    const member = await checkerTypeAbi(
      project,
      memberType,
      `${path}/${name}`,
      nextActive,
      depth + 1,
      boundTypeParameters,
      budget,
    );

    if (member.kind === "unresolved") return member;

    propertyShapes.push({
      name,
      declarations,
      optional: Boolean(property.flags & SymbolFlags.Optional),
      readonly: declarationNodes.some((declaration) =>
        (declaration as TypeMemberNode).modifiers?.some(
          (modifier) => modifier.kind === SyntaxKind.ReadonlyKeyword,
        ),
      ),
      type: member.shape,
    });
  }

  const signatures: CheckerSignatureShape[][] = [];

  for (const kind of [SignatureKind.Call, SignatureKind.Construct]) {
    const shapes: CheckerSignatureShape[] = [];

    for (const signature of await project.checker.getSignaturesOfType(type, kind)) {
      const declaration = (await signature.declaration?.resolve(project)) as
        | FunctionLikeNode
        | undefined;

      if (!declaration) return { kind: "unresolved", reason: "checker-error" };

      const typeParameters = await signature.getTypeParameters();
      const signatureTypeParameters = new Map(boundTypeParameters);

      for (const [index, parameter] of typeParameters.entries())
        signatureTypeParameters.set(parameter.id, `${path}/typeparam/${index}`);

      const typeParameterShapes: CheckerTypeShape[] = [];

      for (const [index, parameter] of typeParameters.entries()) {
        const parameterShape = await checkerTypeAbi(
          project,
          parameter,
          `${path}/typeparam/${index}`,
          nextActive,
          depth + 1,
          signatureTypeParameters,
          budget,
        );

        if (parameterShape.kind === "unresolved") return parameterShape;

        typeParameterShapes.push(parameterShape.shape);
      }

      const parameters: CheckerSignatureShape["parameters"][number][] = [];

      for (const [index, parameter] of (declaration.parameters ?? []).entries()) {
        const parameterNode = parameter as TypeMemberNode;
        const parameterType = await project.checker.getParameterType(signature, index);

        if (!parameterType) return { kind: "unresolved", reason: "checker-error" };

        const parameterShape = await checkerTypeAbi(
          project,
          parameterType,
          `${path}/arg/${index}`,
          nextActive,
          depth + 1,
          signatureTypeParameters,
          budget,
        );

        if (parameterShape.kind === "unresolved") return parameterShape;

        parameters.push({
          optional:
            parameterNode.questionToken !== undefined || parameterNode.initializer !== undefined,
          rest: parameterNode.dotDotDotToken !== undefined,
          type: parameterShape.shape,
        });
      }

      const returnType = await project.checker.getReturnTypeOfSignature(signature);

      if (!returnType) return { kind: "unresolved", reason: "checker-error" };

      const returnShape = await checkerTypeAbi(
        project,
        returnType,
        `${path}/return`,
        nextActive,
        depth + 1,
        signatureTypeParameters,
        budget,
      );

      if (returnShape.kind === "unresolved") return returnShape;

      const declarations = await checkerDeclarationShapes(project, [signature.declaration!]);

      if (!declarations.length) return { kind: "unresolved", reason: "checker-error" };

      const thisParameter = await signature.getThisParameter();
      const thisType = thisParameter
        ? await project.checker.getTypeOfSymbol(thisParameter)
        : undefined;
      const thisShape = thisType
        ? await checkerTypeAbi(
            project,
            thisType,
            `${path}/this`,
            nextActive,
            depth + 1,
            signatureTypeParameters,
            budget,
          )
        : undefined;

      if (thisShape?.kind === "unresolved") return thisShape;

      const predicate = await project.checker.getTypePredicateOfSignature(signature);
      const predicateType = predicate?.type
        ? await checkerTypeAbi(
            project,
            predicate.type,
            `${path}/predicate`,
            nextActive,
            depth + 1,
            signatureTypeParameters,
            budget,
          )
        : undefined;

      if (predicateType?.kind === "unresolved") return predicateType;

      shapes.push({
        declarations,
        typeParameters: typeParameterShapes,
        ...(thisShape?.kind === "resolved" ? { thisType: thisShape.shape } : {}),
        parameters,
        ...(predicate
          ? {
              predicate: {
                kind: predicate.kind,
                ...("parameterName" in predicate && predicate.parameterName !== undefined
                  ? { parameterName: predicate.parameterName }
                  : {}),
                ...("parameterIndex" in predicate && predicate.parameterIndex !== undefined
                  ? { parameterIndex: predicate.parameterIndex }
                  : {}),
                ...(predicateType?.kind === "resolved" ? { type: predicateType.shape } : {}),
              },
            }
          : {}),
        returns: returnShape.shape,
      });
    }

    signatures.push(shapes);
  }

  const indexes = [] as CheckerObjectShape["indexes"] extends readonly (infer I)[] ? I[] : never;

  for (const info of await project.checker.getIndexInfosOfType(type)) {
    const key = await checkerTypeAbi(
      project,
      info.keyType,
      `${path}/index-key`,
      nextActive,
      depth + 1,
      boundTypeParameters,
      budget,
    );
    const value = await checkerTypeAbi(
      project,
      info.valueType,
      `${path}/index-value`,
      nextActive,
      depth + 1,
      boundTypeParameters,
      budget,
    );

    if (key.kind === "unresolved") return key;
    if (value.kind === "unresolved") return value;

    const declaration = info.declaration
      ? (await checkerDeclarationShapes(project, [info.declaration]))[0]
      : undefined;

    indexes.push({
      key: key.shape,
      readonly: info.isReadonly,
      type: value.shape,
      ...(declaration ? { declaration } : {}),
    });
  }

  return {
    kind: "resolved",
    shape: {
      kind: "object",
      properties: propertyShapes,
      calls: signatures[0]!,
      constructs: signatures[1]!,
      indexes,
    },
  };
}

async function checkerStringMappingOperation(
  project: Project,
  type: Type,
): Promise<"Uppercase" | "Lowercase" | "Capitalize" | "Uncapitalize" | undefined> {
  const intrinsic = await type.getSymbol();
  const operation = intrinsic?.name;

  if (
    operation !== "Uppercase" &&
    operation !== "Lowercase" &&
    operation !== "Capitalize" &&
    operation !== "Uncapitalize"
  )
    return undefined;

  const declarations = intrinsic
    ? await Promise.all(intrinsic.declarations.map((declaration) => declaration.resolve(project)))
    : [];

  if (
    !declarations.length ||
    declarations.some(
      (declaration) =>
        declaration?.kind !== SyntaxKind.TypeAliasDeclaration ||
        (declaration as NamedTypeDeclarationNode).name?.getText(declaration.getSourceFile()) !==
          operation,
    )
  )
    return undefined;

  for (const declaration of declarations)
    if (!(await project.program.isSourceFileDefaultLibrary(declaration!.getSourceFile())))
      return undefined;

  return operation;
}

async function hasNominalDeclarationMembers(
  project: Project,
  declarations: readonly { resolve(project: Project): Promise<Node | undefined> }[],
): Promise<boolean> {
  for (const handle of declarations) {
    const declaration = await handle.resolve(project);

    if (
      !declaration ||
      (declaration.kind !== SyntaxKind.ClassDeclaration &&
        declaration.kind !== SyntaxKind.ClassExpression)
    )
      continue;

    for (const member of (declaration as ClassLikeNode).members ?? []) {
      const node = member as TypeMemberNode;

      if (
        node.name?.kind === SyntaxKind.PrivateIdentifier ||
        node.modifiers?.some(
          (modifier) =>
            modifier.kind === SyntaxKind.PrivateKeyword ||
            modifier.kind === SyntaxKind.ProtectedKeyword,
        )
      )
        return true;
    }
  }

  return false;
}

async function isTrustedWellKnownSymbolMember(
  project: Project,
  declarations: readonly Node[],
): Promise<boolean> {
  if (!declarations.length) return false;

  for (const declaration of declarations) {
    const computed = (declaration as TypeMemberNode).name as ComputedNameNode | undefined;
    const access = computed?.expression as PropertyAccessNode | undefined;

    if (
      !computed ||
      computed.kind !== SyntaxKind.ComputedPropertyName ||
      !access ||
      access.kind !== SyntaxKind.PropertyAccessExpression ||
      !access.expression ||
      !access.name ||
      access.expression.kind !== SyntaxKind.Identifier ||
      access.expression.getText(access.expression.getSourceFile()) !== "Symbol"
    )
      return false;

    const memberName = access.name.getText(access.name.getSourceFile());

    if (
      memberName !== "iterator" &&
      memberName !== "asyncIterator" &&
      memberName !== "toStringTag" &&
      memberName !== "unscopables" &&
      memberName !== "dispose"
    )
      return false;

    const binding = await project.checker.getSymbolAtLocation(access.expression);

    if (!binding) return false;

    const target =
      binding.flags & SymbolFlags.Alias ? await project.checker.getAliasedSymbol(binding) : binding;
    const symbolType = await project.checker.getTypeOfSymbol(target);
    const selected = symbolType
      ? await project.checker.getPropertyOfType(symbolType, memberName)
      : undefined;
    const referenced = await project.checker.getSymbolAtLocation(access.name);

    if (!selected || !referenced || selected.id !== referenced.id || !selected.declarations.length)
      return false;

    const selectedDeclarations = await Promise.all(
      selected.declarations.map((handle) => handle.resolve(project)),
    );

    if (selectedDeclarations.length !== selected.declarations.length) return false;

    const intrinsicOwners: InterfaceDeclaration[] = [];
    const redeclarations: PropertySignatureDeclaration[] = [];

    for (const selectedDeclaration of selectedDeclarations) {
      if (!selectedDeclaration || !isPropertySignatureDeclaration(selectedDeclaration))
        return false;

      const owner = selectedDeclaration.parent;

      if (
        !owner ||
        !isInterfaceDeclaration(owner) ||
        owner.name.text !== "SymbolConstructor" ||
        !owner.parent ||
        !isSourceFile(owner.parent)
      )
        return false;

      if (await project.program.isSourceFileDefaultLibrary(selectedDeclaration.getSourceFile()))
        intrinsicOwners.push(owner);
      else redeclarations.push(selectedDeclaration);
    }

    const intrinsicOwner = intrinsicOwners[0];

    if (!intrinsicOwner) return false;

    if (redeclarations.length) {
      const intrinsicOwnerSymbol = await project.checker.getSymbolAtLocation(intrinsicOwner.name);

      if (!intrinsicOwnerSymbol) return false;

      for (const declaration of redeclarations)
        if (
          !(await isIntrinsicSymbolRedeclaration(
            project,
            declaration,
            memberName,
            selected,
            intrinsicOwnerSymbol,
          ))
        )
          return false;
    }
  }

  return true;
}

async function isIntrinsicSymbolRedeclaration(
  project: Project,
  declaration: PropertySignatureDeclaration,
  memberName: string,
  intrinsicMember: Symbol,
  intrinsicOwner: Symbol,
): Promise<boolean> {
  if (
    !isIdentifier(declaration.name) ||
    declaration.name.text !== memberName ||
    declaration.postfixToken ||
    !declaration.modifiers?.some((modifier) => modifier.kind === SyntaxKind.ReadonlyKeyword) ||
    !isTypeOperatorNode(declaration.type) ||
    declaration.type.operator !== SyntaxKind.UniqueKeyword ||
    declaration.type.type.kind !== SyntaxKind.SymbolKeyword
  )
    return false;

  const source = declaration.getSourceFile();
  const owner = declaration.parent;

  if (
    !source.isDeclarationFile ||
    !owner ||
    !isInterfaceDeclaration(owner) ||
    owner.name.text !== "SymbolConstructor" ||
    !owner.parent ||
    !isSourceFile(owner.parent)
  )
    return false;

  const ownerSymbol = await project.checker.getSymbolAtLocation(owner.name);
  const memberSymbol = await project.checker.getSymbolAtLocation(declaration.name);

  return ownerSymbol?.id === intrinsicOwner.id && memberSymbol?.id === intrinsicMember.id;
}

async function checkerDeclarationShapes(
  project: Project,
  handles: readonly { resolve(project: Project): Promise<Node | undefined> }[],
): Promise<CheckerTypeDeclarationShape[]> {
  const shapes = new Map<string, CheckerTypeDeclarationShape>();

  for (const handle of handles) {
    const declaration = await handle.resolve(project);

    if (!declaration) continue;

    const sourceFile = declaration.getSourceFile();
    const start = declaration.getStart(sourceFile);
    const end = declaration.getEnd();
    const key = `${sourceFile.fileName}\0${declaration.kind}\0${start}\0${end}`;

    if (shapes.has(key)) continue;

    shapes.set(key, {
      filename: sourceFile.fileName,
      kind: declaration.kind,
      start,
      end,
      source: declaration.getText(sourceFile),
    });
  }

  return [...shapes.values()].sort(
    (left, right) =>
      left.filename.localeCompare(right.filename) ||
      left.start - right.start ||
      left.end - right.end,
  );
}

export type {
  CheckerTypeAbi as StructuralTypeResolution,
  CheckerTypeShape as StructuralTypeShape,
  CheckerTypeDeclarationShape as StructuralDeclarationShape,
  CheckerObjectShape as StructuralObjectShape,
};

export type TypeEvidenceFailure =
  | "checker-error"
  | "unsupported-anchor"
  | "free-instantiation"
  | "inferred-dependency"
  | "incomplete-capture"
  | "capture-changed"
  | "ambiguous-join"
  | "nominal-origin"
  | "symbol-origin"
  | "unsupported-type"
  | "limit";

export type CheckedTypeEvidence =
  | {
      readonly kind: "structural";
      readonly schema: 1;
      readonly algorithm: "ts-shape-v1";
      readonly digest: string;
      /** Full native shape and declaration provenance stay in the private checked cohort. */
      readonly shape: CheckerTypeShape;
    }
  | { readonly kind: "unproved"; readonly reason: TypeEvidenceFailure };

export interface ComponentPropTypeEvidence {
  readonly mapped: Readonly<Record<string, CheckedTypeEvidence>>;
  readonly authored?: Readonly<Record<string, CheckedTypeEvidence>>;
}

export interface ComponentPropsTypeEvidence {
  readonly byParameterStart: Readonly<Record<string, ComponentPropTypeEvidence>>;
}

const propTypeEvidence = new WeakMap<object, ComponentPropsTypeEvidence>();

/** Internal association used only by the native prop analyzer and the sealed project issuer. */
export function retainComponentPropsTypeEvidence(
  analysis: object,
  evidence: ComponentPropsTypeEvidence,
): void {
  if (propTypeEvidence.has(analysis))
    throw new Error("Component type evidence was already retained.");

  propTypeEvidence.set(analysis, freezeComponentPropsTypeEvidence(evidence));
}

function componentPropsTypeEvidence(analysis: object): ComponentPropsTypeEvidence | undefined {
  return propTypeEvidence.get(analysis);
}

async function resolveStructuralType(project: Project, type: Type): Promise<CheckerTypeAbi> {
  return checkerTypeAbi(project, type);
}

function checkedTypeEvidence(type: CheckerTypeAbi): CheckedTypeEvidence {
  if (type.kind === "unresolved") {
    const reason: TypeEvidenceFailure =
      type.reason === "checker-error"
        ? "checker-error"
        : type.reason === "recursive-depth"
          ? "limit"
          : type.reason === "type-parameter"
            ? "free-instantiation"
            : type.reason === "nominal-member"
              ? "nominal-origin"
              : type.reason === "symbol-member"
                ? "symbol-origin"
                : "unsupported-type";

    return Object.freeze({ kind: "unproved", reason });
  }

  const normalized = semanticStructuralShape(type.shape);
  const digest = `sha256-${createHash("sha256").update(JSON.stringify(normalized)).digest("hex")}`;

  return Object.freeze({
    kind: "structural",
    schema: 1,
    algorithm: "ts-shape-v1",
    digest,
    shape: deepFreeze(type.shape),
  });
}

export async function captureStructuralEvidence(
  project: Project,
  type: Type,
): Promise<CheckedTypeEvidence> {
  try {
    return checkedTypeEvidence(await resolveStructuralType(project, type));
  } catch {
    return Object.freeze({ kind: "unproved", reason: "checker-error" });
  }
}

export type CompiledTypeEvidence =
  | {
      readonly kind: "structural";
      readonly schema: 1;
      readonly algorithm: "ts-shape-v1";
      readonly digest: string;
    }
  | {
      readonly kind: "unchanged-inputs";
      readonly schema: 1;
      readonly algorithm: "closed-type-inputs-v1";
      readonly queryDigest: string;
      readonly inputsDigest: string;
    }
  | { readonly kind: "unproved"; readonly reason: TypeEvidenceFailure };

function freezeComponentPropsTypeEvidence(
  evidence: ComponentPropsTypeEvidence,
): ComponentPropsTypeEvidence {
  const byParameterStart = Object.create(null) as Record<string, ComponentPropTypeEvidence>;

  for (const [parameterStart, record] of Object.entries(evidence.byParameterStart)) {
    byParameterStart[parameterStart] = Object.freeze({
      mapped: Object.freeze({ ...record.mapped }),
      ...(record.authored ? { authored: Object.freeze({ ...record.authored }) } : {}),
    });
  }

  return Object.freeze({ byParameterStart: Object.freeze(byParameterStart) });
}

function deepFreeze<T>(value: T): T {
  if (Array.isArray(value)) {
    for (const item of value) deepFreeze(item);
    return Object.freeze(value) as T;
  }

  if (typeof value !== "object" || value === null) return value;

  for (const item of Object.values(value as Record<string, unknown>)) deepFreeze(item);

  return Object.freeze(value);
}

export type TypingHostOperation =
  | "readFile"
  | "fileExists"
  | "directoryExists"
  | "getAccessibleEntries"
  | "realpath";

export interface TypingHostObservation {
  readonly operation: TypingHostOperation;
  readonly path: string;
  readonly result:
    | string
    | boolean
    | null
    | undefined
    | {
        readonly files: readonly string[];
        readonly directories: readonly string[];
      };
}

export class TypingHostObservationRecorder {
  readonly #observations: TypingHostObservation[] = [];
  #closed = false;
  #lateObservation = false;
  #delegated = false;

  record(observation: TypingHostObservation): void {
    if (this.#closed) {
      this.#lateObservation = true;
      return;
    }

    if (observation.result === undefined) this.#delegated = true;

    const result =
      observation.operation === "readFile" && typeof observation.result === "string"
        ? sourceDigest(observation.result)
        : observation.result;

    this.#observations.push(
      deepFreeze({
        ...observation,
        result,
        ...(typeof result === "object" && result !== null
          ? {
              result: {
                files: [...result.files],
                directories: [...result.directories],
              },
            }
          : {}),
      }),
    );
  }

  close(): void {
    this.#closed = true;
  }

  snapshot(): {
    readonly observations: readonly TypingHostObservation[];
    readonly delegated: boolean;
    readonly lateObservation: boolean;
  } {
    return Object.freeze({
      observations: Object.freeze([...this.#observations]),
      delegated: this.#delegated,
      lateObservation: this.#lateObservation,
    });
  }
}

const typingEvidenceCaptureRequests = new WeakSet<object>();

/** @internal Mark one actual checker options object for compiler-owned evidence capture. */
export function requestTypingEvidenceCapture<T extends ProjectCheckingOptions>(options: T): T {
  typingEvidenceCaptureRequests.add(options);
  return options;
}

export function hasRequestedTypingEvidenceCapture(options: ProjectCheckingOptions): boolean {
  return typingEvidenceCaptureRequests.has(options);
}

export interface CapturedTypingSourceFile {
  readonly filename: string;
  readonly source: string;
  readonly digest: string;
  readonly isDefaultLibrary: boolean;
  readonly isFromExternalLibrary: boolean;
  readonly packageJsonType: string;
  readonly packageJsonDirectory: string;
  readonly impliedNodeFormat: number;
}

export interface TypingInputEnvironment {
  readonly state: "incomplete-capture";
  readonly snapshotId: number;
  readonly projectId: string;
  readonly configFileName: string;
  readonly projectInputs: {
    readonly root: string;
    readonly additionalFiles: readonly {
      readonly filename: string;
      readonly source: string;
      readonly digest: string;
    }[];
    readonly checkingRoots: readonly {
      readonly filename: string;
      readonly source: string;
      readonly digest: string;
    }[];
    readonly resolutionOverrides: Readonly<Record<string, string>>;
    readonly allowUnsafeHTML: boolean;
    readonly allowUnsafeEmbed: boolean;
    readonly documentShell: boolean;
    readonly browserTarget: boolean;
    readonly runtimeModule?: string;
    readonly styleRuntimeModule?: string;
    readonly styledEntryIds: readonly string[];
    readonly styleShellEntryId?: string;
    readonly styleIdentityRoot?: string;
    readonly externalResolverProvided: boolean;
  };
  readonly checkingInputs: readonly {
    readonly filename: string;
    readonly source: string;
    readonly digest: string;
    readonly digestMatchesSource: boolean;
  }[];
  readonly rootFiles: readonly string[];
  readonly projectCompilerOptions: Readonly<Record<string, unknown>>;
  readonly programCompilerOptions: Readonly<Record<string, unknown>>;
  readonly sourceFiles: readonly CapturedTypingSourceFile[];
  readonly host: {
    readonly observations: readonly TypingHostObservation[];
    readonly delegated: boolean;
    readonly lateObservation: boolean;
  };
  readonly typeScriptVersion: string;
  readonly nativeExecutableIdentity: "unobserved-default";
  readonly gaps: readonly string[];
}

export async function captureTypingInputEnvironment(
  project: Project,
  snapshotId: number,
  root: string,
  options: ProjectCheckingOptions,
  checkingInputs: CheckingInputSnapshot,
  host: TypingHostObservationRecorder,
  additionalGaps: readonly string[],
  sessionOwned: () => boolean,
): Promise<TypingInputEnvironment> {
  const gaps = new Set<string>([
    "query-capsules-not-sealed",
    "native-executable-identity-unobserved",
    ...additionalGaps,
  ]);
  let projectCompilerOptions: Readonly<Record<string, unknown>> = Object.freeze({});
  let programCompilerOptions: Readonly<Record<string, unknown>> = Object.freeze({});
  const sourceFiles: CapturedTypingSourceFile[] = [];
  let rootFiles: readonly string[] = Object.freeze([]);

  try {
    if (!sessionOwned()) gaps.add("final-program-owner-changed");

    projectCompilerOptions = freezeCaptureValue(project.compilerOptions);
    programCompilerOptions = freezeCaptureValue(project.program.getCompilerOptions());
    rootFiles = Object.freeze([...project.rootFiles]);
  } catch {
    gaps.add("final-compiler-options-unavailable");
  }

  try {
    if (sessionOwned()) {
      const filenames = await project.program.getSourceFileNames();

      if (!sessionOwned()) {
        gaps.add("final-program-owner-changed");
        gaps.add("final-program-inventory-abandoned");
      } else {
        for (const filename of filenames) {
          if (!sessionOwned()) {
            gaps.add("final-program-owner-changed");
            break;
          }

          try {
            const source = await project.program.getSourceFile(filename);

            if (!sessionOwned()) {
              gaps.add("final-program-owner-changed");
              break;
            }

            const metadata = await project.program.getSourceFileMetadata(filename);

            if (!sessionOwned()) {
              gaps.add("final-program-owner-changed");
              break;
            }

            if (!source || !metadata) {
              gaps.add("final-program-source-missing");
              continue;
            }

            sourceFiles.push(
              Object.freeze({
                filename,
                source: source.text,
                digest: sourceDigest(source.text),
                isDefaultLibrary: metadata.isDefaultLibrary,
                isFromExternalLibrary: metadata.isFromExternalLibrary,
                packageJsonType: metadata.packageJsonType,
                packageJsonDirectory: metadata.packageJsonDirectory,
                impliedNodeFormat: metadata.impliedNodeFormat,
              }),
            );
          } catch {
            gaps.add(
              sessionOwned()
                ? "final-program-source-unavailable"
                : "final-program-owner-changed",
            );

            if (!sessionOwned()) break;
          }
        }
      }
    } else gaps.add("final-program-owner-changed");
  } catch {
    gaps.add(
      sessionOwned()
        ? "final-program-inventory-unavailable"
        : "final-program-owner-changed",
    );
  }

  const hostSnapshot = host.snapshot();

  if (hostSnapshot.delegated) gaps.add("native-filesystem-fallback");
  if (hostSnapshot.lateObservation) gaps.add("late-filesystem-observation");

  return Object.freeze({
    state: "incomplete-capture",
    snapshotId,
    projectId: String(project.id),
    configFileName: project.configFileName,
    projectInputs: Object.freeze({
      root,
      additionalFiles: Object.freeze(
        (options.additionalFiles ?? []).map((file) =>
          Object.freeze({
            filename: file.filename,
            source: file.source,
            digest: sourceDigest(file.source),
          }),
        ),
      ),
      checkingRoots: Object.freeze(
        (options.checkingRoots ?? []).map((file) =>
          Object.freeze({
            filename: file.filename,
            source: file.source,
            digest: sourceDigest(file.source),
          }),
        ),
      ),
      resolutionOverrides: Object.freeze({ ...options.resolutionOverrides?.browser }),
      allowUnsafeHTML: options.allowUnsafeHTML === true,
      allowUnsafeEmbed: options.allowUnsafeEmbed === true,
      documentShell: options.documentShell === true,
      browserTarget: options.browserTarget === true,
      ...(options.runtimeModule ? { runtimeModule: options.runtimeModule } : {}),
      ...(options.styleRuntimeModule ? { styleRuntimeModule: options.styleRuntimeModule } : {}),
      styledEntryIds: Object.freeze([...(options.styledEntryIds ?? [])]),
      ...(options.styleShellEntryId ? { styleShellEntryId: options.styleShellEntryId } : {}),
      ...(options.styleIdentityRoot ? { styleIdentityRoot: options.styleIdentityRoot } : {}),
      externalResolverProvided: options.resolution !== undefined,
    }),
    checkingInputs: Object.freeze(
      checkingInputs.captured.map(({ filename, source, digest }) => {
        const digestMatchesSource = digest === sourceDigest(source);
        if (!digestMatchesSource) gaps.add("checking-input-digest-mismatch");
        return Object.freeze({ filename, source, digest, digestMatchesSource });
      }),
    ),
    rootFiles,
    projectCompilerOptions,
    programCompilerOptions,
    sourceFiles: Object.freeze(sourceFiles),
    host: hostSnapshot,
    typeScriptVersion,
    nativeExecutableIdentity: "unobserved-default",
    gaps: Object.freeze([...gaps].sort()),
  });
}

export type CheckedPropsEvidence =
  | { readonly kind: "none" }
  | {
      readonly kind: "props";
      readonly entries: readonly {
        readonly name: string;
        readonly category: string;
        readonly optional: boolean;
        readonly mappedType: CheckedTypeEvidence;
        readonly authoredType?: CheckedTypeEvidence;
      }[];
    }
  | { readonly kind: "unproved"; readonly reason: TypeEvidenceFailure };

export interface CheckedComponentTypingEvidence {
  readonly canonicalPath: readonly (string | number)[];
  readonly emittedPath?: readonly (string | number)[];
  readonly canonicalSpan: { readonly start: number; readonly end: number };
  readonly emittedSpan?: { readonly start: number; readonly end: number };
  readonly parameterStart?: number;
  readonly parameterEnd?: number;
  readonly emittedParameterStart?: number;
  readonly parameterOrdinal: 0;
  readonly emittedComponentJoin: "matched" | "ambiguous" | "missing";
  readonly props: CheckedPropsEvidence;
}

export interface SealedModuleTypingEvidence {
  readonly filename: string;
  readonly nativeFilename: string;
  readonly sourceJoin: boolean;
  readonly checkingAnalysisAvailable: boolean;
  readonly emittedModuleAvailable: boolean;
  readonly sourceDigest: string;
  readonly checkingViewDigest: string;
  readonly checkedSemanticHash: string;
  readonly checkedIrDigest: string;
  readonly checkedMetadataDigest: string;
  readonly emittedCodeDigest: string;
  readonly emittedSemanticHash: string;
  readonly emittedIrDigest: string;
  readonly renderPlanJoin: "unavailable";
  readonly components: readonly CheckedComponentTypingEvidence[];
}

export interface SealedProjectTypingEvidence {
  readonly schema: 1;
  readonly state: "sealed";
  readonly snapshotId: number;
  readonly captureState: "incomplete-capture";
  readonly environment: TypingInputEnvironment;
  readonly modules: readonly SealedModuleTypingEvidence[];
  readonly certificates: readonly [];
  readonly projectPolicy: {
    readonly kind: "unproved";
    readonly reason: "missing-policy";
  };
  readonly unavailableTypeLocations: readonly (
    | "state-value"
    | "native-markup-context"
    | "native-binding"
    | "route-role-reference"
    | "render-plan-preservation"
  )[];
  readonly checkingHasErrors: boolean;
  readonly emissionHasErrors: boolean;
  readonly checkingResultJoin: boolean;
  readonly analysisJoin: boolean;
  readonly modulePopulationJoin: boolean;
}

interface CompilationBinding {
  readonly evidence: SealedProjectTypingEvidence;
  readonly compilationKeys: readonly PropertyKey[];
  readonly checkingKeys: readonly PropertyKey[];
  readonly checking: ProjectCompilation["checking"];
  readonly modules: ProjectCompilation["modules"];
  readonly moduleOutputs: readonly {
    readonly filename: string;
    readonly keys: readonly PropertyKey[];
    readonly result: CompileResult;
    readonly fingerprint: string;
    readonly diagnosticsFingerprint: string;
  }[];
  readonly checkingFingerprint: string;
  readonly host: TypingHostObservationRecorder;
}

interface CheckingSessionTypingState {
  readonly project: Project;
  readonly environment: TypingInputEnvironment;
  readonly snapshotId: number;
  readonly modules: readonly VirtualModule[];
  readonly views: readonly {
    readonly filename: string;
    readonly nativeFilename: string;
    readonly source: string;
  }[];
  readonly analyses: ReadonlyMap<string, ModuleAnalysis>;
  readonly resultGetter: (() => ProjectCheckingResult) | undefined;
  readonly isDisposed: () => boolean;
  readonly analysisEntries: readonly {
    readonly filename: string;
    readonly analysis: ModuleAnalysis;
    readonly result: ModuleAnalysis["result"];
    readonly componentProps: ModuleAnalysis["componentProps"];
    readonly normalized: ModuleAnalysis["normalized"];
    readonly operationCalls: ModuleAnalysis["operationCalls"];
    readonly mapOffset: ModuleAnalysis["mapOffset"];
    readonly fingerprint: string;
  }[];
  readonly baselineCheckingFingerprint: string;
  readonly baselineHasErrors: boolean;
  readonly host: TypingHostObservationRecorder;
}

const sessionTypingState = new WeakMap<CheckingSession, CheckingSessionTypingState>();
const compilationTypingBinding = new WeakMap<ProjectCompilation, CompilationBinding>();

export function registerCheckingSessionTypingState(
  session: CheckingSession,
  input: {
    readonly project: Project;
    readonly environment: TypingInputEnvironment;
    readonly snapshotId: number;
    readonly modules: readonly VirtualModule[];
    readonly views: readonly {
      readonly filename: string;
      readonly nativeFilename: string;
      readonly source: string;
    }[];
    readonly analyses: ReadonlyMap<string, ModuleAnalysis>;
    readonly baseline: ProjectCheckingResult;
    readonly host: TypingHostObservationRecorder;
    readonly isDisposed: () => boolean;
  },
): void {
  try {
    registerCheckingSessionTypingStateUnchecked(session, input);
  } catch {
    sessionTypingState.delete(session);
  }
}

function registerCheckingSessionTypingStateUnchecked(
  session: CheckingSession,
  input: {
    readonly project: Project;
    readonly environment: TypingInputEnvironment;
    readonly snapshotId: number;
    readonly modules: readonly VirtualModule[];
    readonly views: readonly {
      readonly filename: string;
      readonly nativeFilename: string;
      readonly source: string;
    }[];
    readonly analyses: ReadonlyMap<string, ModuleAnalysis>;
    readonly baseline: ProjectCheckingResult;
    readonly host: TypingHostObservationRecorder;
    readonly isDisposed: () => boolean;
  },
): void {
  const modules = Object.freeze(
    input.modules.map(({ filename, source }) => Object.freeze({ filename, source })),
  );
  const views = Object.freeze(
    input.views.map(({ filename, nativeFilename, source }) =>
      Object.freeze({ filename, nativeFilename, source }),
    ),
  );
  const analysisEntries = Object.freeze(
    [...input.analyses].map(([filename, analysis]) =>
      Object.freeze({
        filename,
        analysis,
        result: analysis.result,
        componentProps: analysis.componentProps,
        normalized: analysis.normalized,
        operationCalls: analysis.operationCalls,
        mapOffset: analysis.mapOffset,
        fingerprint: moduleAnalysisFingerprint(analysis),
      }),
    ),
  );
  const resultGetter = Object.getOwnPropertyDescriptor(session, "result")?.get;

  if (!resultGetter) return;

  sessionTypingState.set(
    session,
    Object.freeze({
      project: input.project,
      environment: input.environment,
      snapshotId: input.snapshotId,
      modules,
      views,
      analyses: input.analyses,
      resultGetter,
      isDisposed: input.isDisposed,
      analysisEntries,
      baselineCheckingFingerprint: fingerprintCheckingResult(input.baseline),
      baselineHasErrors: input.baseline.diagnostics.some((item) => item.severity === "error"),
      host: input.host,
    }),
  );
}

export function sealProjectTypingEvidence(
  session: CheckingSession,
  checkingAtEmission: ProjectCheckingResult,
  compilation: ProjectCompilation,
): void {
  try {
    sealProjectTypingEvidenceUnchecked(session, checkingAtEmission, compilation);
  } catch {
    sessionTypingState.delete(session);
  }
}

function sealProjectTypingEvidenceUnchecked(
  session: CheckingSession,
  checkingAtEmission: ProjectCheckingResult,
  compilation: ProjectCompilation,
): void {
  const state = sessionTypingState.get(session);

  if (!state) return;

  if (state.host.snapshot().lateObservation) {
    sessionTypingState.delete(session);
    return;
  }

  if (
    session.project !== state.project ||
    Object.getOwnPropertyDescriptor(session, "result")?.get !== state.resultGetter ||
    state.isDisposed()
  ) {
    sessionTypingState.delete(session);
    return;
  }

  const analysesMatch =
    state.analyses === session.analyses &&
    state.analysisEntries.length === session.analyses.size &&
    state.analysisEntries.every(
      ({
        filename,
        analysis,
        result,
        componentProps,
        normalized,
        operationCalls,
        mapOffset,
        fingerprint,
      }) =>
        session.analyses.get(filename) === analysis &&
        analysis.result === result &&
        analysis.componentProps === componentProps &&
        analysis.normalized === normalized &&
        analysis.operationCalls === operationCalls &&
        analysis.mapOffset === mapOffset &&
        moduleAnalysisFingerprint(analysis) === fingerprint,
    );
  const checkingMatches =
    checkingAtEmission.snapshotId === state.snapshotId &&
    fingerprintCheckingResult(checkingAtEmission) === state.baselineCheckingFingerprint;
  const modulePopulationMatches =
    compilation.modules.size === state.analysisEntries.length &&
    sameOwnKeys(
      [...compilation.modules.keys()],
      state.analysisEntries.map((entry) => entry.filename),
    );
  const cohortMatches = checkingMatches && analysesMatch && modulePopulationMatches;
  const modules = state.modules.map((module) => {
    const analysis = session.analyses.get(module.filename);
    const emitted = compilation.modules.get(module.filename);
    const view = state.views.find((item) => item.filename === module.filename);
    const sourceDigest_ = sourceDigest(module.source);
    const normalizedNativeFilename = view ? normalizePath(view.nativeFilename) : "";
    const nativeSource = state.environment.sourceFiles.find(
      (item) => normalizePath(item.filename) === normalizedNativeFilename,
    );
    const nativeFilenameCount = state.views.filter(
      (item) => normalizePath(item.nativeFilename) === normalizedNativeFilename,
    ).length;
    const sourceJoin = Boolean(
      analysis &&
      emitted &&
      view &&
      cohortMatches &&
      nativeSource &&
      nativeSource.source === view.source &&
      nativeFilenameCount === 1,
    );
    const components = analysis
      ? componentEvidence(module.filename, analysis, emitted, sourceJoin)
      : Object.freeze([] as CheckedComponentTypingEvidence[]);
    const metadata = analysis?.componentProps
      ? {
          props: analysis.componentProps.byParameterStart,
          types: componentPropsTypeEvidence(analysis.componentProps),
          operations: analysis.operationCalls,
        }
      : (analysis?.operationCalls ?? null);

    return Object.freeze({
      filename: module.filename,
      nativeFilename: view?.nativeFilename ?? "",
      sourceJoin,
      checkingAnalysisAvailable: analysis !== undefined,
      emittedModuleAvailable: emitted !== undefined,
      sourceDigest: sourceDigest_,
      checkingViewDigest: view ? sourceDigest(view.source) : "",
      checkedSemanticHash: analysis?.result.semanticHash ?? "",
      checkedIrDigest: analysis ? digestCanonicalModule(analysis.result.ir) : "",
      checkedMetadataDigest: sourceDigest(JSON.stringify(canonicalCaptureValue(metadata))),
      emittedCodeDigest: emitted ? sourceDigest(emitted.code) : "",
      emittedSemanticHash: emitted?.semanticHash ?? "",
      emittedIrDigest: emitted ? digestCanonicalModule(emitted.ir) : "",
      renderPlanJoin: "unavailable",
      components,
    });
  });
  const checkingHasErrors =
    state.baselineHasErrors ||
    compilation.checking.diagnostics.some((item) => item.severity === "error");
  const evidence: SealedProjectTypingEvidence = Object.freeze({
    schema: 1,
    state: "sealed",
    snapshotId: state.snapshotId,
    captureState: "incomplete-capture",
    environment: state.environment,
    modules: Object.freeze(modules),
    certificates: Object.freeze([] as const),
    projectPolicy: Object.freeze({ kind: "unproved", reason: "missing-policy" }),
    unavailableTypeLocations: Object.freeze([
      "state-value",
      "native-markup-context",
      "native-binding",
      "route-role-reference",
      "render-plan-preservation",
    ] as const),
    checkingHasErrors,
    emissionHasErrors: [...compilation.modules.values()].some((result) =>
      result.diagnostics.some((item) => item.severity === "error"),
    ),
    checkingResultJoin: checkingMatches,
    analysisJoin: analysesMatch,
    modulePopulationJoin: modulePopulationMatches,
  });
  const moduleOutputs = Object.freeze(
    [...compilation.modules].map(([filename, result]) =>
      Object.freeze({
        filename,
        keys: Object.freeze(Reflect.ownKeys(result)),
        result,
        fingerprint: compileResultFingerprint(result),
        diagnosticsFingerprint: sourceDigest(
          JSON.stringify(canonicalCaptureValue(result.diagnostics)),
        ),
      }),
    ),
  );

  compilationTypingBinding.set(compilation, {
    evidence,
    compilationKeys: Object.freeze(Reflect.ownKeys(compilation)),
    checkingKeys: Object.freeze(Reflect.ownKeys(compilation.checking)),
    checking: compilation.checking,
    modules: compilation.modules,
    moduleOutputs,
    checkingFingerprint: fingerprintCheckingResult(compilation.checking),
    host: state.host,
  });
  sessionTypingState.delete(session);
}

export function issuedProjectTypingEvidence(
  compilation: ProjectCompilation,
): SealedProjectTypingEvidence | undefined {
  try {
    return issuedProjectTypingEvidenceUnchecked(compilation);
  } catch {
    return undefined;
  }
}

function issuedProjectTypingEvidenceUnchecked(
  compilation: ProjectCompilation,
): SealedProjectTypingEvidence | undefined {
  const binding = compilationTypingBinding.get(compilation);

  if (
    !binding ||
    !sameOwnKeys(Reflect.ownKeys(compilation), binding.compilationKeys) ||
    compilation.checking !== binding.checking ||
    !sameOwnKeys(Reflect.ownKeys(compilation.checking), binding.checkingKeys) ||
    compilation.modules !== binding.modules ||
    fingerprintCheckingResult(compilation.checking) !== binding.checkingFingerprint ||
    compilation.modules.size !== binding.moduleOutputs.length
  )
    return undefined;

  if (
    !sameOwnKeys(
      [...compilation.modules.keys()],
      binding.moduleOutputs.map((item) => item.filename),
    )
  )
    return undefined;

  for (const output of binding.moduleOutputs) {
    const result = compilation.modules.get(output.filename);

    if (
      !result ||
      result !== output.result ||
      compileResultFingerprint(result) !== output.fingerprint ||
      sourceDigest(JSON.stringify(canonicalCaptureValue(result.diagnostics))) !==
        output.diagnosticsFingerprint
    )
      return undefined;

    if (!sameOwnKeys(Reflect.ownKeys(result), output.keys)) return undefined;
  }

  const host = binding.host.snapshot();

  if (host.lateObservation) return undefined;

  return binding.evidence;
}

/** Carry an issued cohort only across Tooling's validated diagnostic/source-map projection. */
export function registerMappedProjectCompilation(
  source: ProjectCompilation,
  mapped: ProjectCompilation,
): boolean {
  try {
    return registerMappedProjectCompilationUnchecked(source, mapped);
  } catch {
    return false;
  }
}

function registerMappedProjectCompilationUnchecked(
  source: ProjectCompilation,
  mapped: ProjectCompilation,
): boolean {
  const binding = compilationTypingBinding.get(source);

  if (
    !binding ||
    !issuedProjectTypingEvidence(source) ||
    !isAllowedToolingProjection(source, mapped)
  )
    return false;

  compilationTypingBinding.set(mapped, {
    evidence: binding.evidence,
    compilationKeys: Object.freeze(Reflect.ownKeys(mapped)),
    checkingKeys: Object.freeze(Reflect.ownKeys(mapped.checking)),
    checking: mapped.checking,
    modules: mapped.modules,
    moduleOutputs: Object.freeze(
      [...mapped.modules].map(([filename, result]) =>
        Object.freeze({
          filename,
          keys: Object.freeze(Reflect.ownKeys(result)),
          result,
          fingerprint: compileResultFingerprint(result),
          diagnosticsFingerprint: sourceDigest(
            JSON.stringify(canonicalCaptureValue(result.diagnostics)),
          ),
        }),
      ),
    ),
    checkingFingerprint: fingerprintCheckingResult(mapped.checking),
    host: binding.host,
  });

  return true;
}

function isAllowedToolingProjection(
  source: ProjectCompilation,
  mapped: ProjectCompilation,
): boolean {
  if (
    !sameOwnKeys(Reflect.ownKeys(source), Reflect.ownKeys(mapped)) ||
    !sameOwnKeys(Reflect.ownKeys(source.checking), Reflect.ownKeys(mapped.checking)) ||
    source.checking.snapshotId !== mapped.checking.snapshotId ||
    source.checking.checkingInputs !== mapped.checking.checkingInputs ||
    source.checking.modules.length !== mapped.checking.modules.length ||
    source.modules.size !== mapped.modules.size
  )
    return false;

  for (const key of Reflect.ownKeys(source.checking)) {
    if (key === "diagnostics" || key === "modules") continue;
    if (
      (source.checking as unknown as Record<PropertyKey, unknown>)[key] !==
      (mapped.checking as unknown as Record<PropertyKey, unknown>)[key]
    )
      return false;
  }

  for (const [index, before] of source.checking.modules.entries()) {
    const after = mapped.checking.modules[index];

    if (
      !after ||
      !sameOwnKeys(Reflect.ownKeys(before), Reflect.ownKeys(after)) ||
      before.filename !== after.filename ||
      before.diagnostics.length !== after.diagnostics.length ||
      before.diagnostics.some(
        (item, diagnosticIndex) =>
          item.code !== after.diagnostics[diagnosticIndex]?.code ||
          item.severity !== after.diagnostics[diagnosticIndex]?.severity,
      )
    )
      return false;

    for (const key of Reflect.ownKeys(before)) {
      if (key === "diagnostics") continue;
      if (
        (before as unknown as Record<PropertyKey, unknown>)[key] !==
        (after as unknown as Record<PropertyKey, unknown>)[key]
      )
        return false;
    }
  }

  const mappedDiagnostics = mapped.checking.modules.flatMap((module) => module.diagnostics);

  if (
    mappedDiagnostics.length !== mapped.checking.diagnostics.length ||
    mappedDiagnostics.some(
      (item, index) => !sameDiagnostic(item, mapped.checking.diagnostics[index]),
    )
  )
    return false;

  const beforeEntries = [...source.modules];
  const afterEntries = [...mapped.modules];

  for (const [index, [filename, before]] of beforeEntries.entries()) {
    const afterEntry = afterEntries[index];

    if (!afterEntry || afterEntry[0] !== filename) return false;

    const after = afterEntry[1];
    const beforeKeys = Reflect.ownKeys(before);

    if (!sameOwnKeys(beforeKeys, Reflect.ownKeys(after))) return false;

    for (const key of beforeKeys) {
      if (key === "diagnostics" || key === "map") continue;
      if (
        (before as unknown as Record<PropertyKey, unknown>)[key] !==
        (after as unknown as Record<PropertyKey, unknown>)[key]
      )
        return false;
    }

    if (
      before.diagnostics.length !== after.diagnostics.length ||
      before.diagnostics.some(
        (item, diagnosticIndex) =>
          item.code !== after.diagnostics[diagnosticIndex]?.code ||
          item.severity !== after.diagnostics[diagnosticIndex]?.severity,
      )
    )
      return false;
  }

  return true;
}

function componentEvidence(
  filename: string,
  analysis: ModuleAnalysis,
  emitted: CompileResult | undefined,
  sourceJoin: boolean,
): readonly CheckedComponentTypingEvidence[] {
  const propAnalysis = analysis.componentProps;
  const propTypes = propAnalysis ? componentPropsTypeEvidence(propAnalysis) : undefined;
  const checked = canonicalComponents(analysis.result.ir, filename);
  const emittedComponents = emitted ? canonicalComponents(emitted.ir, filename) : [];

  return Object.freeze(
    checked.map((component) => {
      const first = component.parameters[0];
      const matches = emittedComponents.filter(
        (candidate) =>
          candidate.kind === component.kind &&
          candidate.span.start === component.span.start &&
          candidate.span.end === component.span.end,
      );
      const emittedComponent = matches.length === 1 ? matches[0] : undefined;
      const emittedFirst = emittedComponent?.parameters[0];
      const emittedComponentJoin: CheckedComponentTypingEvidence["emittedComponentJoin"] =
        !sourceJoin
          ? "ambiguous"
          : !emitted
            ? "missing"
            : matches.length === 0
              ? "missing"
              : matches.length !== 1 ||
                  (first?.span?.start ?? undefined) !== (emittedFirst?.span?.start ?? undefined)
                ? "ambiguous"
                : "matched";
      const parameterStart = first?.span
        ? (analysis.mapOffset?.(first.span.start) ?? first.span.start)
        : undefined;
      let props: CheckedPropsEvidence;
      let parameterEnd: number | undefined;

      if (emittedComponentJoin !== "matched") {
        props = Object.freeze({ kind: "unproved", reason: "ambiguous-join" });
      } else if (!first) {
        props = Object.freeze({ kind: "none" });
      } else if (parameterStart === undefined) {
        props = Object.freeze({ kind: "unproved", reason: "ambiguous-join" });
      } else {
        const metadata = propAnalysis?.byParameterStart[String(parameterStart)];
        const types = propTypes?.byParameterStart[String(parameterStart)];

        if (!metadata) {
          props = Object.freeze({ kind: "unproved", reason: "unsupported-anchor" });
        } else {
          parameterEnd = metadata.parameterEnd;
          const entries = Object.keys(metadata.props)
            .sort(compareCodeUnits)
            .map((name) => {
              const mappedType = types?.mapped[name] ?? {
                kind: "unproved" as const,
                reason: "incomplete-capture" as const,
              };
              const authoredType =
                types?.authored && Object.hasOwn(types.authored, name)
                  ? types.authored[name]
                  : undefined;
              const prop = metadata.props[name]!;

              return Object.freeze({
                name,
                category: prop.kind,
                optional: prop.optional,
                mappedType,
                ...(authoredType ? { authoredType } : {}),
              });
            });

          props = Object.freeze({ kind: "props", entries: Object.freeze(entries) });
        }
      }

      return Object.freeze({
        canonicalPath: component.path,
        ...(emittedComponent ? { emittedPath: emittedComponent.path } : {}),
        canonicalSpan: component.span,
        ...(emittedComponent ? { emittedSpan: emittedComponent.span } : {}),
        ...(parameterStart === undefined ? {} : { parameterStart }),
        ...(parameterEnd === undefined ? {} : { parameterEnd }),
        ...(emittedFirst?.span ? { emittedParameterStart: emittedFirst.span.start } : {}),
        parameterOrdinal: 0,
        emittedComponentJoin,
        props,
      });
    }),
  );
}

interface CanonicalComponentOccurrence {
  readonly path: readonly (string | number)[];
  readonly kind: string;
  readonly span: { readonly start: number; readonly end: number };
  readonly parameters: readonly { readonly span?: { readonly start: number } }[];
}

function canonicalComponents(
  root: CanonicalModule,
  filename: string,
): readonly CanonicalComponentOccurrence[] {
  const found: CanonicalComponentOccurrence[] = [];

  const visit = (value: unknown, path: readonly (string | number)[]): void => {
    if (Array.isArray(value)) {
      value.forEach((item, index) => visit(item, [...path, index]));
      return;
    }

    if (typeof value !== "object" || value === null) return;

    const node = value as {
      readonly kind?: string;
      readonly component?: boolean;
      readonly span?: { readonly start: number; readonly end: number };
      readonly parameters?: readonly { readonly span?: { readonly start: number } }[];
    };

    if (
      node.component === true &&
      (node.kind === "function" || node.kind === "arrow" || node.kind === "function-expression") &&
      node.span
    )
      found.push(
        Object.freeze({
          path: Object.freeze([...path]),
          kind: node.kind,
          span: Object.freeze({ start: node.span.start, end: node.span.end }),
          parameters: Object.freeze([...(node.parameters ?? [])]),
        }),
      );

    for (const [key, child] of Object.entries(value)) visit(child, [...path, key]);
  };

  visit(root, [filename]);
  return Object.freeze(found);
}

function fingerprintCheckingResult(result: ProjectCheckingResult): string {
  return JSON.stringify(
    canonicalCaptureValue({
      snapshotId: result.snapshotId,
      diagnostics: result.diagnostics,
      checkingInputs: result.checkingInputs,
      modules: result.modules,
    }),
  );
}

function sameDiagnostic(left: unknown, right: unknown): boolean {
  return (
    JSON.stringify(canonicalCaptureValue(left)) === JSON.stringify(canonicalCaptureValue(right))
  );
}

function sameOwnKeys(left: readonly PropertyKey[], right: readonly PropertyKey[]): boolean {
  return left.length === right.length && left.every((key, index) => key === right[index]);
}

function digestCanonicalModule(module: CanonicalModule): string {
  return sourceDigest(encodeCanonicalModule(module));
}

function moduleAnalysisFingerprint(analysis: ModuleAnalysis): string {
  const componentProps = analysis.componentProps;

  return sourceDigest(
    JSON.stringify(
      canonicalCaptureValue({
        result: {
          semanticHash: analysis.result.semanticHash,
          ir: digestCanonicalModule(analysis.result.ir),
          diagnostics: analysis.result.diagnostics,
        },
        normalized: analysis.normalized,
        componentProps: componentProps
          ? {
              byParameterStart: componentProps.byParameterStart,
              diagnostics: componentProps.diagnostics,
              typeEvidence: componentPropsTypeEvidence(componentProps),
            }
          : null,
        operationCalls: analysis.operationCalls,
      }),
    ),
  );
}

function compileResultFingerprint(result: CompileResult): string {
  const fields: Record<string, unknown> = Object.create(null);

  for (const key of Reflect.ownKeys(result)) {
    if (typeof key !== "string" || key === "diagnostics" || key === "map") continue;

    const value = (result as unknown as Record<string, unknown>)[key];
    fields[key] =
      key === "ir" && typeof value === "object" && value !== null
        ? digestCanonicalModule(value as CanonicalModule)
        : canonicalCaptureValue(value);
  }

  return JSON.stringify(fields);
}

function sourceDigest(source: string): string {
  return `sha256-${createHash("sha256").update(source).digest("hex")}`;
}

function freezeCaptureValue(value: unknown): Readonly<Record<string, unknown>> {
  const normalized = canonicalCaptureValue(value);

  return normalized && typeof normalized === "object" && !Array.isArray(normalized)
    ? deepFreeze(normalized as Record<string, unknown>)
    : Object.freeze({});
}

function canonicalCaptureValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalCaptureValue);

  if (typeof value !== "object" || value === null) return value;

  if (value instanceof Map)
    return {
      kind: "map",
      entries: [...value].map(([key, item]) => [
        canonicalCaptureValue(key),
        canonicalCaptureValue(item),
      ]),
    };

  if (value instanceof Set) return { kind: "set", values: [...value].map(canonicalCaptureValue) };

  const record = value as Record<string, unknown>;
  const result: Record<string, unknown> = Object.create(null);

  for (const key of Object.keys(record).sort(compareCodeUnits)) {
    const item = canonicalCaptureValue(record[key]);

    if (item !== undefined) result[key] = item;
  }

  return result;
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
