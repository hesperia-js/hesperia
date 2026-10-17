import { expect, test } from "bun:test";
import { compile } from "../../packages/compiler/src/index.ts";

test("quoted native event names remain typed component props through compilation", async () => {
  const result = await compile(
    `import type { Component } from "hesperia";
type EmbedProps = {
  readonly "on:load"?: (event: Event) => void;
  readonly "on:error"?: (event: Event) => void;
};
function Embed(props: Component.Props<EmbedProps>) {
  props["on:load"]()?.preventDefault();
  props["on:error"]()?.preventDefault();
  return null;
}
export function Screen() {
  return <Embed
    on:load={(event) => event.preventDefault()}
    on:error={(event) => event.preventDefault()}
  />;
}`,
    { filename: "embed-component-props.tsx" },
  );

  expect(result.diagnostics).toStrictEqual([]);

  expect(result.code).toContain('"on:load"');

  expect(result.code).toContain('"on:error"');

  expect(result.code).toContain('"on:load": (event) => event.preventDefault()');

  expect(result.code).toContain('"on:error": (event) => event.preventDefault()');
});
