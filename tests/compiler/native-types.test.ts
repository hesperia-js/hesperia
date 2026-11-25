import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { checkProjectModules } from "../../packages/compiler/src/checking.ts";
import { compile } from "../../packages/compiler/src/index.ts";

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
