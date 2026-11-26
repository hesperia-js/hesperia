import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { checkProjectModules, openCheckingProject } from "../../packages/compiler/src/checking.ts";
import {
  compile,
  emitTerminalCliSession,
  openTerminalCliProject,
} from "../../packages/compiler/src/index.ts";
import { emitCheckingSession } from "../../packages/compiler/src/project-compilation.ts";

test("native bindings reject a mismatched target and accept the declared native type", async () => {
  const source = `import * as client from "hesperia/client";
export function App() {
  const input = client.bind<HTMLInputElement>();
  const textarea = client.bind<HTMLTextAreaElement>();
  const good = <input bind={input} />;
  const bad = <input bind={textarea} />;
  return good;
}`;
  const result = await checkProjectModules([{ filename: "native-bindings.tsx", source }]);

  expect(result.diagnostics).toHaveLength(1);

  expect(result.diagnostics[0]?.code).toBe("TS2322");

  expect(result.diagnostics[0]?.message).toContain("HTMLInputElement");

  expect(result.diagnostics[0]?.span?.start).toBe(source.lastIndexOf("bind="));
});

test(
  "the private creator profile checks native terminal bindings, events and keyed components",
  async () => {
    const filename = "creator-terminal.tsx";
    const source = `import { client, type Component } from "hesperia";
import type { Binding } from "hesperia/client";
import type { InputRenderable, SelectRenderable } from "@opentui/core";
const Row: Component<{ label: string }> = (props) => {
  return <text>{props.label()}{[" / ", ["row"]]}</text>;
};
export function App() {
  const selected = client.state(0);
  const input = client.bind<InputRenderable>();
  const chooser: Binding<SelectRenderable> = client.bind<SelectRenderable>();
  client.effect(() => { input().focus(); chooser().focus(); });
  return <box width="100%" height={8} gap={undefined} flexDirection="column"
    on:keydown={(event) => { if (event.name === "return") selected.set(1); }}>
    <input bind={input} value="Hesperia" maxLength={40} placeholder={undefined}
      on:input={(value) => { value.toUpperCase(); }} />
    <select bind={chooser} height={4}
      options={[{ key: "elysia", label: "Elysia", description: undefined }, { key: "none", label: "No host" }]}
      selectedIndex={selected()}
      on:selectionChanged={(event) => { if (event.key !== null) selected.set(event.index); }} />
    {["first", "second"].map((label) => <Row key={label} label={label} />)}
  </box>;
}`;
    const session = await openTerminalCliProject([{ filename, source }]);

    try {
      expect(session.result.diagnostics).toStrictEqual([]);

      const emitted = await emitTerminalCliSession(session);

      expect(emitted.checking.diagnostics).toStrictEqual([]);

      expect(emitted.modules.get(filename)?.code.length).toBeGreaterThan(0);
    } finally {
      await session.dispose();
    }
  },
  { timeout: 30_000 },
);

test(
  "terminal diagnostics retain authored locations for DOM output and native payload mistakes",
  async () => {
    const filename = "invalid-terminal.tsx";
    const source = `export function App() {
  return <box on:keydown={(event) => event.clientX}>
    <div />
    <input value="text" maxLength={-1} />
    <select height={3} options={[]} />
  </box>;
}`;
    const session = await openTerminalCliProject([{ filename, source }]);

    try {
      const diagnostics = session.result.diagnostics;

      expect(
        diagnostics.some(
          (item) =>
            item.code === "HES-TERMINAL-INTRINSIC" &&
            item.message.includes("<div>") &&
            item.span?.start === source.indexOf("<div"),
        ),
      ).toBe(true);

      expect(
        diagnostics.some(
          (item) =>
            item.code === "HES-TERMINAL-INTRINSIC" &&
            item.message.includes("maxLength") &&
            item.span?.start === source.indexOf("maxLength"),
        ),
      ).toBe(true);

      expect(
        diagnostics.some(
          (item) =>
            item.code === "HES-TERMINAL-INTRINSIC" && item.message.includes("at least one option"),
        ),
      ).toBe(true);

      expect(
        diagnostics.some(
          (item) => item.code === "TS2339" && item.span?.start === source.indexOf("clientX"),
        ),
      ).toBe(true);

      expect((await emitTerminalCliSession(session)).modules.size).toBe(0);
    } finally {
      await session.dispose();
    }
  },
  { timeout: 30_000 },
);

test(
  "retained checked sessions reject a later host or helper change",
  async () => {
    const terminal = await openTerminalCliProject([
      {
        filename: "terminal-profile.tsx",
        source: "export function App() { return <box><text>Creator</text></box>; }",
      },
    ]);

    try {
      expect(terminal.result.diagnostics).toStrictEqual([]);

      const wrongHost = emitCheckingSession(terminal);
      expect(wrongHost.modules.size).toBe(0);
      expect(
        wrongHost.checking.diagnostics.some((item) => item.code === "HES-TERMINAL-PROFILE"),
      ).toBe(true);

      const serverOptions = { documentShell: false, renderTarget: "server" };
      const wrongTarget = await emitTerminalCliSession(terminal, serverOptions);
      expect(wrongTarget.modules.size).toBe(0);
      expect(
        wrongTarget.checking.diagnostics.some(
          (item) =>
            item.code === "HES-TERMINAL-OPTION" && item.message.includes("server or resume"),
        ),
      ).toBe(true);

      const wrongHelper = await emitTerminalCliSession(terminal, {
        runtimeModule: "hesperia/runtime",
      });

      expect(wrongHelper.modules.size).toBe(0);

      expect(
        wrongHelper.checking.diagnostics.some((item) => item.code === "HES-TERMINAL-OPTION"),
      ).toBe(true);

      expect((await emitTerminalCliSession(terminal)).checking.diagnostics).toStrictEqual([]);
    } finally {
      await terminal.dispose();
    }

    const invalidOptions = await openTerminalCliProject(
      [
        {
          filename: "terminal-option-first.tsx",
          source: "export function App() { return <box><text>First</text></box>; }",
        },
        {
          filename: "terminal-option-second.tsx",
          source: "export function App() { return <box><text>Second</text></box>; }",
        },
      ],
      { runtimeModule: "hesperia/runtime" },
    );

    try {
      const result = invalidOptions.result;
      const optionDiagnostics = result.diagnostics.filter(
        (item) => item.code === "HES-TERMINAL-OPTION",
      );
      const moduleOptionDiagnostics = result.modules
        .flatMap((module) => module.diagnostics)
        .filter((item) => item.code === "HES-TERMINAL-OPTION");

      expect(optionDiagnostics).toHaveLength(1);
      expect(moduleOptionDiagnostics).toHaveLength(0);
    } finally {
      await invalidOptions.dispose();
    }

    const browser = await openCheckingProject([
      {
        filename: "browser-profile.tsx",
        source: "export function App() { return <button>Browser</button>; }",
      },
    ]);

    try {
      expect(browser.result.diagnostics).toStrictEqual([]);

      const wrongHost = await emitTerminalCliSession(browser);

      expect(wrongHost.modules.size).toBe(0);

      expect(
        wrongHost.checking.diagnostics.some((item) => item.code === "HES-TERMINAL-PROFILE"),
      ).toBe(true);

      expect(emitCheckingSession(browser).checking.diagnostics).toStrictEqual([]);
    } finally {
      await browser.dispose();
    }
  },
  { timeout: 30_000 },
);

test(
  "terminal client markers require a compiled component lifetime",
  async () => {
    const invalidFilename = "module-client-alias.tsx";
    const invalidSource = `import { client } from "hesperia";
const ops = client;
export function App() {
  const count = ops.state(0);
  return <text>{count()}</text>;
}`;
    const validFilename = "owned-client-alias.tsx";
    const validSource = `import { client } from "hesperia";
import type { Client } from "hesperia/client";
function initialState(ops: Client) { return ops.state(1); }
export function App() {
  const ops = client;
  const count = initialState(ops);
  return <text>{count()}</text>;
}`;
    const session = await openTerminalCliProject([
      { filename: invalidFilename, source: invalidSource },
      { filename: validFilename, source: validSource },
    ]);

    try {
      expect(session.result.diagnostics).toStrictEqual([]);

      const emitted = await emitTerminalCliSession(session);

      expect(emitted.modules.get(invalidFilename)?.code).toBe("");

      expect(
        emitted.checking.modules
          .find((module) => module.filename === invalidFilename)
          ?.diagnostics.some(
            (item) =>
              item.code === "HES-TERMINAL-MODULE" &&
              item.span?.start === invalidSource.indexOf("client;"),
          ),
      ).toBe(true);

      expect(emitted.modules.get(validFilename)?.diagnostics).toStrictEqual([]);

      expect(emitted.modules.get(validFilename)?.code.length).toBeGreaterThan(0);
    } finally {
      await session.dispose();
    }
  },
  { timeout: 30_000 },
);

test("native event callbacks retain event-specific properties and receiver types", async () => {
  const source = `export function App() {
  return <button
    on:click={function (event) { console.log(this.disabled, event.clientX); this.focus(); }}
    on:keydown={(event) => console.log(event.key)}
  />;
}`;
  const result = await checkProjectModules([{ filename: "native-events.tsx", source }]);

  expect(result.diagnostics).toStrictEqual([]);
});

test("native event callbacks still reject properties absent from that event", async () => {
  const source = `export function App() {
  return <button on:keydown={(event) => console.log(event.clientX)} />;
}`;
  const result = await checkProjectModules([{ filename: "native-event-error.tsx", source }]);

  expect(result.diagnostics).toHaveLength(1);

  expect(result.diagnostics[0]?.code).toBe("TS2339");

  expect(result.diagnostics[0]?.message).toContain("KeyboardEvent");

  expect(result.diagnostics[0]?.span?.start).toBe(source.indexOf("clientX"));
});

test("native event checking validates declared handler types and the target receiver", async () => {
  const source = `export function App() {
  const keyboardOnly = (event: KeyboardEvent) => console.log(event.key);
  return <button on:click={keyboardOnly} on:focus={function () { console.log(this.href); }} />;
}`;
  const result = await checkProjectModules([{ filename: "native-handler-types.tsx", source }]);

  expect(result.diagnostics).toHaveLength(2);

  expect(result.diagnostics.some((item) => item.code === "TS2322")).toBe(true);

  expect(
    result.diagnostics.some(
      (item) => item.code === "TS2339" && item.message.includes("HTMLButtonElement"),
    ),
  ).toBe(true);
});

test("custom native events retain the base Event type", async () => {
  const source = `export function App() {
  return <div on:custom={(event) => console.log(event.type)} />;
}`;

  expect(
    (await checkProjectModules([{ filename: "custom-event.tsx", source }])).diagnostics,
  ).toStrictEqual([]);
});

test("explicit component type arguments constrain the caller props", async () => {
  const source = `import { type Component } from "hesperia";
function Child<T>(props: Component.Props<{ value: T }>) { return <span>{String(props.value())}</span>; }
export function App() { return <Child<number> value="wrong" />; }`;
  const result = await checkProjectModules([{ filename: "generic-component.tsx", source }]);

  expect(result.diagnostics).toHaveLength(1);

  expect(result.diagnostics[0]).toMatchObject({ code: "TS2769", severity: "error" });

  expect(result.diagnostics[0]?.message).toContain(
    "Type 'string' is not assignable to type 'number'",
  );

  expect(
    (
      await checkProjectModules([
        { filename: "valid-generic.tsx", source: source.replace('value="wrong"', "value={1}") },
      ])
    ).diagnostics,
  ).toStrictEqual([]);
});

test("component type argument diagnostics retain their authored positions", async () => {
  const source = `import { type Component } from "hesperia";
function Child<T>(props: Component.Props<{ value: T }>) { return <span>{String(props.value())}</span>; }
export function App() { return <Child<Missing> value={1} />; }`;
  const result = await checkProjectModules([{ filename: "generic-type-name.tsx", source }]);

  expect(
    result.diagnostics.some(
      (item) => item.code === "TS2304" && item.span?.start === source.indexOf("Missing"),
    ),
  ).toBe(true);
});

test("native binding and receiver types follow SVG, MathML and HTML integration contexts", async () => {
  const source = `import * as client from "hesperia/client";
export function App() {
  const svgLink = client.bind<SVGAElement>();
  const htmlLink = client.bind<HTMLAnchorElement>();
  const mathLink = client.bind<HTMLAnchorElement>();
  const math = client.bind<MathMLElement>();
  return <div>
    <svg><><a bind={svgLink} on:click={function () { console.log(this.href.baseVal); }} /></>
      <foreignObject><a bind={htmlLink} on:click={function () { console.log(this.href.length); }} /></foreignObject>
    </svg>
    <math><mi bind={math} /><mtext><a bind={mathLink} /></mtext></math>
  </div>;
}`;

  expect(
    (await checkProjectModules([{ filename: "native-namespaces.tsx", source }])).diagnostics,
  ).toStrictEqual([]);
});

test("native markup accepts CSS text and scalar SVG attribute values", async () => {
  const source = `export function App() {
  return <div style="color: red"><svg viewBox="0 0 10 10">
    <a href="#target"><circle r={3} cx="5" cy={5} /></a>
  </svg></div>;
}`;

  expect(
    (await checkProjectModules([{ filename: "native-attribute-values.tsx", source }])).diagnostics,
  ).toStrictEqual([]);
});

test("Blob sources are accepted for HTML src, video poster, and native srcset candidates", async () => {
  const source = `import * as client from "hesperia/client";
type Candidate = readonly [Blob | string, \`\u0024{number}w\` | \`\u0024{number}x\`];
export function App() {
  const photo = new Blob(["photo"]);
  const source = client.state<Blob | string>(photo);
  const candidates = client.state<readonly Candidate[]>([[photo, "480w"], ["/large.svg", "2x"]]);
  return <>
    <div src={photo} />
    <img src={source()} srcset={candidates()} />
    <picture><source srcset={[[photo, "1x"], ["/large.svg", "2x"]]} /><img src={photo} /></picture>
    <video src={source()} poster={source()} />
  </>;
}`;

  expect(
    (await checkProjectModules([{ filename: "blob-source-types.tsx", source }])).diagnostics,
  ).toStrictEqual([]);
});

test("Blob attribute types do not widen script, foreign, or unrelated attributes", async () => {
  const source = `const blob = new Blob(["photo"]);
export function App() {
  return <>
    <div id="number-source" src={12} />
    <div id="poster-on-div" poster={blob} />
    <div id="srcset-on-div" srcset={[[blob, "1x"]]} />
    <img id="invalid-descriptor" srcset={[[blob, "480q"]]} />
    <script src={blob} />
    <svg src={blob}><image srcset={[[blob, "1x"]]} /></svg>
    <math><mi src={blob} /></math>
  </>;
}`;
  const result = await checkProjectModules([{ filename: "blob-source-restrictions.tsx", source }]);
  const errors = result.diagnostics.filter((item) => item.code === "TS2322");

  expect(errors.length).toBeGreaterThanOrEqual(8);

  expect(errors.some((item) => item.span?.start === source.indexOf("src={12}"))).toBe(true);

  expect(errors.some((item) => item.span?.start === source.indexOf("poster={blob}"))).toBe(true);

  expect(errors.some((item) => item.message.includes("HesperiaSourceDescriptor"))).toBe(true);

  expect(errors.some((item) => item.span?.start === source.indexOf("src={blob}"))).toBe(true);
});

test("authored embedded-document tags require the official Embed component", async () => {
  for (const sourceValue of ['src="/frame.html"', 'src={new Blob(["frame"])}']) {
    const source = `export function App() {
  return <>
    <iframe ${sourceValue} />
    <embed ${sourceValue} />
    <object ${sourceValue} />
  </>;
}`;
    const checked = await checkProjectModules([{ filename: "embed-markup.tsx", source }]);
    const expectedStarts = ["iframe", "embed", "object"].map((tag) => source.indexOf(`<${tag}`));

    for (const start of expectedStarts) {
      expect(
        checked.diagnostics.some(
          (item) =>
            item.code === "HES-EMBED" &&
            item.message.includes("official Embed component from hesperia/embed") &&
            item.span?.start === start,
        ),
      ).toBe(true);
    }

    const compiled = await compile(source, { filename: "embed-markup.tsx" });
    const compilerErrors = compiled.diagnostics.filter((item) => item.code === "HES-EMBED");

    expect(compilerErrors).toHaveLength(3);

    expect(compilerErrors.every((item) => item.message.includes("hesperia/embed"))).toBe(true);

    expect(compiled.code).toBe("");
  }
});

test("the native browser application passes the authored project checker", async () => {
  const filename = resolve(import.meta.dir, "../browser/Native.tsx");
  const source = await Bun.file(filename).text();

  expect((await checkProjectModules([{ filename, source }])).diagnostics).toStrictEqual([]);
});

test(
  "native element guide examples pass checking and executable emission",
  async () => {
    const guide = await Bun.file(resolve(import.meta.dir, "../../docs/native-elements.md")).text();
    const examples = [...guide.matchAll(/```tsx\r?\n([\s\S]*?)```/gu)];

    expect(examples).toHaveLength(6);

    for (const [index, example] of examples.entries()) {
      const documentShell = index === 4;
      const filename = documentShell ? "app.tsx" : `native-guide-${index}.tsx`;
      const source = example[1]!;

      expect(
        (
          await checkProjectModules([{ filename, source }], {
            documentShell,
            resolutionOverrides: {
              browser: { "hesperia/events": "./packages/hesperia/src/events.ts" },
            },
          })
        ).diagnostics,
      ).toStrictEqual([]);

      const result = await compile(source, { filename, documentShell });

      expect(result.diagnostics).toStrictEqual([]);

      expect(result.code.length).toBeGreaterThan(0);
    }
  },
  { timeout: 30_000 },
);
