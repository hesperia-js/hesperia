import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { compile } from "../../packages/compiler/src/index.ts";

const clientApiFixtures = join(import.meta.dir, "fixtures/applications/client-api");

test("direct imported API values remain module imports and bind to each component owner", async () => {
  const result = await compile(
    await readFile(join(clientApiFixtures, "imported-api.tsx"), "utf8"),
    { filename: "imported-api.tsx" },
  );

  expect(result.diagnostics).toStrictEqual([]);

  expect(result.code).toContain('import api, { helper as named } from "./api";');

  expect(result.code).toContain('import * as tools from "./tools";');

  expect(result.code).toContain("_$.bindImported(owner, api)");

  expect(result.code).toContain("_$.bindImported(owner, named)");

  expect(result.code).toContain('_$.bindImported(owner, tools, "namespace")');
});

test("navigation imports lower by symbol identity across direct, namespace, and const aliases", async () => {
  const result = await compile(
    await readFile(join(clientApiFixtures, "navigation-api.tsx"), "utf8"),
    { filename: "navigation-api.tsx" },
  );

  expect(result.diagnostics).toStrictEqual([]);

  expect(result.code).toContain('from "hesperia/navigation"');

  expect(result.code.match(/registerDeparture\(owner/g)?.length).toBe(8);

  expect(result.code.match(/bindImported\(owner, navigation\)/g)?.length).toBe(1);

  expect(result.code).toContain("mutableGuard(() => true);");

  expect(result.code).toContain("beforeLeave(() => {});");
});

test("captured navigation marker values bind the owner and preserve reassignment", async () => {
  const result = await compile(
    await readFile(join(clientApiFixtures, "navigation-marker-value.tsx"), "utf8"),
    { filename: "navigation-marker-value.tsx" },
  );

  expect(result.diagnostics).toStrictEqual([]);

  const registrations: { readonly owner: object; readonly check: () => boolean }[] = [];

  const owner = {};

  const runtime = {
    defineComponent(factory: (owner: object) => unknown) {
      return () => factory(owner);
    },

    element() {
      return null;
    },

    registerDeparture(registeredOwner: object, check: () => boolean) {
      registrations.push({ owner: registeredOwner, check });
    },
  };

  const executable = result.code
    .replace(/^import[^\r\n]*;[ \t]*\r?\n/gm, "")
    .replace(/^export\s+/gm, "");

  const load = new Function(
    "_$",
    "beforeLeave",
    "Navigation",
    executable + "\nreturn { App, reassignedChecks };",
  ) as (
    runtimeAdapter: typeof runtime,
    marker: (check: () => boolean) => void,
    navigation: { readonly beforeLeave: (check: () => boolean) => void },
  ) => {
    readonly App: () => unknown;
    readonly reassignedChecks: (() => boolean)[];
  };

  const module = load(
    runtime,
    () => {
      throw new Error("The uncompiled beforeLeave marker escaped into generated code");
    },
    {
      beforeLeave: () => {
        throw new Error("The uncompiled namespace marker escaped into generated code");
      },
    },
  );

  module.App();

  expect(registrations).toHaveLength(2);

  expect(registrations[0]?.owner).toBe(owner);

  expect(registrations[0]?.check()).toBe(true);

  expect(registrations[1]?.owner).toBe(owner);

  expect(registrations[1]?.check()).toBe(false);

  expect(module.reassignedChecks).toHaveLength(1);

  expect(module.reassignedChecks[0]?.()).toBe(false);
});

test("deprecated navigation authoring fails with migration diagnostics", async () => {
  const result = await compile(
    `import client from "hesperia/client";
import { beforeLeave } from "hesperia/routing";
export function App() {
  client.navigation.beforeLeave(() => true);
  beforeLeave(() => true);
  return <button>finish</button>;
}`,
    { filename: "old-navigation-api.tsx" },
  );

  expect(result.code).toBe("");

  expect(result.diagnostics.map((item) => item.code)).toEqual(
    expect.arrayContaining(["HES-NAVIGATION-CLIENT-MEMBER", "HES-NAVIGATION-IMPORT"]),
  );
});
