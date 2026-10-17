import { basename } from "node:path";
import type { BundledCss } from "./css-bundling.ts";
import type { StyleTopology } from "./style-topology.ts";
import type { RouteStyleMetadata } from "./route-style-topology.ts";

export interface StyleRevisionPlan {
  readonly assets: readonly {
    readonly id: string;
    readonly revision: string;
    readonly path: string;
    readonly link?: StyleLinkMetadata;
  }[];
  readonly owners: StyleTopology["owners"];
  readonly entries: StyleTopology["entries"];
  readonly compositions: RouteStyleMetadata["compositions"];
}

export interface StyleLinkMetadata {
  readonly rel: string;
  readonly media?: string;
  readonly disabled?: boolean;
  readonly title?: string;
  readonly requestAttributes?: Readonly<Record<string, string>>;
}

export function styleRevisionPlan(
  bundled: BundledCss,
  topology: StyleTopology,
  compositions: RouteStyleMetadata["compositions"] = [],
  linkMetadata: ReadonlyMap<string, StyleLinkMetadata> = new Map(),
): StyleRevisionPlan {
  return {
    assets: bundled.roots.map((root) => ({
      id: root.id,
      revision: root.revision,
      path: root.href ?? `./${basename(root.path)}`,
      ...(linkMetadata.has(root.id) ? { link: linkMetadata.get(root.id)! } : {}),
    })),
    owners: topology.owners,
    entries: topology.entries,
    compositions,
  };
}

/** Emit one shared module so every generated definition uses the same style runtime. */
export function stylePlanSource(
  bundled: BundledCss,
  topology: StyleTopology,
  runtimeModule: string,
  development = false,
  compositions: RouteStyleMetadata["compositions"] = [],
  linkMetadata: ReadonlyMap<string, StyleLinkMetadata> = new Map(),
): string {
  const assets = bundled.roots.map((root) => {
    const path = root.href ?? `./${basename(root.path)}`;
    const href =
      path.startsWith("./") || path.startsWith("../")
        ? `new URL(${JSON.stringify(path)},import.meta.url).href`
        : JSON.stringify(path);
    return `{id:${JSON.stringify(root.id)},revision:${JSON.stringify(root.revision)},href:${href}${linkMetadata.has(root.id) ? `,link:${JSON.stringify(linkMetadata.get(root.id))}` : ""}}`;
  });
  return [
    `import { createInternalStyleRuntime } from ${JSON.stringify(runtimeModule)};`,
    `export const styles = createInternalStyleRuntime({assets:[${assets.join(",")}],owners:${JSON.stringify(topology.owners)},entries:${JSON.stringify(topology.entries)},compositions:${JSON.stringify(compositions)}});`,
    ...(development
      ? [
          `addEventListener("hesperia:style-revision", event => {`,
          `  const detail = event.detail;`,
          `  if (!detail || !detail.plan || !detail.resolve || !detail.reject) return;`,
          `  event.preventDefault();`,
          `  const next = {...detail.plan, assets: detail.plan.assets.map(asset => ({id: asset.id, revision: asset.revision, href: asset.path.startsWith("./") || asset.path.startsWith("../") ? new URL(asset.path, import.meta.url).href : asset.path, ...(asset.link ? {link: asset.link} : {})}))};`,
          `  void styles.prepareRevision(next, document.head).then(revision => { try { revision.publish(); detail.resolve(); } finally { revision.release(); } }, detail.reject).catch(detail.reject);`,
          `});`,
        ]
      : []),
  ].join("\n");
}
