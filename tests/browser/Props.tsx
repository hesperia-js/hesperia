import { type Component as C } from "hesperia";
import * as client from "hesperia/client";

let bodies = 0;

export function childBodies() {
  return bodies;
}

function Child(
  props: C.Props<{
    optional?: () => string;
    nullable: (() => string) | undefined;
    required: () => string;
    __proto__: string;
  }>,
) {
  bodies++;
  return (
    <section id="prop-child">
      <span id="optional-callback">{props.optional()?.() ?? "absent"}</span>
      <span id="nullable-callback">{props.nullable()?.() ?? "absent"}</span>
      <span id="required-callback">{props.required()}</span>
      <span id="named-prop">{props.__proto__()}</span>
    </section>
  );
}

export default function Props() {
  const callback = client.state<(() => string) | undefined>(() => "first");
  return (
    <main>
      <button id="clear-callback" on:click={() => callback.set(undefined)}>
        Clear
      </button>
      <button id="replace-callback" on:click={() => callback.set(() => "second")}>
        Replace
      </button>
      <Child
        optional={callback()}
        nullable={callback()}
        required={() => "required"}
        __proto__="own value"
      />
    </main>
  );
}
