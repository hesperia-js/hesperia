import * as client from "hesperia/client";
import { Embed } from "hesperia/embed";

export interface EmbedLoadObservation {
  readonly type: string;
  readonly targetTag: string;
  readonly targetName: string;
  readonly sourceAttribute: string;
  readonly targetIsCurrent: boolean;
  readonly targetParentIsWrapper: boolean;
}

export interface EmbedReplacementObservation {
  readonly wrapperBindingStable: boolean;
  readonly wrapperConnected: boolean;
  readonly frameReplaced: boolean;
  readonly previousFrameDetached: boolean;
}

export interface EmbedSecurityProbe {
  readonly loads: EmbedLoadObservation[];

  wrapper(): HTMLElement;

  remember(): void;

  identity(): EmbedReplacementObservation;
}

let activeProbe: EmbedSecurityProbe | undefined;

export function getEmbedSecurityProbe(): EmbedSecurityProbe {
  if (!activeProbe) throw new Error("The Embed security application has not mounted");

  return activeProbe;
}

export default function EmbedSecurity() {
  const sandbox = client.state("allow-scripts");
  const wrapper = client.bind<HTMLElement>();
  const loads: EmbedLoadObservation[] = [];
  let rememberedWrapper: HTMLElement | undefined;
  let rememberedFrame: HTMLIFrameElement | undefined;

  const publishedWrapper = () => wrapper();

  const remember = () => {
    rememberedWrapper = publishedWrapper();
    const frame = rememberedWrapper.querySelector("iframe");

    if (!(frame instanceof HTMLIFrameElement)) {
      throw new Error("The Embed wrapper has no native iframe");
    }

    rememberedFrame = frame;
  };

  activeProbe = {
    loads,
    wrapper: publishedWrapper,
    remember,

    identity() {
      if (!rememberedWrapper || !rememberedFrame) {
        throw new Error("Remember the wrapper before checking its replacement");
      }

      const currentWrapper = publishedWrapper();
      const currentFrame = currentWrapper.querySelector("iframe");
      return {
        wrapperBindingStable: currentWrapper === rememberedWrapper,
        wrapperConnected: currentWrapper.isConnected,
        frameReplaced: currentFrame !== rememberedFrame,
        previousFrameDetached: !rememberedFrame.isConnected,
      };
    },
  };

  const onLoad = (event: Event) => {
    const target = event.target;
    const frame = target instanceof HTMLIFrameElement ? target : undefined;
    const currentWrapper = publishedWrapper();

    loads.push({
      type: event.type,
      targetTag: target instanceof Element ? target.tagName.toLowerCase() : "",
      targetName: frame?.name ?? "",
      sourceAttribute: frame?.getAttribute("src") ?? "",
      targetIsCurrent: frame !== undefined && currentWrapper.querySelector("iframe") === frame,
      targetParentIsWrapper: frame !== undefined && frame.parentElement === currentWrapper,
    });
  };

  return (
    <main id="embed-security-app">
      <Embed
        src="/embed-child?case=embed-security"
        title="Golden controlled child"
        name="hesperia-embed-golden"
        loading="eager"
        referrerPolicy="no-referrer"
        sandbox={sandbox()}
        width={320}
        height="180px"
        bind={wrapper}
        on:load={onLoad}
      />
      <button
        id="grant-same-origin"
        type="button"
        on:click={() => sandbox.set("allow-scripts allow-same-origin")}
      >
        Grant same-origin permission
      </button>
    </main>
  );
}
