# @hesperia/postcss

Run an explicit, ordered list of PostCSS plugins during a Hesperia build. The
integration transforms imported and generated CSS, passes source maps to Hesperia,
and carries PostCSS file and directory dependencies into development watches.

This package is part of Hesperia's alpha release channel. Ordinary CSS imports
work without this optional integration.

## Add a CSS transform

In a Hesperia application, install the integration, PostCSS, and the plugins you
want to use. This example adds CSS nesting:

```sh
bun add --dev @hesperia/postcss@alpha postcss@8.5.28 postcss-nesting
```

Register the plugin in `hesperia.config.ts`:

```ts
import { postcss } from "@hesperia/postcss";
import { defineConfig } from "@hesperia/tooling";
import nesting from "postcss-nesting";

export default defineConfig({
  plugins: [postcss({ plugins: [nesting()] })],
});
```

Import a stylesheet from an authored application module:

```ts
import "./styles.css";
```

For example, `styles.css` can contain a nested selector:

```css
.card {
  color: rebeccapurple;

  &:hover {
    color: steelblue;
  }
}
```

The `plugins` option is required and accepts PostCSS plugins in execution order.
Hesperia does not discover `postcss.config.*` files. Installing a plugin does not
register it; pass its configured value in the array.

Use the matching `@hesperia/tooling@alpha` release. PostCSS 8.5.16 or later in
the 8.x series satisfies the integration's peer requirement. See
[project plugin configuration](https://github.com/hesperia-js/hesperia/blob/main/packages/tooling/docs/project-configuration.md#optional-css-and-stylex-plugins)
and [CSS readiness and ownership](https://github.com/hesperia-js/hesperia/blob/main/docs/css.md)
for source maps, warning locations, watches, and stylesheet lifetimes.

See the project's [license notice](https://github.com/hesperia-js/hesperia/blob/main/LICENSE),
[MPL-2.0 text](https://github.com/hesperia-js/hesperia/blob/main/COPYING), and
[commercial license terms](https://github.com/hesperia-js/hesperia/blob/main/LICENSE-COMMERCIAL.md).
