# CI and npm releases

Reader: contributors and maintainers deciding which checks must pass before a
Hesperia change is accepted.

The [CI workflow](../.github/workflows/ci.yml) defines the accepted Windows and
Linux gates. Its golden jobs use the [implemented case catalog](../golden/catalog.json)
and [affected-case selector](ci-selection.md). The [test guide](../tests/README.md)
describes the individual suites and their evidence.

The `CI` workflow runs for pull requests targeting `main` or `release/*`, pushes
to `main`, version tags, and manual dispatch. It calls the reusable `Verify`
workflow with one checkout revision for every job. Main pushes, version tags,
manual runs, and same-repository `release/*` pull requests into `main` request
full verification. Other pull requests select affected suites. The release
workflow repeats full verification at the exact merged release commit.

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

`dorny/paths-filter` uses local Git with no API token to select ordinary suites.
Missing history, failed detection, missing outputs, an empty comparison, or an
unknown path requests full verification. CI, manifest, lockfile, configuration,
and shared test-support changes also request full verification. Known production
source changes run every ordinary test root and the browser, package, and editor
gates. A known test-only change can select its owning root. Known documentation
changes can skip runtime gates; distributed documentation still selects package
consumers. Partial runs do not create or combine whole-project coverage receipts.
The standalone editor gate runs on Windows. The Linux native editor proof runs
inside full platform coverage; a partial run does not claim that proof.

The build job packs the ten workspace packages once and saves a versioned candidate
manifest with their archives. Both package jobs download that candidate and run
the installed behavior tests against those exact archives. Tests whose contract
requires deliberately changing an archive or building a fixture retain their
separate local preparation. Linked-package checks retain their module-identity
contract alongside the installed candidate checks.

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
the native-editor coverage group; the standalone editor job runs `editors/vscode/test.ps1`.
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

The [release workflow](../.github/workflows/release.yml) runs only after a
same-repository `release/<VERSION>` pull request merges into `main`. All ten
publishable packages share the authored workspace version. The release PR checks
that this version advances beyond its base and is not already published. The
merged commit receives full verification before the publication job starts.
Before registry preflight or tag creation, the publication job also requires the
authored version to advance beyond the merge commit's first-parent version.

For each release, update the root and public package versions, internal package
pins, and the versions emitted by the creator and tooling application templates.
Aeolia keeps its independently chosen exact dependency version.

Configure the GitHub `npm` environment before merging the first release. Leave
the repository variable `NPM_TRUSTED_PUBLISHING` unset or `false` for that release.
The workflow still verifies the exact merge commit, preflights the candidate,
and creates `v<VERSION>`. Its job summary links the candidate artifact and states
that manual npm publication is required. The approved first version remains
`1.0.0-alpha.1`.

After the merge, download the original `release-candidate` artifact from that
successful workflow run. Check out its merge commit and extract the artifact
into `.hesperia/release-candidate`. Verify the archives and registry retry state:

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

After manual publication, configure an npm trusted publisher for each of
the ten package names: `hesperia`, `@hesperia/compiler`, `@hesperia/tooling`,
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
`NPM_TRUSTED_PUBLISHING` to `true` to enable automatic npm
publication for later releases. npm requires each package to exist before its
trusted publisher can be configured. See
[npm's trusted publisher prerequisites](https://docs.npmjs.com/cli/v11/commands/npm-trust/#prerequisites).

Publication consumes the same candidate archives tested on Windows and Linux.
It creates `v<VERSION>` at the verified merge commit and publishes in workspace
dependency order. Stable releases use the `latest` dist-tag; prereleases use
`alpha`, `beta`, or `rc` according to their version. A retry may reuse an existing
version only when its archive integrity matches the tested candidate and its
release tag identifies the same commit. Changed archives, conflicting tags, and
dist-tag rollback fail before another package is published. Keep the original
candidate artifact available when recovering an interrupted publication.
GitHub retains that original artifact for 14 days. Download and preserve the
manifest and every archive before expiry if recovery may take longer. After
expiry, automatic recovery cannot retrieve the original artifact. A rebuild
is usable only if it reproduces every original archive byte and hash; otherwise
it cannot replace the tested candidate or retry a partially published version.

## Primary references

- [GitHub Actions workflow permissions](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#permissions)
- [GitHub-hosted Windows runner image inventory](https://github.com/actions/runner-images/blob/main/images/windows/Windows2025-Readme.md)
- [Pinned `actions/checkout` release](https://github.com/actions/checkout/releases/tag/v6.0.2)
- [Pinned `actions/setup-node` release](https://github.com/actions/setup-node/releases/tag/v7.0.0)
- [Pinned `oven-sh/setup-bun` release](https://github.com/oven-sh/setup-bun/releases/tag/v2.2.0)
- [Visual Studio Code versioned Windows archive URLs](https://code.visualstudio.com/docs/supporting/faq#_previous-release-versions)
