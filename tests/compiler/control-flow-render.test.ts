import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Window } from "happy-dom";
import { mount, type Component } from "hesperia";
import { compile } from "../../packages/compiler/src/index.ts";

test.each(["row", "{ id, ...row }"])(
  "keyed rows retain current values through spreads and try callbacks: %s",
  async (parameter) => {
    const key = parameter === "row" ? "row.id" : "id";
    const result = await compile(
      `
    import { state } from "hesperia/client";
    export const controls = { replace: () => {}, events: [] as string[] };
    export function App() {
      const rows = state([{ id: "one", words: ["first"] }]);
      controls.replace = () => rows.set([{ id: "one", words: ["second", "value"] }]);
      return <main>{rows().map((${parameter}) => <button key={${key}} on:click={() => {
        try { throw {}; }
        catch ({ message = [...row.words].join(" ") }) { controls.events.push(message); }
        finally { controls.events.push(${key}); }
      }}>{[...row.words].join(" ")}</button>)}</main>;
    }
  `,
      { filename: "control-flow-render.tsx" },
    );

    expect(result.diagnostics).toStrictEqual([]);

    const directory = resolve(import.meta.dir, "../../.hesperia");

    await mkdir(directory, { recursive: true });

    const filename = resolve(directory, `control-flow-render-${randomUUID()}.mjs`);

    await writeFile(filename, result.code);

    const window = new Window();

    try {
      const generated = (await import(pathToFileURL(filename).href)) as {
        App: Component<Record<string, never>>;
        controls: { replace(): void; events: string[] };
      };
      const faults: unknown[] = [];
      const app = mount(
        window.document.body as unknown as Element,
        generated.App,
        {},
        {
          onError: (error) => faults.push(error),
        },
      );

      try {
        await app.settled();

        const button = window.document.querySelector("button")!;

        expect(button.textContent).toBe("first");

        button.click();

        generated.controls.replace();

        await app.settled();

        expect(window.document.querySelector("button")).toBe(button);

        expect(button.textContent).toBe("second value");

        button.click();

        expect(generated.controls.events).toStrictEqual(["first", "one", "second value", "one"]);

        expect(faults).toStrictEqual([]);
      } finally {
        app.dispose();
      }
    } finally {
      await window.happyDOM.close();

      await unlink(filename);
    }
  },
);
