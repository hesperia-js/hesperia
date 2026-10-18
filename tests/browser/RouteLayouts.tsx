import { type Component, type Rendered } from "hesperia";
import { cleanup, effect, state } from "hesperia/client";

const events: string[] = [];
const nestedProps: object[] = [];

export function routeEvents() {
  return events.slice();
}

export function damageNestedLayout() {
  Reflect.deleteProperty(nestedProps.at(-1)!, "children");
}

export function Frame(props: Component.Props<{ children: Rendered }>) {
  events.push("body:frame");

  const count = state(0);

  effect(() => {
    props.children();

    events.push("children:frame");
  });

  cleanup(() => {
    events.push("cleanup:frame");
  });

  return (
    <section id="route-frame">
      <button id="layout-count" on:click={() => count.update((value) => value + 1)}>
        Layout count: {count()}
      </button>
      {props.children()}
    </section>
  );
}

export function NestedFrame(props: Component.Props<{ children: Rendered }>) {
  nestedProps.push(props);

  events.push("body:nested");

  effect(() => {
    props.children();

    events.push("children:nested");
  });

  cleanup(() => {
    events.push("cleanup:nested");
  });

  return <article id="nested-frame">{props.children()}</article>;
}

export function Page(props: Component.Props<{ label: string; query: () => string | null }>) {
  const label = props.label();

  events.push(`body:${label}`);

  const node = (
    <main id="route-page">
      <input id="route-field" value={props.label()} />
      <span id="route-query">{props.query() ?? "none"}</span>
    </main>
  );

  effect(() => {
    events.push(`effect:${label}:${node.isConnected}`);
  });

  cleanup(() => {
    events.push(`cleanup:${label}:${node.isConnected}`);
  });

  return node;
}
