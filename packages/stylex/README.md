# @hesperia/stylex

Compile StyleX definitions in Hesperia components and generate one application
stylesheet with StyleX's global rule ordering. Relative asset URLs resolve from
the TSX file that contributes each definition.

This package is part of Hesperia's alpha release channel. It uses StyleX's
0.19.1 Babel transform and requires the matching StyleX runtime.

## Add StyleX to an application

Install the runtime and build integration in a Hesperia application:

```sh
bun add @stylexjs/stylex@0.19.1
bun add --dev @hesperia/stylex@alpha
```

Register `stylex()` in `hesperia.config.ts`:

```ts
import { stylex } from "@hesperia/stylex";
import { defineConfig } from "@hesperia/tooling";

export default defineConfig({
  plugins: [stylex()],
});
```

Use StyleX's `attrs` result for the component's native class and style attributes:

```tsx
import * as client from "hesperia/client";
import * as stylex from "@stylexjs/stylex";

const styles = stylex.create({
  root: { color: "rebeccapurple" },
  dynamicColor: (color: string) => ({ color }),
});

export default function ColorButton() {
  const color = client.state("rebeccapurple");
  const attrs = () => stylex.attrs(styles.root, styles.dynamicColor(color()));

  return (
    <button
      class={attrs().class ?? ""}
      style={attrs().style ?? ""}
      on:click={() => color.set("steelblue")}
    >
      Change color
    </button>
  );
}
```

`stylex()` has no configuration options. Use the matching
`@hesperia/tooling@alpha` release. Hesperia prepares the generated stylesheet with
the application's other CSS; you do not import `.hesperia/stylex.css` yourself.

See [CSS readiness and ownership](https://github.com/hesperia-js/hesperia/blob/main/docs/css.md)
for relative URLs, asset capture, source maps, and stylesheet lifetimes. The
[optional styling fixture](https://github.com/hesperia-js/hesperia/tree/main/golden/fixtures/optional-styling)
shows StyleX alongside Tailwind and another PostCSS stage.

See the project's [license notice](https://github.com/hesperia-js/hesperia/blob/main/LICENSE),
[MPL-2.0 text](https://github.com/hesperia-js/hesperia/blob/main/COPYING), and
[commercial license terms](https://github.com/hesperia-js/hesperia/blob/main/LICENSE-COMMERCIAL.md).
