import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Window } from "happy-dom";
import { mount, type Component } from "hesperia";
import { compileProjectModules } from "../../src/compiler/project-compilation.ts";
import { createQueryParams } from "../../src/routing/query.ts";

test("compiled pages retain plain route values and react to query changes without rerunning their body", async () => {
  const root = resolve(import.meta.dir, "../..");
  const filename = "src/routes/[id]/+page.tsx";
  const result = compileProjectModules(
    [
      {
        filename,
        source: `import type { Page } from "hesperia";
export let bodies = 0;
export const observations: unknown[] = [];
export default function User(props: Page.Props<{ queryParams: { page?: string }; id?: string }>) {
  bodies++;
  observations.push(props.params, props.queryParams);
  return <span>{props.params.id}:{props.queryParams().get("page")}:{props.id()}</span>;
}`,
      },
    ],
    { root },
  );
  expect(result.checking.diagnostics).toStrictEqual([]);
  const directory = resolve(root, ".hesperia");
  await mkdir(directory, { recursive: true });
  const emitted = resolve(directory, `page-props-${randomUUID()}.mjs`);
  await writeFile(emitted, result.modules.get(filename)!.code);
  const window = new Window();
  let app: ReturnType<typeof mount> | undefined;
  try {
    const generated = (await import(pathToFileURL(emitted).href)) as {
      default: Component<Record<string, unknown>>;
      bodies: number;
      observations: unknown[];
    };
    const controller = new AbortController();
    const query = createQueryParams("page=one", controller.signal);
    const params = Object.freeze({ id: "42" });
    let queryReads = 0;
    const read = () => {
      queryReads++;
      return query.read();
    };
    const errors: unknown[] = [];
    app = mount(
      window.document.body as unknown as Element,
      generated.default,
      { params, queryParams: read, id: "ordinary" },
      { onError: (error) => errors.push(error) },
    );
    await app.settled();
    expect(errors).toStrictEqual([]);
    expect(generated.observations[0]).toBe(params);
    expect(generated.observations[1]).toBe(read);
    const span = window.document.querySelector("span")!;
    expect(span.textContent).toBe("42:one:ordinary");
    expect(queryReads).toBe(1);
    query.update("page=two");
    await app.settled();
    expect(span.textContent).toBe("42:two:ordinary");
    expect(window.document.querySelector("span")).toBe(span);
    expect(generated.bodies).toBe(1);
    expect(queryReads).toBe(2);
    expect(errors).toStrictEqual([]);
  } finally {
    app?.dispose();
    await window.happyDOM.close();
    await unlink(emitted);
  }
});
