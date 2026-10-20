import { relative, resolve } from "node:path";
import { parseSync } from "oxc-parser";
import type { CompileResult, ModuleResolver, ProjectCompilation } from "@hesperia/compiler/tooling";
import type { BundledCssRoot } from "./css-bundling.ts";
import type {
  PreparedMarkupStyleImport,
  PreparedStyleImport,
  TransformedPluginSource,
} from "./plugin-pipeline.ts";
import type { PluginStyleArtifact } from "./plugins.ts";

export interface StyleTopology {
  readonly entries: readonly {
    readonly entryId: string;
    readonly closure: readonly string[];
  }[];
  readonly owners: readonly {
    readonly ownerId: string;
    readonly styles: readonly string[];
  }[];
}

type Event = { readonly position: number; readonly order: number } & (
  | {
      readonly kind: "style";
      readonly id: string;
      readonly ownerIds?: readonly string[];
    }
  | { readonly kind: "module"; readonly filename: string }
);

type EventInput = { readonly position: number } & (
  | {
      readonly kind: "style";
      readonly id: string;
      readonly ownerIds?: readonly string[];
    }
  | { readonly kind: "module"; readonly filename: string }
);

/** Compute static preload closure independently from active definition ownership. */
export function buildStyleTopology(
  root: string,
  sources: ReadonlyMap<string, TransformedPluginSource>,
  compilation: ProjectCompilation,
  resolution: ModuleResolver,
  imports: readonly PreparedStyleImport[],
  generated: readonly PluginStyleArtifact[],
  bundled: readonly BundledCssRoot[],
  authoredOffset: (filename: string, generatedOffset: number) => number,
  markupImports: readonly PreparedMarkupStyleImport[] = [],
): StyleTopology {
  const sourceNames = new Map([...sources.keys()].map((name) => [key(name), name]));

  const ids = new Map(bundled.map((root) => [key(root.source), root.id]));

  const events = new Map<string, Event[]>();

  const add = (filename: string, event: EventInput): void => {
    const keyName = key(filename);
    const row = events.get(keyName) ?? [];

    row.push({ ...event, order: row.length } as Event);

    events.set(keyName, row);
  };

  for (const item of imports) {
    const id = ids.get(key(item.filename));

    if (!id) throw new TypeError(`Stylesheet was not bundled: ${item.filename}`);

    add(item.importer, { kind: "style", id, position: item.origin.start });
  }

  const ownersByModule = new Map<string, readonly { id: string; name?: string }[]>();

  for (const [filename, module] of compilation.modules)
    ownersByModule.set(key(filename), module.styleOwners ?? []);

  const directGenerated = new Map<string, string[]>();

  for (const style of generated) {
    const id = `generated:${style.id}`;

    if (!bundled.some((root) => root.id === id))
      throw new TypeError(`Generated stylesheet was not bundled: ${style.id}`);

    let ownerIds: string[];
    let ownerFilename: string | undefined;

    if (style.owner.kind === "component") {
      const separator = style.owner.id.lastIndexOf("#");
      const filename = style.owner.id.slice(0, separator);
      const name = style.owner.id.slice(separator + 1);
      ownerFilename = filename;

      ownerIds =
        name === "__markup"
          ? [style.owner.id]
          : (ownersByModule.get(key(filename)) ?? [])
              .filter((item) => item.name === name)
              .map((item) => item.id);
    } else {
      const shell = [...compilation.modules].find(([filename]) => filename.endsWith("app.tsx"));

      const filename = shell?.[0];
      ownerFilename = filename;
      const rootName = shell && defaultExportName(shell[1]);

      ownerIds = filename
        ? (ownersByModule.get(key(filename)) ?? [])
            .filter((item) => item.name === rootName)
            .map((item) => item.id)
        : [];
    }

    if (ownerIds.length !== 1)
      throw new TypeError(
        `Generated stylesheet ${style.id} must identify exactly one compiled owner; found ${ownerIds.length}`,
      );

    if (!ownerFilename)
      throw new TypeError(`Generated stylesheet ${style.id} has no owning module`);

    add(ownerFilename, {
      kind: "style",
      id,
      position:
        key(style.origin.filename) === key(ownerFilename)
          ? style.origin.start
          : Number.MAX_SAFE_INTEGER,
      ownerIds,
    });

    for (const ownerId of ownerIds) {
      const row = directGenerated.get(ownerId) ?? [];

      row.push(id);

      directGenerated.set(ownerId, row);
    }
  }

  const generatedIds = new Set(generated.map((style) => `generated:${style.id}`));

  for (const item of markupImports) {
    for (const styleId of item.styleIds) {
      const id = `generated:${styleId}`;

      if (!generatedIds.has(id))
        throw new TypeError(`Markup stylesheet was not bundled: ${styleId}`);

      add(item.importer, {
        kind: "style",
        id,
        position: item.origin.start,
        ownerIds: [item.ownerId],
      });
    }
  }

  for (const [filename, source] of sources) {
    const parsed = parseSync(filename, source.current, {
      lang: filename.endsWith(".tsx") ? "tsx" : "ts",
      astType: "ts",
      range: true,
      sourceType: "module",
    });

    for (const node of parsed.program.body as readonly {
      readonly type: string;
      readonly start: number;
      readonly importKind?: string;
      readonly exportKind?: string;
      readonly source?: { readonly value?: unknown };
    }[]) {
      if (
        node.type !== "ImportDeclaration" &&
        node.type !== "ExportNamedDeclaration" &&
        node.type !== "ExportAllDeclaration"
      )
        continue;

      if (node.importKind === "type" || node.exportKind === "type") continue;

      const specifier = node.source?.value;

      if (typeof specifier !== "string") continue;

      const target = resolution.resolve(filename, specifier);

      if (target.kind !== "resolved") continue;

      const actual = sourceNames.get(key(target.filename));

      if (actual)
        add(filename, {
          kind: "module",
          filename: actual,
          position: authoredOffset(filename, node.start),
        });
    }
  }

  for (const row of events.values())
    row.sort((a, b) => a.position - b.position || a.order - b.order);

  const walk = (
    filename: string,
    styles: string[],
    seenStyles: Set<string>,
    seenModules: Set<string>,
    stopAtComponents: boolean,
    ownerId?: string,
  ): void => {
    const moduleKey = key(filename);

    if (seenModules.has(moduleKey)) return;

    seenModules.add(moduleKey);

    for (const event of events.get(moduleKey) ?? []) {
      if (event.kind === "style") {
        if (ownerId && event.ownerIds && !event.ownerIds.includes(ownerId)) continue;

        if (!seenStyles.has(event.id)) {
          seenStyles.add(event.id);

          styles.push(event.id);
        }
      } else if (!stopAtComponents || !ownersByModule.get(key(event.filename))?.length)
        walk(event.filename, styles, seenStyles, seenModules, stopAtComponents, ownerId);
    }
  };

  const entries = [...compilation.modules.keys()].map((filename) => {
    const closure: string[] = [];

    walk(filename, closure, new Set(), new Set(), false);

    return { entryId: relative(root, filename).replaceAll("\\", "/"), closure };
  });

  const markupEntries = [...directGenerated]
    .filter(([ownerId]) => ownerId.endsWith("#__markup"))
    .map(([entryId, closure]) => ({ entryId, closure: [...closure] }));

  const owners = [...compilation.modules].flatMap(([filename, compiled]) =>
    (compiled.styleOwners ?? []).map(({ id }) => {
      const styles: string[] = [];

      walk(filename, styles, new Set(), new Set(), true, id);

      for (const generatedId of directGenerated.get(id) ?? [])
        if (!styles.includes(generatedId)) styles.push(generatedId);

      return { ownerId: id, styles };
    }),
  );
  const knownOwners = new Set(owners.map((item) => item.ownerId));

  const markupOwners = [...directGenerated]
    .filter(([ownerId]) => ownerId.endsWith("#__markup") && !knownOwners.has(ownerId))
    .map(([ownerId, styles]) => ({ ownerId, styles: [...styles] }));

  return {
    entries: [...entries, ...markupEntries],
    owners: [...owners, ...markupOwners],
  };
}

function defaultExportName(module: CompileResult): string | undefined {
  for (const item of module.ir.body) {
    if (item.kind !== "export" || item.exportKind !== "default") continue;

    if (item.declaration.kind === "function") return item.declaration.name;

    if (item.declaration.kind === "expression") return "default";
  }

  return undefined;
}

function key(filename: string): string {
  const normalized = resolve(filename).replaceAll("\\", "/");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}
