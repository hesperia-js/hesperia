import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Window } from "happy-dom";
import { mount, type Component } from "hesperia";
import { checkProjectModules, compile } from "../../packages/compiler/src/index.ts";

test("compiled optional callbacks remain accessors through presence changes without recreating the child", async () => {
  const source = `
    import { type Component } from "hesperia";
    import * as client from "hesperia/client";
    let bodies = 0;
    export function childBodies() { return bodies; }
    function Child(props: Component.Props<{ onDone?: () => string }>) {
      bodies++;
      return <span>{props.onDone()?.() ?? "absent"}</span>;
    }
    export function App() {
      const callback = client.state<(() => string) | undefined>(() => "first");
      return <main>
        <button on:click={() => callback.set(undefined)}>clear</button>
        <button on:click={() => callback.set(() => "second")}>replace</button>
        <Child onDone={callback()} />
      </main>;
    }
  `;

  expect(
    (await checkProjectModules([{ filename: "props-contract.tsx", source }])).diagnostics,
  ).toStrictEqual([]);

  const compiled = await compile(source, { filename: "props-contract.tsx" });

  expect(compiled.diagnostics).toStrictEqual([]);

  const directory = resolve(import.meta.dir, "../../.hesperia");

  await mkdir(directory, { recursive: true });

  const filename = resolve(directory, `props-contract-${randomUUID()}.mjs`);

  await writeFile(filename, compiled.code);

  const window = new Window();
  let app: ReturnType<typeof mount> | undefined;

  try {
    const generated = (await import(pathToFileURL(filename).href)) as {
      App: Component<object>;

      childBodies(): number;
    };
    const errors: unknown[] = [];
    app = mount(
      window.document.body as unknown as Element,
      generated.App,
      {},
      { onError: (error) => errors.push(error) },
    );

    await app.settled();

    expect(errors).toStrictEqual([]);

    const span = window.document.querySelector("span")!;

    expect(span.textContent).toBe("first");

    window.document.querySelectorAll("button")[0]!.click();

    expect(span.textContent).toBe("absent");

    window.document.querySelectorAll("button")[1]!.click();

    expect(span.textContent).toBe("second");

    expect(window.document.querySelector("span")).toBe(span);

    expect(generated.childBodies()).toBe(1);

    expect(errors).toStrictEqual([]);
  } finally {
    app?.dispose();

    await window.happyDOM.close();

    await unlink(filename);
  }
});
