# Asset imports

Reader: a junior TypeScript engineer loading files in a Hesperia application.

Relative file imports in a Hesperia application can produce strings, parsed JSON, or completed native `Blob` values. The compiler and editor use the same interpretation, including for finite dynamic imports.

```ts
import template from "./template.html"; // string
import settings from "./settings.json" with { type: "json" }; // parsed value
import photo from "./photo.jpg" with { type: "image" }; // Blob, image/jpeg
import rawCss from "./theme.css" with { type: "string" }; // string; does not apply CSS
import "./theme.css" with { type: "css" }; // managed stylesheet
```

Without a `type` attribute, text files and unfamiliar extensions are strings. JSON files also default to strings. Both implicit strings and `type: "string"` use strict UTF-8 decoding; malformed bytes cause an import diagnostic. A JSON import parses during the build and exposes a declaration inferred from the parsed value. Invalid JSON fails at the import.

Known binary extensions require an explicit type. The `image`, `audio`, and `video` shorthands select a MIME type from a known extension in the requested category. If the extension cannot identify that category, use a full MIME type such as `image/jpeg`, `video/mp4`, or `application/pdf`. An explicit MIME type labels the original bytes; it does not convert them. A known extension that disagrees with the declared MIME type produces a warning in checking and the editor.

Dynamic imports use the same rules:

```ts
const module = await import("./clip.mp4", { with: { type: "video/mp4" } });
const clip: Blob = module.default;
```

An async component can await a dynamic import directly. Its enclosing
`AsyncBoundary` shows the fallback until the component finishes:

```tsx
import { AsyncBoundary } from "hesperia";

async function Photo() {
  const { default: photo } = await import("./photo.jpg", {
    with: { type: "image" },
  });
  return <img src={photo} alt="Photo" />;
}

export default function Gallery() {
  return (
    <AsyncBoundary fallback={<span>Loading photo...</span>}>
      <Photo />
    </AsyncBoundary>
  );
}
```

You can also start the import outside the component and await its original
Promise inside it:

```tsx
const photoPromise = import("./photo.jpg", { with: { type: "image" } });

async function Photo() {
  const { default: photo } = await photoPromise;
  return <img src={photo} alt="Photo" />;
}
```

Several components can await that same Promise. Removing one component stops
its continuation without cancelling the import or another component's wait.
They receive the same imported module value. An import rejection reaches the
component's `catch`, or the rendering error boundary if uncaught.

Separate asset-import sites currently produce separate generated module views,
even for the same file and type. Reuse one import Promise when the components
need to share the exact module or `Blob` object.

This component-body support applies to import Promises created by source that
Hesperia compiles. It does not admit arbitrary Promises: `.then()`, `Promise.all()`,
and an ordinary async helper create separate Promises that are not registered
component waits. Event handlers and ordinary async functions retain normal
JavaScript await behavior.

The `type` key may be quoted in a static import or in a dynamic import's
`with` object, for example `with { "type": "json" }` and
`import("./settings.json", { "with": { "type": "json" } })`. Other attribute
keys and unbounded dynamic import targets remain errors. Explicit `type: "css"`
parses a side-effect import as CSS regardless of its filename extension. Bare
dynamic CSS imports have no activation lifetime; import the
stylesheet statically from the dynamically loaded component instead.

The compiler consumes import attributes before producing browser modules. Each import view shares the captured file bytes within one project revision, even when the same file is imported as both text and JSON.

HTML and SVG component imports use a distinct import type. Importing `.html` or `.svg` without a component type returns source text.
