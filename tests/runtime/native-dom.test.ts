import { afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { createClient, type State } from "../../src/client.ts";
import { component, defineComponent, dynamic, element, mount } from "../../src/runtime/index.ts";
import type { WritableBinding } from "../../src/runtime/binding.ts";

const windows: Window[] = [];

afterEach(() => {
  for (const window of windows.splice(0)) window.close();
});

function container(): Element {
  const window = new Window();
  windows.push(window);
  return window.document.body as unknown as Element;
}

test("native event callbacks receive the element and are released with its owner", () => {
  const target = container();
  const errors: unknown[] = [];
  const failure = new Error("event failed");
  let button!: HTMLButtonElement;
  let receiverWasButton = false;
  let calls = 0;
  const App = defineComponent((owner) => {
    button = element(owner, "button", {
      "on:click": function (this: HTMLButtonElement) {
        receiverWasButton = this === button;
        calls++;
        throw failure;
      },
    });
    return button;
  });

  const app = mount(target, App, {}, { onError: (error) => errors.push(error) });
  button.click();
  expect(receiverWasButton).toBe(true);
  expect(calls).toBe(1);
  expect(errors).toStrictEqual([failure]);

  app.dispose();
  button.textContent = "still native";
  button.click();
  expect(button.textContent).toBe("still native");
  expect(calls).toBe(1);
  expect(errors).toStrictEqual([failure]);
});

test("dynamic native properties reset and ordinary attributes are removed", () => {
  const target = container();
  let value!: State<string | undefined>;
  let checked!: State<boolean | undefined>;
  let title!: State<string | undefined>;
  let input!: HTMLInputElement;
  const App = defineComponent((owner) => {
    const client = createClient(owner);
    value = client.state<string | undefined>("initial");
    checked = client.state<boolean | undefined>(true);
    title = client.state<string | undefined>("label");
    input = element(owner, "input", {
      value: dynamic(value),
      checked: dynamic(checked),
      title: dynamic(title),
    });
    return input;
  });

  const app = mount(target, App, {});
  expect(input.value).toBe("initial");
  expect(input.checked).toBe(true);
  expect(input.getAttribute("title")).toBe("label");

  value.set(undefined);
  checked.set(undefined);
  title.set(undefined);
  expect(input.value).toBe("");
  expect(input.checked).toBe(false);
  expect(input.hasAttribute("title")).toBe(false);
  app.dispose();
});

test("unsafe bindings publish absence after external removal", async () => {
  const target = container();
  const errors: unknown[] = [];
  let read!: () => HTMLDivElement | undefined;
  const seen: (HTMLDivElement | undefined)[] = [];
  let runs = 0;
  let node!: HTMLDivElement;
  const App = defineComponent((owner) => {
    const client = createClient(owner);
    const binding = client.unsafeBind<HTMLDivElement>();
    read = binding;
    client.effect(() => {
      runs++;
      seen.push(binding());
    });
    node = element(owner, "div", { bind: binding });
    return node;
  });

  const app = mount(target, App, {}, { onError: (error) => errors.push(error) });
  await app.settled();
  expect(runs).toBe(1);
  expect(seen).toStrictEqual([node]);

  node.remove();
  await windows.at(-1)!.happyDOM.whenAsyncComplete();
  await app.settled();

  expect(runs).toBe(2);
  expect(seen).toStrictEqual([node, undefined]);
  expect(read()).toBeUndefined();
  expect(errors).toHaveLength(1);
  expect((errors[0] as Error).message).toContain("removed from its rendered tree");
  app.dispose();
});

test("component bindings reject a duplicate live attachment", () => {
  const Child = defineComponent<{ bind: { read(): string } }>(
    (owner, props) => {
      createClient(owner).effect(() => props.bind.set({ read: () => "published" }));
      return element(owner, "span");
    },
    { props: { bind: { kind: "binding", optional: false } } },
  );
  const App = defineComponent((owner) => {
    const binding = createClient(owner).bind<{ read(): string }>();
    return [
      component(owner, Child, { bind: binding }, "first"),
      component(owner, Child, { bind: binding }, "second"),
    ];
  });

  expect(() => mount(container(), App, {})).toThrow("multiple live targets");
});

test("a component publication endpoint rejects writes after its owner is destroyed", async () => {
  const target = container();
  let endpoint!: WritableBinding<{ read(): string }>;
  const Child = defineComponent<{ bind: { read(): string } }>(
    (owner, props) => {
      endpoint = props.bind;
      createClient(owner).effect(() => props.bind.set({ read: () => "published" }));
      return element(owner, "span");
    },
    { props: { bind: { kind: "binding", optional: false } } },
  );
  const App = defineComponent((owner) => {
    const binding = createClient(owner).bind<{ read(): string }>();
    return component(owner, Child, { bind: binding }, "child");
  });

  const app = mount(target, App, {});
  await app.settled();
  app.dispose();

  expect(() => endpoint.set({ read: () => "late" })).toThrow("no longer active");
});
