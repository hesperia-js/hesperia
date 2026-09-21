# Hesperia for VS Code

Reader: engineers working on Hesperia applications or its editor integration.

This development extension connects VS Code to the application's installed
`hesperia language-server`. It provides diagnostics, hover types, completions,
and definitions through the same authored-source checking view as
`hesperia check`. Bun must be available on the editor process's PATH.

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
Hesperia package. It recognizes TSX under that folder's `src/` and the root
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

Build Hesperia before the extension. From the Hesperia package root:

```sh
bun run build
bun install --cwd editors/vscode
bun run --cwd editors/vscode typecheck
bun run --cwd editors/vscode build
```

For interactive development, launch VS Code with this directory as its
`--extensionDevelopmentPath` and open a Hesperia application. This extension has
not been published to the marketplace or installed into the user's editor profile.

The Windows acceptance command uses the installed VS Code application with an
isolated workspace, user-data directory, and extensions directory:

```sh
bun run test:editor
```

It checks language recognition, exact source diagnostics, absence of duplicate
stock JSX diagnostics, hover, completion, definition navigation, and unsaved
edits. Successful runs remove their temporary workspace; failures retain logs
and `editor-result.json` for inspection. If VS Code is installed elsewhere, build
the test host and run `test.ps1 -CodePath <absolute-Code.exe-path>` directly.

Source edits rebuild an immutable TypeScript checking snapshot. Rename,
refactoring, semantic highlighting, and workspace-wide symbol search are not
advertised by this initial extension. The milestone ledger tracks the remaining
compiler and language-profile work.
