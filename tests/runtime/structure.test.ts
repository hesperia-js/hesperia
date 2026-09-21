import { afterEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { createClient, type State } from "../../src/client.ts";
import {
  componentItem,
  defineComponent,
  element,
  mount,
  nativeItem,
  region,
  text,
  type NativeFactory,
} from "../../src/runtime/index.ts";
import type { ComponentProps } from "../../src/runtime/components.ts";

const windows: Window[] = [];
afterEach(() => {
  for (const window of windows.splice(0)) window.close();
});
function container(): Element {
  const window = new Window();
  windows.push(window);
  return window.document.body as unknown as Element;
}

describe("structural ownership and recovery", () => {
  test("a prop named __proto__ is an own reactive slot without changing the props prototype", () => {
    const target = container();
    let input!: State<string>;
    let bodies = 0;
    const Row = defineComponent<{ __proto__: string }>(
      (owner, props) => {
        bodies++;
        expect(Object.hasOwn(props, "__proto__")).toBe(true);
        expect(Object.getPrototypeOf(props)).toBe(Object.prototype);
        return text(owner, props.__proto__);
      },
      { props: { ["__proto__"]: { kind: "value", optional: false } } },
    );
    const App = defineComponent((owner) => {
      input = createClient(owner).state("first");
      return region(owner, "row", () => componentItem(Row, { ["__proto__"]: input() }, "row"));
    });
    const errors: unknown[] = [];
    const app = mount(target, App, {}, { onError: (error) => errors.push(error) });
    try {
      expect(errors).toStrictEqual([]);
      expect(target.textContent).toBe("first");
      input.set("second");
      expect(target.textContent).toBe("second");
      expect(bodies).toBe(1);
    } finally {
      app.dispose();
    }
  });
  test("hoisted native factories move keyed ranges and receive current captured scope", () => {
    const target = container();
    let rows!: State<{ id: number; label: string }[]>;
    const bodies: number[] = [];
    const factory: NativeFactory<{ label: string; id: number }> = (owner, scope) => {
      bodies.push(scope.id());
      return [element(owner, "input", { value: scope.label() }), text(owner, scope.label)];
    };
    const App = defineComponent((owner) => {
      rows = createClient(owner).state([
        { id: 1, label: "one" },
        { id: 2, label: "two" },
      ]);
      return region(owner, "rows", () =>
        rows().map((row) => nativeItem(factory, row, "native", row.id)),
      );
    });
    const app = mount(target, App, {});
    const original = [...target.querySelectorAll("input")];
    original[0]!.value = "local state";
    rows.set([
      { id: 2, label: "second" },
      { id: 1, label: "first" },
    ]);
    expect([...target.querySelectorAll("input")]).toStrictEqual([original[1]!, original[0]!]);
    expect(original[0]!.value).toBe("local state");
    expect(target.textContent).toBe("secondfirst");
    expect(bodies).toStrictEqual([1, 2]);
    app.dispose();
  });
  test("optional bind presence uses the approved fresh-lifetime recovery with one input snapshot", async () => {
    const target = container();
    let attach!: State<boolean>;
    let bodies = 0;
    let cleanups = 0;
    let reads = 0;
    const Child = defineComponent<{ bind?: { read(): number } }>(
      (owner, props) => {
        const generation = ++bodies;
        createClient(owner).cleanup(() => {
          cleanups++;
        });
        createClient(owner).effect(() => {
          props.bind?.set({ read: () => generation });
        });
        return text(owner, () => String(generation));
      },
      { props: { bind: { kind: "binding", optional: true } } },
    );
    const App = defineComponent((owner) => {
      attach = createClient(owner).state(false);
      const binding = createClient(owner).unsafeBind<{ read(): number }>();
      return region(owner, "child", () =>
        componentItem(
          Child,
          attach()
            ? {
                get bind() {
                  reads++;
                  return binding;
                },
              }
            : {},
          "child",
        ),
      );
    });
    const app = mount(target, App, {}, { development: false });
    await app.settled();
    attach.set(true);
    await app.settled();
    expect(reads).toBe(1);
    expect(bodies).toBe(2);
    expect(cleanups).toBe(1);
    attach.set(false);
    await app.settled();
    expect(bodies).toBe(3);
    expect(cleanups).toBe(2);
    expect(target.textContent).toBe("3");
    app.dispose();
  });
  test("a rejected later list body cleans up earlier staged children without retrying either body", () => {
    const target = container();
    let rows!: State<number[]>;
    const cleaned: number[] = [];
    const calls: number[] = [];
    const failure = new Error("body failed");
    const errors: unknown[] = [];
    const Child = defineComponent<{ id: number }>(
      (owner, props) => {
        const id = props.id();
        calls.push(id);
        createClient(owner).cleanup(() => {
          cleaned.push(id);
        });
        if (id === 2) throw failure;
        return String(id);
      },
      { props: { id: { kind: "value", optional: false } } },
    );
    const App = defineComponent((owner) => {
      rows = createClient(owner).state([0]);
      return region(owner, "rows", () =>
        rows().map((id) => componentItem(Child, { id }, "row", id)),
      );
    });
    const app = mount(target, App, {}, { onError: (error) => errors.push(error) });
    rows.set([0, 1, 2]);
    expect(errors).toStrictEqual([failure]);
    expect(calls).toStrictEqual([0, 1, 2]);
    expect(cleaned).toStrictEqual([2, 1]);
    expect(target.textContent).toBe("0");
    app.dispose();
    expect(cleaned).toStrictEqual([2, 1, 0]);
  });
  test("changing a present binding preserves the child endpoint, publication, and lifetime", async () => {
    const target = container();
    let selected!: State<boolean>;
    let first!: import("../../src/runtime/binding.ts").Binding<{ read(): string } | undefined>;
    let second!: typeof first;
    let bodies = 0;
    let cleanups = 0;
    const Child = defineComponent<{ bind: { read(): string } }>(
      (owner, props) => {
        bodies++;
        const endpoint = props.bind;
        Object.freeze(props);
        createClient(owner).cleanup(() => {
          cleanups++;
        });
        createClient(owner).effect(() => {
          endpoint.set({ read: () => "published" });
        });
        return element(owner, "span", {}, ["child"]);
      },
      { props: { bind: { kind: "binding", optional: false } } },
    );
    const App = defineComponent((owner) => {
      const client = createClient(owner);
      selected = client.state(false);
      first = client.unsafeBind();
      second = client.unsafeBind();
      return region(owner, "child", () =>
        componentItem(Child, { bind: selected() ? second : first }, "child"),
      );
    });
    const app = mount(target, App, {}, { development: false });
    await app.settled();
    const node = target.querySelector("span");
    expect(first()?.read()).toBe("published");
    expect(second()).toBeUndefined();
    selected.set(true);
    expect(first()).toBeUndefined();
    expect(second()?.read()).toBe("published");
    expect(target.querySelector("span")).toBe(node);
    expect(bodies).toBe(1);
    expect(cleanups).toBe(0);
    app.dispose();
    expect(cleanups).toBe(1);
  });
  test("optional function-valued inputs stay reactive accessors across absence and presence", async () => {
    const target = container();
    let input!: State<{ onDone?: () => string }>;
    let bodies = 0;
    const seen: (string | undefined)[] = [];
    const Row = defineComponent<{ onDone?: () => string }>(
      (owner, props) => {
        bodies++;
        const { onDone } = props;
        Object.freeze(props);
        createClient(owner).effect(() => {
          seen.push(onDone()?.());
        });
        return text(owner, () => onDone()?.() ?? "absent");
      },
      { props: { onDone: { kind: "value", optional: true } } },
    );
    const App = defineComponent((owner) => {
      input = createClient(owner).state({});
      return region(owner, "row", () => componentItem(Row, input(), "row"));
    });
    const app = mount(target, App, {});
    await app.settled();
    input.set({ onDone: () => "present" });
    expect(target.textContent).toBe("present");
    await app.settled();
    input.set({});
    expect(target.textContent).toBe("absent");
    await app.settled();
    expect(bodies).toBe(1);
    expect(seen).toStrictEqual([undefined, "present", undefined]);
    app.dispose();
  });
  test("keyed moves preserve native ranges, local state, and component lifetimes", async () => {
    const target = container();
    let rows!: State<{ id: string; label: string }[]>;
    const created: string[] = [];
    const cleaned: string[] = [];
    const Row = defineComponent<{ id: string; label: string }>(
      (owner, props) => {
        const client = createClient(owner);
        const local = client.state(0);
        created.push(props.id());
        client.cleanup(() => {
          cleaned.push(props.id());
        });
        return [
          element(owner, "button", { "on:click": () => local.update((n) => n + 1) }, [
            text(owner, () => `${props.label()}:${local()}`),
          ]),
          element(owner, "i"),
        ];
      },
      {
        props: {
          id: { kind: "value", optional: false },
          label: { kind: "value", optional: false },
        },
      },
    );
    const App = defineComponent((owner) => {
      rows = createClient(owner).state([
        { id: "a", label: "A" },
        { id: "b", label: "B" },
      ]);
      return region(owner, "rows", () =>
        rows().map((row) => componentItem(Row, row, "Row", row.id)),
      );
    });
    const app = mount(target, App, {});
    await app.settled();
    const [a, b] = Array.from(target.querySelectorAll("button"));
    a!.click();
    rows.set([
      { id: "b", label: "Bee" },
      { id: "a", label: "Aye" },
    ]);
    expect(Array.from(target.querySelectorAll("button"))).toStrictEqual([b!, a!]);
    expect(target.textContent).toBe("Bee:0Aye:1");
    expect(created).toStrictEqual(["a", "b"]);
    expect(cleaned).toStrictEqual([]);
    rows.set([{ id: "b", label: "Bee" }]);
    expect(cleaned).toStrictEqual(["a"]);
    rows.set([
      { id: "b", label: "Bee" },
      { id: "a", label: "Again" },
    ]);
    expect(created).toStrictEqual(["a", "b", "a"]);
    expect(target.textContent).toBe("Bee:0Again:0");
    await app.settled();
    app.dispose();
  });

  test("duplicate and missing keys reject the whole candidate before existing props publish", async () => {
    const target = container();
    const errors: unknown[] = [];
    let rows!: State<{ key?: string | number; value: number }[]>;
    const Row = defineComponent<{ value: number }>((owner, props) => text(owner, props.value));
    const App = defineComponent((owner) => {
      rows = createClient(owner).state([{ key: "a", value: 1 }]);
      return region(owner, "rows", () =>
        rows().map((row) => componentItem(Row, { value: row.value }, "row", row.key)),
      );
    });
    const app = mount(target, App, {}, { onError: (error) => errors.push(error) });
    await app.settled();
    rows.set([
      { key: "a", value: 2 },
      { key: "a", value: 3 },
    ]);
    expect(target.textContent).toBe("1");
    rows.set([{ value: 4 }]);
    expect(target.textContent).toBe("1");
    expect(errors).toHaveLength(2);
    rows.set([
      { key: "1", value: 5 },
      { key: 1, value: 6 },
    ]);
    expect(target.textContent).toBe("56");
    rows.set([
      { key: -0, value: 7 },
      { key: 0, value: 8 },
    ]);
    expect(target.textContent).toBe("56");
    expect(errors).toHaveLength(3);
    await app.settled();
    app.dispose();
  });

  test("conditional arms retain one owner for the same declaration and publish optional absence", async () => {
    const target = container();
    const errors: unknown[] = [];
    let incoming!: State<{ value?: number; required?: number }>;
    let bodies = 0;
    const Row = defineComponent<{ value?: number; required: number }>(
      (owner, props) => {
        bodies++;
        Object.freeze(props);
        return text(owner, () => `${props.required()}/${props.value!()}`);
      },
      {
        props: {
          value: { kind: "value", optional: true },
          required: { kind: "value", optional: false },
        },
      },
    );
    const App = defineComponent((owner) => {
      incoming = createClient(owner).state({ value: 1, required: 2 });
      return region(owner, "conditional", () => {
        const values = incoming();
        return componentItem(
          Row,
          values as { value?: number; required: number },
          values.value ? "leftArm" : "rightArm",
        );
      });
    });
    const app = mount(target, App, {}, { onError: (error) => errors.push(error) });
    await app.settled();
    incoming.set({ required: 3 });
    expect(target.textContent).toBe("3/undefined");
    expect(bodies).toBe(1);
    incoming.set({ value: 9 });
    expect(target.textContent).toBe("3/undefined");
    expect(errors).toHaveLength(1);
    app.dispose();
  });

  test("a genuinely replaced props accessor recreates once using the original incoming snapshot", async () => {
    const target = container();
    let update!: State<number>;
    let bodyProps!: ComponentProps<{ value: number }>;
    let local!: State<number>;
    let getterReads = 0;
    const bodies: number[] = [];
    const cleaned: number[] = [];
    const Row = defineComponent<{ value: number }>(
      (owner, props) => {
        const client = createClient(owner);
        bodyProps = props;
        local = client.state(10);
        bodies.push(props.value());
        const captured = props.value;
        client.cleanup(() => {
          cleaned.push(captured());
        });
        return text(owner, () => `${props.value()}/${local()}`);
      },
      { props: { value: { kind: "value", optional: false } } },
    );
    const App = defineComponent((owner) => {
      update = createClient(owner).state(1);
      return region(owner, "row", () => {
        const value = update();
        return componentItem(
          Row,
          {
            get value() {
              getterReads++;
              return value;
            },
          },
          "row",
        );
      });
    });
    const app = mount(target, App, {});
    await app.settled();
    local.set(77);
    Object.defineProperty(bodyProps, "value", { value: () => -1 });
    update.set(2);
    expect(target.textContent).toBe("2/10");
    expect(bodies).toStrictEqual([1, 2]);
    expect(cleaned).toStrictEqual([1]);
    expect(getterReads).toBe(2);
    await app.settled();
    app.dispose();
  });

  test("three-render counting survives fresh generations and microtask passes", async () => {
    const target = container();
    const errors: unknown[] = [];
    const warnings: string[] = [];
    let tick!: State<number>;
    let bodies = 0;
    const Row = defineComponent<{ value: number }>((owner, props) => {
      bodies++;
      createClient(owner).effect(() => {
        Object.defineProperty(props, "value", { value: () => -1 });
        tick.update((value) => value + 1);
      });
      return text(owner, props.value);
    });
    const App = defineComponent((owner) => {
      tick = createClient(owner).state(0);
      return region(owner, "row", () => componentItem(Row, { value: tick() }, "row"));
    });
    const app = mount(
      target,
      App,
      {},
      {
        development: true,
        warn: (warning) => warnings.push(warning),
        onError: (error) => errors.push(error),
      },
    );
    await app.settled();
    expect(bodies).toBe(3);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("Second recreation");
    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toContain("Third recreation");
    app.dispose();
  });

  test("required binding replacement publishes only live interfaces and revokes the old method", async () => {
    const target = container();
    let choose!: State<boolean>;
    const published: string[] = [];
    let saved!: () => string;
    let readBinding!: () => { name(): string };
    const First = defineComponent<{ bind: { name(): string } }>((owner, props) => {
      createClient(owner).effect(() => {
        props.bind.set({ name: () => "first" });
      });
      return element(owner, "i");
    });
    const Second = defineComponent<{ bind: { name(): string } }>((owner, props) => {
      createClient(owner).effect(() => {
        props.bind.set({ name: () => "second" });
      });
      return element(owner, "b");
    });
    const App = defineComponent((owner) => {
      const client = createClient(owner);
      choose = client.state(true);
      const bind = client.bind<{ name(): string }>();
      readBinding = bind;
      client.effect(() => {
        const value = bind();
        published.push(value.name());
        if (choose()) saved = value.name;
      });
      return region(owner, "choice", () =>
        choose() ? componentItem(First, { bind }, "a") : componentItem(Second, { bind }, "b"),
      );
    });
    const app = mount(target, App, {});
    await app.settled();
    choose.set(false);
    expect(() => saved()).toThrow("destroyed");
    expect(() => readBinding()).toThrow("no live target");
    await app.settled();
    expect(published).toStrictEqual(["first", "second"]);
    app.dispose();
  });

  test("the 64-flush limit counts a chain across distinct jobs, not independent jobs in one pass", async () => {
    const errors: unknown[] = [];
    let independent = 0;
    const App = defineComponent((owner) => {
      const client = createClient(owner);
      for (let index = 0; index < 100; index++)
        client.effect(() => {
          independent++;
        });
      const states = Array.from({ length: 65 }, (_, index) => client.state(index === 0));
      for (let index = states.length - 1; index >= 0; index--) {
        client.effect(() => {
          if (states[index]!() && index < states.length - 1) states[index + 1]!.set(true);
        });
      }
      return null;
    });
    const app = mount(container(), App, {}, { onError: (error) => errors.push(error) });
    await app.settled();
    expect(independent).toBe(100);
    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toContain("64 successive flushes");
    app.dispose();
  });
});
