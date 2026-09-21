import { afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { createClient, type State } from "../../src/client.ts";
import type { Task } from "../../src/data/types.ts";
import { defineComponent, element, mount, text } from "../../src/runtime/dom.ts";
import type { Owner } from "../../src/runtime/owner.ts";

const windows: Window[] = [];

afterEach(() => {
  for (const window of windows.splice(0)) window.close();
});

function container(): Element {
  const window = new Window();
  windows.push(window);
  return window.document.body as unknown as Element;
}

test("suspending a page retains its body state, pauses DOM work, and reruns effects on resume", async () => {
  const target = container();
  const events: string[] = [];
  let bodies = 0;
  let owner!: Owner;
  let count!: State<number>;
  const App = defineComponent((current: Owner) => {
    bodies++;
    owner = current;
    const client = createClient(current);
    count = client.state(0);
    client.effect(() => {
      const value = count();
      events.push(`effect:${value}`);
      return () => events.push(`cleanup:${value}`);
    });
    return text(current, count);
  });

  const app = mount(target, App, {});
  await app.settled();
  expect(bodies).toBe(1);
  expect(target.textContent).toBe("0");
  expect(events).toStrictEqual(["effect:0"]);

  owner.suspend();
  expect(owner.state).toBe("suspended");
  expect(events).toStrictEqual(["effect:0", "cleanup:0"]);
  count.set(1);
  expect(target.textContent).toBe("0");

  owner.resume();
  expect(owner.state).toBe("mounted");
  expect(target.textContent).toBe("1");
  expect(bodies).toBe(1);
  await app.settled();
  expect(events).toStrictEqual(["effect:0", "cleanup:0", "effect:1"]);

  app.dispose();
  expect(events).toStrictEqual(["effect:0", "cleanup:0", "effect:1", "cleanup:1"]);
});

test("a parked binding does not fault while suspended but still faults after resume when removed", async () => {
  const target = container();
  const errors: unknown[] = [];
  let owner!: Owner;
  let input!: HTMLInputElement;
  const App = defineComponent((current: Owner) => {
    owner = current;
    const bind = createClient(current).bind<HTMLInputElement>();
    input = element(current, "input", { bind });
    return input;
  });

  const app = mount(target, App, {}, { onError: (error) => errors.push(error) });
  await app.settled();
  owner.suspend();
  input.remove();
  expect(errors).toStrictEqual([]);

  owner.resume();
  expect(errors).toHaveLength(1);
  expect((errors[0] as Error).message).toContain("removed from its rendered tree");
  app.dispose();
});

test("an in-flight owner task settles while its page is suspended", async () => {
  const target = container();
  let owner!: Owner;
  let finish!: (value: string) => void;
  let task!: Task<void, string>;
  const App = defineComponent((current: Owner) => {
    owner = current;
    const client = createClient(current);
    task = client.task<void, string>(() => () => new Promise((resolve) => (finish = resolve)));
    return element(current, "button", { "on:click": () => task.run(undefined) });
  });

  const app = mount(target, App, {});
  await app.settled();
  const run = task.run(undefined);
  owner.suspend();
  finish("done");
  await expect(run).resolves.toBe("done");
  expect(task.status()).toBe("success");
  expect(task.value()).toBe("done");
  owner.resume();
  app.dispose();
});
