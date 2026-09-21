import { expect, test } from "bun:test";
import { compile } from "../../src/compiler/index.ts";

test("direct imported API values remain module imports and bind to each component owner", () => {
  const result = compile(
    `import api, { helper as named } from "./api";
import * as tools from "./tools";
export function App() {
  const user = api.users.get("ada");
  return <main>{user.value()}:{named()}:{tools.value}</main>;
}`,
    { filename: "imported-api.tsx" },
  );

  expect(result.diagnostics).toStrictEqual([]);
  expect(result.code).toContain('import api, { helper as named } from "./api";');
  expect(result.code).toContain('import * as tools from "./tools";');
  expect(result.code).toContain("_$.bindImported(owner, api)");
  expect(result.code).toContain("_$.bindImported(owner, named)");
  expect(result.code).toContain('_$.bindImported(owner, tools, "namespace")');
});

test("client navigation and the named routing marker lower to owner departure registration", () => {
  const result = compile(
    `import client from "hesperia/client";
import { beforeLeave as guard } from "hesperia/routing";
export function App() {
  const pending = () => true;
  client.navigation.beforeLeave(() => !pending());
  guard(async () => !pending());
  return <button>finish</button>;
}`,
    { filename: "navigation-api.tsx" },
  );

  expect(result.diagnostics).toStrictEqual([]);
  expect(result.code).not.toContain('from "hesperia/client"');
  expect(result.code).not.toContain('from "hesperia/routing"');
  expect(result.code.match(/registerDeparture\(owner/g)?.length).toBe(2);
});
