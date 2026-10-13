import { mount } from "hesperia";
import NativeEvents, { captureOrder, deliveries, expectPlainEvent } from "./NativeEvents.tsx";

interface NativeEventsHarness {
  readonly deliveries: typeof deliveries;
  readonly captureOrder: typeof captureOrder;

  plainClick(): boolean;

  dispatchCancellation(id: "passive-probe" | "active-probe"): {
    readonly dispatchResult: boolean;
    readonly defaultPrevented: boolean;
  };

  recreate(): Promise<void>;

  dispose(): void;
}

declare global {
  interface Window {
    hesperiaNativeEvents: NativeEventsHarness;
  }
}

const host = document.getElementById("app");

if (!(host instanceof HTMLElement)) throw new Error("Golden application host is missing");

let application = mount(host, NativeEvents, {});

await application.settled();

window.hesperiaNativeEvents = {
  deliveries,
  captureOrder,

  plainClick() {
    const button = host.querySelector<HTMLButtonElement>("#plain-handler");

    if (!button) throw new Error("Plain event button is missing");

    const event = new MouseEvent("click", { bubbles: true });

    expectPlainEvent(event);

    return button.dispatchEvent(event);
  },

  dispatchCancellation(id) {
    const button = host.querySelector<HTMLButtonElement>(`#${id}`);

    if (!button) throw new Error(`Cancellation probe is missing: ${id}`);

    const event = new Event("hesperia-golden-probe", { bubbles: true, cancelable: true });
    return {
      dispatchResult: button.dispatchEvent(event),
      defaultPrevented: event.defaultPrevented,
    };
  },

  async recreate() {
    application.dispose();

    await application.settled();

    application = mount(host, NativeEvents, {});

    await application.settled();
  },

  dispose() {
    application.dispose();
  },
};

document.documentElement.dataset.ready = "true";
