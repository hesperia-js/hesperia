import type { Component, Rendered } from "hesperia";
import { client } from "hesperia";
import { beforeLeave } from "hesperia/navigation";

export default function Layout(props: Component.Props<{ children: Rendered }>) {
  const fixture = globalThis as unknown as { routingPublicFixture: { layoutInstance?: string } };

  const check = (
    globalThis as unknown as {
      routingPublicReloadCheck: (name: string) => boolean | Promise<boolean>;
    }
  ).routingPublicReloadCheck;

  fixture.routingPublicFixture.layoutInstance = crypto.randomUUID();

  beforeLeave(() => check("layout"));

  const state = client.state(0);

  // prettier-ignore
  return <section id="route-layout" data-layout-instance={fixture.routingPublicFixture.layoutInstance}>
    <button id="bump-layout-state" on:click={() => state.set(state() + 1)}>Layout state</button>
    <output id="layout-state">{String(state())}</output>
    {props.children()}
  </section>;
}
