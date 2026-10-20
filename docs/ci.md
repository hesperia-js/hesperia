# CI and npm releases

Reader: contributors and maintainers deciding which checks must pass before a
Hesperia change is accepted.

The [CI workflow](../.github/workflows/ci.yml) defines the accepted Windows and
Linux gates. Its golden jobs use the [implemented case catalog](../golden/catalog.json)
and [affected-case selector](ci-selection.md). The [test guide](../tests/README.md)
describes the individual suites and their evidence.

The `CI` workflow runs for pull requests targeting `main` or `release/*`, pushes
to `main`, version tags, and manual dispatch. It calls the reusable `Verify`
workflow with the same checkout for every job. Main pushes, version tags,
manual runs, pull requests targeting `release/*`, and same-repository `release/*`
pull requests into `main` run every gate. Other pull requests select affected suites.

PR checks run on opening, new commits, and reopening. Metadata edits and draft
status changes do not rerun CI. After changing the target branch, push a commit
or reopen the PR to check against the new base.

Each push to `main` has its own CI run. Later pushes do not cancel it. Release
uses that run's tested archives. See [npm release setup](#npm-release-setup).

For same-repository pull requests, CI accepts `feature/<name>`, `fix/<name>`,
and `release/<VERSION>` source branches. Release branches must name a supported
version matching the shared workspace version. Fork branch names are exempt;
a fork's `release/*` branch does not authorize a release.

## Required checks

The workflow separates framework tests from the independent golden suite.
Passing framework tests cannot override a failing golden expectation.

After the first successful run, require the **Required** check from `CI` in the
repository ruleset targeting `main` and `release/*`. Keep its bypass list empty.
The reusable workflow also has an always-running result job. Both aggregate
checks reject failed, cancelled, or unexpectedly skipped dependencies. A job
may be skipped only when a successful scope decision explicitly excludes it.

The check rejects incorrectly named branches at PR verification time. To also
restrict branch creation, create a separate branch ruleset targeting all branches,
exclude `main`, `feature/**/*`, `fix/**/*`, and `release/**/*`, and enable
**Restrict creations** without bypass actors. CI still validates release versions.
See [GitHub's ruleset guide](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/creating-rulesets-for-a-repository).

Build, typechecking, lint, and formatting always run. The following gates run
when selected; full verification selects every gate.

| Gate                                    | Platforms                            | Evidence                                                                                                                                                                                                         |
| --------------------------------------- | ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Source checks                           | Ubuntu 24.04                         | Builds, TypeScript, lint, formatting, and the shared package candidate.                                                                                                                                          |
| Coverage groups and platform aggregates | Windows Server 2025 and Ubuntu 24.04 | Four independent coverage owners per OS, followed by one aggregate per OS and the combined Windows/Linux gate.                                                                                                   |
| Selected deterministic tests            | Windows Server 2025 and Ubuntu 24.04 | Affected Bun test roots on partial runs. Full runs measure these tests in their coverage groups.                                                                                                                 |
| Browser suite                           | Windows Server 2025 and Ubuntu 24.04 | `tests/browser` in Chromium, Firefox, and WebKit.                                                                                                                                                                |
| Installed packages                      | Windows Server 2025 and Ubuntu 24.04 | Packed and linked consumer tests, including their three-engine browser checks.                                                                                                                                   |
| Golden suite                            | Windows Server 2025 and Ubuntu 24.04 | Every implemented golden spec on full runs, in Chromium, Firefox, and WebKit. Other pull requests may use affected-case selection.                                                                               |
| Editor host                             | Windows Server 2025 and Ubuntu 24.04 | The built extension runs inside current stable VS Code satisfying its existing engine and API baseline, with isolated user-data and extension directories; Linux retains its native process observer under Xvfb. |

The workflow pins Bun 1.4.2, Node.js 22.23.2, and action releases by full
commit SHA. Each job checks out Hesperia at the supplied revision and installs
the workspace with `bun install --frozen-lockfile`. Aeolia is the exact published
dependency `1.0.0-alpha.1`; CI does not need a sibling Aeolia checkout.

Windows CI runs the browser and golden suites with one Playwright worker per job
to reduce contention between browser processes. Linux CI and local runs use three
workers. Separate matrix jobs still run in parallel, with the same test selection,
assertions, timeouts, and retry policy.

The [verification selector](../scripts/ci/select-verification.ts) reads the compared
source revisions and selects ordinary test roots from their owners and consumers.
It retains dependencies from both revisions, so deleted files and removed imports
still reach their previous consumers. New production files retain a package or
subsystem owner even before another tracked module imports them.

The selector also accounts for opaque consumers, including dynamic loaders, file
readers, and subprocess harnesses. Their target may lack an import edge, so their
known owning test roots remain selected conservatively. Fixture directories seed
an owner but do not exclude consumers in another root. Unknown ownership or an
untrustworthy dependency graph requests full verification.

Missing history, failed selection, missing outputs, an empty comparison, or an
unknown path also requests full verification. CI, manifest, lockfile, configuration,
policy, and shared test-support changes retain that fallback. A selector or policy
change therefore runs full CI itself. Its successful CI run does not demonstrate
that a later source-only change receives a partial plan.

Known production changes keep the browser, package, editor, and golden gates
selected. Their ordinary test roots follow conservative ownership and dependency
selection instead of a single source flag selecting every root. Opaque consumers
can still require several or all ordinary roots. Distributed documentation selects
package consumers and can also select conservative file-reader owners. A partial
plan describes the selected gates, not a promise that few tests run. Partial runs
do not create or combine whole-project coverage receipts.

Golden selection has a narrower supported boundary. The current harness permits
partial plans only for inputs within reviewed golden fixture domains, with each
domain selecting its complete suite. Product changes retain full golden coverage.
Reviewed readers must match their LF-normalized source hashes in both revisions;
new, changed, unknown, or stale readers require full selection. The existing
unknown-path guard also keeps unmapped fixture additions conservative. See the
[selection guide](ci-selection.md) for the supported domains and limitations.

The standalone editor gate installs the candidate VSIX on Windows. The Linux native editor proof runs
inside full platform coverage; a partial run does not claim that proof.

The build job packs the ten workspace packages once and saves a versioned candidate
manifest with their archives. Both package jobs download that candidate and run
the installed behavior tests against those exact archives. Tests whose contract
requires deliberately changing an archive or building a fixture retain their
separate local preparation. Linked-package checks retain their module-identity
contract alongside the installed candidate checks.

When the editor gate is selected, the build job also prepares an `editor-candidate`
artifact. The Windows editor job installs that exact VSIX and the same run's npm
archives, then runs the existing nineteen behavior checks. It saves the installed
identity, archive hash, and package paths in `editor-package-evidence`. See
[releasing the VS Code extension](editor-release.md) for packaging, publisher
setup, approval, and publication of the accepted archive.

Each candidate archive contains its package's `README.md` and exact copies of the
root `LICENSE`, `COPYING`, and `LICENSE-COMMERCIAL.md`. Candidate preparation copies
these files into the staging directory before packing. Verification rejects an
absent, empty, or changed README and any missing or changed license notice.
The package suite also checks the guides shipped under each package's `docs/`.

Editor setup resolves current stable VS Code from Microsoft's official update
metadata. It requires that version to satisfy the extension's `engines.vscode`
range and meet its `@types/vscode` API baseline, currently `^1.137.0` and
`1.137.0`. The extension's supported APIs remain unchanged. Setup records the
resolved version, product commit, download URL, and SHA-256 in the job log and
checks the downloaded archive against that checksum. Microsoft's
[extension test tooling](https://github.com/microsoft/vscode-test/blob/main/lib/util.ts)
documents the update metadata fields and checksum validation.

On Windows, setup checks `resources/app/package.json`, the product commit, and
`Code.exe`'s `ProductVersion` against the resolved metadata without starting the
executable. The coverage step passes the verified path and actual version to
the native-editor coverage group; the standalone editor job runs
`scripts/ci/test-editor-package.ts`, which invokes `editors/vscode/test.ps1` in
installed-VSIX mode.
Both exercise a real editor process.

The Linux coverage step installs Python 3, Xvfb, and `strace` on the ephemeral
Ubuntu runner. It downloads Microsoft's resolved stable Linux x64 package,
checks the official metadata checksum, and checks the reported product commit,
version, architecture, and package-owned canonical launcher before the editor run. The
coverage command receives `DONT_PROMPT_WSL_INSTALL=1` to suppress the launcher's
WSL prompt. Ubuntu resolves the package's declared runtime dependencies from
its configured apt repositories; those system package versions are not pinned
by the Code package checksum. CI prints apt's installation output and the
installed versions of `code`, `python3`, `xvfb`, and `strace`; it does not record
a complete immutable manifest of every package in Code's runtime dependency
closure. The Code version check is only a launcher preflight. The final editor
capture exercises the GUI and extension host; separate native rejection
controls provide their own required evidence.

The standalone coverage checker retains its 90% line and function diagnostic.
The inventory includes
non-declaration `.ts` and `.tsx` files recursively under each `packages/*/src/`
and `editors/vscode/src/` tree, plus direct-child `.ts` and `.tsx` files in
`scripts/` and `scripts/ci/`. Tests, specs, fixtures, generated output,
dependencies, and temporary modules are excluded. The check fails if any
executable source has no coverage records or either floor is below 90%.
Sources with no executable statements are reported separately.

For a bounded local in-process report, run `bun run test:coverage` followed by
`bun run scripts/ci/check-coverage.ts`. Those commands do not include browser
or editor subprocesses. To capture all owners locally, use
`bun run test:coverage:final [Code launcher] [expected-version-prefix]`. Run it after the frozen workspace install, `bun run build`, and
the platform editor/browser setup above; the caller does not build the workspace.
CI passes the verified VS Code path and actual resolved version described above.
Without a version argument, local coverage validates the extension's engine
range. An explicit version or prefix requests an additional identity check.
See the [test guide's final coverage instructions](../tests/README.md#complete-cross-owner-coverage)
for direct Windows and Linux command examples.

The local final driver runs the ordinary Bun test roots with `tests/ci` included, the
compiled project-worker test as its own owner, the single Chromium CSS case, and
the native editor. A separate owner records the final driver's own support-code
hits. Each run keeps its original identity, report path, proof, and source maps.
The per-platform join requires matching complete source populations, authored
source hashes, and canonical maps. It records a versioned platform-capture
receipt only after all four owners and the native proof complete. This command
establishes capture completeness; it does not apply the combined acceptance
threshold. Branch records are reported when measured and do not contribute to
the combined line or function result. An absent branch record is unmeasured,
and is not evidence that the branch passed.

Full CI runs eight independent coverage jobs: `bun-tests-ordinary`,
`project-worker-owner`, `browser-css`, and `native-editor` on each OS. The
ordinary group keeps the complete ordinary test selection, including `tests/ci`
and `tests/package/check-installed.test.ts`. The worker group keeps its isolated
selection. Browser CSS installs Chromium; native editor installs the verified
editor and native observer tools. The ordinary group retains all three browser
engines. Each producer runs the existing owner through:

```sh
bun run scripts/ci/coverage-owner-launcher.ts scripts/ci/run-final-coverage.ts -- \
  --group <coverage-family> [Code launcher] [expected-version-prefix]
```

Each successful group writes `.hesperia/coverage/group-artifact/` with a manifest
and only its original run-directory files. The manifest records their SHA-256
hashes, the original checkout path, family, OS, run ID, and child summary. It
binds the capture to the immutable checkout SHA recorded by `checks`, plus
`GITHUB_RUN_ID` and `GITHUB_RUN_ATTEMPT`. All coverage jobs check out that exact
SHA, including a merge commit when the workflow verifies one; the binding does
not substitute the pull request's head SHA.

Both matrices use `fail-fast: false`. A failed group retains its child logs and
available original failure evidence. It never writes a completed group manifest.
After all producers finish, each OS aggregate downloads separate group bundles
and runs:

```sh
bun run scripts/ci/coverage-owner-launcher.ts scripts/ci/run-final-coverage.ts -- \
  --aggregate .coverage-groups
```

Each bundle also preserves the producer wrapper's own seed and hit records in
`coverage/final-runs/<familyRunId>/`. The wrapper first binds its distinct owner
to the actual family context and snapshots executed support code. The aggregate
validates the child summary and counts before admitting these separate wrapper
records; it does not change the child summary or relabel captured evidence.

The aggregate requires exactly four completed groups from its OS and execution.
Missing, failed, stale, duplicate, foreign, or changed evidence fails admission.
The aggregate preserves original evidence bytes and UUIDs, validates producer
path containment, and relocates coverage paths only in memory. Existing source,
transform, source-map, population, and canonical-map checks still apply. It
measures its own support code before creating the platform receipt. The
aggregate also runs after a producer failure to report invalid or missing inputs;
the verification result requires every producer and aggregate to succeed.
Artifact names and execution binding include the attempt: rerun the complete workflow when new
coverage evidence is needed. Rerunning only failed jobs cannot combine retained
successful groups from an earlier attempt.

After both platform aggregates succeed, CI downloads their separate artifacts
and runs:

```sh
bun run scripts/ci/run-combined-coverage.ts \
  --windows-root .coverage-artifacts/windows \
  --linux-root .coverage-artifacts/linux \
  --output .hesperia/coverage/combined
```

Each root is the downloaded artifact contents, with `coverage/` and `ec/`
directly inside. The command requires exactly one
versioned `coverage/final-runs/<runId>/platform-coverage-capture.json` receipt
from each root. It rejects incomplete receipts and source-population, source
hash, or location-map mismatches. It combines canonical counters by authored
location, counting each line or function once if either platform covered it.
Acceptance requires strictly more than 85% combined line coverage and at least
90% combined function coverage; branches remain informational.

On successful capture, the final run directory
`.hesperia/coverage/final-runs/<runId>/` contains the platform receipt and
`final-coverage-summary.json`, which lists each original family run ID and
output path. A failed test, family, native proof, or evidence validation exits
nonzero and leaves a failed summary listing completed families. Existing
per-platform summaries remain unchanged; older 90% floor failures are historical
results and do not count as new capture receipts. The combined output directory
contains `combined-coverage-summary.json`, `lcov.info`, `coverage-final.json`,
and `html/index.html` when both receipts are valid. CI retains the hidden
final and original run directories in separate
`hesperia-coverage-<platform>-<attempt>` artifacts, including after failure. It uploads only
`coverage/final-runs/`, `coverage/runs/`, `coverage/browser-css-runs/`, and `ec/`;
temporary owner-launch and build-control trees are excluded. Producer bundles
use separate `hesperia-coverage-group-<platform>-<family>-<attempt>` artifacts. Native
rejection controls under `coverage/editor-controls/` and package capture receipts
under `coverage/worker-builds/<runId>/captures/` remain in separate per-group
`hesperia-coverage-diagnostics-<platform>-<family>-<attempt>` artifacts. If group admission
fails, a separate failed-group artifact retains its original run and wrapper
summary. These diagnostic records never contribute hits to the positive capture.
The combined
job retains its report separately as `hesperia-coverage-combined-<attempt>`, including
when the numeric threshold fails. A threshold failure exits 1 after writing the
combined report; incomplete or mismatched evidence exits 2 without one. A
successful combined check exits 0. Use emitted and saved summaries to locate
records; do not reconstruct paths from a guessed run ID. A failed family does
not become an accepted platform capture.
The positive editor capture does not run the separate native process-rejection
controls; those controls remain separate editor-owner evidence. The standalone
Windows editor job also remains an independent gate.

These percentages apply to the TypeScript inventory. Authored JavaScript,
PowerShell, shell scripts, and native helper code require separate behavior
checks; their execution is not included in this percentage.

## Golden selection

Full runs request the full suite through the planner's existing
`--release-candidate` flag. That flag selects every implemented case; it does
not publish a release. Other pull requests may select affected cases from their
base and checked-out verification commits. The planner turns case IDs into
spec-file paths, then runs those files
on both operating systems and in all three browser projects. Selection is at
spec-file granularity: when a selected case shares a file with other tests,
those sibling tests also run. The catalog records logical Playwright tests;
the browser matrix does not filter by test title.

The 32 cataloged Playwright cases across ten spec files produce 96 declared
case/browser combinations on each platform before test-time skips. The matrix
groups those combinations into six jobs total: three per platform, one for each
browser project, each running the ten relevant spec files. The planner prints
the case-to-suite mapping and each selector reason in the job log.

A missing or malformed catalog, failed selector, empty selection, invalid
suite path, catalog-inventory mismatch, or unmapped changed file under
`golden/` plans every discovered golden spec. The matrix still runs those
specs; it then fails if the catalog names an unimplemented suite or leaves an
implemented Playwright test uncataloged. Every full verification run selects the
complete implemented suite. Known documentation-only changes can omit the golden
jobs. See [selection and catalog details](ci-selection.md).

## Golden expectation review

Golden tests record the expected behavior of real applications. The author
reviews the contract inventory, known gaps, and full results before declaring
the baseline frozen. After approval, an expectation change is a contract change and
requires author approval. CI reports whether tests pass; it does not provide
that approval. Review changes to the test, fixture, and expected output
together.

## npm release setup

The [release workflow](../.github/workflows/release.yml) runs after a
same-repository `release/<VERSION>` PR merges into `main`. All ten publishable
packages share the workspace version. The release PR requires an unpublished
version newer than its base. Before registry preflight or tagging, Release also
requires that version to exceed the merge commit's first-parent version.

Release polls every 30 seconds for up to 180 minutes for the exact merge
commit's main CI run. That run must be unique and successful. Its current
attempt must pass **Required** and **Verification result** and have one unexpired
`release-candidate` from a successful upload in that attempt. Release pins the
run, attempt, and artifact ID, then rechecks them before download and publication.
If a check fails or the wait expires, Release stops without rebuilding or
rerunning verification. Publication retries must pass the same checks.

The Release summary links the source CI run. Use it to inspect checks and
download artifacts.

For each release, update the root and public package versions, internal package
pins, and the versions emitted by the creator and tooling application templates.
Aeolia keeps its independently chosen exact dependency version.

The VS Code extension uses its own numeric pre-release version. Full release
verification prepares and tests its VSIX alongside the npm candidates, but npm
publication does not publish to the Marketplace. Complete the separate
[editor publication steps](editor-release.md#publish-after-approval) after
approval to make both distributions available to application authors.

Configure the GitHub `npm` environment before merging a release. For packages
that already exist on npm, configure or confirm all ten trusted publishers as
described below, then set `NPM_TRUSTED_PUBLISHING` to `true` before the release
workflow runs. Its first successful publication activates each new configuration.

If the packages have never been published, bootstrap them with manual
publication. Leave `NPM_TRUSTED_PUBLISHING` unset or `false` for that release.
Release preflights the tested candidate, creates `v<VERSION>`, and records
manual publication instructions. Use the same path when automatic publication
is disabled for an existing package release.

For manual publication after the merge, download the original
`release-candidate` from the main CI run linked in the Release summary. Use
that CI run ID for the download. Check out its merge commit and extract the
artifact into `.hesperia/release-candidate`. Verify the archives and registry
retry state:

```powershell
bun scripts/ci/verify-release-candidate.ts --candidate-dir .hesperia/release-candidate
$env:HESPERIA_RELEASE_CANDIDATE_DIR = '.hesperia/release-candidate'
bun scripts/ci/check-release.ts
```

Verify that `v<VERSION>` identifies that merge commit. Then authenticate your
local npm CLI with the maintainer account and publish the original archives:

```powershell
bun scripts/ci/publish-release-candidate.ts
```

This command runs the complete archive and registry preflight, then invokes
native `npm publish` in manifest dependency order. It skips an existing version
only when its registry integrity matches the original archive. Run publication
only after all verification commands succeed. Keep credentials in your local
npm client; the workflow does not need an npm token. Do not publish before the
release PR passes and merges: its unpublished-version check must still succeed.

For packages already published to npm, configure or confirm an npm trusted
publisher for each of the ten package names: `hesperia`, `@hesperia/compiler`,
`@hesperia/tooling`,
`@hesperia/language-server`, `@hesperia/hosting`, `create-hesperia`,
`@hesperia/elysia`, `@hesperia/postcss`, `@hesperia/tailwind`, and
`@hesperia/stylex`. Use organization `hesperia-js`, repository `hesperia`, workflow
filename `release.yml`, and environment `npm`. Enable direct publishing for this
publisher; the workflow uses `npm publish` rather than staged publishing. npm
describes these fields and the direct-publishing option in its
[trusted publishing guide](https://docs.npmjs.com/trusted-publishers/).
Configure publishers near the next release: a new configuration expires if it
does not complete its first successful publication within two days. An already
activated publisher remains available for later releases. See
[npm's activation window](https://docs.npmjs.com/trusted-publishers/#trusted-publisher-configuration-expiry).

Once all ten publishers are configured, set the repository variable
`NPM_TRUSTED_PUBLISHING` to `true` before the next release workflow runs to enable
automatic npm publication. npm requires each package to exist before its
trusted publisher can be configured. See
[npm's trusted publisher prerequisites](https://docs.npmjs.com/cli/v11/commands/npm-trust/#prerequisites).

Release creates `v<VERSION>` at the verified merge commit and publishes the
tested archives in workspace dependency order. Confirm that the Release
publication job succeeds. CI success alone does not prove publication. Stable
releases use the `latest` dist-tag. Prereleases use `alpha`, `beta`, or `rc`
according to their version. A retry may reuse an existing
version only when its archive integrity matches the tested candidate and its
release tag identifies the same commit. Changed archives, conflicting tags, and
dist-tag rollback fail before another package is published. Keep the original
candidate artifact available when recovering an interrupted publication.
GitHub retains it for 14 days from the source CI upload. Preserve the manifest
and archives before expiry if recovery may take longer. After expiry, automatic
recovery cannot retrieve the original artifact. A rebuild must reproduce every
archive byte and hash to replace the tested candidate or retry a partial publication.

## Primary references

- [GitHub Actions workflow permissions](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#permissions)
- [GitHub-hosted Windows runner image inventory](https://github.com/actions/runner-images/blob/main/images/windows/Windows2025-Readme.md)
- [Pinned `actions/checkout` release](https://github.com/actions/checkout/releases/tag/v6.0.2)
- [Pinned `actions/setup-node` release](https://github.com/actions/setup-node/releases/tag/v7.0.0)
- [Pinned `oven-sh/setup-bun` release](https://github.com/oven-sh/setup-bun/releases/tag/v2.2.0)
- [Visual Studio Code versioned Windows archive URLs](https://code.visualstudio.com/docs/supporting/faq#_previous-release-versions)
