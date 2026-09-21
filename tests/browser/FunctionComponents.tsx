import { AsyncBoundary, type Component, type Rendered } from "hesperia";
import { effect, state } from "hesperia/client";

const bodies: string[] = [];

export function bodyExecutions() {
  return bodies.slice();
}

export const Tree = function Branch(props: Component.Props<{ depth: number; label: string }>) {
  bodies.push("tree");
  return (
    <section data-depth={props.depth()}>
      <span class="tree-label">{props.label()}</span>
      {props.depth() > 0 ? (
        <Branch depth={props.depth() - 1} label={props.label()} />
      ) : (
        <span id="tree-leaf">leaf</span>
      )}
    </section>
  );
};

const Field = function (props: Component.Props<{ label: string }>) {
  bodies.push("field");
  return <input id="function-field" value={props.label()} />;
};

const upper = function convert(value: string): string {
  return value.toUpperCase();
};

async function ReadyMarker(): Promise<Rendered> {
  return <span id="function-ready-marker">Ready</span>;
}

const DeferredField = async function (
  props: Component.Props<{ label: string }>,
): Promise<Rendered> {
  // The compiler registers JSX awaits with this component's lifetime.
  // oxlint-disable-next-line unicorn/no-unnecessary-await
  const marker = await (<ReadyMarker />);
  bodies.push("deferred");
  const input = <input id="deferred-function-field" value={props.label()} />;
  effect(() => {
    input.setAttribute("data-effect", "ready");
  });
  return (
    <section>
      {marker}
      {input}
    </section>
  );
};

function Frame(props: Component.Props<{ children: Rendered }>) {
  return <main>{props.children()}</main>;
}

export default function FunctionComponents() {
  const label = state("first");
  return (
    <Frame>
      <button id="update-functions" on:click={() => label.set(upper("second"))}>
        Update
      </button>
      <Field label={label()} />
      <Tree depth={2} label={label()} />
      <AsyncBoundary fallback={<span>Loading field</span>}>
        <DeferredField label={label()} />
      </AsyncBoundary>
    </Frame>
  );
}
