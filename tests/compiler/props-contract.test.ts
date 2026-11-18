import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Window } from "happy-dom";
import { mount, type Component } from "hesperia";
import { checkProjectModules } from "../../packages/compiler/src/index.ts";
import { openCheckingProject } from "../../packages/compiler/src/checking.ts";
import type { CompileResult } from "../../packages/compiler/src/compilation.ts";
import { emitCheckingSession } from "../../packages/compiler/src/project-compilation.ts";
import {
  issuedProjectTypingEvidence,
  requestTypingEvidenceCapture,
} from "../../packages/compiler/src/typing-inputs.ts";

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

  const sourceFilename = "props-contract.tsx";
  const root = resolve(import.meta.dir, "../..");
  const session = await openCheckingProject(
    [{ filename: sourceFilename, source }],
    requestTypingEvidenceCapture({ root }),
  );
  let compiled: CompileResult | undefined;

  try {
    const compilation = emitCheckingSession(session);
    const emitted = compilation.modules.get(sourceFilename);
    const evidence = issuedProjectTypingEvidence(compilation);

    expect(compilation.checking.diagnostics).toStrictEqual([]);
    expect(emitted).toBeDefined();
    expect(evidence).toMatchObject({
      state: "sealed",
      captureState: "incomplete-capture",
      checkingResultJoin: true,
      analysisJoin: true,
      modulePopulationJoin: true,
    });
    expect(evidence?.modules).toHaveLength(1);
    expect(evidence?.modules[0]).toMatchObject({ filename: sourceFilename, sourceJoin: true });

    if (!emitted || !evidence) throw new Error("Checked props compilation has no issued evidence");

    compiled = emitted;
    const revisedSource = source.replace(
      'callback.set(() => "second")',
      'callback.set(() => "third")',
    );
    expect(revisedSource).not.toBe(source);
    const revisedSession = await openCheckingProject(
      [{ filename: sourceFilename, source: revisedSource }],
      requestTypingEvidenceCapture({ root }),
    );

    try {
      const revised = emitCheckingSession(revisedSession);
      const revisedModule = revised.modules.get(sourceFilename);

      expect(revised.checking.diagnostics).toStrictEqual([]);
      expect(revisedModule).toBeDefined();
      expect(issuedProjectTypingEvidence(revised)).toBeDefined();
      if (!revisedModule) throw new Error("Revised checked props compilation has no module");

      expect(revisedModule.code).not.toBe(emitted.code);

      const modules = compilation.modules as Map<string, typeof emitted>;
      modules.set(sourceFilename, revisedModule);
      expect(issuedProjectTypingEvidence(compilation)).toBeUndefined();
      modules.set(sourceFilename, emitted);
      expect(issuedProjectTypingEvidence(compilation)).toBe(evidence);
    } finally {
      await revisedSession.dispose();
    }
  } finally {
    await session.dispose();
  }

  if (!compiled) throw new Error("Checked props compilation did not complete");

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
