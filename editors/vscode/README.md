# Hesperia for VS Code

Hesperia provides diagnostics, hover types, completions, definitions, and an
Outline for Hesperia applications. The extension uses your application's
`@hesperia/language-server`, which shares the authored-source checking view of
`hesperia check`.

Install `hesperia.hesperia-vscode` version `0.1.0` from the
[Marketplace pre-release channel](https://marketplace.visualstudio.com/items?itemName=hesperia.hesperia-vscode).
For local framework development, use a locally packaged VSIX.

## Install and open an application

You need VS Code 1.137.0 or later, Bun on the editor process's `PATH`, and a
Hesperia application with its dependencies installed. The extension does not
bundle Bun, the compiler, or the language server.

1. Create an application with the [getting-started guide](https://github.com/hesperia-js/hesperia/blob/main/docs/getting-started.md),
   or install dependencies in an existing application with `bun install`.
   The Hesperia starter includes `@hesperia/language-server`.
2. If your application does not include the server, install the version that
   matches your other Hesperia packages. For an application using `1.0.0-alpha.2`:

   ```sh
   bun add --dev @hesperia/language-server@1.0.0-alpha.2
   ```

   Use the same version for the runtime, tooling, and language server. To try
   framework changes newer than the published npm release, follow the
   [local framework checkout instructions](https://github.com/hesperia-js/hesperia/blob/main/docs/getting-started.md#use-a-local-framework-checkout).

3. Install the Marketplace pre-release:

   ```sh
   code --install-extension hesperia.hesperia-vscode --pre-release
   ```

   To install a local candidate, open the **Views and More Actions** menu in
   VS Code's Extensions view and choose **Install from VSIX...**. Select the
   packaged `.vsix` file. You can also run:

   ```sh
   code --install-extension /path/to/hesperia-vscode-0.1.0.vsix
   ```

4. Open the application root, which contains its `package.json`, as a workspace
   folder. For a repository with nested applications, add each application root
   as its own workspace folder. Trust the workspace when you trust its code.
5. Open `src/routes/+page.tsx`, another TSX file under `src/`, or the root `app.tsx` shell.
   The language mode changes to **Hesperia TSX**. Hover a native tag such as
   `<button>` to see its DOM type, or inspect diagnostics in **Problems**.

If you install the language server after opening the folder, run
**Developer: Reload Window**. The extension resolves the server when it attaches
to the folder. It skips folders that cannot resolve
`@hesperia/language-server/bin`.

## Supported editor features

When the standalone TypeScript service cannot prepare auto-import suggestions,
Hesperia still completes names already in scope: locals, parameters, existing
imports, and global values and types. This fallback uses TypeScript's scope
resolution and excludes generated checking helpers. It does not add new imports
or provide keyword and snippet suggestions; ordinary member and event completion
continue through their existing paths.

Definition navigation follows local functions, imports, component tags (including
closing tags), and declared component props. Native property attributes lead to
their DOM declarations; native event attributes such as `on:click` lead to the
corresponding DOM handler declaration. Custom attributes without a declaration
have no definition target.

In a native element's opening tag, typing `on:` opens event-name suggestions;
Ctrl+Space also requests them. The list comes from the DOM event types for the
element's namespace and filters as you type, including in unfinished JSX.
Accepting `dragstart` after `on:dr` produces `on:dragstart`. Names use browser
spellings such as `mouseenter`, and handlers keep their existing event types.
Custom events can still be written explicitly.

Native opening and closing tag names show the type of the created DOM object on
hover, such as `HTMLInputElement` or `SVGCircleElement`, and navigate to that
type's DOM declaration. These are the same types used when checking a variable
that holds the element; hovering a tag does not expose generated checking code.

The Outline lists authored functions, variables, classes, types, and their nested
members. It reads the current document text, including unsaved changes, without
exposing generated compiler helpers. Incomplete syntax may temporarily produce
a partial or empty Outline.

An invalid `hesperia.config.json` produces an `HES-CONFIG` diagnostic on that
file. Editor checking and navigation continue with the last valid configuration,
or defaults if none has been read successfully. Save a repaired configuration to
clear the error and apply its settings. Builds and command-line checking still
reject invalid configuration. Use `{}` for an empty configuration object; a
zero-byte file is invalid JSON.

The extension starts only in trusted workspace folders that resolve an installed
`@hesperia/language-server` package. It recognizes TSX under that folder's `src/` and the root
`app.tsx` shell as Hesperia TSX, without writing file associations or changing
global TypeScript settings. Ordinary TypeScript files retain their existing
editor support; TypeScript and MTS files anywhere in the workspace are watched
and their unsaved changes are sent to Hesperia when they belong to the checked
project, including imports from TSX. Dependency and generated trees under
`node_modules/` and `.hesperia/` are excluded. Other TSX files outside `src/` and the root
`app.tsx` are not claimed by this extension.

Hesperia-specific diagnostics also appear in ordinary TypeScript files, including
route declarations and helpers used by route guards. TypeScript's own diagnostics
for those files remain with the built-in TypeScript extension, avoiding duplicate
reports. Route collisions and guard errors update when files move or unsaved
source changes.

## Troubleshoot startup

If TSX stays in **TypeScript React** mode, check that you opened the application
root and installed its dependencies. Confirm that the workspace is trusted,
then run **Developer: Reload Window**.

If the Hesperia server fails to start, open **View: Toggle Output** and select
**Hesperia**. Check that Bun is available to VS Code. After changing `PATH`,
restart VS Code so its extension host receives the new environment.

Use `bun run check` in the application to compare editor diagnostics with the
command-line result. Include the extension version, language-server version,
Bun version, VS Code version, and a minimal source example in
[bug reports](https://github.com/hesperia-js/hesperia/issues).

## Develop and package the extension

Build Hesperia before the extension. From the repository root:

```sh
bun run build
bun install --cwd editors/vscode
bun run --cwd editors/vscode typecheck
bun run --cwd editors/vscode build
```

Create a prerelease VSIX from the repository root:

```sh
bun run package:editor
```

The command writes `.hesperia/editor-candidate/hesperia-vscode-0.1.0.vsix` and
its `manifest.json` receipt. To choose another output directory, pass
`--candidate-dir <directory>`. Packaging builds the client and includes its
runtime dependencies. It does not publish the extension.

For interactive development, launch VS Code with `editors/vscode` as its
`--extensionDevelopmentPath` and open a Hesperia application.

Verify the packaged extension through a real installed VSIX on Windows:

```sh
bun run test:editor:installed
```

This command builds npm package candidates and a prerelease VSIX, installs them
into isolated directories, and runs VS Code against those artifacts. Its result
and candidate hashes are saved under `.hesperia/editor-package-evidence/`.
The extension loads from the isolated extensions directory, and its language
server resolves from the application's installed candidate packages.

For source development, use the separate native editor gate:

```sh
bun run test:editor
```

This gate loads the built extension through `--extensionDevelopmentPath` and
uses workspace packages. Both commands isolate their workspace, user-data, and
extensions directories. The installed-VSIX gate verifies distribution; native
coverage instrumentation uses the development path.

Both gates check language recognition, source diagnostics, absence of duplicate stock
JSX diagnostics, hover, completion, definition navigation, and unsaved edits.
Successful runs remove their temporary workspace. Failures retain logs and
`editor-result.json`. To select another VS Code executable for installed-artifact
verification, reuse prepared candidates with
`bun scripts/ci/test-editor-package.ts --code-path <absolute-Code.exe-path>`.
For the development gate, build the test host and run
`editors/vscode/test.ps1 -CodePath <absolute-Code.exe-path>` directly.

The test workspace disables TypeScript's automatic type acquisition, whose npm
downloads can keep logs locked after the editor exits on Windows. The built-in
TypeScript extension remains enabled and uses installed types.

See the [editor release guide](https://github.com/hesperia-js/hesperia/blob/main/docs/editor-release.md)
for packaging, installed-VSIX verification, and the separate Marketplace approval
and publishing steps.

## Current limits

Source edits rebuild an immutable TypeScript checking snapshot. Rename,
refactoring, semantic highlighting, and workspace-wide symbol search are not
advertised by this initial extension.

The extension launches a local Bun process. It does not run as a browser-only
extension in vscode.dev. Remote extension-host environments are not covered by
the installed-editor acceptance check.
