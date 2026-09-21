import { afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { createClient, type State } from "../../src/client.ts";
import { defineComponent, element, mount, rawHTML } from "../../src/runtime/index.ts";

const windows: Window[] = [];
afterEach(() => {
  for (const window of windows.splice(0)) window.close();
});
function container(): Element {
  const window = new Window();
  windows.push(window);
  return window.document.body as unknown as Element;
}

test("raw replacement destroys its whole authored host and owns fresh host effects and listeners", async () => {
  const target = container();
  let html!: State<string>;
  const cleanups: number[] = [];
  const clicks: number[] = [];
  let generations = 0;
  const App = defineComponent((owner) => {
    html = createClient(owner).state("<b>first</b>");
    return rawHTML(owner, "raw", html, (hostOwner) => {
      const generation = ++generations;
      createClient(hostOwner).cleanup(() => {
        cleanups.push(generation);
      });
      return element(hostOwner, "article", { "on:click": () => clicks.push(generation) });
    });
  });
  const app = mount(target, App, {}, { development: false });
  const first = target.querySelector("article") as HTMLElement;
  const content = first.firstChild!;
  first.click();
  html.set("<i>second</i>");
  const second = target.querySelector("article") as HTMLElement;
  expect(second).not.toBe(first);
  expect(first.isConnected).toBe(false);
  expect(content.isConnected).toBe(false);
  expect(second.innerHTML).toBe("<i>second</i>");
  first.click();
  second.click();
  expect(clicks).toStrictEqual([1, 2]);
  expect(cleanups).toStrictEqual([1]);
  await app.settled();
  app.dispose();
  expect(cleanups).toStrictEqual([1, 2]);
  expect(target.childNodes.length).toBe(0);
});

test("fragment raw HTML uses no wrapper and removes the entire native range", () => {
  const target = container();
  let html!: State<string>;
  const App = defineComponent((owner) => {
    html = createClient(owner).state("<span>one</span><span>two</span>");
    return element(owner, "section", {}, [rawHTML(owner, "rows", html, null, "section")]);
  });
  const app = mount(target, App, {}, { development: false });
  const body = target.querySelector("section")!;
  expect([...body.children].map((node) => node.tagName)).toStrictEqual(["SPAN", "SPAN"]);
  const old = [...body.children];
  html.set("<span>three</span>");
  expect(body.children.length).toBe(1);
  expect(body.firstElementChild?.textContent).toBe("three");
  expect(old.every((node) => !node.isConnected)).toBe(true);
  app.dispose();
  expect(target.childNodes.length).toBe(0);
});

test("raw replacements warn on the second replacement per connected frame without faulting", async () => {
  const target = container();
  const warnings: string[] = [];
  const errors: unknown[] = [];
  let html!: State<string>;
  const App = defineComponent((owner) => {
    const client = createClient(owner);
    html = client.state("zero");
    client.effect(() => {
      const value = html();
      if (value === "zero") html.set("one");
      if (value === "one") html.set("two");
      if (value === "two") html.set("three");
    });
    return rawHTML(owner, "html", html, null);
  });
  const app = mount(
    target,
    App,
    {},
    {
      development: true,
      warn: (message) => warnings.push(message),
      onError: (error) => errors.push(error),
    },
  );
  await app.settled();
  expect(target.textContent).toBe("three");
  expect(warnings.filter((message) => message.startsWith("Second raw"))).toHaveLength(1);
  expect(errors).toStrictEqual([]);
  html.set("four");
  await app.settled();
  expect(warnings.filter((message) => message.startsWith("Second raw"))).toHaveLength(1);
  app.dispose();
});

test("a failed replacement cleans up the old raw region and a later value can recover", () => {
  const target = container();
  const errors: unknown[] = [];
  let html!: State<string>;
  let failHost = false;
  const failure = new Error("host creation failed");
  const App = defineComponent((owner) => {
    html = createClient(owner).state("first");
    return rawHTML(owner, "recoverable", html, (hostOwner) => {
      if (failHost) throw failure;
      return element(hostOwner, "article");
    });
  });

  const app = mount(
    target,
    App,
    {},
    { development: false, onError: (error) => errors.push(error) },
  );
  expect(target.querySelector("article")?.textContent).toBe("first");

  failHost = true;
  html.set("failed");
  expect(target.querySelector("article")).toBeNull();
  expect(errors).toStrictEqual([failure]);

  failHost = false;
  html.set("recovered");
  expect(target.querySelector("article")?.textContent).toBe("recovered");
  expect(errors).toStrictEqual([failure]);
  app.dispose();
});
