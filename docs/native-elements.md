# Native elements

Reader: a junior engineer who knows TypeScript, JSX, and browser event handlers.

Hesperia creates native browser objects from JSX, so you can call their methods
directly and use bindings when another part of the rendered tree supplies the object.

```tsx
import * as client from "hesperia/client";

export default function Search() {
  const input = <input type="search" />;

  client.effect(() => {
    input.focus();
  });

  return <form>{input}</form>;
}
```

Here `input` has the type `HTMLInputElement`. The effect runs after the rendered
tree is installed. Hesperia's checker preserves the native type, including when
you ask the editor for method completion.

A binding gives you a callable reference to an attached element:

```tsx
import { bind, effect } from "hesperia/client";

export default function Search() {
  const input = bind<HTMLInputElement>();

  effect(() => {
    input().focus();
  });

  return <input type="search" bind={input} />;
}
```

You can import client operations individually, as in this example, or through
the `client` namespace used above. Both forms belong to the component that calls
them and require Hesperia compilation. Import aliases work too.

Each binding has one target. Read it in an effect or an event handler; reading
it while a component body executes is a fault. A required binding must have a
value by the end of the first effect pass. Removing its target while the creating
component remains mounted also faults. The checker rejects incompatible targets,
such as attaching an `HTMLTextAreaElement` binding to an `input`.

Event attributes use the `on:` prefix. Known events receive their native event
type: a `keydown` handler receives `KeyboardEvent`, for example. An ordinary
function handler also receives the element as `this`:

```tsx
export default function FocusButton() {
  return (
    <button
      on:click={function () {
        this.focus();
      }}
    >
      Focus
    </button>
  );
}
```

Hesperia removes these listeners when their component is destroyed. Exceptions
from a handler follow rendering error handling. Custom event names receive the
base `Event` type.

Pass a handler and static options as a readonly pair when you need `capture`,
`once`, or `passive`. The same options can be composed with helpers from
`hesperia/events`:

```tsx
import { capture, once } from "hesperia/events";

export default function FocusOnce() {
  return (
    <button
      on:click={capture(
        once(function (event) {
          this.focus();
          event.clientX;
        }),
      )}
    >
      Focus once
    </button>
  );
}
```

`capture`, `once`, and `passive` each set their option to `true` and preserve the
handler and other options. `preventDefault()` and `stopPropagation()` remain
handler calls; they are not registration options. For example, a submit handler
can still call `event.preventDefault()` before reading a form.

The compiler checks option names and values before rendering. Option values must
be static booleans, and an options object cannot be spread or mutated. Constant
string keys are accepted when the compiler can resolve them. Destructuring with
a computed binding key remains outside this compiler profile and receives its
existing `HES-PATTERN` diagnostic.

The helpers are also available from the `events` export of `hesperia/client`,
including `client.events` when importing that module as a namespace. They return
a fresh handler/options pair. Sharing a `once` pair between elements gives each
element its own native listener and independent once behavior.

Suspending a cached page suppresses callback delivery while preserving its nodes
and listener registrations. A native `once` listener remains consumed after it
fires; restoring the page resumes the remaining listeners. Component destruction
removes them. For options computed at runtime, use the element's native
`addEventListener` with component cleanup.

An application that owns the whole document can pass a `Document` to `mount`.
Its shell belongs in the project's root `app.tsx`, where Hesperia permits
document-level JSX. The example below shows manual mounting. A generated
application installs the root `app.tsx` shell and its filesystem routes during
startup, so its generated entry does not also call `mount`.

```tsx
import { mount } from "hesperia";

export default function AppShell() {
  return (
    <html>
      <head>
        <title>Application</title>
      </head>
      <body>
        <main>Ready</main>
      </body>
    </html>
  );
}

mount(document, AppShell, {});
```

The component must produce exactly one native HTML `html` element. Hesperia
builds and validates the candidate tree before replacing the current document
element. A failure during that preparation leaves the existing shell in place;
effects run after installation and can still raise faults then. Disposing the returned
application removes the installed shell and revokes its component lifetimes.
Document mounts use the same binding, effect, async-boundary, and application
data rules as element mounts.

Native handles can be passed to browser constructors. For example, `FormData`
reads the form's current controls when the user submits it:

```tsx
import * as client from "hesperia/client";

export default function ProfileForm() {
  const submitted = client.state("");
  const form = (
    <form
      on:submit={(event) => {
        event.preventDefault();
        const data = new FormData(form);
        submitted.set(String(data.get("name")));
      }}
    >
      <input name="name" />
      <button type="submit">Read name</button>
      <output>{submitted()}</output>
    </form>
  );
  return form;
}
```

The input retains its native value while the output updates. The constructor
runs each time the handler executes. A constructor in the component body runs
during that lifetime's setup instead. Creating a browser resource does not give
it automatic Hesperia cleanup: register cleanup when needed, such as aborting
an `AbortController` used for native event listeners.

The compiler and checker track whether literal JSX creates HTML, SVG, or MathML
objects. For example, a `circle` inside `svg` has type `SVGCircleElement`, while
an `input` inside SVG's `foreignObject` has type `HTMLInputElement`. SVG values
such as `r={3}` and `viewBox="0 0 10 10"` are supplied as attribute values; the
browser exposes the corresponding native objects when you read the element.
CSS in a `style` attribute is a string.

HTML `src` attributes accept a native `Blob` as well as a URL string on any HTML
element except `script`; executable elements remain string-only. A video `poster`
accepts the same values. For responsive images, `srcset`
accepts either the browser's usual string or pairs such as
`[[smallImage, "480w"], [largeImage, "960w"]]`; each source can be a Blob or a URL
string, and each descriptor uses native `w` or `x` notation. Hesperia creates an
object URL for each Blob source and updates the existing element when a reactive
value changes. It revokes an old object URL after replacement and releases the
current one when the element is destroyed. A page kept in the route cache retains
its object URLs until restoration or final destruction. Author-supplied URL
strings remain untouched and are never revoked by Hesperia. These attributes do
not change executable-markup restrictions. `File` values are accepted as Blob
subtypes, including files from another same-origin Document. Hesperia creates
each object URL through the target element's Document. If that Document has no
URL API, the render reports a `blob-url` fault instead of stringifying the File
or Blob. Authored `iframe`, `embed`, and `object` elements are rejected with
guidance to use the official `Embed` component from `hesperia/embed`; direct
calls to the native element runtime are guarded the same way. Independently
created browser DOM is outside this JSX policy.

See the [Embed guide](embed.md) for sandbox permissions, iframe events, Blob
sources, and sizing behavior.

The compiler accepts a restricted set of HTML compositions. Paragraphs with
text and phrasing children are supported when the browser parser preserves the
authored tree, including `<strong>`, `<br />`, and `<img />`. It reports an
error when it cannot establish the native tree, including direct block content
inside a paragraph and dynamic MathML
`annotation-xml` encodings with children whose namespace depends on that encoding.
These compiler diagnostics also appear in `hesperia check` and the Hesperia editor
extension, with locations in the authored source, including unsaved editor changes.
Full HTML parsing support is outside the current compiler profile.
