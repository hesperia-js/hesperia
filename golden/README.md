# Golden browser cases

This suite compiles independent TSX applications with the public
`@hesperia/compiler` package, bundles
the emitted `hesperia` package for the browser, and runs each scenario in
Chromium, Firefox, and WebKit. Its server defaults to port `4189`; the framework
browser suite uses `4178`. Set `HESPERIA_GOLDEN_PORT` to choose an isolated port.

For manual review, run `bun run serve` from `golden/` and open
[the fixture index](http://127.0.0.1:4189/). It links to every fixture and its
scenario variants, with notes for pages that need the test runner to supply data
or setup. The server prints its actual address after startup. Restart it after
changing fixtures or the index; this command does not watch files.

Run from the repository root to install the dependencies, build Hesperia's
packages, and execute the suite:

```sh
bun install --frozen-lockfile
bun run build
bun run --cwd golden verify:packages
bun run --cwd golden test
```

The root Bun workspace installs the local Hesperia packages and the pinned
published Aeolia package. Before starting, `verify-packages.ts` checks that
public exports resolve into each workspace package's `dist/` and that Hesperia
and the fixtures resolve the same Aeolia installation. After bundling,
`verify-aeolia-inputs.ts` checks the bundle's actual inputs for Aeolia source
imports or a second Aeolia installation. Both checks run when the golden server
starts.

The focused commands are `bun run test:chromium`, `bun run test:firefox`, and
`bun run test:webkit`. Install the matching browser binaries once with
`bun run install:browsers` when the machine does not already have them.

The native identity case keeps `ElementHandle`s for a button and input, performs
real clicks, then compares those objects with the live DOM. A negative control
replaces a node deliberately and confirms the same identity check returns
false. The task case starts a real public `TaskRun`, cancels it, awaits its
`AbortError`, then releases a controlled late backend result and waits for that
backend promise to settle. The visible status/value must remain
`cancelled:none`.

The Embed security case imports `Embed` from `hesperia/embed` in a compiled TSX
application. Its root enables `allowUnsafeEmbed` to exercise generated policy
registration. A controlled same-origin child attempts to write its parent;
an unsandboxed iframe provides the negative control. The case also checks
permission-driven iframe replacement, persistent native wrapper identity and
sizing, load callbacks, and parent disposal. See [the Embed guide](../docs/embed.md)
for the public contract. Checklist cached-page restoration is described below in
the navigation scenario.

The native-events case compiles plain `on:` handlers, literal handler/options
pairs, and helpers imported from `hesperia/events` and `client.events`. Two
elements share one `once` pair and each receives one click. The case checks
capture and bubbling order, passive `preventDefault()` against a non-passive
control, exact event identity, and the callback's `this`, target, and current
target. It dispatches through an old button after disposal and confirms a
recreated component receives fresh once state. A bounded native control shows
how a callback-level once flag incorrectly suppresses the second element.
Cached-route once preservation remains queued until the public navigation
contract is ready.

The checklist cache scenario runs explicit `fallback` and `native` rows under the
existing Chromium, Firefox, and WebKit projects. Fallback disables
`window.navigation` before application startup and records real History traversal
events. Native runs only when the browser provides the required Navigation API
and async admission hook; an unavailable capability produces an explicit native
skip. Its observer preserves the native event and callback receivers while
recording completed `NavigateEvent.intercept` precommit admissions. Both rows run
the same retained-node, control-state, effect cleanup, data revalidation, Back,
and Forward assertions. Each successful row attaches its actual path observations
as `navigation-mode.json`. Acceptance controls reject a missing observer, fallback
selected as native, and fallback without actual traversals. Browser names alone
do not establish either mode. The catalog maps both rows to the same navigation
behavior, and the selector retains the Windows/Linux and three-engine matrix.

The component CSS case builds an authored project through the public
`@hesperia/tooling/project-service` package and serves its emitted index and
assets. It holds the compiled component's module preload in the main document,
then holds the direct mount's stylesheet request in a same-origin iframe
document. A no-wait control commits and runs its effect before the module import
resolves; styled nodes stay hidden and their effects wait for the iframe
stylesheet. Two mounts in the iframe share one stylesheet request, and disposing
them releases that link after the final owner is gone. Both cases pass in
Chromium, Firefox, and WebKit (6/6 checks). This case does not cover navigation
or cached-page restoration.

The public-values application checks that compiled configuration preserves the
difference between an omitted key, an own `undefined` value, and `null`. Its
declaration consumer checks the generated types. A controlled change to one
emitted browser asset removes the own `undefined` key and confirms the same
behavioral assertion rejects that result, then passes again with the ordinary
asset.

The lifecycle application checks children-first effects, registration order,
native bindings, retained input identity, and owner cleanup. Two mounted stream
consumers exercise shared ownership and the configured idle expiry using a
paused browser clock. Async-query cases check fallback rendering, success, and
error cleanup.

No runtime recorder is needed for these cases. Native DOM identity, rendered
task state, the public task handle, and explicit completion promises expose the
required behavior without observing private fields. This initial suite does not
prove every public contract, declaration type, integration, or lifecycle
transition; those cases remain to be added as their behavior is established.
