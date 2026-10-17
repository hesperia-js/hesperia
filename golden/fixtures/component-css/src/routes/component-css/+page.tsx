import { mount, type MountedApplication } from "hesperia";
import * as client from "hesperia/client";
import UnwaitedControl from "../../UnwaitedControl.tsx";

interface PanelProps {
  readonly name: string;
  readonly effects: string[];
}

type HarnessState =
  | "not-started"
  | "mounting-control"
  | "preloading"
  | "pending"
  | "ready"
  | "failed";

interface ComponentCssHarness {
  start(options?: {
    readonly panelCount?: 1 | 2;
    readonly includeControl?: boolean;
  }): Promise<void>;

  whenSettled(): Promise<void>;

  dispose(name: "first" | "second" | "control"): void;

  snapshot(): {
    readonly effects: readonly string[];
    readonly state: HarnessState;
  };
}

declare global {
  interface Window {
    hesperiaComponentCss?: ComponentCssHarness;
  }
}

const effects: string[] = [];
const applications = new Map<string, MountedApplication>();
let startPromise: Promise<void> | undefined;
let readiness: Promise<void> = Promise.resolve();
let state: HarnessState = "not-started";

function frameDocument(): Document {
  const frame = document.querySelector<HTMLIFrameElement>("#mount-frame");
  const targetDocument = frame?.contentDocument;

  if (!frame || !targetDocument?.body)
    throw new Error("The component CSS mount document is not ready");

  return targetDocument;
}

function targetIn(targetDocument: Document, selector: string): HTMLElement {
  const target = targetDocument.querySelector<HTMLElement>(selector);

  if (!target) throw new Error(`Component CSS mount target is missing: ${selector}`);

  return target;
}

const harness: ComponentCssHarness = {
  start(options = {}) {
    if (startPromise) return startPromise;

    startPromise = (async () => {
      const targetDocument = frameDocument();

      if (options.includeControl) {
        state = "mounting-control";
        const control = mount(targetIn(targetDocument, "#control-target"), UnwaitedControl, {
          name: "control",
          effects,
        } satisfies PanelProps);

        applications.set("control", control);

        await control.settled();
      }

      state = "preloading";
      const { default: StyledPanel } = await import("../../StyledPanel.tsx");
      const first = mount(targetIn(targetDocument, "#first-target"), StyledPanel, {
        name: "first",
        effects,
      } satisfies PanelProps);

      applications.set("first", first);

      if ((options.panelCount ?? 2) === 2) {
        applications.set(
          "second",
          mount(targetIn(targetDocument, "#second-target"), StyledPanel, {
            name: "second",
            effects,
          } satisfies PanelProps),
        );
      }

      state = "pending";
      readiness = Promise.all(
        [...applications.values()].map((application) => application.settled()),
      )
        .then(() => {
          state = "ready";
        })
        .catch((error: unknown) => {
          state = "failed";
          throw error;
        });

      void readiness.catch(() => undefined);
    })().catch((error: unknown) => {
      state = "failed";
      throw error;
    });

    void startPromise.catch(() => undefined);

    return startPromise;
  },

  whenSettled() {
    return readiness;
  },

  dispose(name) {
    const application = applications.get(name);

    if (!application) throw new Error(`No component CSS mount named ${name}`);

    applications.delete(name);

    application.dispose();
  },

  snapshot() {
    return { effects: [...effects], state };
  },
};

export default function ComponentCssPage() {
  client.effect(() => {
    window.hesperiaComponentCss = harness;
  });

  return (
    <main>
      <h1>Component CSS readiness</h1>
      <div id="mount-frame-host" />
    </main>
  );
}
