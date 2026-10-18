import { Embed } from "../../../packages/hesperia/src/embed.ts";
import type { EmbedProps } from "../../../packages/hesperia/src/embed.ts";
import {
  component,
  createClient,
  defineComponent,
  dynamic,
  mount,
  registerProjectPolicy,
  type CallerProps,
  type MountedApplication,
} from "../../../packages/hesperia/src/runtime/index.ts";

interface EmbedMessage {
  readonly name: string;
  readonly childOrigin: string;
  readonly parentAccess: string;
  readonly eventOrigin: string;
}

interface EmbedProbe {
  readonly messages: EmbedMessage[];
  readonly loads: Record<string, number>;
  readonly errors: unknown[];

  setSandbox(tokens: string): Promise<void>;

  remember(): void;

  identity(): {
    readonly bindingStable: boolean;
    readonly wrapperNodeStable: boolean;
    readonly frameReplaced: boolean;
  };

  dispose(): void;
}

declare global {
  interface Window {
    embedProbe: EmbedProbe;
  }
}

const messages: EmbedMessage[] = [];
const loads: Record<string, number> = { dynamic: 0, strict: 0 };
const errors: unknown[] = [];

window.addEventListener("message", (event: MessageEvent<unknown>) => {
  if (
    typeof event.data === "object" &&
    event.data !== null &&
    "type" in event.data &&
    event.data.type === "hesperia-embed-proof"
  ) {
    const data = event.data as {
      name: string;
      childOrigin: string;
      parentAccess: string;
    };

    messages.push({ ...data, eventOrigin: event.origin });
  }
});

const srcdoc = `<!doctype html><script>
document.documentElement.dataset.embedScriptRan = "yes";
let parentAccess = "denied";
try {
  parent.document.documentElement.dataset.embedUnsafeAccess = window.name;
  parentAccess = "allowed";
} catch {}
parent.postMessage({
  type: "hesperia-embed-proof",
  name: window.name,
  childOrigin: location.origin,
  parentAccess
}, "*");
</script>`;

let application!: MountedApplication;
let setSandbox!: (tokens: string) => void;
let wrapperBinding!: () => HTMLElement;
let rememberedBinding: HTMLElement | undefined;
let rememberedWrapper: Element | undefined;
let rememberedFrame: Element | null | undefined;

const Root = defineComponent((owner) => {
  const client = createClient(owner);
  const sandbox = client.state("allow-scripts");
  setSandbox = (tokens) => sandbox.set(tokens);
  wrapperBinding = client.bind<HTMLElement>();
  return [
    component(
      owner,
      Embed,
      {
        name: "dynamic",
        sandbox: dynamic(sandbox),
        srcdoc,
        title: "Dynamic sandbox probe",
        width: 320,
        height: 180,
        bind: wrapperBinding,
        "on:load": () => {
          loads.dynamic++;
        },
      } as unknown as CallerProps<EmbedProps>,
      "dynamic-embed",
    ),
    component(
      owner,
      Embed,
      {
        name: "strict",
        srcdoc,
        title: "Strict sandbox probe",
        "on:load": () => {
          loads.strict++;
        },
      } as unknown as CallerProps<EmbedProps>,
      "strict-embed",
    ),
  ];
});

const definition = registerProjectPolicy(Root, { allowUnsafeEmbed: true });
application = mount(
  document.querySelector("#app")!,
  definition,
  {},
  { onError: (error) => errors.push(error) },
);
window.embedProbe = {
  messages,
  loads,
  errors,

  setSandbox(tokens) {
    setSandbox(tokens);

    return application.settled();
  },

  remember() {
    rememberedBinding = wrapperBinding();
    rememberedWrapper = document.querySelector('iframe[name="dynamic"]')?.parentElement;
    rememberedFrame = document.querySelector('iframe[name="dynamic"]');
  },

  identity() {
    const frame = document.querySelector('iframe[name="dynamic"]');
    return {
      bindingStable: wrapperBinding() === rememberedBinding,
      wrapperNodeStable: frame?.parentElement === rememberedWrapper,
      frameReplaced: frame !== rememberedFrame,
    };
  },

  dispose() {
    application.dispose();
  },
};

await application.settled();

document.documentElement.dataset.ready = "true";
