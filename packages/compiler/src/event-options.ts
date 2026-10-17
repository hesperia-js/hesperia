import type {
  CanonicalArgument,
  CanonicalComponent,
  CanonicalElement,
  CanonicalExpression,
  CanonicalModule,
  CanonicalPattern,
  CanonicalProperty,
  CompilerDiagnostic,
  SourceSpan,
} from "./ir.ts";
import { isCanonicalChild } from "./ir.ts";

export interface NativeEventHandlerContext {
  readonly span: SourceSpan;
  readonly attributeSpan: SourceSpan;
  readonly tag: string;
  readonly namespace: CanonicalElement["namespace"];
  readonly eventName: string;
}

type HelperName = "once" | "capture" | "passive";

type FrameworkValue =
  | { readonly kind: "helper"; readonly name: HelperName }
  | { readonly kind: "events" }
  | { readonly kind: "client" }
  | { readonly kind: "client-module" }
  | { readonly kind: "module" }
  | { readonly kind: "embed" }
  | { readonly kind: "embed-module" }
  | { readonly kind: "dynamic-helper" }
  | { readonly kind: "dynamic-module" }
  | { readonly kind: "other" };

interface NativeEventTarget {
  readonly tag: string;
  readonly namespace: CanonicalElement["namespace"];
}

interface VariableBinding {
  readonly declarationKind: "const" | "let" | "var";
  readonly initializer: CanonicalExpression | null;
}

interface OptionResult {
  readonly values: ReadonlyMap<string, boolean>;
  readonly references: readonly { readonly bindingId: string; readonly span: SourceSpan }[];
}

const HELPER_NAMES = new Set<HelperName>(["once", "capture", "passive"]);
const OPTION_NAMES = new Set(["capture", "once", "passive"]);

/** Analyze native event helper identity and the static descriptor grammar. */
export function analyzeNativeEventOptions(module: CanonicalModule): {
  readonly diagnostics: readonly CompilerDiagnostic[];
  readonly contexts: readonly NativeEventHandlerContext[];
} {
  const imports = new Map<string, FrameworkValue>();
  const variables = new Map<string, VariableBinding>();
  const destructuredAliases = new Map<
    string,
    { readonly base: CanonicalExpression; readonly key: string }
  >();
  const mutations = new Map<string, SourceSpan>();
  const objectOptionBindings = new Set<string>();
  const descriptorBindings = new Set<string>();
  const allowedOptionReferences = new Set<string>();
  const allowedDescriptorReferences = new Set<string>();
  const diagnostics: CompilerDiagnostic[] = [];
  const contexts: NativeEventHandlerContext[] = [];

  visit(module.body, (value) => {
    if (value.kind === "import") {
      const source = value.source;

      for (const specifier of value.specifiers) {
        const bindingId = specifier.bindingId;

        if (!bindingId) continue;

        if (source === "hesperia/events") {
          if (specifier.kind === "namespace") imports.set(bindingId, { kind: "events" });
          else if (specifier.kind === "named" && isHelper(specifier.imported))
            imports.set(bindingId, { kind: "helper", name: specifier.imported });
        } else if (source === "hesperia" || source === "hesperia/client") {
          if (specifier.kind === "namespace")
            imports.set(bindingId, { kind: source === "hesperia" ? "module" : "client-module" });
          else if (specifier.kind === "named" && specifier.imported === "client")
            imports.set(bindingId, { kind: "client" });
          else if (
            source === "hesperia/client" &&
            specifier.kind === "named" &&
            specifier.imported === "events"
          )
            imports.set(bindingId, { kind: "events" });
        } else if (source === "hesperia/embed") {
          if (specifier.kind === "namespace") imports.set(bindingId, { kind: "embed-module" });
          else if (specifier.kind === "named" && specifier.imported === "Embed")
            imports.set(bindingId, { kind: "embed" });
        }
      }
    }

    if (value.kind === "variable") {
      for (const declaration of value.declarations) {
        const initializer = isExpression(declaration.initializer) ? declaration.initializer : null;

        collectVariableBindings(
          declaration.pattern,
          initializer,
          value.declarationKind,
          variables,
          destructuredAliases,
        );
      }
    }

    if (value.kind === "assignment")
      markMutationRoot("target" in value ? value.target : value.left, mutations);

    if (
      value.kind === "unary" &&
      (value.operator === "++" || value.operator === "--" || value.operator === "delete")
    )
      markMutationRoot(value.argument, mutations);
  });

  const resolveValue = (
    expression: CanonicalExpression,
    seen = new Set<string>(),
  ): FrameworkValue => {
    expression = sequenceValue(expression);

    if (expression.kind === "identifier") {
      const id = expression.referenceId;

      if (!id) return { kind: "other" };

      const imported = imports.get(id);

      if (imported) return imported;

      if (seen.has(id)) return { kind: "other" };

      const alias = variables.get(id);

      if (!alias) {
        const destructured = destructuredAliases.get(id);

        if (!destructured) return { kind: "other" };

        return memberValue(
          resolveValue(destructured.base, new Set(seen).add(id)),
          destructured.key,
        );
      }

      if (alias.declarationKind !== "const") {
        const target = alias.initializer
          ? resolveValue(alias.initializer, new Set(seen).add(id))
          : { kind: "other" as const };

        if (
          target.kind === "helper" ||
          target.kind === "events" ||
          target.kind === "client" ||
          target.kind === "client-module"
        )
          return { kind: "dynamic-helper" };

        if (target.kind === "embed" || target.kind === "embed-module")
          return { kind: "dynamic-module" };

        return target;
      }

      return alias.initializer
        ? resolveValue(alias.initializer, new Set(seen).add(id))
        : { kind: "other" };
    }

    if (expression.kind === "member") {
      const object = resolveValue(expression.object, seen);
      const key = memberKey(expression);

      if (key !== null) return memberValue(object, key);

      if (expression.optional)
        return object.kind === "events"
          ? { kind: "dynamic-helper" }
          : object.kind === "module" || object.kind === "client" || object.kind === "client-module"
            ? { kind: "dynamic-module" }
            : { kind: "other" };

      if (
        expression.computed &&
        (object.kind === "events" ||
          object.kind === "module" ||
          object.kind === "client" ||
          object.kind === "client-module")
      )
        return object.kind === "events" ? { kind: "dynamic-helper" } : { kind: "dynamic-module" };

      return { kind: "other" };
    }

    if (expression.kind === "conditional") {
      const left = resolveValue(expression.consequent, seen);
      const right = resolveValue(expression.alternate, seen);

      if (left.kind === "helper" && right.kind === "helper")
        return left.name === right.name ? left : { kind: "dynamic-helper" };

      if (left.kind === "helper" || right.kind === "helper") return { kind: "dynamic-helper" };

      return { kind: "other" };
    }

    return { kind: "other" };
  };

  const literalValue = (
    expression: CanonicalExpression,
    seen = new Set<string>(),
  ): string | boolean | number | null | undefined => {
    expression = sequenceValue(expression);

    if (expression.kind === "literal") return expression.value;

    if (
      expression.kind !== "identifier" ||
      !expression.referenceId ||
      seen.has(expression.referenceId)
    )
      return undefined;

    const declaration = variables.get(expression.referenceId);

    if (!declaration || declaration.declarationKind !== "const" || !declaration.initializer)
      return undefined;

    return literalValue(declaration.initializer, new Set(seen).add(expression.referenceId));
  };

  const markBindingAndAliases = (
    bindingId: string,
    bindings: Set<string>,
    seen = new Set<string>(),
  ): void => {
    if (seen.has(bindingId)) return;

    seen.add(bindingId);

    bindings.add(bindingId);

    for (const [aliasId, declaration] of variables) {
      if (
        declaration.declarationKind === "const" &&
        declaration.initializer?.kind === "identifier" &&
        declaration.initializer.referenceId === bindingId
      )
        markBindingAndAliases(aliasId, bindings, seen);
    }
  };

  const staticOptions = (
    expression: CanonicalExpression,
    seen = new Set<string>(),
  ): OptionResult | null => {
    expression = sequenceValue(expression);

    if (expression.kind === "identifier" && expression.referenceId) {
      const id = expression.referenceId;

      if (seen.has(id)) return null;

      const declaration = variables.get(id);

      if (!declaration || declaration.declarationKind !== "const" || !declaration.initializer)
        return null;

      const resolved = staticOptions(declaration.initializer, new Set(seen).add(id));

      if (!resolved) return null;

      markBindingAndAliases(id, objectOptionBindings);

      return {
        values: resolved.values,
        references: [...resolved.references, { bindingId: id, span: expression.span }],
      };
    }

    if (expression.kind !== "object") return null;

    const values = new Map<string, boolean>();
    const references: { bindingId: string; span: SourceSpan }[] = [];

    for (const property of expression.properties) {
      if (property.kind === "spread") return null;

      const key = propertyKey(property, literalValue);

      if (
        key === null ||
        !OPTION_NAMES.has(key) ||
        property.method ||
        property.propertyKind === "get" ||
        property.propertyKind === "set"
      )
        return null;

      const value = literalValue(property.value);

      if (typeof value !== "boolean") return null;

      values.set(key, value);
    }

    return { values, references };
  };

  const report = (message: string, span: SourceSpan): void => {
    diagnostics.push({
      code: "HES-EVENT-OPTIONS",
      severity: "error",
      message,
      span,
    });
  };

  const checkPair = (expression: CanonicalExpression): CanonicalExpression | null => {
    if (expression.kind !== "array") return null;

    const entries = expression.elements;

    if (entries.length !== 2 || entries.some((entry) => entry === null || isSpread(entry))) {
      report(
        "A native event pair must contain exactly a handler and a static options object.",
        expression.span,
      );

      return null;
    }

    const handler = entries[0] as CanonicalExpression;
    const optionExpression = entries[1] as CanonicalExpression;
    const options = staticOptions(optionExpression);

    if (!options) {
      report(
        "Native event options must be a static object containing only boolean capture, once, and passive values.",
        optionExpression.span,
      );
    } else {
      for (const reference of options.references) {
        allowedOptionReferences.add(
          `${reference.bindingId}:${reference.span.start}:${reference.span.end}`,
        );
      }
    }

    return handler;
  };

  const unwrap = (
    expression: CanonicalExpression,
    element: NativeEventTarget,
    eventName: string,
    attributeSpan: SourceSpan,
    fromHelper = false,
    seen = new Set<string>(),
  ): boolean => {
    if (expression.kind === "sequence") {
      const value = expression.expressions.at(-1);
      return value ? unwrap(value, element, eventName, attributeSpan, fromHelper, seen) : false;
    }

    if (expression.kind === "call") {
      const target = resolveValue(expression.callee);

      if (target.kind === "dynamic-helper" || target.kind === "dynamic-module") {
        report(
          "Native event helpers must be selected through a statically identifiable Hesperia helper.",
          expression.callee.span,
        );

        return true;
      }

      if (target.kind === "helper") {
        if (
          expression.optional ||
          expression.arguments.length !== 1 ||
          isSpread(expression.arguments[0]!)
        ) {
          report(
            "A native event helper requires exactly one non-spread handler or handler/options pair.",
            expression.span,
          );

          return true;
        }

        const argument = expression.arguments[0] as CanonicalExpression;

        if (argument.kind === "array") {
          const handler = checkPair(argument);

          if (handler) addContext(handler, element, eventName, attributeSpan);

          return true;
        }

        unwrap(argument, element, eventName, attributeSpan, true, seen);

        return true;
      }
    }

    if (expression.kind === "array") {
      const handler = checkPair(expression);

      if (handler && (fromHelper || seen.size > 0))
        addContext(handler, element, eventName, attributeSpan);

      return true;
    }

    if (expression.kind === "function-expression" || expression.kind === "arrow") {
      if (fromHelper) addContext(expression, element, eventName, attributeSpan);

      return false;
    }

    if (expression.kind === "identifier") {
      const target = resolveValue(expression);

      if (target.kind === "dynamic-helper" || target.kind === "dynamic-module") {
        report(
          "Native event helpers must be selected through a statically identifiable Hesperia helper.",
          expression.span,
        );

        return true;
      }

      const bindingId = expression.referenceId;

      if (!bindingId || seen.has(bindingId)) return false;

      const alias = variables.get(bindingId);

      if (!alias?.initializer) return false;

      const recognized = unwrap(
        alias.initializer,
        element,
        eventName,
        attributeSpan,
        fromHelper,
        new Set(seen).add(bindingId),
      );

      if (!recognized) return false;

      if (alias.declarationKind !== "const")
        report("A native event descriptor alias must be immutable.", expression.span);
      else {
        markBindingAndAliases(bindingId, descriptorBindings);

        allowedDescriptorReferences.add(
          `${bindingId}:${expression.span.start}:${expression.span.end}`,
        );
      }

      return true;
    }

    return false;
  };

  const addContext = (
    handler: CanonicalExpression,
    element: NativeEventTarget,
    eventName: string,
    attributeSpan: SourceSpan,
  ): void => {
    if (handler.kind !== "function-expression" && handler.kind !== "arrow") return;

    contexts.push({
      span: handler.span,
      attributeSpan,
      tag: element.tag,
      namespace: element.namespace,
      eventName,
    });
  };

  visit(module.body, (value) => {
    if (value.kind === "element") {
      const element = value as unknown as CanonicalElement;

      for (const attribute of element.attributes) {
        if (attribute.kind !== "event") continue;

        unwrap(attribute.expression, element, attribute.name, attribute.span);
      }
    } else if (value.kind === "component") {
      const component = value as unknown as CanonicalComponent;

      if (resolveValue(component.reference).kind !== "embed") return;

      for (const prop of component.props) {
        if (prop.kind !== "value" || (prop.name !== "on:load" && prop.name !== "on:error"))
          continue;

        unwrap(
          prop.expression,
          { tag: "iframe", namespace: "html" },
          prop.name.slice(3),
          prop.span,
        );
      }
    }
  });

  for (const bindingId of objectOptionBindings) {
    const mutationSpan = mutations.get(bindingId);

    if (mutationSpan)
      report("A static native event options object cannot be mutated.", mutationSpan);
  }

  for (const bindingId of descriptorBindings) {
    const mutationSpan = mutations.get(bindingId);

    if (mutationSpan) report("A static native event pair cannot be mutated.", mutationSpan);
  }

  visit(module.body, (value) => {
    const escapes: CanonicalExpression[] = [];

    if (value.kind === "variable") {
      for (const declaration of value.declarations) {
        const initializer = declaration.initializer;

        if (
          isExpression(initializer) &&
          (initializer.kind === "object" ||
            initializer.kind === "array" ||
            (initializer.kind === "identifier" &&
              (value.declarationKind !== "const" || declaration.pattern.kind !== "identifier")))
        )
          escapes.push(initializer);
      }
    } else if (value.kind === "call" || value.kind === "new") {
      for (const argument of value.arguments) {
        if (isSpread(argument)) escapes.push(argument.argument);
        else escapes.push(argument);
      }
    } else if (value.kind === "return" && value.argument && isExpression(value.argument)) {
      escapes.push(value.argument);
    } else if (value.kind === "assignment" && "right" in value) {
      escapes.push(value.right);
    }

    for (const expression of escapes)
      visit(expression, (nested) => {
        if (
          nested.kind !== "identifier" ||
          !nested.referenceId ||
          (!objectOptionBindings.has(nested.referenceId) &&
            !descriptorBindings.has(nested.referenceId))
        )
          return;

        if (mutations.has(nested.referenceId)) return;

        const key = `${nested.referenceId}:${nested.span.start}:${nested.span.end}`;

        if (!allowedOptionReferences.has(key) && !allowedDescriptorReferences.has(key))
          report(
            objectOptionBindings.has(nested.referenceId)
              ? "A static native event options object cannot escape or be used dynamically."
              : "A static native event pair cannot escape or be used dynamically.",
            nested.span,
          );
      });
  });

  return { diagnostics: dedupeDiagnostics(diagnostics), contexts: dedupeContexts(contexts) };

  function memberValue(object: FrameworkValue, key: string): FrameworkValue {
    if (object.kind === "events" && isHelper(key)) return { kind: "helper", name: key };

    if (object.kind === "client" && key === "events") return { kind: "events" };

    if (object.kind === "client-module" && key === "events") return { kind: "events" };

    if (object.kind === "client-module" && key === "client") return { kind: "client" };

    if (object.kind === "module" && key === "client") return { kind: "client" };

    if (object.kind === "embed-module" && key === "Embed") return { kind: "embed" };

    return { kind: "other" };
  }

  function memberKey(expression: Extract<CanonicalExpression, { kind: "member" }>): string | null {
    if (!expression.computed) {
      if (expression.property.kind === "identifier") return expression.property.name;

      if (expression.property.kind === "literal" && typeof expression.property.value === "string")
        return expression.property.value;

      return null;
    }

    const value = literalValue(expression.property);
    return typeof value === "string" ? value : null;
  }
}

function collectVariableBindings(
  pattern: CanonicalPattern,
  initializer: CanonicalExpression | null,
  declarationKind: VariableBinding["declarationKind"],
  variables: Map<string, VariableBinding>,
  destructuredAliases: Map<string, { readonly base: CanonicalExpression; readonly key: string }>,
): void {
  if (pattern.kind === "identifier") {
    if (!pattern.bindingId) return;

    variables.set(pattern.bindingId, { declarationKind, initializer });

    return;
  }

  if (pattern.kind !== "object" || !initializer) return;

  for (const property of pattern.properties) {
    if (property.computed) continue;

    collectDestructured(
      property.value,
      initializer,
      property.key,
      declarationKind,
      variables,
      destructuredAliases,
    );
  }
}

function collectDestructured(
  pattern: CanonicalPattern,
  base: CanonicalExpression,
  key: string,
  declarationKind: VariableBinding["declarationKind"],
  variables: Map<string, VariableBinding>,
  aliases: Map<string, { readonly base: CanonicalExpression; readonly key: string }>,
): void {
  if (pattern.kind === "identifier") {
    if (!pattern.bindingId) return;

    if (declarationKind !== "const") {
      variables.set(pattern.bindingId, { declarationKind, initializer: null });

      return;
    }

    aliases.set(pattern.bindingId, { base, key });

    return;
  }

  if (pattern.kind !== "object") return;

  const parent = syntheticMember(base, key, pattern.span);

  for (const property of pattern.properties) {
    if (!property.computed)
      collectDestructured(
        property.value,
        parent,
        property.key,
        declarationKind,
        variables,
        aliases,
      );
  }
}

function syntheticMember(
  object: CanonicalExpression,
  key: string,
  span: SourceSpan,
): CanonicalExpression {
  return {
    kind: "member",
    object,
    property: { kind: "literal", value: key, span },
    computed: false,
    optional: false,
    span,
  };
}

function propertyKey(
  property: Extract<CanonicalProperty, { kind: "property" }>,
  literalValue: (expression: CanonicalExpression) => string | boolean | number | null | undefined,
): string | null {
  if (!property.computed) {
    if (typeof property.key === "string") return property.key;

    if (property.key.kind === "literal" && typeof property.key.value === "string")
      return property.key.value;

    return null;
  }

  const value = typeof property.key === "string" ? property.key : literalValue(property.key);
  return typeof value === "string" ? value : null;
}

function markMutationRoot(
  expression: CanonicalExpression,
  mutations: Map<string, SourceSpan>,
): void {
  let current = expression;

  while (current.kind === "member") current = current.object;

  if (current.kind === "identifier" && current.referenceId)
    mutations.set(current.referenceId, expression.span);
}

function isExpression(value: unknown): value is CanonicalExpression {
  if (typeof value !== "object" || value === null || !("kind" in value)) return false;

  const candidate = value as Parameters<typeof isCanonicalChild>[0];
  return candidate.kind !== "block" && !isCanonicalChild(candidate);
}

function isSpread(
  value: CanonicalArgument,
): value is Extract<CanonicalArgument, { kind: "spread" }> {
  return typeof value === "object" && value !== null && value.kind === "spread";
}

function isHelper(value: string): value is HelperName {
  return HELPER_NAMES.has(value as HelperName);
}

function sequenceValue(expression: CanonicalExpression): CanonicalExpression {
  while (expression.kind === "sequence") {
    const value = expression.expressions.at(-1);

    if (!value) return expression;

    expression = value;
  }

  return expression;
}

function visit(value: unknown, callback: (value: Record<string, any>) => void): void {
  if (Array.isArray(value)) {
    for (const child of value) visit(child, callback);
  } else if (typeof value === "object" && value !== null) {
    const record = value as Record<string, any>;

    callback(record);

    for (const [key, child] of Object.entries(record)) if (key !== "span") visit(child, callback);
  }
}

function dedupeDiagnostics(diagnostics: readonly CompilerDiagnostic[]): CompilerDiagnostic[] {
  const seen = new Set<string>();
  return diagnostics.filter((item) => {
    const key = `${item.code}:${item.message}:${item.span?.start ?? -1}:${item.span?.end ?? -1}`;

    if (seen.has(key)) return false;

    seen.add(key);

    return true;
  });
}

function dedupeContexts(
  contexts: readonly NativeEventHandlerContext[],
): NativeEventHandlerContext[] {
  const seen = new Set<string>();
  return contexts.filter((item) => {
    const key = `${item.span.start}:${item.span.end}:${item.attributeSpan.start}:${item.attributeSpan.end}:${item.tag}:${item.namespace}:${item.eventName}`;

    if (seen.has(key)) return false;

    seen.add(key);

    return true;
  });
}
