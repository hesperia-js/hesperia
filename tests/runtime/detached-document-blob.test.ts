import { expect, test } from "bun:test";
import { Window } from "happy-dom";
import { defineComponent, element, mount } from "../../packages/hesperia/src/runtime/index.ts";

test("a real Blob faults instead of stringifying for a detached Document", () => {
  const sourceWindow = new Window();
  const document = sourceWindow.document.implementation.createHTMLDocument();

  expect(document.defaultView).toBeNull();

  const imageBlob = new Blob(["image"]);
  const errors: unknown[] = [];
  const App = defineComponent((owner) => element(owner, "img", { src: imageBlob }));

  mount(document.body as unknown as Element, App, {}, { onError: (error) => errors.push(error) });

  expect(errors).toHaveLength(1);

  expect(errors[0]).toMatchObject({ kind: "blob-url", name: "RenderFault" });

  expect(document.querySelector("img")).toBeNull();

  sourceWindow.close();
});

test("the detached-Document Blob fallback does not accept plain size-shaped objects", () => {
  const sourceWindow = new Window();
  const document = sourceWindow.document.implementation.createHTMLDocument();
  const sizeShaped = { size: 5, [Symbol.toStringTag]: "Blob" };
  const errors: unknown[] = [];
  const App = defineComponent((owner) => element(owner, "div", { src: sizeShaped }));

  mount(document.body as unknown as Element, App, {}, { onError: (error) => errors.push(error) });

  expect(errors).toStrictEqual([]);

  expect(document.querySelector("div")?.getAttribute("src")).toBe("[object Blob]");

  sourceWindow.close();
});

test("the detached-Document Blob fallback does not confuse Map or Set size accessors", () => {
  const sourceWindow = new Window();
  const document = sourceWindow.document.implementation.createHTMLDocument();
  const map = new Map([["key", "value"]]);
  const set = new Set(["value"]);
  const errors: unknown[] = [];
  const App = defineComponent((owner) => [
    element(owner, "div", { id: "map", src: map }),
    element(owner, "div", { id: "set", src: set }),
  ]);

  mount(document.body as unknown as Element, App, {}, { onError: (error) => errors.push(error) });

  expect(errors).toStrictEqual([]);

  expect(document.querySelector("#map")?.getAttribute("src")).toBe("[object Map]");

  expect(document.querySelector("#set")?.getAttribute("src")).toBe("[object Set]");

  sourceWindow.close();
});

test("a class named Blob with a size getter is not accepted as a native Blob", () => {
  const sourceWindow = new Window();
  const document = sourceWindow.document.implementation.createHTMLDocument();

  class Blob {
    get size() {
      return 5;
    }
  }

  const errors: unknown[] = [];
  const App = defineComponent((owner) => element(owner, "div", { src: new Blob() }));

  mount(document.body as unknown as Element, App, {}, { onError: (error) => errors.push(error) });

  expect(errors).toStrictEqual([]);

  expect(document.querySelector("div")?.getAttribute("src")).toBe("[object Object]");

  sourceWindow.close();
});
