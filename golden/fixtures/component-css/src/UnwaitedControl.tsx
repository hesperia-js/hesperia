import type { Component } from "hesperia";
import * as client from "hesperia/client";

interface PanelInput {
  readonly name: string;
  readonly effects: string[];
}

export default function UnwaitedControl(props: Component.Props<PanelInput>) {
  const panel = client.bind<HTMLDivElement>();

  client.effect(() => {
    props.effects().push(`${props.name()}:${getComputedStyle(panel()).color}`);
  });

  return (
    <div bind={panel} class="golden-component-css" data-panel={props.name()}>
      {props.name()}
    </div>
  );
}
