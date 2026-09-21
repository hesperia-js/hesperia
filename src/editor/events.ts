import { SymbolFlags, type Project, type Type } from "typescript/unstable/sync";
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
import type { CheckingView } from "../compiler/checking-view.ts";
import { namespaceForTag, childNamespace, type NamespaceContext } from "../compiler/namespace.ts";
import type { Completion } from "./project.ts";

/**
 * Complete native `on:` names from the snapshot's DOM types, including unfinished JSX.
 * Offsets and replacement spans refer to authored UTF-16 text; `view` maps it to
 * the checking source. Returns undefined outside an event-name prefix, or an
 * empty list when that prefix is outside a native attribute or has no matches.
 */
export function eventCompletions(
  project: Project,
  filename: string,
  source: string,
  offset: number,
  view: CheckingView,
): readonly Completion[] | undefined {
  const match = /\bon:([\w-]*)$/.exec(source.slice(0, offset));
  if (!match) return undefined;
  const file = project.program.getSourceFile(filename);
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
      type = project.checker.getContextualType(object);
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
    const symbol = project.checker.resolveName(
      namespace === "svg"
        ? "SVGElementEventMap"
        : namespace === "mathml"
          ? "MathMLElementEventMap"
          : "HTMLElementEventMap",
      SymbolFlags.Type,
    );
    type = symbol && project.checker.getDeclaredTypeOfSymbol(symbol);
  }
  if (!type) return [];
  const prefix = match[1]!;
  const replacement = {
    start: offset - prefix.length,
    end: offset + (/^[\w-]*/.exec(source.slice(offset))?.[0].length ?? 0),
  };
  return project.checker.getPropertiesOfType(type).flatMap((symbol) => {
    const name = symbol.name;
    if (mapped && !name.startsWith("on:")) return [];
    const label = mapped ? name.slice(3) : name;
    if (!label.startsWith(prefix)) return [];
    const event = project.checker.getTypeOfSymbol(symbol);
    return [
      {
        label,
        insertText: label,
        replacement,
        sortText: label,
        ...(event ? { detail: project.checker.typeToString(event) } : {}),
      },
    ];
  });
}

function nativeTag(node: Node): boolean {
  return /^[a-z]/.test(node.getText()) && (isIdentifier(node) || isJsxNamespacedName(node));
}
