import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { checkProjectModules, compile } from "../../src/compiler/index.ts";

test("component prop guide examples pass authored checking and executable emission", async () => {
  const guide = await Bun.file(resolve(import.meta.dir, "../../docs/component-props.md")).text();
  const examples = [...guide.matchAll(/```tsx\r?\n([\s\S]*?)```/gu)];
  expect(examples).toHaveLength(2);
  for (const [index, example] of examples.entries()) {
    const source = example[1]!;
    const filename = `component-props-guide-${index}.tsx`;
    expect(checkProjectModules([{ filename, source }]).diagnostics).toStrictEqual([]);
    const compiled = compile(source, { filename });
    expect(compiled.diagnostics).toStrictEqual([]);
    expect(compiled.code).toContain("defineComponent");
  }
});
