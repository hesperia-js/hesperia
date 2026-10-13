import { afterEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { Signal } from "aeolia";
import { createClient, type State } from "../../packages/hesperia/src/client.ts";
import {
  child,
  component,
  defineComponent,
  dynamic,
  element,
  mount,
  text,
} from "../../packages/hesperia/src/runtime/dom.ts";
import {
  registerOwnerResourceLifecycle,
  type Owner,
} from "../../packages/hesperia/src/runtime/owner.ts";

const windows: Window[] = [];

afterEach(() => {
  for (const window of windows.splice(0)) window.close();
});

function container(): Element {
  const window = new Window();

  windows.push(window);

  return window.document.body as unknown as Element;
}

describe("browser component lifetimes", () => {
  test("removing one resource lifecycle during resume does not skip the next", () => {
    const target = container();
    const resumed: string[] = [];
    let root!: Owner;
    const App = defineComponent((owner) => {
      root = owner;
      let unregisterFirst!: () => void;
      unregisterFirst = registerOwnerResourceLifecycle(owner, {
        suspended() {},

        resumed() {
          resumed.push("first");

          unregisterFirst();
        },
      });

      registerOwnerResourceLifecycle(owner, {
        suspended() {},

        resumed() {
          resumed.push("second");
        },
      });

      return null;
    });
    const app = mount(target, App, {});

    try {
      root.suspend();

      root.resume();

      expect(resumed).toStrictEqual(["first", "second"]);

      root.suspend();

      root.resume();

      expect(resumed).toStrictEqual(["first", "second", "second"]);
    } finally {
      app.dispose();
    }
  });

  test("compiler-declared plain page parameters retain the immutable route input object", () => {
    const target = container();
    const params = Object.freeze({ id: "42" });
    let received: unknown;
    const Page = defineComponent<{ params: { readonly id: string } }>(
      (owner, props) => {
        received = props.params;
        return text(owner, () => (props.params as unknown as typeof params).id);
      },
      { props: { params: { kind: "plain", optional: false } } },
    );
    const app = mount(target, Page, { params });

    expect(received).toBe(params);

    expect(target.textContent).toBe("42");

    app.dispose();
  });

  test("native fragment child expressions retain and remove their complete inserted range", () => {
    const target = container();
    let value!: State<Node | undefined>;
    const fragment = target.ownerDocument.createDocumentFragment();
    const first = target.ownerDocument.createElement("i");
    const second = target.ownerDocument.createElement("b");

    fragment.append(first, second);

    const App = defineComponent((owner) => {
      value = createClient(owner).state<Node | undefined>(fragment);
      return child(owner, value);
    });
    const app = mount(target, App, {});

    expect([...target.children]).toStrictEqual([first, second]);

    value.set(undefined);

    expect(target.children.length).toBe(0);

    const later = target.ownerDocument.createDocumentFragment();

    later.append(first, second);

    value.set(later);

    expect([...target.children]).toStrictEqual([first, second]);

    app.dispose();

    expect(target.childNodes.length).toBe(0);
  });

  test("disposing a primitive root removes its owned text", async () => {
    const target = container();
    const App = defineComponent(() => "hello");
    const app = mount(target, App, {});

    expect(target.textContent).toBe("hello");

    await app.settled();

    app.dispose();

    expect(target.textContent).toBe("");
  });

  test("bound native movement preserves identity and continued removal faults", async () => {
    const target = container();
    const errors: unknown[] = [];
    let read!: () => HTMLInputElement;
    let input!: HTMLInputElement;
    const App = defineComponent((owner) => {
      const client = createClient(owner);
      const bind = client.bind<HTMLInputElement>();
      read = bind;
      input = element(owner, "input", { bind });
      return element(owner, "section", {}, [input, element(owner, "aside")]);
    });
    const app = mount(target, App, {}, { onError: (error) => errors.push(error) });

    await app.settled();

    target.querySelector("aside")!.appendChild(input);

    input.remove();

    target.querySelector("section")!.appendChild(input);

    await windows.at(-1)!.happyDOM.whenAsyncComplete();

    expect(read()).toBe(input);

    expect(errors).toStrictEqual([]);

    input.remove();

    await windows.at(-1)!.happyDOM.whenAsyncComplete();

    expect(errors).toHaveLength(1);

    expect((errors[0] as Error).message).toContain("removed from its rendered tree");

    expect(() => read()).toThrow("no live target");

    app.dispose();
  });

  test("a duplicate target faults before the second attachment can replace the first", () => {
    const App = defineComponent((owner) => {
      const bind = createClient(owner).bind<HTMLInputElement>();
      return [element(owner, "input", { bind }), element(owner, "input", { bind })];
    });

    expect(() => mount(container(), App, {})).toThrow("multiple live targets");
  });

  test("native child expressions preserve the original element and namespaced events update DOM", async () => {
    const target = container();
    let input!: HTMLInputElement;
    const App = defineComponent((owner) => {
      const client = createClient(owner);
      const count = client.state(0);
      input = element(owner, "input");
      return element(owner, "section", {}, [
        child(owner, () => input),
        element(owner, "button", { "on:click": () => count.update((n) => n + 1) }, [
          text(owner, count),
        ]),
      ]);
    });
    const app = mount(target, App, {});

    expect(target.querySelector("input")).toBe(input);

    target.querySelector("button")!.click();

    expect(target.querySelector("button")!.textContent).toBe("1");

    await app.settled();

    app.dispose();
  });

  test("an effect's own read-then-write survives tracking and runs at the next pass", async () => {
    const values: number[] = [];
    const App = defineComponent((owner) => {
      const client = createClient(owner);
      const count = client.state(0);

      client.effect(() => {
        const value = count();

        values.push(value);

        if (value < 2) count.set(value + 1);
      });

      return text(owner, count);
    });
    const app = mount(container(), App, {});

    await app.settled();

    expect(values).toStrictEqual([0, 1, 2]);

    app.dispose();
  });

  test("computed equality skips effects and dynamic dependencies detach abandoned branches", async () => {
    let choose!: State<boolean>;
    let left!: State<number>;
    let right!: State<number>;
    const seen: number[] = [];
    const App = defineComponent((owner) => {
      const client = createClient(owner);
      choose = client.state(true);
      left = client.state(1);
      right = client.state(10);
      const selected = client.derived(() => (choose() ? left() % 2 : right() % 2));

      client.effect(() => {
        seen.push(selected());
      });

      return text(owner, selected);
    });
    const app = mount(container(), App, {});

    await app.settled();

    left.set(3);

    await app.settled();

    expect(seen).toStrictEqual([1]);

    choose.set(false);

    await app.settled();

    expect(seen).toStrictEqual([1, 0]);

    left.set(4);

    await app.settled();

    expect(seen).toStrictEqual([1, 0]);

    right.set(11);

    await app.settled();

    expect(seen).toStrictEqual([1, 0, 1]);

    app.dispose();
  });

  test("each independent write updates the same native nodes before returning", async () => {
    const target = container();
    let count!: State<number>;
    const seen: string[] = [];
    const App = defineComponent((owner) => {
      const client = createClient(owner);
      count = client.state(0);
      const output = element(owner, "output", { title: dynamic(() => `Count ${count()}`) }, [
        text(owner, count),
      ]);

      client.effect(() => {
        count();

        seen.push(output.textContent!);
      });

      return output;
    });
    const app = mount(target, App, {});
    const output = target.firstChild;

    expect(output?.textContent).toBe("0");

    expect(seen).toStrictEqual([]);

    count.set(1);

    expect(target.firstChild).toBe(output);

    expect(output?.textContent).toBe("1");

    count.set(2);

    expect(output?.textContent).toBe("2");

    expect((output as Element).getAttribute("title")).toBe("Count 2");

    await app.settled();

    expect(seen).toStrictEqual(["2"]);

    app.dispose();

    expect(target.childNodes.length).toBe(0);

    expect(() => count.set(3)).toThrow("no longer active");
  });

  test("descendant effects finish each branch before parents and preserve own registration order", async () => {
    const events: string[] = [];
    const Leaf = defineComponent<{ name: string }>((owner, props) => {
      createClient(owner).effect(() => {
        events.push(props.name());
      });

      return element(owner, "span");
    });
    const Branch = defineComponent<{ name: string }>((owner, props) => {
      createClient(owner).effect(() => {
        events.push(props.name());
      });

      return component(owner, Leaf, { name: `${props.name()}Child` });
    });
    const App = defineComponent((owner) => {
      const client = createClient(owner);

      client.effect(() => {
        events.push("App1");
      });

      client.effect(() => {
        events.push("App2");
      });

      return [
        component(owner, Branch, { name: "Left" }),
        component(owner, Branch, { name: "Right" }),
      ];
    });
    const app = mount(container(), App, {});

    await app.settled();

    expect(events).toStrictEqual(["LeftChild", "Left", "RightChild", "Right", "App1", "App2"]);

    app.dispose();
  });

  test("a child's published interface is available to parent effects and retained methods revoke", async () => {
    const events: string[] = [];
    let saved!: () => void;
    const Child = defineComponent<{ bind: { sayHi(): void } }>((owner, props) => {
      createClient(owner).effect(() => {
        props.bind.set(
          Object.freeze({
            sayHi: () => {
              events.push("hi");
            },
          }),
        );
      });

      return element(owner, "span");
    });
    const App = defineComponent((owner) => {
      const client = createClient(owner);
      const bind = client.bind<{ sayHi(): void }>();

      client.effect(() => {
        saved = bind().sayHi;

        saved();
      });

      return component(owner, Child, { bind });
    });
    const app = mount(container(), App, {});

    await app.settled();

    expect(events).toStrictEqual(["hi"]);

    app.dispose();

    expect(() => saved()).toThrow("destroyed");
  });

  test("an unread required binding faults after first effects and body reads fault immediately", async () => {
    const errors: unknown[] = [];
    const Missing = defineComponent((owner) => {
      createClient(owner).bind<Element>();

      return element(owner, "span");
    });
    const app = mount(container(), Missing, {}, { onError: (error) => errors.push(error) });

    await app.settled();

    expect(errors).toHaveLength(1);

    expect((errors[0] as Error).message).toContain("did not publish");

    app.dispose();

    const Invalid = defineComponent((owner) => createClient(owner).bind<Element>()());

    expect(() => mount(container(), Invalid, {})).toThrow("component body");
  });

  test("cleanup runs parent first, in reverse order, and continues after failures", async () => {
    const order: string[] = [];
    const errors: unknown[] = [];
    const Child = defineComponent((owner) => {
      const client = createClient(owner);

      client.cleanup(() => {
        order.push("child");
      });

      return element(owner, "span");
    });
    const App = defineComponent((owner) => {
      const client = createClient(owner);

      client.cleanup(() => {
        order.push("parent first");
      });

      client.cleanup(() => {
        order.push("parent last");

        throw new Error("cleanup failure");
      });

      return component(owner, Child, {});
    });
    const app = mount(container(), App, {}, { onError: (error) => errors.push(error) });

    await app.settled();

    app.dispose();

    app.dispose();

    expect(order).toStrictEqual(["parent last", "parent first", "child"]);

    expect(errors).toHaveLength(1);

    expect(errors[0]).toBeInstanceOf(AggregateError);
  });

  test("cleanup cannot write raw Aeolia signals", async () => {
    const errors: unknown[] = [];
    const raw = new Signal.State(0);
    const App = defineComponent((owner) => {
      createClient(owner).cleanup(() => {
        raw.set(1);
      });

      return element(owner, "span");
    });
    const app = mount(container(), App, {}, { onError: (error) => errors.push(error) });

    await app.settled();

    app.dispose();

    expect(raw.get()).toBe(0);

    expect(errors).toHaveLength(1);
  });

  test("invalidating an effect after its turn defers its second run until the next DOM/effect pass", async () => {
    const seen: string[] = [];
    const App = defineComponent((owner) => {
      const client = createClient(owner);
      const count = client.state(0);
      const output = element(owner, "output", {}, [text(owner, count)]);

      client.effect(() => {
        seen.push(`read ${count()} DOM ${output.textContent}`);
      });

      client.effect(() => {
        seen.push("write");

        count.set(1);
      });

      return output;
    });
    const app = mount(container(), App, {});

    await app.settled();

    expect(seen).toStrictEqual(["read 0 DOM 0", "write", "read 1 DOM 1"]);

    app.dispose();
  });

  test("owner cleanup may read a child method before child destruction", async () => {
    const events: string[] = [];
    let childOwner!: Owner;
    const Child = defineComponent<{ bind: { ping(): void } }>((owner, props) => {
      childOwner = owner;

      createClient(owner).effect(() => {
        props.bind.set({
          ping: () => {
            events.push(owner.state);
          },
        });
      });

      return element(owner, "span");
    });
    const App = defineComponent((owner) => {
      const client = createClient(owner);
      const bind = client.bind<{ ping(): void }>();

      client.cleanup(() => {
        bind().ping();
      });

      return component(owner, Child, { bind });
    });
    const app = mount(container(), App, {});

    await app.settled();

    app.dispose();

    expect(events).toStrictEqual(["mounted"]);

    expect(childOwner.state).toBe("destroyed");
  });
});
