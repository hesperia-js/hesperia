# CSS readiness and ownership

Reader: application authors configuring styles for components and routed pages.

## Optional CSS transforms

Ordinary CSS imports work without an optional transform package. Add an integration only when the application needs it, and register its factory in `hesperia.config.ts` as shown in [project configuration](../packages/tooling/docs/project-configuration.md#optional-css-and-stylex-plugins). Installation by itself has no effect.

```powershell
bun add @hesperia/postcss postcss
bun add @hesperia/tailwind postcss
bun add @hesperia/stylex @stylexjs/stylex
```

`@hesperia/postcss` takes an explicit ordered list of PostCSS plugins. Install those plugins in the application too; Hesperia does not search for PostCSS config files. It carries file and directory dependency messages into revision watches. When a warning refers to a mapped current input, Hesperia traces that span back through the source map. If the map cannot locate the warning, Hesperia identifies the contributing stylesheet without attaching a source span and says the original CSS location is unavailable. A warning from a separate PostCSS input uses that input's own source text when available; otherwise it identifies the stage's authored origin without a span.

`@hesperia/tailwind` uses Tailwind CSS and `@tailwindcss/postcss` 4.3.3. Its `base` option selects the scan root; the default captures the Hesperia config process's working directory, which is the application root. Both imported CSS roots and generated CSS roots pass through the ordered CSS hook. Nested imported stylesheets use their own filenames for relative `@import` and `url(...)` resolution. Each physical stylesheet is captured and transformed once per revision even when multiple roots import it.

`@hesperia/stylex` uses `@stylexjs/babel-plugin` 0.19.1; install the matching `@stylexjs/stylex` runtime in the application. It recognizes real `stylex.create(...)` calls through StyleX imports and aliases. Static relative `url(...)` values in those definitions resolve from the contributing TSX file, then rebase to Hesperia's generated `.hesperia/stylex.css` input before StyleX hashes the rules. This keeps identical URL text from different source directories distinct and keeps the URL resolution base aligned with CSS bundling. The generated stylesheet aggregates all contributors in one StyleX pass, preserving global priority ordering. Colocated relative files are bundled and captured when the CSS loader reads them; the source transform does not read image bytes. If your deployment serves a `public/` directory, use its root URL for assets that should keep a stable public address. Relative colocated assets remain supported.

CSS source maps from a transform describe output against that stage's current input. Hesperia composes maps once and follows only an exact current-input source edge; library, placeholder, and other source branches stay attached to their actual sources. Generated or otherwise unmapped output remains unmapped rather than being attributed wholesale to an unrelated root file.

Ordinary side-effect CSS imports, with or without `type: "css"`, compile into independent Bun-bundled
stylesheets. The compiler emits one shared private plan, prepares each module's
static CSS closure before its definition becomes available, and binds component
styles to mounted owners. An installed-package application verified a direct
component mount in Chromium, Firefox, and WebKit: the stylesheet loaded inactive
before the mount, became active with the component, and returned inactive after
disposal. Nested imports, `url(...)` assets, minification, opposite import order,
and conditional closure planning have focused tooling coverage.

The public-package component CSS golden builds an authored project through
`@hesperia/tooling/project-service`. Its two browser cases passed in Chromium,
Firefox, and WebKit (6/6 checks). They hold the compiled module's stylesheet
preload and a direct mount's stylesheet in separate Documents, then verify the
mount's visibility, initial effect timing, shared stylesheet ownership, and
release after the final owner is disposed.

The compiler emits finite route composition records for separate page and
not-found views, including loading and error views with the surviving shell and
layouts. It emits a shared plan even for a CSS-free application and binds the
generated shell to that plan without an unnecessary preload. The router prepares
these styles in the installed document head and activates the selected view's
styles before its initial effects run. Styles needed by the surviving shell and
layouts stay active during the switch.

The compiler records the stylesheet closure for each compiled module and the
styles owned by each component definition. Module imports prepare that full
closure, including styles below conditional components, without activating it.
The first source encounter fixes cascade order.

Mounted owners activate their own styles after their DOM is installed. A style
stays active while any mounted owner in that application needs it. Suspending a
cached page pauses its style references with its effects; restoring the page
reactivates them without replacing its native nodes. Disposing the final owner
releases those references.

Each application selects styles independently. Applications that need the same
ordered stylesheet vector in the same `head` share its loaded links. One
application cannot turn off a sheet another active application still needs.
Separate applications have no defined cascade precedence over one another.

An element mount uses the `head` of the target's Document. If its stylesheet
group is already ready there, the mount reveals and commits immediately. If the
group is still loading, `mount` returns its handle immediately and inserts the
new native nodes in a connected, hidden range. When the exact group is ready,
Hesperia moves those same nodes into their final host positions, removes the
temporary range, and then runs initial effects. Existing host children remain
in place. A head replacement during this wait cancels that preparation and
starts one for the new head.

This wait also applies to compiled component modules reached through a dynamic
import. Two mounts in the same Document that need the same ordered stylesheet
group share its link load. Disposing one mount keeps the stylesheet active for
the other; disposing the last mount releases the group and removes its links.
The golden's no-wait control mounts equivalent markup without stylesheet
registration and records its initial unstyled effect while the stylesheet
request is held.

A `Document` mount installs the new shell with its body hidden, then waits for
the ordered group in that shell's actual `head`. It restores the body's prior
`display` declaration and runs initial effects only after the group is ready.
Preloaded styles in a replaced head are released when the runtime prepares the
new current head.

If a required stylesheet fails during either startup wait, Hesperia reports the
same rendering fault through the nearest boundary or root error handler. The
new content stays hidden and initial effects do not run. Calling the returned
handle's `settled()` rejects with that same error. The runtime handles the
failure internally when no caller requests `settled()`.

CSS-only revisions keep the current bytes active while replacement links load.
After every currently retained vector for the target head has a ready
replacement, publication switches the links in place. A failed, superseded, or
stale revision leaves the current CSS and mounted DOM unchanged; a vector first
retained after staging requires a fresh revision preparation.

The development server now sends CSS-only revisions to the shared plan without
reloading the document. A browser test verified that a direct mount's native
node and component state survive a CSS edit, and that a failed CSS build leaves
the old color in place. Executable changes still trigger a full reload.

Removing a source file has a separate development consequence after a successful
build. The server uses the previous builds' dependency ownership to identify
affected routes. An affected active page reloads the document. An affected cached
page is disposed, and visiting its destination loads a fresh document. An
unrelated active page keeps its mounted state. Removing a shared application
dependency affects the whole application.

These document replacements run the application's departure checks. A veto
keeps the current document and state; a later attempt still requires a fresh
document for the invalidated destination. An API navigation rejected by a veto
reports `AbortError` through its result promises.

The server retires obsolete outputs attributable only to removed sources.
Changing a content hash alone does not count as source removal. Older shared
assets remain available because a retained page or delayed dynamic import can
still need them after CSS-only edits. Retention is not limited to the current
and previous revisions; this repair does not define a page-disposal or asset
expiry policy.

The runtime's plan and registration helpers are generated-code plumbing, not
an author-facing style registry.
