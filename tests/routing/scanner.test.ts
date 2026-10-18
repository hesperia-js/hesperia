import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, dirname, join } from "node:path";
import { scanRoutes, scanRouteFiles, RouteScanError } from "../../packages/compiler/src/scanner.ts";
import { matchRoute, matchNotFound } from "../../packages/hesperia/src/routing/manifest.ts";
import type { Route } from "../../packages/hesperia/src/routing/index.ts";

const temporary: string[] = [];

afterEach(async () => {
  for (const directory of temporary.splice(0)) {
    if (!resolve(directory).startsWith(resolve(tmpdir(), "hesperia-routing-")))
      throw new Error("Unexpected temporary routing directory");

    await rm(directory, { recursive: true, force: true });
  }
});

async function files(names: readonly string[]): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "hesperia-routing-"));

  temporary.push(root);

  for (const name of names) {
    const path = resolve(root, name);

    await mkdir(dirname(path), { recursive: true });

    await writeFile(path, "throw new Error('Route scanning must never execute a module');\n");
  }

  return root;
}

test("filesystem conventions preserve grouped ancestry, boundaries, and deterministic parameter precedence", async () => {
  const names = [
    "+layout.tsx",
    "+not-found.tsx",
    "+loading.tsx",
    "+error.tsx",
    "+route.ts",
    "(site)/users/+layout.tsx",
    "(site)/users/new/+page.tsx",
    "(site)/users/[id]/+page.tsx",
    "(site)/users/[[optional]]/+page.tsx",
    "(site)/users/[...rest]/+page.tsx",
    "_private/+page.tsx",
    "(site)/users/+not-found.tsx",
  ];
  const root = await files(names);
  const manifest = await scanRoutes(root);

  expect(manifest.routes.map((route) => route.pattern)).toStrictEqual([
    "/users/new",
    "/users/[id]",
    "/users/[[optional]]",
    "/users/[...rest]",
  ]);

  expect(manifest).toStrictEqual(
    scanRouteFiles(root, names.map((name) => resolve(root, name)).reverse()),
  );

  const matched = matchRoute(manifest, new URL("https://example.test/users/a%20b"))!;

  expect(matched.params).toStrictEqual({ id: "a b" });

  expect(matched.chain.map((node) => node.id)).toStrictEqual([
    "/",
    "/(site)",
    "/(site)/users",
    "/(site)/users/[id]",
  ]);

  expect(matched.chain[0]!.files.route).toBe(resolve(root, "+route.ts"));

  expect(matchRoute(manifest, new URL("https://example.test/users"))!.params).toStrictEqual({});

  expect(matchRoute(manifest, new URL("https://example.test/users/a/b"))!.params).toStrictEqual({
    rest: ["a", "b"],
  });

  expect(matchNotFound(manifest, new URL("https://example.test/users/missing/more"))!.leaf.id).toBe(
    "/(site)/users",
  );
});

test("real group collisions and renamed parameter siblings reject both paths", async () => {
  const grouped = await files(["(first)/same/+page.tsx", "(second)/same/+page.tsx"]);

  await expect(scanRoutes(grouped)).rejects.toMatchObject({
    name: "RouteScanError",
    paths: [
      resolve(grouped, "(first)/same/+page.tsx"),
      resolve(grouped, "(second)/same/+page.tsx"),
    ],
  });

  const params = await files(["users/[id]/+page.tsx", "users/[name]/+page.tsx"]);

  await expect(scanRoutes(params)).rejects.toMatchObject({
    name: "RouteScanError",
    paths: [resolve(params, "users/[id]"), resolve(params, "users/[name]")],
  });

  const optionalRest = await files(["files/[[...parts]]/+page.tsx", "files/[[...rest]]/+page.tsx"]);

  await expect(scanRoutes(optionalRest)).rejects.toMatchObject({
    name: "RouteScanError",
    paths: [
      resolve(optionalRest, "files/[[...parts]]"),
      resolve(optionalRest, "files/[[...rest]]"),
    ],
  });

  const separated = await files(["(one)/[id]/+page.tsx", "(two)/[name]/+page.tsx"]);

  await expect(scanRoutes(separated)).rejects.toBeInstanceOf(RouteScanError);
});

test("optional and rest matching backtrack without treating empty internal path segments as absent", async () => {
  const root = await files([
    "docs/[[lang]]/intro/+page.tsx",
    "files/[...parts]/edit/+page.tsx",
    "optional/[[...parts]]/+page.tsx",
    "required/[...parts]/+page.tsx",
  ]);
  const manifest = await scanRoutes(root);

  expect(matchRoute(manifest, new URL("https://example.test/docs/intro"))!.params).toStrictEqual(
    {},
  );

  expect(matchRoute(manifest, new URL("https://example.test/docs/fr/intro"))!.params).toStrictEqual(
    { lang: "fr" },
  );

  expect(
    matchRoute(manifest, new URL("https://example.test/files/a/b/edit"))!.params,
  ).toStrictEqual({ parts: ["a", "b"] });

  expect(matchRoute(manifest, new URL("https://example.test/docs/%E0%A4/intro"))).toBeNull();

  expect(matchRoute(manifest, new URL("https://example.test/docs//intro"))!.params).toStrictEqual({
    lang: "",
  });

  expect(matchRoute(manifest, new URL("https://example.test/required"))).toBeNull();

  expect(
    matchRoute(manifest, new URL("https://example.test/required/a%2Fb/c"))!.params,
  ).toStrictEqual({ parts: ["a/b", "c"] });

  const optionalAbsent = matchRoute(manifest, new URL("https://example.test/optional"))!;

  expect(optionalAbsent.params).toStrictEqual({});

  expect(optionalAbsent.params.parts).toBeUndefined();

  const optionalPresent = matchRoute(manifest, new URL("https://example.test/optional/a%2Fb/c"))!;

  expect(optionalPresent.params).toStrictEqual({ parts: ["a/b", "c"] });

  expect(Object.isFrozen(optionalPresent.params.parts)).toBe(true);
});

test("required rest precedes optional rest and both support static suffixes", async () => {
  const root = await files([
    "catch/[...parts]/edit/+page.tsx",
    "catch/[[...parts]]/edit/+page.tsx",
    "suffix/[...parts]/edit/+page.tsx",
    "optional-suffix/[[...parts]]/edit/+page.tsx",
  ]);
  const manifest = await scanRoutes(root);

  expect(manifest.routes.map((route) => route.pattern)).toStrictEqual([
    "/catch/[...parts]/edit",
    "/suffix/[...parts]/edit",
    "/catch/[[...parts]]/edit",
    "/optional-suffix/[[...parts]]/edit",
  ]);

  expect(manifest.routes[2]!.segments[1]!.kind).toBe("optional-rest");

  expect(matchRoute(manifest, new URL("https://example.test/catch/a/edit"))!.leaf.pattern).toBe(
    "/catch/[...parts]/edit",
  );

  expect(matchRoute(manifest, new URL("https://example.test/catch/edit"))!.leaf.pattern).toBe(
    "/catch/[[...parts]]/edit",
  );

  expect(matchRoute(manifest, new URL("https://example.test/suffix/edit"))).toBeNull();

  expect(
    matchRoute(manifest, new URL("https://example.test/suffix/a/b/edit"))!.params,
  ).toStrictEqual({ parts: ["a", "b"] });

  expect(
    matchRoute(manifest, new URL("https://example.test/optional-suffix/edit"))!.params,
  ).toStrictEqual({});
});

test("repeated parameter names, invalid segments, and paths outside the source root fail closed", async () => {
  const root = await files(["users/[id]/posts/[id]/+page.tsx"]);

  await expect(scanRoutes(root)).rejects.toThrow("Repeated route parameter");

  expect(() => scanRouteFiles(root, [resolve(root, "../outside/+page.tsx")])).toThrow(
    "outside its root",
  );

  expect(() => scanRouteFiles(root, [resolve(root, "users/[broken/+page.tsx")])).toThrow(
    "Invalid route segment",
  );

  expect(() => scanRouteFiles(root, [resolve(root, "users/[[...name]]/+page.tsx")])).not.toThrow();

  expect(() => scanRouteFiles(root, [resolve(root, "users/[[...name]]]/+page.tsx")])).toThrow(
    "Invalid route segment",
  );
});

const _guardTypeProbe: Route.Guard<"/users/[[...parts]]/[id]/[[lang]]"> = ({ params }) => {
  const parts: readonly string[] | undefined = params.parts;
  const id: string = params.id;
  const lang: string | undefined = params.lang;
  return Boolean(parts || id || lang);
};
