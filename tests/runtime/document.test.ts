import { expect, test } from "bun:test";
import { Window } from "happy-dom";
import { createClient } from "../../packages/hesperia/src/client.ts";
import {
  createRuntimeRoot,
  defineComponent,
  element,
  mount,
  prepareTree,
} from "../../packages/hesperia/src/runtime/dom.ts";

test("public mount installs a complete shell into a Document and disposes it", async () => {
  const window = new Window();
  const document = window.document as unknown as Document;

  document.documentElement.remove();

  const faults: unknown[] = [];
  const App = defineComponent((owner) => {
    const client = createClient(owner);

    client.effect(() => {
      document.documentElement.dataset.effect = "active";
    });

    return element(owner, "html", {}, [
      element(owner, "head", {}, [element(owner, "title", {}, ["Public mount"])]),
      element(owner, "body", {}, [element(owner, "main", {}, ["ready"])]),
    ]);
  });

  try {
    const application = mount(document, App, {}, { onError: (error) => faults.push(error) });

    await application.settled();

    expect(document.title).toBe("Public mount");

    expect(document.body.textContent).toBe("ready");

    expect(document.documentElement.dataset.effect).toBe("active");

    expect(faults).toStrictEqual([]);

    application.dispose();

    expect(document.documentElement).toBeNull();
  } finally {
    await window.happyDOM.close();
  }
});

test("document installation activates effects only after the shell and keeps binding containment valid", async () => {
  const window = new Window();
  const document = window.document as unknown as Document;

  document.documentElement.remove();

  const faults: unknown[] = [];
  const { owner, context } = createRuntimeRoot(document, {
    onError: (error) => faults.push(error),
  });
  let input!: HTMLInputElement;
  let seenBody: HTMLElement | undefined;
  const prepared = prepareTree(owner, () => {
    const client = createClient(owner);
    const binding = client.bind<HTMLInputElement>();
    input = element(owner, "input", { bind: binding });

    client.effect(() => {
      seenBody = document.body;

      binding().focus();
    });

    return element(owner, "html", { lang: "en" }, [
      element(owner, "head", {}, [element(owner, "title", {}, ["Hesperia shell"])]),
      element(owner, "body", {}, [input]),
    ]);
  });

  try {
    expect(document.documentElement).toBeNull();

    expect(seenBody).toBeUndefined();

    prepared.install(document);

    await context.scheduler.settled();

    expect(document.querySelectorAll("html")).toHaveLength(1);

    expect(document.title).toBe("Hesperia shell");

    expect(seenBody).toBe(document.body);

    expect(document.activeElement).toBe(input);

    expect(context.container).toBe(document);

    await window.happyDOM.whenAsyncComplete();

    expect(faults).toStrictEqual([]);
  } finally {
    prepared.dispose();

    await window.happyDOM.close();
  }
});

test("invalid document output leaves the previous shell intact and releases prepared work", async () => {
  const window = new Window();
  const document = window.document as unknown as Document;
  const previous = document.documentElement;
  const faults: unknown[] = [];
  let cleaned = false;
  const App = defineComponent((owner) => {
    createClient(owner).cleanup(() => {
      cleaned = true;
    });

    return element(owner, "div", {}, ["not a document shell"]);
  });
  const application = mount(document, App, {}, { onError: (error) => faults.push(error) });

  try {
    await application.settled();

    expect(faults).toHaveLength(1);

    expect((faults[0] as Error).message).toContain("exactly one native HTML root");

    expect(document.documentElement).toBe(previous);

    expect(cleaned).toBe(true);
  } finally {
    application.dispose();

    await window.happyDOM.close();
  }
});
