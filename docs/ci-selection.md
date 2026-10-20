# Verification selection

CI makes two selection decisions. The ordinary verification selector chooses
test roots and integration gates. The golden selector maps source impact to
behaviors and implemented application cases. Both use the shared source-impact
reader, but uncertainty can require a broader result in either layer.

The golden planner validates the catalog against Playwright's current test list.
It runs each selected spec file in Chromium, Firefox, and WebKit on Windows and
Linux. Golden selection does not replace build, type, lint, formatting, package,
browser, editor, or deterministic checks.

## Run the ordinary verification selector

From the repository root, compare the base with the checked-out verification
commit:

```sh
bun scripts/ci/select-verification.ts --base <base-commit> --head <verification-commit>
```

Add `--full` to require every gate. The JSON records resolved commits, changed
paths, ordinary roots, integration flags, selection reasons, and fallback reasons.
The workflow consumes the same decision through GitHub step outputs. A failed
selector, missing outputs, or an empty comparison requests full verification.

Ordinary roots are `compiler`, `runtime`, `data`, `tooling`, `routing`, `editor`,
`hosting`, and `ci`. Production package and subsystem ownership supplies a minimum
selection. Tracked consumers can add other roots. Dedicated application fixtures
seed their owning root, while cross-root imports and opaque readers can add
consumers elsewhere. A new production source file retains an owner even without
an incoming import edge.

Authored application fixtures can be staged program inputs rather than executable
modules in the checkout. Their tests may supply imports or deliberately check
malformed source. The selector accounts for those inputs through their owner and
all known static and opaque consumers. This does not exempt executable browser
entrypoints or production modules from dependency validation.

An opaque consumer can load tracked inputs without a statically resolved import.
The reader records dynamic loaders, file access, and subprocess boundaries.
The selector includes their known test owners conservatively instead of requiring
an edge from the changed input. Unknown ownership and invalid dependency data
require full verification. This can select several roots for one source change.

Production source changes retain the browser, package, editor, and golden gates.
These gates consume generated code and built artifacts whose relationships are
not limited to authored imports. Documentation shipped in a package selects its
package consumers. Shared support, configuration, manifests, lockfiles, workflow
and selector changes, policy changes, and unknown paths request full verification.
See the [CI guide](ci.md) for the full event policy and coverage admission.

Changing the selection machinery itself therefore runs full CI. Focused selector
regressions establish partial plans for later source changes. A full successful
run of the selector's own PR is not proof of a partial hosted execution.

## Run the golden selector

From the repository root, provide the base and head commits and both tracked
catalog inputs:

```sh
bun run scripts/ci/select-golden.ts \
  --base <base-commit> \
  --head <head-commit> \
  --catalog-path golden/catalog.json \
  --graph-path golden/dependency-graph.json
```

Add `--release-candidate` to require all catalog cases. The selector prints
JSON, including changed paths, affected behaviors, selected case IDs, suite
paths, and the reasons for each selection.

The current application harness also reads project files, scans directories,
and launches build workers. Its reviewed readers are pinned by SHA-256 of
LF-normalized source in both compared revisions. A new or changed reader, an
unknown reader, or a stale contract requires the full golden suite. This includes
readers discovered within fixture directories even without a static import.
The pins apply to reviewed input domains; they do not exempt arbitrary file access.

With these readers present, partial golden selection is limited to changes
entirely within the ten reviewed `golden/fixtures/<scenario>/` input domains.
Each domain selects its complete catalog suite, including sibling controls,
alongside existing source and configuration impacts. Product changes and other
inputs outside those domains keep full golden coverage even when the ordinary
selector chooses fewer test roots. The existing unknown-path guard still applies:
a newly added unmapped fixture asset can require the full suite. Configuration,
route, asset, and prior declaration inputs are not treated as output-only data.

The workflow uses `scripts/ci/plan-golden.ts` to turn that result into a
Windows/Linux and browser-project matrix. It records the case-to-suite map and
reasons in the job log. The planner also asks Playwright to list the active
tests and checks each catalog `title` and `suite` against that list. This is
an inventory check only. Playwright still runs the entire selected spec file;
the workflow does not filter test execution by title.

Pushes to `main`, version tags, manual runs, pull requests targeting `release/*`,
and same-repository release pull requests into `main` run every implemented case.
Other pull requests can select
affected cases. Known documentation-only changes can omit golden jobs through
the verification workflow's scope decision. See the [CI guide](ci.md) and
[workflow](../.github/workflows/ci.yml) for the current triggers and jobs.

The planner runs every discovered spec file when the catalog or selector
cannot be trusted, selection fails or is empty, a selected suite is missing,
or a changed `golden/` path has no catalog mapping. When a catalog is
syntactically valid but does not match the Playwright inventory, the full
suite runs first and the matrix then fails the catalog check. It never emits
an empty matrix as a successful result.

## Current implemented cases

The catalog lists 34 authored Playwright tests across ten spec files. Cases
sharing a spec file share its suite-level selection, so selecting one can run
its siblings too.

| Case ID                                    | Playwright test title                                                                              | Suite path                        | Behavior                                                                                                                                |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------- | --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `task-cancellation-late-result`            | a cancelled task stays cancelled after its backend completes late                                  | `tests/task-cancellation.spec.ts` | Cancelling an invocation remains final after its backend resolves later.                                                                |
| `native-update-retains-elements`           | reactive text updates keep the native button and uncontrolled input                                | `tests/native-identity.spec.ts`   | Reactive updates keep the browser's native button and uncontrolled input objects.                                                       |
| `native-identity-witness`                  | the native identity witness rejects a deliberately replaced node                                   | `tests/native-identity.spec.ts`   | The native-node identity check detects deliberate replacement.                                                                          |
| `native-event-handler-identity`            | plain native handlers receive the dispatched Event and element as this                             | `tests/native-events.spec.ts`     | Native handlers keep browser event and receiver identity.                                                                               |
| `native-event-options-once`                | helper imports and literal pairs keep shared once behavior native and per element                  | `tests/native-events.spec.ts`     | Helper-imported once options remain native and each element owns its listener state.                                                    |
| `native-event-capture-order`               | capture helpers preserve native capture and bubbling order                                         | `tests/native-events.spec.ts`     | Capture and bubble helpers retain browser dispatch order.                                                                               |
| `native-event-passive-cancellation`        | passive preventDefault is ignored while the default listener cancels                               | `tests/native-events.spec.ts`     | Passive cancellation follows native listener semantics.                                                                                 |
| `native-event-release-recreation`          | disposing releases old listeners and a recreated component gets fresh once state                   | `tests/native-events.spec.ts`     | Disposal releases listeners and a new component receives fresh once state.                                                              |
| `native-event-broken-shared-once-control`  | a callback-level shared once guard incorrectly suppresses the second element                       | `tests/native-events.spec.ts`     | A regression witness detects a callback-level once guard shared by two elements.                                                        |
| `blob-attribute-owner-release`             | public package mount loads Blob sources and releases replaced and destroyed URLs                   | `tests/blob-attributes.spec.ts`   | Public package mount and owner disposal release replaced and destroyed Blob URLs.                                                       |
| `blob-target-document-lease`               | a parent-document File uses the target document URL lease across replacement and release           | `tests/blob-attributes.spec.ts`   | A parent-document `File` uses the target document's URL lease across replacement and disposal.                                          |
| `blob-srcset-candidates`                   | native srcset loads one of its emitted Blob and author candidates                                  | `tests/blob-attributes.spec.ts`   | Native `srcset` loads an emitted Blob candidate or authored data URL.                                                                   |
| `embed-sandbox-isolation`                  | embed-sandbox-isolation: scripts run while a same-origin child cannot write the parent             | `tests/embed-security.spec.ts`    | A sandboxed child runs its script without writing to the parent document.                                                               |
| `embed-permission-replacement`             | embed-permission-replacement: the wrapper survives while the old frame is detached                 | `tests/embed-security.spec.ts`    | Permission changes replace the frame while preserving the wrapper.                                                                      |
| `embed-wrapper-binding-sizing`             | embed-wrapper-binding-sizing: authored numeric and CSS dimensions reach the native layout          | `tests/embed-security.spec.ts`    | Authored numeric and CSS dimensions reach the native embed layout.                                                                      |
| `embed-native-load-callback`               | embed-native-load-callback: native options are present and load targets the bound frame            | `tests/embed-security.spec.ts`    | Native frame options are present and load callbacks target the bound frame.                                                             |
| `embed-parent-disposal`                    | embed-parent-disposal: disposing the parent removes its owned iframe                               | `tests/embed-security.spec.ts`    | Disposing a parent removes its owned iframe.                                                                                            |
| `component-css-readiness`                  | compiled component CSS gates module preload and mount effects on their own Documents               | `tests/component-css.spec.ts`     | Compiled CSS gates preload and mount effects on each target `Document`, including the unwaited control.                                 |
| `component-css-shared-ownership`           | multiple component mounts share CSS until the last mount is disposed                               | `tests/component-css.spec.ts`     | Multiple mounts share CSS until the final owner is disposed.                                                                            |
| `optional-styling-development-output`      | development optional CSS integrations produce observable browser styles                            | `tests/optional-styling.spec.ts`  | The development build applies PostCSS, Tailwind, and reactive StyleX styles and serves its CSS asset.                                   |
| `optional-styling-production-output`       | production optional CSS integrations produce observable browser styles                             | `tests/optional-styling.spec.ts`  | The production build applies PostCSS, Tailwind, and reactive StyleX styles and serves its CSS asset.                                    |
| `checklist-crud-live-queries-cleanup`      | compiled checklist CRUD revalidates live queries and releases component effects                    | `tests/checklist.spec.ts`         | Manual Aeolia adaptation drives list/detail revalidation, keyed row identity, and component cleanup through create, update, and remove. |
| `checklist-cached-page-restoration`        | cached checklist pages restore controls and revalidate data changed on the detail route [fallback] | `tests/checklist.spec.ts`         | Explicit fallback navigation restores cached controls and native nodes while revalidating changed data.                                 |
| `checklist-cached-page-restoration-native` | cached checklist pages restore controls and revalidate data changed on the detail route [native]   | `tests/checklist.spec.ts`         | Native traversal restores cached controls and proves completed precommit admission when supported.                                      |
| `checklist-navigation-mode-controls`       | navigation mode acceptance rejects missing observation and incorrect selection                     | `tests/checklist.spec.ts`         | Missing observations, incorrect selection, and absent fallback traversals fail the mode witness.                                        |
| `checklist-seeded-model-keyed-rows`        | seeded bounded checklist actions match an independent model and retain keyed rows                  | `tests/checklist.spec.ts`         | A seeded action sequence is checked against an independent model while keyed rows are retained or detached correctly.                   |
| `checklist-latest-run-suppression`         | a cancelled latest-run task cannot publish its late response                                       | `tests/checklist.spec.ts`         | A superseded task cannot publish after the newer invocation completes, even when its transport responds late.                           |
| `lifecycle-effect-order-and-binding`       | compiled mount orders effects, publishes a native binding, and cleans up by owner                  | `tests/lifecycle.spec.ts`         | Compiled mount runs effects in owner order, keeps its native binding current through updates, and cleans up by owner.                   |
| `lifecycle-shared-stream-idle-expiry`      | two mounted owners share one stream until the configured idle expiry                               | `tests/lifecycle.spec.ts`         | Two owners share one stream; it stays open through the first removal, expires after the last owner leaves, and reopens on remount.      |
| `lifecycle-query-boundary-success`         | AsyncBoundary keeps its fallback until a pending query succeeds                                    | `tests/lifecycle.spec.ts`         | `AsyncBoundary` keeps its fallback while the query is pending, then renders the result and releases the query owner.                    |
| `lifecycle-query-error-cleanup`            | an initial query failure reaches mount onError and releases the waiting owner                      | `tests/lifecycle.spec.ts`         | An initial query error reaches mount `onError` and releases the waiting owner exactly once.                                             |
| `public-values-runtime-shape`              | compiled public values distinguish an omitted key from own undefined and null                      | `tests/public-values.spec.ts`     | Compiled output distinguishes an absent key from own `undefined` and `null` at runtime.                                                 |
| `public-values-emitted-asset-control`      | missing own undefined in an isolated emitted asset is caught by the same oracle                    | `tests/public-values.spec.ts`     | Removing the emitted own-`undefined` entry makes the public-shape oracle fail; the unmodified asset then passes.                        |
| `public-values-declarations`               | generated declarations preserve public value types and omit absent keys                            | `tests/public-values.spec.ts`     | The generated-declaration consumer checks public value types and confirms absent keys remain omitted.                                   |

The 34 cases map to 102 declared case/browser combinations per platform before
test-time skips. Each full-suite platform run has three matrix jobs, one per
browser project; each job runs the selected spec files. The ten specs contain
1 task-cancellation case, 2 native-identity cases, 6 native-event cases, 3
Blob-attribute cases, 5 embed-security cases, 2 component-CSS cases, 2 optional
styling cases, 6 checklist cases, 4 lifecycle cases, and 3 public-values cases.
The `title` is a catalog inventory key, not a promise of
per-test filtering.

The six checklist cases share `checklist-fixture`, which maps the
fixture configuration, shell, generated declarations, API module, page, and
spec. Separate behaviors map the Aeolia adapter, live list/detail mutation
effects, cached page restoration, keyed rows, component cleanup, seeded model,
and latest-run suppression to the cases that exercise them.

The manual-plan CSS runtime cases are not independent golden tests and are not
catalog entries. Add a case only after its Playwright test exists and
the catalog records its exact title, suite, and behavior paths.

## Catalog shape and behavior paths

The catalog uses version 1. Each behavior lists exact repository paths that
implement or demonstrate it. A behavior may depend on another behavior; a
change affecting the dependency selects cases attached to the dependent
behavior too.

```json
{
  "version": 1,
  "behaviors": [
    { "id": "task-lifecycle", "paths": ["packages/hesperia/src/data/task.ts"] },
    {
      "id": "task-cancellation-late-result",
      "paths": ["golden/fixtures/task-cancellation/TaskCancellation.tsx"],
      "dependsOn": ["task-lifecycle"]
    }
  ],
  "cases": [
    {
      "id": "task-cancellation-late-result",
      "title": "a cancelled task stays cancelled after its backend completes late",
      "suite": "tests/task-cancellation.spec.ts",
      "behaviors": ["task-cancellation-late-result"]
    }
  ]
}
```

The `title` adds a check that the catalog matches the authored Playwright
inventory. The selector uses only `id`, `suite`, and `behaviors`; title does
not alter selection. `suite` is relative to the golden package's Playwright
test directory, which is why these values start with `tests/`.

The `golden-harness` behavior maps the shared package verifier, server,
Playwright configuration, and package manifest to every case. Scenario
behaviors map relevant Hesperia runtime/compiler sources and the scenario
fixtures and specs. The [current catalog](../golden/catalog.json) is the
source of truth for these exact mappings. The supplemental graph
[`golden/dependency-graph.json`](../golden/dependency-graph.json) is empty at
this snapshot because the current behavior paths and tracked imports expose
the needed relationships. Add an edge there only for a known dependency that
imports and workspace package exports cannot represent, such as a generated
output relationship.

## Dependency graph and fallback

The shared [source-impact reader](../scripts/ci/source-impact.ts) builds dependency
edges from both revisions. It reads the base from Git and the head from the
checked-out workspace. Static imports,
re-exports, literal dynamic imports, `require()` calls, and workspace-package
imports resolved through each package manifest's `name` and `exports` create
edges. Common `./dist/*.js` and declaration exports resolve to matching
`src/*.ts` files. Relative imports using emitted `.js` or `.jsx` extensions
also resolve to TypeScript source.

One bounded dynamic form is supported for project configuration loading:

```ts
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export async function load(root: string) {
  const configFile = resolve(root, "hesperia.config.ts");
  return import(pathToFileURL(configFile).href);
}
```

The reader proves the imported Node bindings, the unique immutable target
binding, and the fixed basename. `join` is also supported. Imported aliases may
retain that proof, but shadowing, reassignment, member mutation, and unrecognized
expressions do not. The reader adds dependencies on every tracked
`hesperia.config.ts` candidate in each revision. Those configuration modules'
imports remain part of the graph. The bounded form is not permission to ignore
another unknown dynamic import in the same file.

An unresolved relative import, a known workspace package without one unique
tracked source mapping, an unsupported non-literal `import()` or `require()`, or a
manifest parse error marks part of the graph incomplete. The golden selector
requires the complete suite when an incomplete file lies on a catalog
behavior's dependency path or appears in known changed-path impact.
Supplemental edges add known relationships but do not clear an unresolved
source warning.

The ordinary selector can account for a recognized opaque consumer by selecting
its proven owning roots. Known staged application inputs retain their owner
domain. Syntax errors, ambiguous exports, and missing local modules in executable
sources retain full verification. Conservative ordinary ownership and golden
fallback are separate decisions.

For each changed path, the selector traces source consumers, maps affected
paths to behaviors, follows behavior dependencies, and records the reasons
that selected each case. Deleted paths and removed base relationships remain
part of the calculation because it compares both revisions.

The complete golden suite runs when impact is unknown or empty, the Git diff
has no changed paths, dependency data is unavailable or incomplete, a
workspace package manifest changes, the selector or its tests or guidance
change, the catalog changes, the workspace is dirty or differs from the
requested head, the run is a release candidate, or impact cannot be mapped to
a golden case. These fallbacks preserve verification when the mapping is
uncertain.
