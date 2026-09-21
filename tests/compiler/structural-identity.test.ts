import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Window } from "happy-dom";
import { mount, type Component } from "hesperia";
import { compile } from "../../src/compiler/index.ts";

test("separate raw regions have independent replacement counts in one render frame", async () => {
  const compiled = compile(
    `
    import * as client from "hesperia/client";
    export const controls = { replace: () => undefined };
    export default function App() {
      const markup = client.state("<b>first</b>");
      Object.assign(controls, { replace: () => markup.set("<b>second</b>") });
      return <main>
        <section>{client.unsafeHTML(<article />, markup())}</section>
        <section>{client.unsafeHTML(<article />, markup())}</section>
      </main>;
    }
  `,
    { filename: "raw-identities.tsx", allowUnsafeHTML: true },
  );
  expect(compiled.diagnostics).toStrictEqual([]);
  const directory = resolve(import.meta.dir, "../../.hesperia");
  await mkdir(directory, { recursive: true });
  const filename = resolve(directory, `identity-test-${randomUUID()}.mjs`);
  await writeFile(filename, compiled.code);
  try {
    const generated = (await import(pathToFileURL(filename).href)) as {
      default: Component<object>;
      controls: { replace(): void };
    };
    const window = new Window();
    const warnings: string[] = [];
    const faults: unknown[] = [];
    const app = mount(
      window.document.body as unknown as Element,
      generated.default,
      {},
      {
        warn: (warning) => warnings.push(warning),
        onError: (error) => faults.push(error),
      },
    );
    try {
      await app.settled();
      warnings.length = 0;
      generated.controls.replace();
      await app.settled();
      expect(
        [...window.document.querySelectorAll("article")].map((node) => node.textContent),
      ).toStrictEqual(["second", "second"]);
      expect(faults).toStrictEqual([]);
      expect(warnings).toStrictEqual([]);
    } finally {
      app.dispose();
      await window.happyDOM.close();
    }
  } finally {
    await unlink(filename);
  }
});

test("structural identities survive formatting and local renames", () => {
  const first = compile(
    `import * as client from "hesperia/client";
export default function App(){
 const markup = client.state("<b>first</b>");
 return <main><section>{client.unsafeHTML(<article />, markup())}</section><section>{client.unsafeHTML(<article />, markup())}</section></main>;
}`,
    { filename: "identity-a.tsx", allowUnsafeHTML: true },
  );
  const second = compile(
    `import * as client from "hesperia/client";

export default function App() {
  const html = client.state("<b>first</b>");
  return (
    <main>
      <section>{client.unsafeHTML(<article />, html())}</section>
      <section>{client.unsafeHTML(<article />, html())}</section>
    </main>
  );
}`,
    { filename: "identity-b.tsx", allowUnsafeHTML: true },
  );
  expect(first.diagnostics).toStrictEqual([]);
  expect(second.diagnostics).toStrictEqual([]);
  const identities = (code: string) =>
    [...code.matchAll(/"(?:raw|list|conditional|await|async):[^"]+"/g)].map((match) => match[0]);
  expect(identities(first.code)).toStrictEqual(identities(second.code));
  expect(identities(first.code).filter((value) => value.startsWith('"raw:'))).toHaveLength(2);
});
