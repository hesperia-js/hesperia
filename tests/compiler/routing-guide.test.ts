import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { checkProjectModules, compile } from "../../packages/compiler/src/index.ts";

test(
  "routing guide examples pass authored checking and executable emission",
  async () => {
    const guide = await Bun.file(resolve(import.meta.dir, "../../docs/routing.md")).text();
    const examples = [...guide.matchAll(/```(?:tsx|ts)\r?\n([\s\S]*?)```/gu)];

    expect(examples).toHaveLength(2);

    for (const [index, example] of examples.entries()) {
      const source = example[1]!;
      const filename = `routing-guide-${index}.tsx`;

      expect((await checkProjectModules([{ filename, source }])).diagnostics).toStrictEqual([]);

      const compiled = await compile(source, { filename });

      expect(compiled.diagnostics).toStrictEqual([]);

      expect(compiled.code).toContain(index === 0 ? "route" : "registerDeparture");
    }
  },
  { timeout: 30_000 },
);
