# Installed application fixture

This folder contains the application source copied into the package-install
integration test. Its `tsconfig.json` and the neighboring workspace file are
for opening the checked-in source in VS Code; the test copies only the authored
application programs and `palette.dat`, so the creator's generated application
configuration remains in use in the temporary installed app.

The local `.oxfmtrc.json` uses Oxfmt's defaults, matching the generated app's
formatting check. Keep this configuration separate from repository formatting.

From the repository root, build Hesperia and the development extension, then
open `tests/package/fixtures/installed-app.code-workspace` with that extension:

```powershell
bun run build
bun run --cwd editors/vscode build
code --new-window --extensionDevelopmentPath="$PWD/editors/vscode" tests/package/fixtures/installed-app.code-workspace
```

Open `src/routes/deep/link/+page.tsx` and verify that VS Code recognizes it as
Hesperia TSX and reports no errors for this route. Use Go to Definition on
`client.state` and confirm the target is the client declaration; use it on
`api.greeting` to reach `api.ts`. Request completion after `on:dr` in the button
attribute and confirm `dragstart` is offered. The language server generates the
ignored `hesperia.d.ts` route declaration in this workspace, which uses the
repository's built packages.

Run the installed-package test from the repository root to check these sources
and `consumer.ts` against packed packages in a separate temporary application:

```sh
bun test --timeout=120000 tests/package/installed.test.ts
```

The neighboring `installed-browser.mjs` runs the browser assertions under Node.
Its own TypeScript configuration checks the JavaScript through JSDoc types;
`bun run typecheck` includes that check.
