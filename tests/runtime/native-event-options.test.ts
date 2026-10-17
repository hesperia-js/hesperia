import { afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import * as eventHelpers from "../../packages/hesperia/src/events.ts";
import * as clientModule from "../../packages/hesperia/src/client.ts";
import { createClient, events as exportedEvents } from "../../packages/hesperia/src/client.ts";
import { defineComponent, element, mount } from "../../packages/hesperia/src/runtime/dom.ts";
import type { Owner } from "../../packages/hesperia/src/runtime/owner.ts";

const windows: Window[] = [];

afterEach(() => {
  for (const window of windows.splice(0)) window.close();
});

function createTarget(): { readonly target: Element; readonly window: Window } {
  const window = new Window();

  windows.push(window);

  return { target: window.document.body as unknown as Element, window };
}

test("client namespace, client.events, and hesperia/events share the helper object", () => {
  const { target } = createTarget();
  let ownerEvents: unknown;
  const App = defineComponent((owner) => {
    ownerEvents = createClient(owner).events;
    return element(owner, "main");
  });

  const app = mount(target, App, {});

  expect(clientModule.events).toBe(eventHelpers);

  expect(exportedEvents).toBe(eventHelpers);

  expect(ownerEvents).toBe(exportedEvents);

  app.dispose();
});

test("native pairs keep per-element once, capture order, and passive cancellation", () => {
  const { target, window } = createTarget();
  const calls: string[] = [];
  const order: string[] = [];
  let passiveDefaultPrevented: boolean | undefined;
  let ordinaryDefaultPrevented: boolean | undefined;
  let onceA!: HTMLButtonElement;
  let onceB!: HTMLButtonElement;
  let capturedChild!: HTMLButtonElement;
  let passiveButton!: HTMLButtonElement;
  let ordinaryButton!: HTMLButtonElement;

  const App = defineComponent((owner) => {
    const events = createClient(owner).events;
    const sharedOnce = events.once(function (this: Element, event: Event) {
      calls.push(`${this.id}:${event.currentTarget === this}`);
    });
    onceA = element(owner, "button", { id: "once-a", "on:click": sharedOnce });
    onceB = element(owner, "button", { id: "once-b", "on:click": sharedOnce });

    capturedChild = element(owner, "button", {
      id: "captured-child",
      "on:click": () => order.push("target"),
    });
    const captureParent = element(
      owner,
      "div",
      {
        id: "capture-parent",
        "on:click": events.capture(() => order.push("capture")),
      },
      [capturedChild],
    );
    passiveButton = element(owner, "button", {
      id: "passive",
      "on:click": events.passive((event) => {
        event.preventDefault();

        passiveDefaultPrevented = event.defaultPrevented;
      }),
    });
    ordinaryButton = element(owner, "button", {
      id: "ordinary",
      "on:click": (event: Event) => {
        event.preventDefault();

        ordinaryDefaultPrevented = event.defaultPrevented;
      },
    });
    return [onceA, onceB, captureParent, passiveButton, ordinaryButton];
  });

  const app = mount(target, App, {});

  onceA.click();

  onceA.click();

  onceB.click();

  onceB.click();

  expect(calls).toStrictEqual(["once-a:true", "once-b:true"]);

  const EventConstructor = window.document.defaultView!.Event;

  capturedChild.dispatchEvent(new EventConstructor("click", { bubbles: true }) as unknown as Event);

  expect(order).toStrictEqual(["capture", "target"]);

  const passiveResult = passiveButton.dispatchEvent(
    new EventConstructor("click", { cancelable: true }) as unknown as Event,
  );

  expect(passiveResult).toBe(true);

  expect(passiveDefaultPrevented).toBe(false);

  const ordinaryResult = ordinaryButton.dispatchEvent(
    new EventConstructor("click", { cancelable: true }) as unknown as Event,
  );

  expect(ordinaryResult).toBe(false);

  expect(ordinaryDefaultPrevented).toBe(true);

  app.dispose();
});

test("suspension suppresses dispatch and preserves native once consumption on resume", () => {
  const { target } = createTarget();
  const calls: string[] = [];
  let owner!: Owner;
  let onceA!: HTMLButtonElement;
  let onceB!: HTMLButtonElement;
  let regular!: HTMLButtonElement;
  let cleanupButton!: HTMLButtonElement;
  const removalCapture: boolean[] = [];

  const App = defineComponent((current) => {
    owner = current;
    const events = createClient(current).events;
    const sharedOnce = events.once(function (this: Element) {
      calls.push(`once:${this.id}`);
    });
    onceA = element(current, "button", { id: "once-a", "on:click": sharedOnce });
    onceB = element(current, "button", { id: "once-b", "on:click": sharedOnce });
    regular = element(current, "button", {
      id: "regular",
      "on:click": () => calls.push("regular"),
    });

    const authoredOptions = { capture: true };
    const authoredPair = [() => calls.push("released"), authoredOptions] as const;
    cleanupButton = element(current, "button", {
      id: "cleanup",
      "on:click": authoredPair,
    });
    const remove = cleanupButton.removeEventListener.bind(cleanupButton);
    cleanupButton.removeEventListener = ((
      type: string,
      listener: EventListener | null,
      options?: boolean | EventListenerOptions,
    ) => {
      removalCapture.push(typeof options === "boolean" ? options : (options?.capture ?? false));

      Reflect.apply(remove, cleanupButton, [type, listener, options]);
    }) as typeof cleanupButton.removeEventListener;
    authoredOptions.capture = false;

    return [onceA, onceB, regular, cleanupButton];
  });

  const app = mount(target, App, {});

  onceA.click();

  owner.suspend();

  regular.click();

  expect(calls).toStrictEqual(["once:once-a"]);

  owner.resume();

  regular.click();

  onceA.click();

  onceB.click();

  expect(calls).toStrictEqual(["once:once-a", "regular", "once:once-b"]);

  app.dispose();

  expect(removalCapture).toContain(true);

  cleanupButton.click();

  expect(calls).not.toContain("released");
});

test("pair callback failures report once and malformed pairs fault before attribute fallback", () => {
  const first = createTarget();
  const failure = new Error("pair callback failed");
  const callbackErrors: unknown[] = [];
  let button!: HTMLButtonElement;
  const CallbackFailure = defineComponent((owner) => {
    button = element(owner, "button", {
      "on:click": [
        () => {
          throw failure;
        },
        { once: true },
      ],
    });
    return button;
  });

  const callbackApp = mount(
    first.target,
    CallbackFailure,
    {},
    {
      onError: (error) => callbackErrors.push(error),
    },
  );

  button.click();

  expect(callbackErrors).toStrictEqual([failure]);

  callbackApp.dispose();

  const second = createTarget();
  const renderErrors: unknown[] = [];
  const MalformedPair = defineComponent((owner) =>
    element(owner, "button", {
      "on:click": [() => undefined, { once: "true" }],
    }),
  );
  const malformedApp = mount(
    second.target,
    MalformedPair,
    {},
    {
      onError: (error) => renderErrors.push(error),
    },
  );

  expect(renderErrors).toHaveLength(1);

  expect(renderErrors[0]).toMatchObject({ name: "RenderFault", kind: "event-options" });

  expect(second.target.querySelector("button")).toBeNull();

  malformedApp.dispose();
});
