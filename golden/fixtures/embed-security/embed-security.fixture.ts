import { mount } from "hesperia";
import EmbedSecurity, {
  getEmbedSecurityProbe,
  type EmbedLoadObservation,
  type EmbedReplacementObservation,
} from "./EmbedSecurity.tsx";

interface ChildMessage {
  readonly caseId: string;
  readonly childOrigin: string;
  readonly parentAccess: string;
  readonly eventOrigin: string;
}

interface EmbedGoldenBrowserApi {
  readonly messages: ChildMessage[];
  readonly loads: readonly EmbedLoadObservation[];

  wrapper(): HTMLElement;

  remember(): void;

  identity(): EmbedReplacementObservation;

  dispose(): void;
}

declare global {
  interface Window {
    hesperiaEmbedGolden: EmbedGoldenBrowserApi;
  }
}

const messages: ChildMessage[] = [];

window.addEventListener("message", (event: MessageEvent<unknown>) => {
  const data = event.data;

  if (typeof data !== "object" || data === null || !("type" in data)) return;

  if (data.type !== "hesperia-embed-child") return;

  if (
    !("caseId" in data) ||
    typeof data.caseId !== "string" ||
    !("childOrigin" in data) ||
    typeof data.childOrigin !== "string" ||
    !("parentAccess" in data) ||
    typeof data.parentAccess !== "string"
  ) {
    return;
  }

  messages.push({
    caseId: data.caseId,
    childOrigin: data.childOrigin,
    parentAccess: data.parentAccess,
    eventOrigin: event.origin,
  });
});

const host = document.getElementById("app");

if (!(host instanceof HTMLElement)) throw new Error("Golden application host is missing");

const application = mount(host, EmbedSecurity, {});

await application.settled();

const probe = getEmbedSecurityProbe();
window.hesperiaEmbedGolden = {
  messages,
  loads: probe.loads,
  wrapper: () => probe.wrapper(),
  remember: () => probe.remember(),
  identity: () => probe.identity(),
  dispose: () => application.dispose(),
};
document.documentElement.dataset.ready = "true";
