import { SignatureKind, SymbolFlags, type Project, type Type } from "typescript/unstable/async";
import {
  getTokenAtPosition,
  isCallExpression,
  isIdentifier,
  isStringLiteral,
  isPropertyAssignment,
  isObjectLiteralExpression,
  isJsxNamespacedName,
  isJsxAttribute,
  isJsxOpeningElement,
  isJsxSelfClosingElement,
  isJsxElement,
  isJsxExpression,
  type Node,
} from "typescript/unstable/ast";
import {
  namespaceForTag,
  childNamespace,
  type CheckingView,
  type NamespaceContext,
} from "@hesperia/compiler/editor";
import type { Completion } from "./project.ts";

/**
 * Complete native `on:` names from the snapshot's DOM types, including unfinished JSX.
 * Offsets and replacement spans refer to authored UTF-16 text; `view` maps it to
 * the checking source. Returns undefined outside an event-name prefix, or an
 * empty list when that prefix is outside a native attribute or has no matches.
 */
export async function eventCompletions(
  project: Project,
  filename: string,
  source: string,
  offset: number,
  view: CheckingView,
): Promise<readonly Completion[] | undefined> {
  const match = /\bon:([\w-]*)$/.exec(source.slice(0, offset));

  if (!match) return undefined;

  const file = await project.program.getSourceFile(filename);

  if (!file) return [];

  const token = getTokenAtPosition(file, view.generatedOffset(offset - 1));
  let type: Type | undefined;
  let mapped = false;

  if (isStringLiteral(token) && isPropertyAssignment(token.parent) && token.parent.name === token) {
    if (!token.text.startsWith("on:")) return [];

    const object = token.parent.parent;
    const call = object.parent;

    if (
      isObjectLiteralExpression(object) &&
      isCallExpression(call) &&
      isIdentifier(call.expression) &&
      call.expression.text === "__hesperia_element"
    ) {
      type = await project.checker.getContextualType(object);
      mapped = true;
    }
  } else {
    // Oxc cannot lower a bare `on:`; TypeScript's recovered JSX still identifies its owner.
    const name = isJsxNamespacedName(token) ? token : token.parent;

    if (!isJsxNamespacedName(name) || name.namespace.text !== "on" || !isJsxAttribute(name.parent))
      return [];

    const element = name.parent.parent.parent;

    if (
      !(isJsxOpeningElement(element) || isJsxSelfClosingElement(element)) ||
      !nativeTag(element.tagName)
    )
      return [];

    const ancestors: Node[] = [];

    for (let parent: Node | undefined = element.parent; parent; parent = parent.parent)
      if (isJsxElement(parent) && parent.openingElement !== element)
        ancestors.unshift(parent.openingElement);

    let context: NamespaceContext = { namespace: "html" };

    for (const ancestor of ancestors) {
      if (!isJsxOpeningElement(ancestor) || !nativeTag(ancestor.tagName)) continue;

      const encoding = ancestor.attributes.properties.find(
        (attribute) => isJsxAttribute(attribute) && attribute.name.getText() === "encoding",
      );
      const initializer = encoding && isJsxAttribute(encoding) ? encoding.initializer : undefined;
      const value =
        initializer && isJsxExpression(initializer) ? initializer.expression : initializer;
      context = childNamespace({
        ...namespaceForTag(context, ancestor.tagName.getText()),
        ...(value && isStringLiteral(value) ? { encoding: value.text } : {}),
      });
    }

    const namespace = namespaceForTag(context, element.tagName.getText()).namespace;
    const symbol = await project.checker.resolveName(
      namespace === "svg"
        ? "SVGElementEventMap"
        : namespace === "mathml"
          ? "MathMLElementEventMap"
          : "HTMLElementEventMap",
      SymbolFlags.Type,
    );
    type = symbol ? await project.checker.getDeclaredTypeOfSymbol(symbol) : undefined;
  }

  if (!type) return [];

  const prefix = match[1]!;
  const replacement = {
    start: offset - prefix.length,
    end: offset + (/^[\w-]*/.exec(source.slice(offset))?.[0].length ?? 0),
  };
  const completions: Completion[] = [];

  for (const symbol of await project.checker.getPropertiesOfType(type)) {
    const name = symbol.name;

    if (mapped && !name.startsWith("on:")) continue;

    const label = mapped ? name.slice(3) : name;

    if (!label.startsWith(prefix)) continue;

    const event = await project.checker.getTypeOfSymbol(symbol);
    const detailType = event && mapped ? await handlerEventType(project, event) : event;

    completions.push({
      label,
      insertText: label,
      replacement,
      sortText: label,
      ...(detailType ? { detail: await project.checker.typeToString(detailType) } : {}),
    });
  }

  return completions;
}

async function handlerEventType(project: Project, value: Type): Promise<Type | undefined> {
  const alternatives = value.isUnionType() ? await value.getTypes() : [value];

  for (const alternative of alternatives) {
    const [signature] = await project.checker.getSignaturesOfType(alternative, SignatureKind.Call);
    const [parameter] = (await signature?.getParameters()) ?? [];

    if (parameter) return project.checker.getTypeOfSymbol(parameter);
  }

  return undefined;
}

function nativeTag(node: Node): boolean {
  return /^[a-z]/.test(node.getText()) && (isIdentifier(node) || isJsxNamespacedName(node));
}
