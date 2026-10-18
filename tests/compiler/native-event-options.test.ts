import { expect, test } from "bun:test";
import { openCheckingProject } from "../../packages/compiler/src/checking.ts";
import { compile } from "../../packages/compiler/src/index.ts";

const eventSourceResolution = {
  resolutionOverrides: {
    browser: {
      "hesperia/events": "./packages/hesperia/src/events.ts",
    },
  },
} as const;

test("recognized event imports, aliases, and helper chains get checker-only native context", async () => {
  const source = `import { once as useOnce, capture } from "hesperia/events";
import * as eventTools from "hesperia/events";
import { Embed as ImportedEmbed } from "hesperia/embed";
const captureAlias = eventTools.capture;
const { once: onceAlias } = eventTools;
const EmbedAlias = ImportedEmbed;
export function App() {
  return <>
    <button on:click={[function (event) {
      const receiver: HTMLButtonElement = this;
      const mouse: MouseEvent = event;
      void receiver.disabled;
      void mouse.clientX;
    }, { once: true }]} />
    <button on:click={captureAlias(useOnce(function (event) {
      const receiver: HTMLButtonElement = this;
      const mouse: MouseEvent = event;
      void receiver.disabled;
      void mouse.clientX;
      // @ts-expect-error A click does not carry a keyboard key.
      void event.key;
      // @ts-expect-error A button does not have the anchor href property.
      void this.href;
    }))} />
    <input on:change={eventTools.passive(onceAlias(function (event) {
      const input: HTMLInputElement = this;
      const change: Event = event;
      void input.value;
      void change.type;
    }))} />
    <button on:keydown={capture((event) => {
      const keyboard: KeyboardEvent = event;
      void keyboard.key;
    })} />
    <EmbedAlias on:load={useOnce(function (event) {
      const receiver: HTMLIFrameElement = this;
      const load: Event = event;
      void receiver.contentWindow;
      void load.type;
    })} />
  </>;
}
const overwritten = eventTools.passive([function (this: HTMLButtonElement, event: MouseEvent) {
  void this.disabled;
  void event.clientX;
}, { once: false, passive: false }] as const);
const exactOverwrite: Readonly<{ once: false; passive: true }> = overwritten[1];
// @ts-expect-error The helper overwrites false with literal true.
const wrongOverwrite: typeof overwritten[1] = { once: false, passive: false };
void exactOverwrite;
void wrongOverwrite;
`;
  const session = await openCheckingProject(
    [{ filename: "native-event-options-context.tsx", source }],
    eventSourceResolution,
  );

  try {
    expect(session.result.diagnostics).toStrictEqual([]);

    const view = [...session.views.values()][0]!.source;

    expect(view).toContain('satisfies HesperiaNativeEventHandler<"button","html","click">');

    expect(view).toContain('satisfies HesperiaNativeEventHandler<"input","html","change">');

    expect(view).toContain('satisfies HesperiaNativeEventHandler<"button","html","keydown">');
  } finally {
    await session.dispose();
  }

  const invalidSource = `import { Embed as Frame } from "hesperia/embed";
export function App() {
  return <Frame on:load={[(event: Event) => event.type, { signal: true }]} />;
}`;
  const invalid = await compile(invalidSource, { filename: "embed-event-invalid-options.tsx" });
  const diagnostic = invalid.diagnostics.find((item) => item.code === "HES-EVENT-OPTIONS");

  expect(diagnostic?.message).toContain("static object");

  expect(diagnostic?.span?.start).toBe(invalidSource.indexOf("{ signal: true }"));

  const unrelated = await compile(
    `function Widget(props: { readonly "on:load"?: unknown }) { void props; return null; }
function save(event: Event) { void event.type; }
export function App() { return <Widget on:load={[save, { signal: true }]} />; }`,
    { filename: "unrelated-component-event-prop.tsx" },
  );

  expect(unrelated.diagnostics.filter((item) => item.code === "HES-EVENT-OPTIONS")).toStrictEqual(
    [],
  );
});

test("static option aliases and computed constant keys compile without event diagnostics", async () => {
  const source = `const onceKey = "once";
const onceEnabled = true;
const options = { [onceKey]: onceEnabled, passive: false };
const alias = options;
function save(this: HTMLButtonElement, event: MouseEvent) { this.focus(); event.clientX; }
export function App() { return <button on:click={[save, alias]} />; }`;
  const result = await compile(source, { filename: "native-event-static-options.tsx" });

  expect(result.diagnostics.filter((item) => item.code === "HES-EVENT-OPTIONS")).toStrictEqual([]);
});

test("native loop assignment targets invalidate event options and descriptors", async () => {
  const cases = [
    {
      body: "const options = { once: true }; for (options.once of [false]) {} return <button on:click={[save, options]} />;",
      target: "options.once",
      message: "options object cannot be mutated",
    },
    {
      body: "const options = { once: true }; for (options.once in { changed: false }) {} return <button on:click={[save, options]} />;",
      target: "options.once",
      message: "options object cannot be mutated",
    },
    {
      body: "const listener = [save, { once: true }] as const; for (listener[1] of [{ once: false }]) {} return <button on:click={listener} />;",
      target: "listener[1]",
      message: "event pair cannot be mutated",
    },
    {
      body: "const listener = [save, { once: true }] as const; for (listener[1] in { changed: false }) {} return <button on:click={listener} />;",
      target: "listener[1]",
      message: "event pair cannot be mutated",
    },
  ];

  for (const item of cases) {
    const source = `function save() {} export function App() { ${item.body} }`;
    const diagnostics = (await compile(source, { filename: "native-event-loop-target.tsx" }))
      .diagnostics;

    expect(
      diagnostics.some(
        (diagnostic) =>
          diagnostic.code === "HES-EVENT-OPTIONS" &&
          diagnostic.message.includes(item.message) &&
          diagnostic.span?.start === source.indexOf(item.target),
      ),
    ).toBe(true);
  }
});

test("unrelated native loop assignment targets do not create event diagnostics", async () => {
  const source = `function save() {} export function App() {
    let row = 0;
    for (row of [2]) {}
    for (row in { value: 2 }) {}
    return <button on:click={[save, { once: true }]} />;
  }`;
  const diagnostics = (await compile(source, { filename: "native-event-unrelated-loop.tsx" }))
    .diagnostics;

  expect(diagnostics.filter((item) => item.code === "HES-EVENT-OPTIONS")).toStrictEqual([]);
});

test("computed helper members with a const key are recognized while computed destructuring keeps its compiler diagnostic", async () => {
  const supported = `import * as eventTools from "hesperia/events";
const helperName = "once";
const helper = eventTools[helperName];
export function App() { return <button on:click={helper(save)} />; }`;

  expect(
    (await compile(supported, { filename: "native-event-computed-member.tsx" })).diagnostics.filter(
      (item) => item.code === "HES-EVENT-OPTIONS",
    ),
  ).toStrictEqual([]);

  const unsupported = `import * as eventTools from "hesperia/events";
const helperName = "once";
const { [helperName]: helper } = eventTools;
export function App() { return <button on:click={helper(save)} />; }`;
  const result = await compile(unsupported, { filename: "native-event-computed-destructure.tsx" });

  expect(result.diagnostics.some((item) => item.code === "HES-PATTERN")).toBe(true);
});

test(
  "event descriptors reject dynamic, spread, unsupported, and mutated option data at authored spans",
  async () => {
    const cases: readonly {
      readonly source: string;
      readonly spanText: string;
      readonly lastOccurrence?: boolean;
      readonly occurrence?: number;
    }[] = [
      {
        source: `const options = getOptions(); export function App() { return <button on:click={[save, options]} />; }`,
        spanText: "options",
        lastOccurrence: true,
      },
      {
        source: `export function App() { return <button on:click={[save, { ...options }]} />; }`,
        spanText: "{ ...options }",
      },
      {
        source: `export function App() { return <button on:click={[save, { signal: true }]} />; }`,
        spanText: "{ signal: true }",
      },
      {
        source: `export function App() { return <button on:click={[save, { once: 1 }]} />; }`,
        spanText: "{ once: 1 }",
      },
      {
        source: `const options = { once: true }; options.once = false; export function App() { return <button on:click={[save, options]} />; }`,
        spanText: "options.once",
      },
      {
        source: `const options = { once: true }; const alias = options; alias.once = false; export function App() { return <button on:click={[save, options]} />; }`,
        spanText: "alias.once",
      },
      {
        source: `const options = { once: true }; const firstAlias = options; const secondAlias = firstAlias; secondAlias.once = false; export function App() { return <button on:click={[save, options]} />; }`,
        spanText: "secondAlias.once",
      },
      {
        source: `const options = { once: true }; const box = { options }; box.options.once = false; export function App() { return <button on:click={[save, options]} />; }`,
        spanText: "options",
        occurrence: 1,
      },
      {
        source: `const options = { once: true }; const box = { nested: [options] }; box.nested[0].once = false; export function App() { return <button on:click={[save, options]} />; }`,
        spanText: "options",
        occurrence: 1,
      },
    ];

    for (const item of cases) {
      const result = await compile(item.source, { filename: "native-event-invalid-options.tsx" });
      const diagnostics = result.diagnostics.filter(
        (diagnostic) => diagnostic.code === "HES-EVENT-OPTIONS",
      );

      expect(diagnostics.length).toBeGreaterThan(0);

      let expectedStart = item.lastOccurrence
        ? item.source.lastIndexOf(item.spanText)
        : item.source.indexOf(item.spanText);

      for (let occurrence = 0; occurrence < (item.occurrence ?? 0); occurrence += 1)
        expectedStart = item.source.indexOf(item.spanText, expectedStart + item.spanText.length);

      expect(diagnostics.some((diagnostic) => diagnostic.span?.start === expectedStart)).toBe(true);
    }
  },
  { timeout: 30_000 },
);

test("local same-named helpers stay ordinary handlers and unrelated objects stay unchecked", async () => {
  const source = `function once<T>(value: T): T { return value; }
const unrelated = { once: true };
function save(this: HTMLButtonElement, event: MouseEvent) { this.focus(); event.clientX; }
export function App() { return <button on:click={once(save)} />; }`;
  const result = await compile(source, { filename: "native-event-local-once.tsx" });

  expect(result.diagnostics.filter((item) => item.code === "HES-EVENT-OPTIONS")).toStrictEqual([]);

  const session = await openCheckingProject([{ filename: "native-event-local-once.tsx", source }]);

  try {
    expect(session.result.diagnostics).toStrictEqual([]);
  } finally {
    await session.dispose();
  }
});

test("a local function shadows an imported event helper by binding identity", async () => {
  const source = `import { once } from "hesperia/events";
function save() {}
export function App() {
  function once<Value>(value: Value): Value { return value; }
  return <button on:click={once(save)} />;
}`;
  const compiled = await compile(source, { filename: "native-event-shadowed-helper.tsx" });

  expect(compiled.diagnostics.filter((item) => item.code === "HES-EVENT-OPTIONS")).toStrictEqual(
    [],
  );

  const session = await openCheckingProject(
    [{ filename: "native-event-shadowed-helper.tsx", source }],
    eventSourceResolution,
  );

  try {
    expect(session.result.diagnostics).toStrictEqual([]);
  } finally {
    await session.dispose();
  }
});

test("recognized client.events and namespace helper identities stay binding-based", async () => {
  const source = `import { client as capability } from "hesperia";
import * as framework from "hesperia";
import * as eventTools from "hesperia/events";
const selected = true ? eventTools.once : eventTools.capture;
export function App() { return <>
  <button on:click={capability.events.once(save)} />
  <input on:change={framework.client.events.passive(save)} />
  <button on:keydown={selected(save)} />
</>; }`;
  const result = await compile(source, { filename: "native-event-symbols.tsx" });

  expect(result.diagnostics.filter((item) => item.code === "HES-EVENT-OPTIONS")).toHaveLength(1);

  expect(result.diagnostics.find((item) => item.code === "HES-EVENT-OPTIONS")?.span?.start).toBe(
    source.lastIndexOf("selected"),
  );
});

test("visible pair and helper-result aliases retain static option validation", async () => {
  const cases = [
    {
      name: "inline dynamic control",
      body: "return <button on:click={[save, { once: choose() }]} />;",
      error: true,
    },
    {
      name: "pair alias",
      body: "const listener = [save, { once: choose() }] as const; return <button on:click={listener} />;",
      error: true,
    },
    {
      name: "helper result alias",
      body: "const listener = once([save, { passive: choose() }]); return <button on:click={listener} />;",
      error: true,
    },
    {
      name: "pair alias passed to helper",
      body: "const listener = [save, { passive: choose() }] as const; return <button on:click={once(listener)} />;",
      error: true,
    },
    {
      name: "client namespace helper",
      body: "return <button on:click={client.events.once([save, { passive: choose() }])} />;",
      error: true,
    },
    {
      name: "static pair alias control",
      body: "const listener = [save, { once: true }] as const; return <button on:click={listener} />;",
      error: false,
    },
    {
      name: "static helper-result alias control",
      body: "const listener = once([save, { passive: true }]); const alias = listener; return <button on:click={alias} />;",
      error: false,
    },
  ] as const;

  for (const item of cases) {
    const source = `import { once } from "hesperia/events";
import * as client from "hesperia/client";
function save(event: MouseEvent) { void event.type; }
function choose() { return Math.random() > 0.5; }
export function App() { ${item.body} }`;
    const result = await compile(source, {
      filename: `${item.name.replaceAll(" ", "-")}.tsx`,
    });
    const errors = result.diagnostics.filter(
      (diagnostic) => diagnostic.code === "HES-EVENT-OPTIONS",
    );

    expect(errors.length > 0).toBe(item.error);

    if (item.error) expect(result.code).toBe("");
  }
});

test("client module exports retain native option validation through named and namespace imports", async () => {
  const cases = [
    {
      name: "named events dynamic",
      imports: 'import { events } from "hesperia/client";',
      expression: "events.once([save, { passive: choose() }])",
      error: true,
    },
    {
      name: "namespace named client dynamic",
      imports: 'import * as module from "hesperia/client";',
      expression: "module.client.events.once([save, { passive: choose() }])",
      error: true,
    },
    {
      name: "named client dynamic control",
      imports: 'import { client } from "hesperia/client";',
      expression: "client.events.once([save, { passive: choose() }])",
      error: true,
    },
    {
      name: "named events alias dynamic",
      imports: 'import { events as importedEvents } from "hesperia/client";',
      expression: "alias.once([save, { passive: choose() }])",
      declaration: "const alias = importedEvents;",
      error: true,
    },
    {
      name: "namespace module alias dynamic",
      imports: 'import * as module from "hesperia/client";',
      expression: "alias.events.once([save, { passive: choose() }])",
      declaration: "const alias = module.client;",
      error: true,
    },
    {
      name: "named events static control",
      imports: 'import { events } from "hesperia/client";',
      expression: "events.once([save, { passive: true }])",
      error: false,
    },
    {
      name: "unrelated local events control",
      imports: "",
      expression: "events.once([save, { passive: choose() }])",
      declaration: "const events = { once: (value: unknown) => value };",
      error: false,
    },
  ] as const;

  for (const item of cases) {
    const source = `${item.imports}
function save(event: MouseEvent) { void event.type; }
function choose() { return Math.random() > 0.5; }
export function App() { ${"declaration" in item ? item.declaration : ""} return <button on:click={${item.expression}} />; }`;
    const result = await compile(source, { filename: `${item.name.replaceAll(" ", "-")}.tsx` });
    const errors = result.diagnostics.filter(
      (diagnostic) => diagnostic.code === "HES-EVENT-OPTIONS",
    );

    expect(errors.length > 0).toBe(item.error);

    if (item.error) {
      expect(errors[0]?.span?.start).toBe(source.indexOf("{ passive: choose() }"));

      expect(result.code).toBe("");
    } else expect(result.code.length).toBeGreaterThan(0);
  }
});

test("recognized descriptor aliases cannot be mutated or hidden in mutable containers", async () => {
  const cases = [
    "const options = { once: true }; let leaked = options; leaked.once = false; return <button on:click={[save, options]} />;",
    "const listener = [save, { once: true }] as const; listener[1].once = false; return <button on:click={listener} />;",
    "const listener = [save, { once: true }] as const; const box = { listener }; return <button on:click={listener} />;",
    "const listener = once(save); const alias = listener; alias[1].once = false; return <button on:click={listener} />;",
    "const listener = once(save); const box = { listener }; return <button on:click={listener} />;",
  ];

  for (const body of cases) {
    const source = `import { once } from "hesperia/events";
function save(event: MouseEvent) { void event.type; }
export function App() { ${body} }`;
    const result = await compile(source, { filename: "native-event-alias-escape.tsx" });

    expect(result.diagnostics.some((diagnostic) => diagnostic.code === "HES-EVENT-OPTIONS")).toBe(
      true,
    );
  }

  const valid = `function save(event: MouseEvent) { void event.type; }
export function App() {
  const listener = [save, { once: true }] as const;
  const alias = listener;
  return <button on:click={alias} />;
}`;
  const result = await compile(valid, { filename: "native-event-immutable-pair-alias.tsx" });

  expect(
    result.diagnostics.filter((diagnostic) => diagnostic.code === "HES-EVENT-OPTIONS"),
  ).toStrictEqual([]);
});

test("a static pair alias gives its inline callback the native receiver and event type", async () => {
  const source = `export function App() {
  const listener = [function (event) {
    const receiver: HTMLButtonElement = this;
    const mouse: MouseEvent = event;
    void receiver.disabled;
    void mouse.clientX;
    // @ts-expect-error Clicks do not have keyboard keys.
    void event.key;
  }, { once: true }] as const;
  return <button on:click={listener} />;
}`;
  const session = await openCheckingProject([
    { filename: "native-event-pair-alias-context.tsx", source },
  ]);

  try {
    expect(session.result.diagnostics).toStrictEqual([]);

    expect([...session.views.values()][0]!.source).toContain(
      'satisfies HesperiaNativeEventHandler<"button","html","click">',
    );
  } finally {
    await session.dispose();
  }
});

test("one annotated pair alias can serve two native events", async () => {
  const source = `export function App() {
  const listener = [function (this: HTMLButtonElement, event: Event) {
    void this.disabled;
    void event.type;
  }, { passive: true }] as const;
  return <><button on:click={listener} /><button on:keydown={listener} /></>;
}`;
  const session = await openCheckingProject([
    { filename: "native-event-shared-pair-alias.tsx", source },
  ]);

  try {
    expect(session.result.diagnostics).toStrictEqual([]);
  } finally {
    await session.dispose();
  }
});

test("pair callback context remains checker-only and executable compilation preserves the authored helper expression", async () => {
  const source = `import { once } from "hesperia/events";
export function App() { return <button on:click={once((event) => event.clientX)} />; }`;
  const session = await openCheckingProject(
    [{ filename: "native-event-runtime-source.tsx", source }],
    eventSourceResolution,
  );

  try {
    expect(session.result.diagnostics).toStrictEqual([]);

    const result = await compile(source, { filename: "native-event-runtime-source.tsx" });

    expect(result.diagnostics.filter((item) => item.code === "HES-EVENT-OPTIONS")).toStrictEqual(
      [],
    );

    expect(result.code).toContain("(event) => event.clientX");

    expect(result.code).not.toContain("HesperiaNativeEventHandler");
  } finally {
    await session.dispose();
  }
});

test("nested helper diagnostics point back to the authored event expression", async () => {
  const source = `import { once } from "hesperia/events";
export function App() { return <button on:click={once(function (event) { return event.key; })} />; }`;
  const session = await openCheckingProject(
    [{ filename: "native-event-authored-span.tsx", source }],
    eventSourceResolution,
  );

  try {
    const error = session.result.diagnostics.find((item) => item.code === "TS2339");

    expect(error?.message).toContain("PointerEvent");

    expect(error?.span?.start).toBe(source.lastIndexOf("key"));
  } finally {
    await session.dispose();
  }
});

test("checker snapshots retain authored compiler diagnostics for invalid static options", async () => {
  const source = `export function App() {
  const save = (event: PointerEvent) => { void event.clientX; };
  return <button on:click={[save, { once: 1 }]} />;
}`;
  const session = await openCheckingProject([
    { filename: "native-event-invalid-checking.tsx", source },
  ]);

  try {
    const diagnostic = session.result.diagnostics.find((item) => item.code === "HES-EVENT-OPTIONS");

    expect(diagnostic?.span?.start).toBe(source.indexOf("{ once: 1 }"));

    expect(diagnostic?.span?.end).toBe(source.indexOf("{ once: 1 }") + "{ once: 1 }".length);
  } finally {
    await session.dispose();
  }
});

test("built hesperia/events declarations preserve nested inline event context", async () => {
  const source = `import { once } from "hesperia/events";
export function App() {
  return <button on:click={once(function (event) {
    const receiver: HTMLButtonElement = this;
    const click: PointerEvent = event;
    // @ts-expect-error A click does not carry a keyboard key.
    void event.key;
    // @ts-expect-error A button does not have the anchor href property.
    void this.href;
    void receiver.disabled;
    void click.clientX;
  })} />;
}`;
  const session = await openCheckingProject([
    { filename: "native-event-built-declarations.tsx", source },
  ]);

  try {
    expect(session.result.diagnostics).toStrictEqual([]);

    expect([...session.views.values()][0]!.source).toContain(
      'satisfies HesperiaNativeEventHandler<"button","html","click">',
    );
  } finally {
    await session.dispose();
  }
});
