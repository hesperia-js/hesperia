/** Native namespaces understood by the direct-DOM compiler profile. */
export type Namespace = "html" | "svg" | "mathml";

/** Context needed to resolve the namespace of a literal JSX subtree. */
export interface NamespaceContext {
  /** Namespace used to create the current element or parse its children. */
  readonly namespace: Namespace;
  /** Lowercase-insensitive intrinsic tag that established this context. */
  readonly tag?: string;
  /** Static `encoding` value on an `annotation-xml` element, when known. */
  readonly encoding?: string;
  /** Foreign-content integration point that changes child token handling. */
  readonly integration?: "svg-html" | "mathml-text" | "mathml-html";
}

/**
 * Resolve the namespace occupied by one authored intrinsic element.
 *
 * `parent` describes the context in which the child tag is parsed. In
 * particular, an integration point can put a child back into HTML parsing
 * mode, where a new `svg` or `math` root starts its own foreign namespace.
 */
export function namespaceForTag(parent: NamespaceContext, tag: string): NamespaceContext {
  const normalized = tag.toLowerCase();
  if (
    (normalized === "svg" || tag.startsWith("svg:")) &&
    (parent.namespace === "html" ||
      parent.integration !== undefined ||
      parent.tag === "annotation-xml")
  )
    return { namespace: "svg", tag };
  if (
    (normalized === "math" || tag.startsWith("math:")) &&
    (parent.namespace === "html" || parent.integration !== undefined)
  )
    return { namespace: "mathml", tag };
  if (
    parent.integration === "mathml-text" &&
    normalized !== "mglyph" &&
    normalized !== "malignmark"
  )
    return { namespace: "html", tag };
  if (parent.integration === "svg-html" || parent.integration === "mathml-html")
    return { namespace: "html", tag };
  if (parent.namespace === "svg") return { namespace: "svg", tag };
  if (parent.namespace === "mathml") return { namespace: "mathml", tag };
  return { namespace: "html", tag };
}

/**
 * Resolve the namespace context inherited by an intrinsic element's children.
 *
 * The returned context retains the current foreign namespace while recording
 * SVG and MathML integration points, so `namespaceForTag` can apply the same
 * transitions in canonicalization and native type checking.
 */
export function childNamespace(current: NamespaceContext): NamespaceContext {
  const tag = current.tag?.toLowerCase();
  if (current.namespace === "svg" && (tag === "foreignobject" || tag === "desc" || tag === "title"))
    return { namespace: "svg", integration: "svg-html" };
  if (
    current.namespace === "mathml" &&
    (tag === "mi" || tag === "mo" || tag === "mn" || tag === "ms" || tag === "mtext")
  )
    return { namespace: "mathml", integration: "mathml-text" };
  if (
    current.namespace === "mathml" &&
    tag === "annotation-xml" &&
    (current.encoding?.toLowerCase() === "text/html" ||
      current.encoding?.toLowerCase() === "application/xhtml+xml")
  )
    return { namespace: "mathml", integration: "mathml-html" };
  return current;
}
