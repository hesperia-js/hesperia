import { expect, test } from "bun:test";
import { join } from "node:path";
import type { RouteManifest, RouteNode } from "../../packages/hesperia/src/routing/manifest.ts";
import type { StyleTopology } from "../../packages/tooling/src/style-topology.ts";
import {
  buildRouteStyleMetadata,
  type RouteViewStyles,
} from "../../packages/tooling/src/route-style-topology.ts";
import { createRouteTable } from "../../packages/tooling/src/route-table.ts";

const root = join(process.cwd(), ".hesperia", "route-style-test");

const filename = (name: string) => join(root, name);

function fixture(loading = true): { manifest: RouteManifest; topology: StyleTopology } {
  const child: RouteNode = {
    id: "/child",
    pattern: "/child",
    segments: [{ kind: "static", value: "child" }],
    files: {
      layout: filename("src/routes/child/+layout.tsx"),
      error: filename("src/routes/child/+error.tsx"),
      page: filename("src/routes/child/+page.tsx"),
      notFound: filename("src/routes/child/+not-found.tsx"),
    },
    children: [],
  };
  const parent: RouteNode = {
    id: "/",
    pattern: "/",
    segments: [],
    files: {
      layout: filename("src/routes/+layout.tsx"),
      ...(loading ? { loading: filename("src/routes/+loading.tsx") } : {}),
      error: filename("src/routes/+error.tsx"),
    },
    children: [child],
  };
  const closures = [
    ["app.tsx", ["shell", "shared"]],
    ["src/routes/+layout.tsx", ["root-layout", "shared"]],
    ["src/routes/+loading.tsx", ["loading"]],
    ["src/routes/+error.tsx", ["root-error"]],
    ["src/routes/child/+layout.tsx", ["child-layout"]],
    ["src/routes/child/+error.tsx", ["child-error"]],
    ["src/routes/child/+page.tsx", ["page"]],
    ["src/routes/child/+not-found.tsx", ["not-found"]],
  ] as const;
  return {
    manifest: { root: parent, routes: [child] },
    topology: {
      entries: closures.map(([entryId, closure]) => ({ entryId, closure })),
      owners: [],
    },
  };
}

test("page and not-found modes get complete ordered shell, layout, loading and error vectors", () => {
  const { manifest, topology } = fixture();
  const result = buildRouteStyleMetadata(root, manifest, topology);
  const view = result.views.get("/child")!;

  const composition = (id: string) =>
    result.compositions.find((item) => item.compositionId === id)!;

  expect(view.page).toBeDefined();

  expect(view.notFound).toBeDefined();

  expect(view.page!.destination).not.toBe(view.notFound!.destination);

  expect(composition(view.page!.destination).styles).toStrictEqual([
    "shell",
    "shared",
    "root-layout",
    "child-layout",
    "page",
  ]);

  expect(composition(view.notFound!.destination).styles).toStrictEqual([
    "shell",
    "shared",
    "root-layout",
    "child-layout",
    "not-found",
  ]);

  expect(composition(view.page!.loading).styles).toStrictEqual([
    "shell",
    "shared",
    "root-layout",
    "child-layout",
    "loading",
  ]);

  expect(view.page!.errors.map((item) => item.boundaryNodeId)).toStrictEqual(["/", "/child"]);

  expect(composition(view.page!.errors[0]!.compositionId).styles).toStrictEqual([
    "shell",
    "shared",
    "root-error",
  ]);

  expect(composition(view.page!.errors[1]!.compositionId).styles).toStrictEqual([
    "shell",
    "shared",
    "root-layout",
    "child-error",
  ]);
});

test("an empty loading area still has a shell and surviving layout composition", () => {
  const { manifest, topology } = fixture(false);
  const result = buildRouteStyleMetadata(root, manifest, topology);
  const loading = result.views.get("/child")!.page!.loading;

  expect(result.compositions.find((item) => item.compositionId === loading)?.styles).toStrictEqual([
    "shell",
    "shared",
    "root-layout",
    "child-layout",
  ]);
});

test("route vectors reject missing entry and duplicate node identities", () => {
  const { manifest, topology } = fixture();
  const incomplete = {
    ...topology,
    entries: topology.entries.filter((item) => item.entryId !== "src/routes/child/+page.tsx"),
  };

  expect(() => buildRouteStyleMetadata(root, manifest, incomplete)).toThrow(
    "Missing stylesheet entry src/routes/child/+page.tsx",
  );

  const duplicate = { ...manifest, root: { ...manifest.root, id: "/child" } };

  expect(() => buildRouteStyleMetadata(root, duplicate, topology)).toThrow(
    "Duplicate route node ID /child",
  );
});

test("route table emits distinct page and not-found records and rejects invalid private IDs", async () => {
  const { manifest, topology } = fixture();
  const metadata = buildRouteStyleMetadata(root, manifest, topology);
  const generated = createRouteTable({ manifest, root, styleMetadata: metadata });
  const table = (
    await import(`data:text/javascript;base64,${Buffer.from(generated.code).toString("base64")}`)
  ).routeTable as {
    root: {
      children: {
        viewStyles: {
          page: { destination: string };
          notFound: { destination: string };
        };
      }[];
    };
  };
  const emitted = table.root.children[0]!.viewStyles;

  expect(emitted.page.destination).toBe(metadata.views.get("/child")!.page!.destination);

  expect(emitted.notFound.destination).toBe(metadata.views.get("/child")!.notFound!.destination);

  expect(emitted.page.destination).not.toBe(emitted.notFound.destination);

  const invalid = (page: RouteViewStyles) => ({
    ...metadata,
    views: new Map([["/child", { ...metadata.views.get("/child"), page }]]),
  });

  const page = metadata.views.get("/child")!.page!;

  expect(() =>
    createRouteTable({
      manifest,
      root,
      styleMetadata: invalid({ ...page, destination: "missing" }),
    }),
  ).toThrow("unknown stylesheet composition missing");

  expect(() =>
    createRouteTable({
      manifest,
      root,
      styleMetadata: invalid({
        ...page,
        errors: [{ boundaryNodeId: "/outside", compositionId: page.destination }],
      }),
    }),
  ).toThrow("non-ancestor error boundary /outside");

  expect(() =>
    createRouteTable({
      manifest,
      root,
      styleMetadata: invalid({ ...page, errors: [page.errors[0]!, page.errors[0]!] }),
    }),
  ).toThrow("repeats error boundary /");

  expect(() =>
    createRouteTable({
      manifest,
      root,
      styleMetadata: {
        ...metadata,
        compositions: [...metadata.compositions, metadata.compositions[0]!],
      },
    }),
  ).toThrow("Duplicate or missing stylesheet composition ID");
});
