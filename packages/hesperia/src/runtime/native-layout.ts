export type NativeLayoutSource = object;

export type NativeTableContext =
  | "table"
  | "thead"
  | "tbody"
  | "tfoot"
  | "tr"
  | "colgroup"
  | "other";

export type NativeTableElementClassification = "script-supporting" | "hidden-input";

export type NativeLayoutPart =
  | {
      readonly kind: "text";
      readonly source: NativeLayoutSource;
      readonly value: string;
    }
  | {
      readonly kind: "comment";
      readonly source: NativeLayoutSource;
      readonly value: string;
    }
  | {
      readonly kind: "element";
      readonly source: NativeLayoutSource;
      readonly name: string;
      readonly namespace: string | null;
      readonly classification?: NativeTableElementClassification;
    }
  | {
      readonly kind: "opaque";
      readonly source: NativeLayoutSource;
    }
  | {
      readonly kind: "range";
      readonly source: NativeLayoutSource;
      readonly revision: number;
      readonly parts: readonly NativeLayoutPart[];
    };

export type NativeTableLeafPart = Exclude<NativeLayoutPart, { readonly kind: "range" }>;

export interface NativeTableGroupToken {
  readonly kind: "tbody" | "colgroup";
  readonly ordinal: number;
}

export interface NativeTablePlacement {
  readonly part: NativeTableLeafPart;
  readonly order: number;
  readonly groupToken: NativeTableGroupToken | null;
  readonly rangePath: readonly NativeLayoutSource[];
}

export interface NativeTableGroup {
  readonly token: NativeTableGroupToken;
  readonly placements: readonly NativeTablePlacement[];
}

export interface NativeTableRangeSegment {
  readonly ordinal: number;
  readonly groupToken: NativeTableGroupToken | null;
  readonly first: NativeLayoutSource;
  readonly last: NativeLayoutSource;
}

export interface NativeTableEmptyPosition {
  readonly groupToken: NativeTableGroupToken | null;
  readonly before: NativeLayoutSource | null;
  readonly order: number;
}

export interface NativeTableRangeProjection {
  readonly source: NativeLayoutSource;
  readonly revision: number;
  readonly parent: NativeLayoutSource | null;
  readonly depth: number;
  readonly order: number;
  readonly segments: readonly NativeTableRangeSegment[];
  readonly emptyPosition?: NativeTableEmptyPosition;
}

export interface NativeTableLayoutPlan {
  readonly context: NativeTableContext;
  readonly placements: readonly NativeTablePlacement[];
  readonly groups: readonly NativeTableGroup[];
  readonly ranges: readonly NativeTableRangeProjection[];
}

const HTML_NAMESPACE = "http://www.w3.org/1999/xhtml";
const TABLE_CONTEXTS = new Set<NativeTableContext>([
  "table",
  "thead",
  "tbody",
  "tfoot",
  "tr",
  "colgroup",
  "other",
]);

interface FlatPart {
  readonly part: NativeTableLeafPart;
  readonly rangePath: readonly NativeLayoutSource[];
  readonly order: number;
}

interface RangeSource {
  readonly source: NativeLayoutSource;
  readonly revision: number;
  readonly parent: NativeLayoutSource | null;
  readonly depth: number;
  readonly order: number;
  readonly start: number;
  readonly end: number;
}

/**
 * Plan the full ordered child sequence for one native table-related context.
 *
 * The planner only classifies explicit parts and assigns source references to
 * synthetic groups. It creates no Owner, DOM node, server node, or authority.
 */
export function planTableLayout(
  context: NativeTableContext,
  parts: readonly NativeLayoutPart[],
): NativeTableLayoutPlan {
  if (!TABLE_CONTEXTS.has(context))
    throw new TypeError("A native table layout requires a known parent context");
  if (!Array.isArray(parts))
    throw new TypeError("A native table layout requires an ordered parts array");

  const seenSources = new Set<NativeLayoutSource>();
  const flat: FlatPart[] = [];
  const rangeSources: RangeSource[] = [];
  let sourceOrder = 0;

  const visit = (
    children: readonly NativeLayoutPart[],
    parent: NativeLayoutSource | null,
    ancestors: readonly NativeLayoutSource[],
  ): void => {
    if (!Array.isArray(children))
      throw new TypeError("A native range requires an ordered parts array");

    for (const part of children) {
      if (typeof part !== "object" || part === null)
        throw new TypeError("A native layout part must be an object");
      if (typeof part.source !== "object" || part.source === null)
        throw new TypeError("A native layout source must be an object reference");
      if (seenSources.has(part.source))
        throw new TypeError("A native layout source reference cannot occur twice");
      seenSources.add(part.source);

      if (part.kind === "range") {
        if (!Number.isSafeInteger(part.revision) || part.revision < 0)
          throw new TypeError("A native range revision must be a nonnegative safe integer");

        const rangeIndex = rangeSources.length;
        const range: RangeSource = {
          source: part.source,
          revision: part.revision,
          parent,
          depth: ancestors.length,
          order: sourceOrder++,
          start: flat.length,
          end: flat.length,
        };
        rangeSources.push(range);
        visit(part.parts, part.source, [...ancestors, part.source]);
        rangeSources[rangeIndex] = { ...range, end: flat.length };
        continue;
      }

      if (part.kind === "text" || part.kind === "comment") {
        if (typeof part.value !== "string")
          throw new TypeError("Native text and comment values must be strings");
      } else if (part.kind === "element") {
        if (typeof part.name !== "string" || part.name.length === 0)
          throw new TypeError("A native element part requires its actual local name");
        if (part.namespace !== null && typeof part.namespace !== "string")
          throw new TypeError("A native element namespace must be a string or null");
      } else {
        throw new TypeError("A native layout part has an unsupported classification");
      }

      flat.push({ part, rangePath: ancestors, order: sourceOrder++ });
    }
  };

  visit(parts, null, []);

  const validScriptSupport = new Set(["script", "style", "template"]);
  const sectionContexts = new Set<NativeTableContext>([
    "table",
    "thead",
    "tbody",
    "tfoot",
    "tr",
    "colgroup",
  ]);
  if (sectionContexts.has(context)) {
    for (const { part } of flat) {
      if (part.kind === "comment") continue;
      if (part.kind === "text") {
        if (/^[\t\n\f\r ]*$/.test(part.value)) continue;
        throw new TypeError("Non-whitespace text is not an admitted table child");
      }
      if (part.kind !== "element" || part.namespace !== HTML_NAMESPACE)
        throw new TypeError("An unclassified native part is not admitted in a table context");

      const name = part.name.toLowerCase();
      if (part.classification === "script-supporting" && validScriptSupport.has(name)) continue;
      if (part.classification === "hidden-input" && context === "table" && name === "input")
        continue;

      const valid =
        context === "table"
          ? new Set(["caption", "colgroup", "thead", "tbody", "tfoot", "tr"]).has(name)
          : context === "thead" || context === "tbody" || context === "tfoot"
            ? name === "tr"
            : context === "tr"
              ? name === "td" || name === "th"
              : name === "col";
      if (!valid) throw new TypeError("An element is not admitted in this table context");
    }
  }

  const groups: NativeTableGroup[] = [];
  let activeGroup: NativeTableGroupToken | undefined;
  let activePlacements: NativeTablePlacement[] = [];

  const finishGroup = (): void => {
    if (!activeGroup) return;
    groups.push({ token: activeGroup, placements: activePlacements });
    activeGroup = undefined;
    activePlacements = [];
  };

  const groupKind = (part: NativeTableLeafPart): "row" | "column" | "neutral" | "other" => {
    if (part.kind === "comment") return "neutral";
    if (part.kind === "text") return /^[\t\n\f\r ]*$/.test(part.value) ? "neutral" : "other";
    if (part.kind !== "element" || part.namespace !== HTML_NAMESPACE) return "other";

    const name = part.name.toLowerCase();
    if (part.classification === "script-supporting" && validScriptSupport.has(name))
      return "neutral";
    if (name === "tr") return "row";
    if (name === "col") return "column";
    return "other";
  };

  const placements: NativeTablePlacement[] = flat.map((entry) => {
    let groupToken: NativeTableGroupToken | null = null;
    const classification = context === "table" ? groupKind(entry.part) : "other";

    if (classification === "row" || classification === "column") {
      const kind = classification === "row" ? "tbody" : "colgroup";
      if (activeGroup?.kind !== kind) {
        finishGroup();
        activeGroup = { kind, ordinal: groups.length };
      }
      groupToken = activeGroup;
    } else if (classification === "neutral" && activeGroup) {
      groupToken = activeGroup;
    } else {
      finishGroup();
    }

    const placement: NativeTablePlacement = {
      part: entry.part,
      order: entry.order,
      groupToken,
      rangePath: entry.rangePath,
    };

    if (groupToken) {
      activePlacements.push(placement);
    }

    return placement;
  });

  finishGroup();

  const projectionsBySource = new Map<NativeLayoutSource, NativeTableRangeProjection>();
  const ranges: NativeTableRangeProjection[] = [];

  const nextLogicalSource = (
    placement: NativeTablePlacement,
    parent: NativeLayoutSource | null,
  ): NativeLayoutSource => {
    if (parent) {
      const parentIndex = placement.rangePath.indexOf(parent);
      if (parentIndex >= 0) return placement.rangePath[parentIndex + 1] ?? placement.part.source;
    }
    return placement.rangePath[0] ?? placement.part.source;
  };

  for (const range of rangeSources) {
    const members = placements.filter((placement) => placement.rangePath.includes(range.source));
    const segments: NativeTableRangeSegment[] = [];
    for (const placement of members) {
      const previous = segments.at(-1);
      if (previous && previous.groupToken === placement.groupToken) {
        segments[segments.length - 1] = { ...previous, last: placement.part.source };
      } else {
        segments.push({
          ordinal: segments.length,
          groupToken: placement.groupToken,
          first: placement.part.source,
          last: placement.part.source,
        });
      }
    }
    let projection: NativeTableRangeProjection;
    if (segments.length) {
      projection = {
        source: range.source,
        revision: range.revision,
        parent: range.parent,
        depth: range.depth,
        order: range.order,
        segments,
      };
    } else {
      let previous: NativeTablePlacement | undefined;
      let next: NativeTablePlacement | undefined;
      for (let index = 0; index < placements.length; index++) {
        const placement = placements[index]!;
        if (range.parent && !placement.rangePath.includes(range.parent)) continue;
        if (index < range.start) previous = placement;
        else if (index >= range.end && !next) next = placement;
      }
      let groupToken: NativeTableGroupToken | null;
      let before: NativeLayoutSource | null;
      if (range.parent) {
        if (previous) {
          groupToken = previous.groupToken;
          before = next?.groupToken === groupToken ? nextLogicalSource(next, range.parent) : null;
        } else if (next) {
          groupToken = next.groupToken;
          before = nextLogicalSource(next, range.parent);
        } else {
          const parentPosition = projectionsBySource.get(range.parent)?.emptyPosition;
          if (!parentPosition)
            throw new TypeError(
              "An empty native range requires its actual parent's empty position",
            );
          groupToken = parentPosition.groupToken;
          before = parentPosition.before;
        }
      } else {
        const rootPrevious = range.start > 0 ? placements[range.start - 1] : undefined;
        const rootNext = placements[range.end];
        const remainsInPreviousGroup =
          rootPrevious?.groupToken !== null &&
          rootPrevious?.groupToken !== undefined &&
          rootNext?.groupToken === rootPrevious.groupToken;
        groupToken = remainsInPreviousGroup
          ? rootPrevious!.groupToken
          : (rootPrevious?.groupToken ?? null);
        before = remainsInPreviousGroup
          ? nextLogicalSource(rootNext!, null)
          : groupToken
            ? null
            : rootNext
              ? nextLogicalSource(rootNext, null)
              : null;
      }
      projection = {
        source: range.source,
        revision: range.revision,
        parent: range.parent,
        depth: range.depth,
        order: range.order,
        segments: [],
        emptyPosition: { groupToken, before, order: range.order },
      };
    }
    ranges.push(projection);
    projectionsBySource.set(range.source, projection);
  }

  return { context, placements, groups, ranges };
}
