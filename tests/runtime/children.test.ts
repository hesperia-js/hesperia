import { expect, test } from "bun:test";
import { Window } from "happy-dom";
import { createClient, type State } from "../../packages/hesperia/src/client.ts";
import {
  child,
  defineComponent,
  element,
  mount,
  type Rendered,
} from "../../packages/hesperia/src/runtime/dom.ts";

test("reactive children preserve native siblings and scalar text across nested array updates", async () => {
  const window = new Window();
  const document = window.document as unknown as Document;
  let content!: State<Rendered>;
  let input!: HTMLInputElement;
  const faults: unknown[] = [];
  const App = defineComponent((owner) => {
    input = element(owner, "input", { value: "local" });
    content = createClient(owner).state<Rendered>([input, ["first", null, false]]);
    return element(owner, "section", {}, [child(owner, content)]);
  });
  const application = mount(document.body, App, {}, { onError: (error) => faults.push(error) });

  try {
    expect(faults).toStrictEqual([]);

    const section = document.querySelector("section")!;
    const scalar = [...section.childNodes].find((node) => node.nodeType === 3)!;

    input.focus();

    content.set([input, ["second", undefined]]);

    expect(section.textContent).toBe("second");

    expect(document.querySelector("input")).toBe(input);

    expect(document.activeElement).toBe(input);

    expect([...section.childNodes].find((node) => node.nodeType === 3)).toBe(scalar);

    content.set(["third", input]);

    expect(section.textContent).toBe("third");

    expect(document.querySelector("input")).toBe(input);

    content.set([]);

    expect(section.textContent).toBe("");

    expect(document.querySelector("input")).toBeNull();
  } finally {
    application.dispose();

    await window.happyDOM.close();
  }
});

test("replacing a rendered fragment removes descendants added after its initial installation", async () => {
  const window = new Window();
  const document = window.document as unknown as Document;
  let content!: State<Rendered>;
  let nested!: State<Rendered>;
  const App = defineComponent((owner) => {
    nested = createClient(owner).state<Rendered>("first");
    const fragment = child(owner, nested);
    content = createClient(owner).state<Rendered>([fragment]);
    return child(owner, content);
  });
  const faults: unknown[] = [];
  const application = mount(document.body, App, {}, { onError: (error) => faults.push(error) });

  try {
    expect(faults).toStrictEqual([]);

    nested.set(["later", "nodes"]);

    expect(document.body.textContent).toBe("laternodes");

    content.set("replacement");

    expect(document.body.textContent).toBe("replacement");
  } finally {
    application.dispose();

    await window.happyDOM.close();
  }
});
