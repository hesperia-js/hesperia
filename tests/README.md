# Hesperia tests

Reader: engineers implementing or reviewing the compiler and browser runtime.

Test what an application can observe, then use focused checks to locate failures.
The milestone ledger records which complete workflows still need verification.

| Directory  | Contract under test                                                                         |
| ---------- | ------------------------------------------------------------------------------------------- |
| `compiler` | Authored syntax, checked types, generated code, canonical meaning, and source maps          |
| `runtime`  | DOM identity, component lifetimes, effects, bindings, structural updates, and recovery      |
| `data`     | Task invocation, cancellation, query readiness, and component ownership                     |
| `tooling`  | Starter creation, checking before emission, browser builds, preview, and development reload |
| `routing`  | Filesystem route matching, guards, departure checks, query changes, and native links        |
| `editor`   | Shared checking snapshots and the built language server's source navigation protocol        |
| `browser`  | Compiled public applications in Chromium, Firefox, and WebKit                               |

Build the package before consumer checks. Run a focused suite while changing its
implementation, then run the integrated gate once dependent work is ready:

```sh
bun run build
bun test tests/runtime
bun run check
```

`bun run test` builds the package and runs the compiler, runtime, data, tooling, routing, and editor
suites. `bun run test:browser` runs Playwright through its local Node executable.
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

The `package` suite runs through `bun run test:package` and the full `check` gate.
It builds and packs Aeolia, packs the built Hesperia package, creates a temporary
application outside the repository, and installs the tarballs. The fixture uses
an explicit local override for the unpublished Aeolia peer. Other pinned
dependencies may need registry access on a machine without a package cache.
Installed commands must check, build, and preview the application. A Node process
then verifies the served application in all three browser engines, including a
deep route whose ordinary `api.ts` constructs a custom Aeolia query and mutation,
exports `withAeolia(graph, contract)`, and drives a real query revalidation through
the compiled package. This verifies the package boundary and one public custom
backend flow; it does not cover every milestone application feature.

The package suite also builds an application with linked Hesperia and Aeolia
packages. It checks that an adapted API and raw Aeolia readables update rendered
content after a mutation in all three engines. This catches duplicate module
instances caused by resolving one linked file under multiple path names.

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

Measure line and function coverage separately from browser acceptance:

```sh
bun run test:coverage
```

The minimum is 90% meaningful line and function coverage. Unmeasured branch
coverage is not evidence about branches. Tests must distinguish failures such as
absent data versus a committed `undefined`, stale work versus the current task,
and ordinary updates versus component recreation. Executing the same lines in a
different test is not a substitute for those distinctions.

Coverage excludes generated `dist` copies, temporary compiler output, test
fixtures and helpers, generated data-URL modules, and dependencies. The LCOV file is written to
`.hesperia/coverage/lcov.info`.
These are in-process source measurements; browser and editor subprocesses do
not contribute to them. A source file absent from the report is unmeasured,
not fully covered.
