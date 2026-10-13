# Navigation API fallback audit

Reader: a junior TypeScript engineer familiar with Hesperia routing and the browser History API.

Audit date: 2026-09-11.

## Current runtime status

This audit predates the Navigation runtime implementation. Its candidate review,
browser observations, and statements that fallback work is unfinished describe
the 2026-09-11 research snapshot. The current API and routing behavior are
documented in [routing](routing.md). The runtime uses the native Navigation API
only when the required interception support is present; otherwise it uses the
History-event fallback. That fallback tracks the current entry and entries
created through Hesperia or the installed History wrappers. The classic History
API does not expose earlier entry keys or indexes, so the fallback cannot list
or traverse an entry created before tracking began. It also cannot provide the
same interception events for direct `window.location` changes. During a
fallback Back or Forward, the address may change while Hesperia checks the
route; a rejected move restores the previous tracked entry.

Hesperia has approval to use the native Navigation API, while retaining the project's Baseline 2024 compatibility objective. This document records what the current platform and the concrete polyfill candidate can prove. It does not select a dependency, change the browser support floor, or define behavior for foreign history entries.

## The compatibility problem

The native Navigation API is a good match for Hesperia's routing transaction. A navigation entry has a stable `key`, a unique `id`, an `index`, a URL, and serializable state. The API can traverse to an entry by key, and navigation methods expose separate `committed` and `finished` promises. A `navigate` event has an abort signal and can be intercepted for asynchronous work.

Entry identity lets Hesperia distinguish repeated URLs. Cancellation lets it stop a same-document traversal before preparing its destination. However, an ordinary intercepted `handler` runs after the browser commits the destination entry: rejecting that handler does not restore the previous URL. Hesperia must cancel the original traversal synchronously, run its checks, and traverse to the saved destination key only if that candidate still wins. The [WHATWG Navigation API section](https://html.spec.whatwg.org/multipage/nav-history-apis.html#the-navigation-api) defines the platform behavior; [MDN's interception reference](https://developer.mozilla.org/en-US/docs/Web/API/NavigateEvent/intercept) explains handler timing.

The current MDN browser-compatibility data does not put those capabilities on a 2024 browser floor. It lists Navigation API support beginning at Chrome 102, Firefox 147, and Safari 26.2, with the individual navigation methods and events following the same modern support boundary. See the checked-in [MDN browser-compatibility data for `Navigation`](https://raw.githubusercontent.com/mdn/browser-compat-data/main/api/Navigation.json). This means “the native path works in the browsers probed for Hesperia” and “the feature is available on the Baseline 2024 floor” are separate claims.

The native entry list includes same-document entries created through `history.pushState`, including entries made before Hesperia starts. They do not need Hesperia metadata to have a native key. Cross-document navigation is a separate browser operation; the same-document routing tests do not establish interception of it. Missing entry metadata in a History-based polyfill must not be presented as a limitation of the native API.

## Native replay experiment

Lead reproduced the following sequence independently of Hesperia in the installed Playwright browsers on Windows:

1. Replace the current entry with `/a`, save its native key, then push `/b`.
2. Call `navigation.back()` and cancel its `navigate` event with `preventDefault()`.
3. Await that navigation's rejected `finished` promise.
4. Call `navigation.traverseTo(savedKey)` and install a marker from its intercepted handler.

Firefox completes the replay. Chromium completes after the original cancellation settles, but an immediate replay can reject with `InvalidStateError`. WebKit emits a reload to `/b` and rejects instead of traversing to `/a`. Its entry list still reports both entries and their expected keys. A genuine user click and yielding to a later task did not repair WebKit's result. Replacing `traverseTo` with `history.go`, using the exact native index difference, also failed there.

A separate `precommitHandler` probe preserved `/b` until an admission promise rejected in Chromium and Firefox. The installed WebKit ignored that option and committed `/a` before the ordinary handler ran. WebKit's [open implementation issue](https://bugs.webkit.org/show_bug.cgi?id=293952) is consistent with that missing capability. Its [remaining traversal issues](https://bugs.webkit.org/show_bug.cgi?id=282689) include cancellation-related failures, but that report does not identify our exact top-level reproduction. These tests establish the behavior of the installed WebKit build, not a verified failure in a particular Safari release.

The experimental `Router.listenToHistory()` implementation was withdrawn from public source after this failure. Its small fake-platform tests did not establish browser correctness. Existing programmatic navigation, link handling, and wrapped author state remain implemented; browser Back/Forward integration remains unfinished. Do not hide this limitation by excluding WebKit from an otherwise universal support claim or by adding timed retry loops.

## Candidate found

The concrete candidate examined was [`@virtualstate/navigation`](https://github.com/virtualstate/navigation). Its [repository package metadata](https://raw.githubusercontent.com/virtualstate/navigation/main/package.json) declares version `1.0.1-alpha.212`, and the [npm package page](https://www.npmjs.com/package/%40virtualstate/navigation?activeTab=versions) independently lists `1.0.1-alpha.212` as the latest published version. The package metadata declares the [MIT license](https://raw.githubusercontent.com/virtualstate/navigation/main/LICENSE.md). The alpha version and the source's own “WIP” comments are verified facts; no maintenance or production-readiness claim is inferred from them.

The package has two relevant modes:

1. Its navigation implementation supplies a JavaScript model of entries, keys, indexes, navigation events, interception, transitions, and History-like methods.
2. Importing [`@virtualstate/navigation/polyfill`](https://github.com/virtualstate/navigation#polyfill) installs a global integration. The source describes its `history` option as using `popstate` for traversal and History API calls for pushes. It also has optional persistence and a `patch` option for monkey-patching the History API.

The candidate's README explicitly documents limits: `window.location` changes do not emit its `navigate` event, normal page navigations are not intercepted, and its History integration works “in most cases” but does not recover correctly after a page refresh. Its source labels persistence, session-state persistence, hash changes, scroll, iframe handling, and edge cases as work in progress. The README and source are the relevant evidence: [polyfill options and limitations](https://github.com/virtualstate/navigation#polyfill), [polyfill integration source](https://raw.githubusercontent.com/virtualstate/navigation/main/src/get-polyfill.ts), and [MIT license](https://raw.githubusercontent.com/virtualstate/navigation/main/LICENSE.md).

The repository's browser-version badges are package claims. They are not a substitute for Hesperia's browser matrix, the HTML Standard, or MDN compatibility data, and they do not establish Baseline 2024 support.

## Fit against Hesperia's routing contract

| Hesperia behavior                         | What the candidate appears to provide                                                                                                                    | What remains unproved or unavailable                                                                                                                                                                                                                                                                                             |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Incoming guard and departure checks       | A `navigate` event, `preventDefault`, and an asynchronous `intercept({ handler })` hook.                                                                 | No evidence that the candidate enforces Hesperia's required order of incoming guards, departure checks, detached preparation, and terminal effects. The Hesperia Router must remain the transaction authority.                                                                                                                   |
| Candidate preparation and cancellation    | An intercepted handler can be asynchronous. The internal model has an active transition and abort machinery.                                             | No Hesperia Owner integration has been tested. Candidate disposal, nested owner cleanup, and “committed DOM stays visible until install” still need real browser tests. The handler's signal must be connected to Hesperia's candidate lifetime.                                                                                 |
| Exact same-document Back/Forward identity | Synthetic entries have keys and indexes, and the History adapter calls synthetic `traverseTo`. Repeated URLs can therefore be distinct inside the model. | The package says the History path works in most cases and is WIP after refresh. There is no evidence for Hesperia's exact veto restoration, repeated Back/Forward races, or a programmatic navigation arriving during restoration.                                                                                               |
| Entries created before router startup     | Optional persistence attempts to retain the package's synthetic entry list and session state.                                                            | Persistence is explicitly WIP and cannot recover metadata that was never written. A polyfill cannot reconstruct Hesperia positions for an unknown pre-startup entry without changing that entry or defining a fallback policy.                                                                                                   |
| Raw `pushState` and `replaceState` writes | The `patch` option wraps History methods and can route legacy writes through the synthetic model.                                                        | Patching is global prototype modification; the source calls it “prototype acrobatics” and notes that it hides the browser's underlying history state from the application. With patching disabled, Hesperia has no evidence that every raw writer is observed. Hesperia must decide who owns this boundary before relying on it. |
| Native author state                       | The package has JSON serialization and custom serializer hooks.                                                                                          | Hesperia's approved envelope must preserve arbitrary author state, including explicit `null` and `undefined`, without allowing an author object shaped like an internal marker to be mistaken for framework metadata. The candidate's default JSON path is not proof of that contract.                                           |
| Latest navigation intent wins             | The internal navigation model aborts an active transition in some paths, and the native API also has abort signals.                                      | There is no tested proof that a newer Hesperia intent aborts guards, disposes the detached candidate, prevents old installation, and leaves history positions exact. A synthetic transition abort alone does not establish that invariant.                                                                                       |
| Foreign same-document entries             | The polyfill can recognize the metadata it writes.                                                                                                       | Its `popstate` integration ignores states that do not carry its metadata. It cannot infer a missing Hesperia position or traversal delta for an entry written by an unrelated History API caller.                                                                                                                                |

The candidate is therefore useful as an implementation reference and a possible compatibility layer, but the available evidence does not support treating it as a drop-in implementation of Hesperia routing.

## Browser experiment

An isolated installation of published version `1.0.1-alpha.212` was tested in the project's installed Chromium, Firefox, and WebKit. The native `navigation` property was removed before importing the global polyfill. Each page created two classic History entries before that import. A same-document interception handler allowed the experiment to exercise the package's navigation model without loading a new document. No production dependency was added.

All three engines produced these observations:

| Operation                                                                           | Observed result                                                                                                              |
| ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Initialize after two existing same-document entries                                 | The synthetic entry list contained only the current entry. The earlier entry remained in real browser history.               |
| Read the initial author's object state                                              | `navigation.currentEntry.getState()` retained the object; patched `history.state` returned `undefined`.                      |
| Navigate with explicit `null` state                                                 | Both state readers returned `undefined`. Explicit `undefined` also returned `undefined`.                                     |
| Await `traverseTo(knownKey).finished`                                               | The synthetic current entry had changed, but the address still named the previous entry.                                     |
| Then await the corresponding native `popstate`                                      | The physical URL reached the requested known entry.                                                                          |
| Use the original native `history.go` to reach an entry made before polyfill startup | The browser reached that older URL, while the synthetic current entry still described the previously selected managed entry. |

The traversal checks waited for actual browser events; the completion-promise result and the later `popstate` result were captured separately. The older-entry check used the saved native `history.go`, so it exercised a browser traversal outside the package's synthetic entry list.

These results require adaptation work before Hesperia can rely on the package: preserving author state, distinguishing synthetic completion from physical movement, and handling older entries. They do not prove every package option has the same behavior. Running current engines with the native API removed also does not certify any actual 2024 browser version.

Two other implementations were checked against their published source documentation. [`navigation-ponyfill`](https://github.com/kcrwfrd/navigation-ponyfill#supported-apis) tracks entry keys and persists its own stack, but does not implement `NavigateEvent`, interception, or `traverseTo`. Its state extension also requires author state to be an object or nullish. [`navigation-polyfill`](https://github.com/zhbhun/navigation-polyfill) lists entry keys and traversal methods as unsupported. Neither supplies the operations needed by the native routing path; neither was installed or browser-tested in this audit.

## Fallback implementation path

The user approved a temporary address-bar change in the fallback during Back/Forward. The current page stays mounted while departure checks run; a veto must restore the exact previous entry. This permits the timing difference inherent in the older History API. It does not relax checks, entry identity, or the requirement to discard superseded candidate work.

The first step should be capability detection, with the native implementation used when the required Navigation API surface works. The fallback should be an isolated startup adapter that supplies entry observations and movement to the existing Router transaction. Its restoration timing differs from native precommit handling; an adapter must describe that difference rather than emulate a completion promise that resolves too early. The adapter must not become a second router.

If Hesperia evaluates `@virtualstate/navigation`, it should opt into only the behavior that has been deliberately tested. In particular, enabling the package's global `patch` mode or persistence mode should be an explicit adapter decision, because both alter the relationship between author code and browser history. The adapter would need to translate its transition signal into the Hesperia Owner abort signal, retain the committed entry until candidate installation, and dispose superseded candidates before allowing another transaction to commit.

This does not by itself restore Baseline 2024. A legacy History adapter would still be needed for browsers without a usable Navigation API. The user has now approved installing tracking before application startup and automatically tracking direct application `pushState`/`replaceState` calls, preserving author state separately. Authors can keep using those browser methods. This closes the tracking-policy question for calls made through the installed methods; it does not retroactively identify earlier entries. The old History API does not expose the entry key/index model needed to identify or restore an arbitrary pre-existing foreign entry exactly. Such entries remain a separate limitation to resolve.

## Verification required before dependency or support claims

The next implementation pass should test the native adapter and any fallback separately in Chromium, Firefox, and WebKit. Each matrix cell should use observable `committed`/`finished` or Router installation barriers rather than timed sleeps.

The minimum cases are:

- two entries with the same URL and the same author state remain distinct and traversable;
- a router starts with entries made before initialization and preserves valid author state;
- raw `pushState` and `replaceState` before and after initialization are either handled by an explicit policy or rejected by a documented boundary;
- an incoming guard veto leaves the old DOM and exact committed entry in place;
- an asynchronous guard can be canceled by a newer intent;
- a failed or superseded candidate never runs effects, publishes bindings, or installs DOM;
- Back/Forward restoration preserves every managed entry through rapid repeated traversal;
- a programmatic navigation arriving during restoration wins without corrupting the physical history stack;
- reload/session restore behavior is tested independently from same-document traversal;
- foreign same-document entries produce the documented behavior, including when no departure-check callback is installed.

Until those tests exist, the project can claim native API research and a documented candidate, but it cannot claim fallback parity or Baseline 2024 navigation support.

## Current decision

Do not add a production dependency from this audit. Keep the native Navigation API path approved and under implementation, retain the Baseline 2024 objective, and treat `@virtualstate/navigation` as an evaluated candidate requiring further adaptation. Direct application history-call tracking before application startup is approved. Pre-existing foreign entries and concurrent restoration remain to be resolved; a fallback must not hide either with reloads, guessed history deltas, overwritten entries, or bypassed departure checks.
