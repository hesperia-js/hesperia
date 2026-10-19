# Release the VS Code extension

The extension has its own Marketplace version.
[`hesperia.hesperia-vscode` version `0.1.0`](https://marketplace.visualstudio.com/items?itemName=hesperia.hesperia-vscode)
is available as a pre-release. Hesperia's
npm packages use their shared `1.0.0-alpha.*` version. Marketplace requires a
numeric extension version rather than an `-alpha` suffix.

CI prepares a VSIX and tests that exact file after installing it in an isolated
Windows VS Code profile. It also installs the same run's npm candidate archives
into an isolated application. The native Windows and Linux editor coverage jobs
remain separate checks of the development extension.

Merging a feature PR does not publish either distribution. A `release/<VERSION>`
PR runs full verification and the [npm release process](ci.md#npm-release-setup).
That process publishes the npm candidates when trusted publishing is enabled,
or records manual publication instructions otherwise.
Marketplace publication remains a separate maintainer action after approval.
No repository workflow publishes the extension automatically.
The npm `1.0.0-alpha.2` release does not itself require another Marketplace
upload. A changed extension needs a new numeric version and an approved, tested
candidate before manual publication.

## Create the Marketplace publisher

The `hesperia` publisher already exists. These steps document its initial setup.
Use the existing publisher for future extension releases.

1. Sign in to [Manage publishers and extensions](https://marketplace.visualstudio.com/manage/publishers/)
   with the Microsoft account that will own the extension.
2. Choose **Create publisher**. Use `hesperia` as the identifier and `Hesperia`
   as the display name. The identifier is part of the public extension ID and
   cannot be changed later.
3. Complete the required account details and create the publisher. Confirm that
   the account can manage it. If `hesperia` is unavailable, choose the replacement
   identity before building the release, then update and retest the extension.
4. Use that publisher's management page for the first manual VSIX upload. This
   path does not require storing a publishing credential in the repository.

Publisher creation does not publish an extension. See Microsoft's
[publisher instructions](https://code.visualstudio.com/api/working-with-extensions/publishing-extension#create-a-publisher)
for current account requirements. A verified-domain badge is separate from
creating the publisher and is not required for this first release.

## Prepare and test a local candidate

From the repository root, with Bun and Node.js 22 or later installed:

```sh
bun install --frozen-lockfile
bun run test:editor:installed
```

This Windows command builds the npm packages, prepares their archives, packages
the extension, and runs its nineteen behavior checks against the installed VSIX.
It uses the existing 45-second editor deadline. VSIX installation has a separate
60-second limit. Both the editor profile and application dependencies are isolated
from the user's editor and the workspace's linked packages.

The output files are:

- `.hesperia/editor-candidate/hesperia-vscode-0.1.0.vsix`: installable extension.
- `.hesperia/editor-candidate/manifest.json`: identity, SHA-256, size, source
  commit, and whether the source checkout had uncommitted changes.
- `.hesperia/editor-package-evidence/editor-result.json`: behavior results,
  installed extension path, VSIX SHA-256, and resolved application package paths.
- `.hesperia/editor-package-evidence/candidate.json`: the exact editor and npm
  candidate manifests accepted together.

`bun run package:editor` prepares only the VSIX. It does not prove installation
or language-server behavior. A locally tested candidate with `sourceDirty: true`
is suitable for development installation, but the publication preflight rejects it.

To use a different VS Code installation, prepare the candidates with the command
above and run `scripts/ci/test-editor-package.ts --code-path <absolute-Code.exe-path>`
through Bun. The candidate and evidence directory options are
`--candidate-dir`, `--editor-candidate-dir`, and `--evidence-dir`.

## Select the release artifacts

Open the main **CI** run linked in the **Release** summary for the exact merged
release commit. Wait for all selected checks, including **Installed Windows
VS Code extension**, **Verification result**, and **Required**. Check the separate
Release publication job and confirm the matching npm packages are published
before Marketplace publication.

Download both artifacts from that CI run. Use its ID for `<run-id>`:

```sh
gh run download <run-id> --repo hesperia-js/hesperia --name editor-candidate --dir .hesperia/editor-candidate
gh run download <run-id> --repo hesperia-js/hesperia --name editor-package-evidence --dir .hesperia/editor-package-evidence
```

Use empty download directories so an earlier run's files cannot be mixed in.
Check out the artifact manifest's exact commit in a clean checkout, install the
frozen dependencies, and run:

```sh
bun scripts/ci/verify-editor-release.ts
```

The preflight checks the VSIX hash, clean candidate source, checkout identity,
and the installed acceptance receipt for the same npm and extension candidates.
It does not query GitHub's run status or grant publication approval; check the
run and obtain approval separately. Do not repackage the VSIX after acceptance.
The CI artifacts are retained for fourteen days.

## Publish after approval

Publish the matching npm release first so newly created applications can install
the language server used in acceptance. Every npm archive includes its package's
README, distributed guides, and the root license files. The candidate verifier
checks those README and license bytes before the archives reach publication.

For a future extension release, update its numeric version before preparing and
testing the candidate. Do not upload another `0.1.0` over the published release.
After the maintainer approves the exact candidate for the new version:

1. Open the `hesperia` publisher in
   [Manage publishers and extensions](https://marketplace.visualstudio.com/manage/publishers/).
2. Update the existing `hesperia-vscode` extension with the verified VSIX for
   the new numeric version.
3. Confirm the identity, numeric version, and pre-release status, then publish.
4. Wait for Marketplace processing to finish and check the public listing.

For an already authenticated maintainer CLI, the equivalent command consumes
the same file without rebuilding. Replace `<version>` with the approved new
numeric version:

```sh
node node_modules/@vscode/vsce/vsce publish --packagePath ".hesperia/editor-candidate/hesperia-vscode-<version>.vsix" --pre-release
```

Do not pass a version-bump argument to `vsce publish`; it can modify the manifest
and create a commit and tag. For CLI authentication, follow the current
[Microsoft publishing guide](https://code.visualstudio.com/api/working-with-extensions/publishing-extension).
Microsoft recommends Entra ID authentication for automated publishing and states
that global Azure DevOps PATs retire on December 1, 2026. The first manual upload
does not depend on setting up that automation.

## Verify the public installation

After publication, use a fresh application and editor profile to exercise the
registry and Marketplace paths:

Run these commands in PowerShell. The two editor directories are new temporary
paths. Both installation and launch use the same paths:

```powershell
$editorTrialRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("hesperia-marketplace-trial-" + [guid]::NewGuid().ToString('N'))
$editorTrialUserData = Join-Path $editorTrialRoot 'user-data'
$editorTrialExtensions = Join-Path $editorTrialRoot 'extensions'

bunx create-hesperia@alpha my-hesperia-trial --host none
cd my-hesperia-trial
bun run check
bun run build
code --user-data-dir $editorTrialUserData --extensions-dir $editorTrialExtensions --install-extension hesperia.hesperia-vscode --pre-release
code --user-data-dir $editorTrialUserData --extensions-dir $editorTrialExtensions .
```

For reproducible comparisons, replace `@alpha` with the exact npm release version.
Open `src/routes/+page.tsx` in a trusted application workspace. Confirm the
**Hesperia TSX** language mode, native tag hover, completion, and diagnostics.
Make an unsaved type error, then repair it and confirm that the diagnostics clear.
Run `bun run dev` for the application's browser behavior.

The pre-publication installed-VSIX gate does not prove Marketplace delivery.
Record this final registry and Marketplace smoke check after the release becomes
available. See the [extension README](../editors/vscode/README.md) for startup
requirements, multiple application folders, and feature limitations.
