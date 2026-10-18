# Golden test selection

The selector maps changed source paths to behaviors and implemented golden
cases. The planner validates that catalog against Playwright's current test
list, then runs each selected spec file in Chromium, Firefox, and WebKit on
Windows and Linux. The selector does not replace build, type, lint,
formatting, package, browser, editor, or deterministic checks.

## Run the selector

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

The workflow uses `scripts/ci/plan-golden.ts` to turn that result into a
Windows/Linux and browser-project matrix. It records the case-to-suite map and
reasons in the job log. The planner also asks Playwright to list the active
tests and checks each catalog `title` and `suite` against that list. This is
an inventory check only. Playwright still runs the entire selected spec file;
the workflow does not filter test execution by title.

Pushes to `main`, version tags, manual runs, and same-repository release pull
requests into `main` run every implemented case. Other pull requests can select
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

The catalog lists 32 authored Playwright tests across ten spec files. Cases
sharing a spec file share its suite-level selection, so selecting one can run
its siblings too.

| Case ID                                   | Playwright test title                                                                     | Suite path                        | Behavior                                                                                                                                |
| ----------------------------------------- | ----------------------------------------------------------------------------------------- | --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `task-cancellation-late-result`           | a cancelled task stays cancelled after its backend completes late                         | `tests/task-cancellation.spec.ts` | Cancelling an invocation remains final after its backend resolves later.                                                                |
| `native-update-retains-elements`          | reactive text updates keep the native button and uncontrolled input                       | `tests/native-identity.spec.ts`   | Reactive updates keep the browser's native button and uncontrolled input objects.                                                       |
| `native-identity-witness`                 | the native identity witness rejects a deliberately replaced node                          | `tests/native-identity.spec.ts`   | The native-node identity check detects deliberate replacement.                                                                          |
| `native-event-handler-identity`           | plain native handlers receive the dispatched Event and element as this                    | `tests/native-events.spec.ts`     | Native handlers keep browser event and receiver identity.                                                                               |
| `native-event-options-once`               | helper imports and literal pairs keep shared once behavior native and per element         | `tests/native-events.spec.ts`     | Helper-imported once options remain native and each element owns its listener state.                                                    |
| `native-event-capture-order`              | capture helpers preserve native capture and bubbling order                                | `tests/native-events.spec.ts`     | Capture and bubble helpers retain browser dispatch order.                                                                               |
| `native-event-passive-cancellation`       | passive preventDefault is ignored while the default listener cancels                      | `tests/native-events.spec.ts`     | Passive cancellation follows native listener semantics.                                                                                 |
| `native-event-release-recreation`         | disposing releases old listeners and a recreated component gets fresh once state          | `tests/native-events.spec.ts`     | Disposal releases listeners and a new component receives fresh once state.                                                              |
| `native-event-broken-shared-once-control` | a callback-level shared once guard incorrectly suppresses the second element              | `tests/native-events.spec.ts`     | A regression witness detects a callback-level once guard shared by two elements.                                                        |
| `blob-attribute-owner-release`            | public package mount loads Blob sources and releases replaced and destroyed URLs          | `tests/blob-attributes.spec.ts`   | Public package mount and owner disposal release replaced and destroyed Blob URLs.                                                       |
| `blob-target-document-lease`              | a parent-document File uses the target document URL lease across replacement and release  | `tests/blob-attributes.spec.ts`   | A parent-document `File` uses the target document's URL lease across replacement and disposal.                                          |
| `blob-srcset-candidates`                  | native srcset loads one of its emitted Blob and author candidates                         | `tests/blob-attributes.spec.ts`   | Native `srcset` loads an emitted Blob candidate or authored data URL.                                                                   |
| `embed-sandbox-isolation`                 | embed-sandbox-isolation: scripts run while a same-origin child cannot write the parent    | `tests/embed-security.spec.ts`    | A sandboxed child runs its script without writing to the parent document.                                                               |
| `embed-permission-replacement`            | embed-permission-replacement: the wrapper survives while the old frame is detached        | `tests/embed-security.spec.ts`    | Permission changes replace the frame while preserving the wrapper.                                                                      |
| `embed-wrapper-binding-sizing`            | embed-wrapper-binding-sizing: authored numeric and CSS dimensions reach the native layout | `tests/embed-security.spec.ts`    | Authored numeric and CSS dimensions reach the native embed layout.                                                                      |
| `embed-native-load-callback`              | embed-native-load-callback: native options are present and load targets the bound frame   | `tests/embed-security.spec.ts`    | Native frame options are present and load callbacks target the bound frame.                                                             |
| `embed-parent-disposal`                   | embed-parent-disposal: disposing the parent removes its owned iframe                      | `tests/embed-security.spec.ts`    | Disposing a parent removes its owned iframe.                                                                                            |
| `component-css-readiness`                 | compiled component CSS gates module preload and mount effects on their own Documents      | `tests/component-css.spec.ts`     | Compiled CSS gates preload and mount effects on each target `Document`, including the unwaited control.                                 |
| `component-css-shared-ownership`          | multiple component mounts share CSS until the last mount is disposed                      | `tests/component-css.spec.ts`     | Multiple mounts share CSS until the final owner is disposed.                                                                            |
| `optional-styling-development-output`     | development optional CSS integrations produce observable browser styles                   | `tests/optional-styling.spec.ts`  | The development build applies PostCSS, Tailwind, and reactive StyleX styles and serves its CSS asset.                                   |
| `optional-styling-production-output`      | production optional CSS integrations produce observable browser styles                    | `tests/optional-styling.spec.ts`  | The production build applies PostCSS, Tailwind, and reactive StyleX styles and serves its CSS asset.                                    |
| `checklist-crud-live-queries-cleanup`     | compiled checklist CRUD revalidates live queries and releases component effects           | `tests/checklist.spec.ts`         | Manual Aeolia adaptation drives list/detail revalidation, keyed row identity, and component cleanup through create, update, and remove. |
| `checklist-cached-page-restoration`       | cached checklist pages restore controls and revalidate data changed on the detail route   | `tests/checklist.spec.ts`         | Back and forward restore cached controls and native nodes while revalidating changed data.                                              |
| `checklist-seeded-model-keyed-rows`       | seeded bounded checklist actions match an independent model and retain keyed rows         | `tests/checklist.spec.ts`         | A seeded action sequence is checked against an independent model while keyed rows are retained or detached correctly.                   |
| `checklist-latest-run-suppression`        | a cancelled latest-run task cannot publish its late response                              | `tests/checklist.spec.ts`         | A superseded task cannot publish after the newer invocation completes, even when its transport responds late.                           |
| `lifecycle-effect-order-and-binding`      | compiled mount orders effects, publishes a native binding, and cleans up by owner         | `tests/lifecycle.spec.ts`         | Compiled mount runs effects in owner order, keeps its native binding current through updates, and cleans up by owner.                   |
| `lifecycle-shared-stream-idle-expiry`     | two mounted owners share one stream until the configured idle expiry                      | `tests/lifecycle.spec.ts`         | Two owners share one stream; it stays open through the first removal, expires after the last owner leaves, and reopens on remount.      |
| `lifecycle-query-boundary-success`        | AsyncBoundary keeps its fallback until a pending query succeeds                           | `tests/lifecycle.spec.ts`         | `AsyncBoundary` keeps its fallback while the query is pending, then renders the result and releases the query owner.                    |
| `lifecycle-query-error-cleanup`           | an initial query failure reaches mount onError and releases the waiting owner             | `tests/lifecycle.spec.ts`         | An initial query error reaches mount `onError` and releases the waiting owner exactly once.                                             |
| `public-values-runtime-shape`             | compiled public values distinguish an omitted key from own undefined and null             | `tests/public-values.spec.ts`     | Compiled output distinguishes an absent key from own `undefined` and `null` at runtime.                                                 |
| `public-values-emitted-asset-control`     | missing own undefined in an isolated emitted asset is caught by the same oracle           | `tests/public-values.spec.ts`     | Removing the emitted own-`undefined` entry makes the public-shape oracle fail; the unmodified asset then passes.                        |
| `public-values-declarations`              | generated declarations preserve public value types and omit absent keys                   | `tests/public-values.spec.ts`     | The generated-declaration consumer checks public value types and confirms absent keys remain omitted.                                   |

The 32 cases map to 96 declared case/browser combinations per platform before
test-time skips. Each full-suite platform run has three matrix jobs, one per
browser project; each job runs the selected spec files. The ten specs contain
1 task-cancellation case, 2 native-identity cases, 6 native-event cases, 3
Blob-attribute cases, 5 embed-security cases, 2 component-CSS cases, 2 optional
styling cases, 4 checklist cases, 4 lifecycle cases, and 3 public-values cases.
The `title` is a catalog inventory key, not a promise of
per-test filtering.

The four checklist cases share `checklist-fixture`, which maps the
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

The selector builds source dependency edges from both revisions. It reads the
base from Git and the head from the checked-out workspace. Static imports,
re-exports, literal dynamic imports, `require()` calls, and workspace-package
imports resolved through each package manifest's `name` and `exports` create
edges. Common `./dist/*.js` and declaration exports resolve to matching
`src/*.ts` files. Relative imports using emitted `.js` or `.jsx` extensions
also resolve to TypeScript source.

An unresolved relative import, a known workspace package without one unique
tracked source mapping, a non-literal `import()` or `require()`, or a
manifest parse error marks part of the graph incomplete. The selector
requires the complete suite when an incomplete file lies on a catalog
behavior's dependency path or appears in known changed-path impact.
Supplemental edges add known relationships but do not clear an unresolved
source warning.

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
