# @hesperia/tailwind

Generate Tailwind CSS utilities during a Hesperia build. This integration runs
Tailwind's PostCSS transform on imported and generated stylesheets and uses
Tailwind CSS 4.3.3.

This package is part of Hesperia's alpha release channel.

## Add Tailwind to an application

Install the integration, stylesheet package, and PostCSS peer in a Hesperia
application:

```sh
bun add --dev @hesperia/tailwind@alpha tailwindcss@4.3.3 postcss@8.5.28
```

Register `tailwind()` in `hesperia.config.ts`:

```ts
import { tailwind } from "@hesperia/tailwind";
import { defineConfig } from "@hesperia/tooling";

export default defineConfig({
  plugins: [tailwind({ base: "." })],
});
```

Add Tailwind's import to `src/styles.css`:

```css
@import "tailwindcss";
```

Import that stylesheet from `app.tsx`, then use utility classes in a component:

```tsx
import "./src/styles.css";
```

```tsx
export default function WelcomePage() {
  return <h1 class="bg-fuchsia-950 px-7 text-white">Hello from Hesperia</h1>;
}
```

The `base` option selects the directory Tailwind scans. Relative values resolve
from the application-root configuration process; omitting `base` also uses the
application root. Use the matching `@hesperia/tooling@alpha` release. You do not
need a separate `@hesperia/postcss` registration for Tailwind.

See [project plugin configuration](https://github.com/hesperia-js/hesperia/blob/main/packages/tooling/docs/project-configuration.md#optional-css-and-stylex-plugins)
and [CSS readiness and ownership](https://github.com/hesperia-js/hesperia/blob/main/docs/css.md)
for plugin ordering, imported assets, watches, and stylesheet lifetimes.

See the project's [license notice](https://github.com/hesperia-js/hesperia/blob/main/LICENSE),
[MPL-2.0 text](https://github.com/hesperia-js/hesperia/blob/main/COPYING), and
[commercial license terms](https://github.com/hesperia-js/hesperia/blob/main/LICENSE-COMMERCIAL.md).
