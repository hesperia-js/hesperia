import type { Component } from "hesperia";
import * as client from "hesperia/client";

const events: string[] = [];
let boundInput: HTMLInputElement | undefined;

type EffectProps = Component.Props<{ name: string; revision: number }>;

function EffectLeaf(props: EffectProps) {
  const name = props.name();

  client.effect(() => {
    const revision = props.revision();

    events.push(`run:${name}:first:${revision}`);

    return () => events.push(`cleanup:${name}:first:${revision}`);
  });

  client.effect(() => {
    const revision = props.revision();

    events.push(`run:${name}:second:${revision}`);

    return () => events.push(`cleanup:${name}:second:${revision}`);
  });

  return <output data-effect-owner={name}>{props.revision()}</output>;
}

function EffectBranch(props: EffectProps) {
  const name = props.name();

  client.effect(() => {
    const revision = props.revision();

    events.push(`run:${name}:first:${revision}`);

    return () => events.push(`cleanup:${name}:first:${revision}`);
  });

  client.effect(() => {
    const revision = props.revision();

    events.push(`run:${name}:second:${revision}`);

    return () => events.push(`cleanup:${name}:second:${revision}`);
  });

  return (
    <section>
      <EffectLeaf name={`${name}.child`} revision={props.revision()} />
    </section>
  );
}

function BoundInput() {
  const binding = client.bind<HTMLInputElement>();

  client.effect(() => {
    boundInput = binding();

    events.push("run:binding:ready");

    boundInput.focus();

    return () => events.push("cleanup:binding:ready");
  });

  return <input id="bound-input" aria-label="Bound input" bind={binding} />;
}

export function lifecycleEvents(): readonly string[] {
  return [...events];
}

export function bindingState(): { readonly published: boolean; readonly current: boolean } {
  return {
    published: boundInput !== undefined,
    current: boundInput === document.querySelector("#bound-input"),
  };
}

export default function Lifecycle() {
  const revision = client.state(0);

  client.effect(() => {
    const current = revision();

    events.push(`run:root:first:${current}`);

    return () => events.push(`cleanup:root:first:${current}`);
  });

  client.effect(() => {
    const current = revision();

    events.push(`run:root:second:${current}`);

    return () => events.push(`cleanup:root:second:${current}`);
  });

  return (
    <main>
      <button
        id="advance-revision"
        type="button"
        on:click={() => revision.update((value) => value + 1)}
      >
        Advance revision
      </button>
      <EffectBranch name="left" revision={revision()} />
      <EffectBranch name="right" revision={revision()} />
      <BoundInput />
    </main>
  );
}
