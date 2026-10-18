import { afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { createClient } from "../../packages/hesperia/src/client.ts";
import {
  createRuntimeRoot,
  defineComponent,
  element,
  prepareTree,
  type RuntimeRoot,
} from "../../packages/hesperia/src/runtime/dom.ts";
import { Owner } from "../../packages/hesperia/src/runtime/owner.ts";
import {
  instantiateComponent,
  prepareComponent,
} from "../../packages/hesperia/src/runtime/components.ts";

const windows: Window[] = [];

afterEach(() => {
  for (const window of windows.splice(0)) window.close();
});

function root(): { target: Element; runtime: RuntimeRoot } {
  const window = new Window();

  windows.push(window);

  const target = window.document.body as unknown as Element;
  return { target, runtime: createRuntimeRoot(target, { development: false }) };
}

test("preparation keeps the committed DOM untouched until installation", async () => {
  const { target, runtime } = root();
  const existing = target.ownerDocument.createElement("p");
  existing.textContent = "committed";

  target.append(existing);

  const seen: number[] = [];
  const prepared = prepareTree(runtime.owner, () => {
    const client = createClient(runtime.owner);

    client.effect(() => {
      seen.push(target.childNodes.length);
    });

    return element(runtime.owner, "section", {}, ["candidate"]);
  });

  expect(target.textContent).toBe("committed");

  expect(target.childNodes).toHaveLength(1);

  expect(seen).toStrictEqual([]);

  prepared.install(target);

  expect(target.textContent).toBe("committedcandidate");

  expect(seen).toStrictEqual([]);

  await runtime.context.scheduler.settled();

  expect(seen).toStrictEqual([2]);

  prepared.dispose();

  expect(target.textContent).toBe("committed");
});

test("disposing a detached candidate removes its owned nodes without touching committed DOM", () => {
  const { target, runtime } = root();
  const existing = target.ownerDocument.createElement("p");
  existing.textContent = "committed";

  target.append(existing);

  runtime.owner.commit();

  const candidate = new Owner(runtime.context, runtime.owner, "candidate");
  const prepared = prepareTree(candidate, () => element(candidate, "section", {}, ["candidate"]));

  expect(target.textContent).toBe("committed");

  expect(prepared.fragment.childNodes).toHaveLength(1);

  prepared.dispose(new Error("route superseded"));

  expect(target.textContent).toBe("committed");

  expect(prepared.fragment.childNodes).toHaveLength(0);

  expect(candidate.state).toBe("destroyed");

  expect(runtime.owner.state).toBe("mounted");

  runtime.owner.dispose();
});

test("render failures dispose the candidate and leave existing DOM in place", () => {
  const { target, runtime } = root();
  const existing = target.ownerDocument.createElement("p");
  existing.textContent = "committed";

  target.append(existing);

  const failure = new Error("candidate failed");

  expect(() =>
    prepareTree(runtime.owner, () => {
      element(runtime.owner, "section", {}, ["candidate"]);

      throw failure;
    }),
  ).toThrow(failure);

  expect(target.textContent).toBe("committed");

  expect(runtime.owner.state).toBe("destroyed");
});

test("required publication checks wait until the prepared owner is installed", async () => {
  const errors: unknown[] = [];
  const window = new Window();

  windows.push(window);

  const target = window.document.body as unknown as Element;
  const runtime = createRuntimeRoot(target, {
    development: false,
    onError: (error) => errors.push(error),
  });
  const binding = createClient(runtime.owner).bind<{ value: string }>();
  const Child = defineComponent((owner) => element(owner, "div", {}, ["child"]), {
    props: { bind: { kind: "binding", optional: false } },
  });

  const prepared = prepareTree(runtime.owner, () => {
    const child = new Owner(runtime.context, runtime.owner, "child");
    const output = instantiateComponent(child, prepareComponent(Child, { bind: binding })).output;

    if (output instanceof Promise) throw new Error("unexpected async child");

    return output;
  });

  expect(errors).toStrictEqual([]);

  expect(target.childNodes).toHaveLength(0);

  prepared.install(target);

  expect(errors).toStrictEqual([]);

  await runtime.context.scheduler.settled();

  expect(errors).toHaveLength(1);

  expect((errors[0] as { kind: string }).kind).toBe("binding-missing");
});
