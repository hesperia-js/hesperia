# Hesperia tests

Reader: engineers implementing or reviewing the compiler and browser runtime.

Test what an application can observe, then use focused checks to locate failures.
The [CI guide](../docs/ci.md) describes required verification, coverage, and rules
for the independent golden suite and selecting affected cases from changed paths.
The [golden browser cases](../golden/README.md)
now cover 32 authored Playwright cases across ten spec files. They run outside
framework tests in Chromium, Firefox, and WebKit. The selector and planner map
changed paths to affected specs and fall back to all discovered specs when
impact is uncertain. Release candidates run the complete suite.

| Directory  | Contract under test                                                                          |
| ---------- | -------------------------------------------------------------------------------------------- |
| `compiler` | Authored syntax, checked types, generated code, canonical meaning, and source maps           |
| `runtime`  | DOM identity, component lifetimes, effects, bindings, structural updates, and recovery       |
| `data`     | Task invocation, cancellation, query readiness, and component ownership                      |
| `tooling`  | Starter creation, checking before emission, browser builds, preview, and development reload  |
| `routing`  | Filesystem route matching, guards, departure checks, query changes, and native links         |
| `editor`   | Shared checking snapshots and the built language server's source navigation protocol         |
| `hosting`  | Captured browser builds, mount canonicalization, and standalone asset/document requests      |
| `browser`  | Compiled public applications in Chromium, Firefox, and WebKit                                |
| `ci`       | Golden selection and coverage receipts, workflow result and branch gates, and release policy |

Build the package before consumer checks. Run a focused suite while changing its
implementation, then run the integrated gate once dependent work is ready:

```sh
bun run build
bun test tests/runtime
bun run check
```

`bun run check` is the local integrated functional gate. Run the coverage
producer and checker below separately. Full acceptance also requires Windows/Linux
evidence and author review of the final Golden baseline
described in [the CI guide](../docs/ci.md).

`bun run test` builds the packages and runs the compiler, runtime, data, tooling,
routing, editor, hosting, and CI-selection suites. `bun run test:browser` runs
Playwright through its local Node executable.
The browser fixture server compiles TSX and bundles the resulting application;
the browser tests exercise the bundle, including retained native objects and
synchronous DOM updates. The first counter fixture alone does not establish the
full milestone.

The VS Code extension has a separate real editor gate, `bun run test:editor`,
also included in `bun run check`. Install its pinned dependencies once with
`bun install --cwd editors/vscode`. The command builds and typechecks the extension,
then runs the installed Windows VS Code in isolated user-data and extension
directories. See [the extension guide](../editors/vscode/README.md) for the exact
checks and an alternate VS Code executable path. This gate must not be replaced
by a mocked `vscode` module.

The Linux editor observer has Python standard-library controls for trace parsing
and editor log retention. CI runs them before the final Linux coverage aggregate.
They do not replace native editor coverage.

```sh
python3 -B editors/vscode/tests/test_linux_observer.py -v
```

The `package` suite runs through `bun run test:package` and the full `check` gate.
It installs the exact published `aeolia@1.0.0-alpha.1` dependency and Hesperia
package archives into a temporary application outside the repository. Local
runs pack the built workspace packages. CI supplies
`HESPERIA_RELEASE_CANDIDATE_DIR` so the installed fixtures use the same candidate
archives on Windows and Linux. Tests that deliberately modify an archive or
build a fixture retain their own preparation. Pinned registry dependencies may
need network access on a machine without a package cache.
The package checks also verify public export targets, rejected legacy paths,
compiler declarations, and the files used by the external TypeScript compiler.
Installed commands must check, build, and preview the application. A Node process
then verifies the served application in all three browser engines, including a
deep route whose ordinary `api.ts` constructs a custom Aeolia query and mutation,
exports `withAeolia(graph, contract)`, and drives a real query revalidation through
the compiled package. This verifies the package boundary and one public custom
backend flow; it does not cover every milestone application feature.

The package suite also builds an application with linked runtime, compiler,
tooling, and Aeolia packages. The fixture explicitly links the application's
Aeolia import to the same workspace-installed Aeolia instance that the linked
runtime uses. It checks that an adapted API and raw Aeolia readables update
rendered content after a mutation in all three engines. The linked client-state
control retains its DOM node while updating. These checks catch duplicate
module instances caused by resolving one linked file under multiple path names;
they do not prove that separately installed Aeolia copies deduplicate.

### Authored application fixtures

Complete static test programs live in ordinary files under
`tests/package/fixtures`, `tests/tooling/fixtures/applications`,
`tests/compiler/fixtures/applications`, and `tests/editor/fixtures/applications`.
The tests read or copy those files into
the original temporary destinations. Keep compiler-generated output, deliberately
invalid inputs, and exact-position diagnostic cases in their existing setup.

Use `tests/fixtures.code-workspace` with the Hesperia extension to edit the
application fixtures. Build the packages first so imports resolve to their
emitted declarations. The [package fixture guide](package/fixtures/README.md)
explains overlays that require the test's generated application or optional
dependencies. The standalone browser drivers under `tooling/fixtures/drivers`
have a strict JavaScript typecheck included in `bun run typecheck`.

The workspace also opens `create-hesperia` and its frontend template. Edit starter
files under `packages/create-hesperia/templates/frontend` or `templates/elysia`.
The Elysia files replace or extend the frontend starter. The creator's own
`tsconfig.json` checks that overlay against built workspace packages and is not
copied into generated applications.

The public-routing fixture has an editor `tsconfig.json`; its owning test copies
only the named application inputs, preserving their original write order. Its
browser driver reads generated URLs and coverage settings from a JSON file so
large coverage records do not enter the Windows command line.

The low-level `route-build` and `route-dynamic-imports` fixtures preserve the
guard signatures and runtime globals used by their bundle tests. Those signatures
do not represent a fully checked application. Their owning tests remain the
verification boundary; do not change the inputs solely to remove editor errors.

The compiler's class and runtime-semantic fixtures isolate JavaScript behavior
such as class reassignment, setter returns, and parameter shadowing. Keep those
operations intact. Narrow lint exceptions document the behavior being tested;
the owning compiler tests check the emitted code and its results.

Install the matching browser binaries when preparing a new development machine:

```sh
node node_modules/@playwright/test/cli.js install chromium firefox webkit
```

The browser suite uses at most three workers to bound simultaneous browser
processes. Every configured engine still runs the complete browser test set.

Use completion signals from the operation being tested. For example, await
`settled()` for effects, a task's invocation handle for its result, or the server's
reload event after a source edit. Use controlled time for expiry policies. Avoid
sleeping for a guessed duration or assuming a fixed number of microtasks.

The local `test:coverage` and checker pair measures the in-process suites. It is
bounded evidence, not the complete browser-and-editor milestone gate:

```sh
bun run test:coverage
bun run scripts/ci/check-coverage.ts
```

The first command creates the in-process coverage report. The second enforces
the complete executable-source inventory and both coverage floors. It fails
if any executable source is absent from the report, even when the measured
subset reaches 90%. The inventory includes package sources, the VS Code
extension sources, and the direct-child TypeScript files in `scripts/` and
`scripts/ci/`; see [the CI guide](../docs/ci.md) for the exact scope.

The local checker retains its 90% line and function diagnostic. CI acceptance
uses the combined Windows and Linux captures: line coverage must be strictly
above 85%, and function coverage must be at least 90%. Unmeasured branch
coverage is not evidence about branches. Tests must distinguish failures such as
absent data versus a committed `undefined`, stale work versus the current task,
and ordinary updates versus component recreation. Executing the same lines in a
different test is not a substitute for those distinctions.

Coverage excludes generated `dist` copies, temporary compiler output, test
fixtures and helpers, generated data-URL modules, and dependencies. The LCOV file is written to
`.hesperia/coverage/lcov.info`.
The `test:coverage` report measures the in-process suites above; browser and
editor subprocesses do not contribute to it. A source file absent from that
report is unmeasured, not fully covered.

### Complete cross-owner coverage

The platform capture caller is `bun run test:coverage:final [Code launcher]
[expected-version-prefix]`. Both arguments are optional; CI passes the verified
editor path and actual resolved stable version. Without the second argument,
local coverage requires the extension's existing `engines.vscode` compatibility
range. An explicit version or prefix adds a strict identity check. It invokes the measured owner launcher
and final coverage driver. Run it after `bun install --frozen-lockfile` and
`bun run build`; the caller does not rebuild the workspace. A successful exit
means all four coverage owners and native evidence completed and passed capture
validation. It does not decide the combined coverage threshold. Local full
capture requires all three Playwright engines. Full CI runs each owner as an
independent job on each OS, then admits all four groups in that OS aggregate;
see [coverage groups and artifact admission](../docs/ci.md) for the commands and
workflow execution binding.

On Windows, supply a compatible VS Code `Code.exe` path. CI resolves current
stable above the extension's engine and API baseline and checks Microsoft's
archive checksum, application manifest, product commit, and executable metadata.
On Linux, supply the package-owned compatible VS Code launcher; the CI runner
checks Microsoft's metadata checksum and product commit, installs Python 3,
Xvfb, and `strace`, and sets `DONT_PROMPT_WSL_INSTALL=1`. The Code version check
validates the launcher but does not open the GUI, run extension-host assertions,
or measure coverage; the final command performs the editor capture. CI prints
apt installation output and the installed versions of `code`, `python3`, `xvfb`,
and `strace`, but it does not capture a complete immutable manifest of every
Code runtime dependency. Those apt-resolved package versions are not pinned to
a snapshot.

For example, use the exact launcher path prepared by the platform setup:

Windows PowerShell:

```powershell
bun run test:coverage:final "$env:VSCODE_CODE_PATH"
```

Linux bash:

```sh
DONT_PROMPT_WSL_INSTALL=1 bun run test:coverage:final "$VSCODE_CODE_PATH"
```

The final driver runs ordinary Bun coverage with the CI test suite included,
the compiled project-worker owner separately, the Chromium CSS
capture ([scenario contract](../scripts/ci/browser-css-coverage-contract.ts)),
and the real editor owner. A separate owner records the final driver's support
hits. Each run keeps its original run ID, output path, native or worker proof,
and canonical maps. The join admits runs only when their source paths, authored
file hashes, full population, and canonical maps match. It adds their hits to
one inventory within each platform capture, counting each authored line or
function once even when several owners contribute hits. CI then combines the two
platform captures by authored location: a line or function counts once if either
platform covered it. The combined result must exceed 85% for lines and reach
90% for functions. Branches are informational.

On successful capture, `.hesperia/coverage/final-runs/<runId>/` contains the
platform `lcov.info`, versioned `platform-coverage-capture.json` receipt, and
`final-coverage-summary.json`, which lists the original family run IDs and
output paths. Capture failures exit nonzero and leave a failed summary listing
the families completed before failure. CI retains bounded producer bundles and
final and original run directories in separate per-platform artifacts, including
after failure. It excludes temporary build-control and launcher directories.
The group manifest verifies every original file by SHA-256 and binds all
four groups to the same checkout SHA, Actions run ID, and attempt. Admission
preserves the original bytes, source maps, transform hashes, and UUIDs while
mapping coverage paths to the aggregate checkout in memory. A failed or missing
group cannot create an accepted platform receipt.
The combined job downloads those artifacts separately; each downloaded root
contains `coverage/` and `ec/`. It runs:

```sh
bun run scripts/ci/run-combined-coverage.ts \
  --windows-root .coverage-artifacts/windows \
  --linux-root .coverage-artifacts/linux \
  --output .hesperia/coverage/combined
```

The command requires one valid capture receipt in each root and rejects
incomplete or mismatched source populations, authored hashes, and location
maps. It writes `combined-coverage-summary.json`, `lcov.info`,
`coverage-final.json`, and `html/index.html` before returning exit 1 when the
numeric threshold fails. Exit 0 means the combined threshold passed; exit 2
means evidence was missing, incomplete, or inconsistent and no combined report
was written. CI retains the combined output in a separate
`hesperia-coverage-combined` artifact even after a threshold failure. Existing
per-platform reports and historical 90% floor results stay separate and are
not reinterpreted as combined acceptance. Use emitted and saved summaries to
locate records instead of guessing a run ID. The final editor family completes its positive artifact
capture and 27 common artifact rejection controls. Linux also runs one positive
raw-only creator replay and five Linux-specific rejection controls, for 32
rejection controls on Linux; Windows adds six Windows-only artifact checks,
for 33 total. The family then runs
two real native process-rejection controls: one for the extension host and one
for the language server. Each native control launches a VS Code session, adding
two sessions per platform's final editor capture. Their subcapture directories
are separate, and their child coverage stays outside the positive family. This
does not replace the dedicated Windows `vscode` job. Full milestone acceptance also requires
successful complete per-platform results, matched source populations and the
combined coverage gate, and author review of the Golden baseline.

The ordinary Linux capture creates a private helper under the real Extension
Host. The observer retains that helper before allowing it to fork, then holds
the child's admission until the helper group has exited and the child's actual
parent has changed. The full baseline retains both genuine process events; the
raw-only creator replay removes exactly the helper event. The fixture completes
before normal deactivation and is absent from both native kill-control sessions.

The separate capture tools each gather evidence from a specific owner:

- `bun run scripts/ci/run-coverage.ts <test-path>...` captures the selected Bun
  tests. When running the dedicated compiled-worker test, it also validates
  that worker's captures.
- `bun run scripts/ci/coverage-owner-launcher.ts scripts/ci/run-browser-css-coverage.ts`
  captures the fixture server
  alongside the eleven selected Chromium page scenarios described below.
- `bun run scripts/ci/run-editor-coverage.ts [Code.exe] [expected-version-prefix]`
  captures the real VS Code extension host and language server.

Selecting `tests/tooling/create-hesperia.test.ts` also captures its eight existing
creator-command invocations. Each child contributes the command source, both
template modules and the capture helper. This is separate from the four installed
tooling-command invocations, whose fragments contain the tooling command and its
helper. The runner checks both groups against the same run's source maps and
population before saving its own counters. Existing failure cases retain their
natural nonzero exits, and the installation test retains its supplied preload.

Run both owners together through the measured launcher:

```sh
bun run scripts/ci/coverage-owner-launcher.ts scripts/ci/run-coverage.ts -- tests/tooling/create-hesperia.test.ts tests/package/check-installed.test.ts
```

These captures do not individually establish the complete milestone coverage
gate. Preserve each run's identity and combine evidence only when it refers to
the same source files and content hashes, with mappings validated against that
source inventory. Recording package execution in a process does not prove that
its parent verification script was captured. Initial
uninstrumented setup and operations after a capture's last snapshot remain
unobserved.

### Browser CSS coverage capture

Use this separate capture to verify that coverage includes the compiler running
in the fixture server and the runtime executing in the browser:

```sh
bun run scripts/ci/coverage-owner-launcher.ts scripts/ci/run-browser-css-coverage.ts
```

The capture selects eleven Chromium page scenarios: successful and failed
direct mounts, successful and failed Document mounting, three async cases
covering composition, bindings, and recovery, three route-host lifecycle cases,
and imported markup. The [scenario
and owner contract](../scripts/ci/browser-css-coverage-contract.ts) defines their
selection. A fixture-server owner is captured alongside the pages. The runner
requires receipts and coverage artifacts for all twelve owners, plus
positive hits for each owner's required authored sources.

Each run keeps its records, coverage artifacts, and merged `lcov.info` under
`.hesperia/coverage/browser-css-runs/<runId>/`. The command prints that directory
and the LCOV path. Files with no recorded hits remain in the measured source
population.

This capture runs separately from the ordinary coverage and browser commands.
Its selected scenarios verify this capture path only; complete browser, editor,
application-startup, and CI coverage have separate evidence requirements for
milestone acceptance. The full browser suite and standalone VS Code job remain
independent CI gates, not inputs to the combined coverage report.
