# Embedded documents

Import the supported iframe component from `hesperia/embed`:

```tsx
import { Embed } from "hesperia/embed";
import * as client from "hesperia/client";

export default function Video() {
  return (
    <Embed
      src="https://video.example/watch/42"
      title="Product demonstration"
      sandbox="allow-scripts"
      width={640}
      aspectRatio={16 / 9}
      on:load={client.events.once((event) => console.log(event.type))}
    />
  );
}
```

`Embed` keeps the iframe inside a persistent wrapper. Bindings publish that
wrapper, never the replaceable iframe. Direct authored `<iframe>`, `<embed>`,
and `<object>` elements remain prohibited.

## Sandbox permissions

When `sandbox` is omitted, `Embed` sets the native `sandbox=""` attribute.
Authors can request native sandbox tokens explicitly. Token matching follows
the HTML Standard's ASCII case-insensitive rules; duplicate spellings collapse
to one token. The browser must support every requested token.

`allow-scripts` is the only permission that does not require project approval.
It permits scripts inside the isolated frame while preserving origin
isolation. Any other token requires both `allowUnsafeEmbed: true` in
`hesperia.config.json` and that token on the individual `Embed`:

```json
{
  "allowUnsafeEmbed": true
}
```

The project flag grants no permission by itself. Hesperia validates the
complete token set before assigning `src` or `srcdoc`. Changing the token set
replaces the inner iframe, so its document reloads and loses its own state.
The wrapper and its binding stay in place.

## Sources and native options

`src` accepts a URL string or a `Blob`. Hesperia creates and owns the Blob URL;
it revokes the URL when the source is replaced, the owner is suspended in the
page cache, or the component is removed. Resuming a cached page creates a new
iframe and, for a Blob source, a new URL. Author-provided URL strings are left
unchanged.

If both `srcdoc` and `src` are present, the browser gives `srcdoc` precedence.
`title`, `loading`, `referrerPolicy`, and `name` set their corresponding native
iframe options. `on:load` and `on:error` accept a callback or a native
handler/options pair such as `[handler, { passive: true }]`. The supported
options are `capture`, `once`, and `passive`; the `once`, `capture`, and
`passive` helpers from `hesperia/events` and `client.events` create these pairs.
Callbacks receive native events whose target is the current iframe. Hesperia
reads the latest callback when each event fires and removes its listener when
that iframe is replaced. A `once` listener is consumed on its iframe; replacing
the iframe installs a fresh listener. The wrapper binding does not change.
Browsers do not reliably fire `error` for failed iframe navigations, so use it
only for the native event, not as a complete navigation-failure signal.

## Sizing and cached pages

`width` and `height` accept a number in CSS pixels or a CSS length string.
`aspectRatio` accepts a number or a CSS ratio string. Hesperia does not apply a
fixed fallback size. With no sizing props, ordinary iframe layout and authored
CSS determine the result. Only explicitly supplied dimensions remain
constrained on the wrapper; an unspecified dimension may collapse while the
inner iframe is stopped in the page cache. Supply sizing or author CSS when
the inactive page needs a reserved box.

See [native element behavior](native-elements.md#foreign-and-safe-html-domains)
for the broader DOM policy.
