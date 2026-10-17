# Package test fixtures

Reader: contributors editing the installed-package tests.

These files are authored inputs to the package tests. The tests copy them into
temporary applications, preserving the application's import paths, then run the
installed commands and browser checks. Edit the source files here instead of
embedding programs in strings inside a test.

`applications/` contains the asset, plugin, hosting, linked-package, styling,
Embed, isolated-tooling, and creator-overlay inputs. `installed-app/` contains
the original installed application. The neighboring `.mjs` files are child
process programs; their runtime paths and values arrive through command-line
arguments. Their TypeScript configuration checks the JavaScript using JSDoc.

## Editing

Build the framework packages and open `tests/fixtures.code-workspace` with the
Hesperia development extension. See the [installed application instructions](installed-app/README.md)
for the extension launch command. The workspace lists fixtures that can be
opened as Hesperia projects without running an installation or a mutating plugin.
The local TypeScript configurations describe the checked-in files; tests keep
using their original generated application and consumer configurations.

Some fixtures are overlays rather than complete applications:

- `creator/` adds routes and configuration to a real `create-hesperia` output.
  Its client and server imports are supplied by that generated application.
- `assets/` receives generated binary data and an existing test image during
  setup. Keep those setup steps in the owning test.
- `styling/` uses the optional PostCSS, Tailwind, and StyleX packages installed
  in its temporary application. Those dependencies are not installed at this
  fixture's root by the repository setup.
- `analyze-project/analysis.config.ts` becomes `hesperia.config.ts` only in the
  temporary application. Its plugin deliberately changes files to test captured
  compiler inputs. Do not rename this checked-in input to the discovered
  configuration name or run that plugin against the checked-in fixture.

These overlays remain ordinary editable source files. Use their owning package
test to check them with the complete generated or installed environment; do not
add placeholder modules or permissive types to hide missing setup.

## Formatting and verification

The application fixture formatter uses Oxfmt defaults, matching the generated
application's `hesperia check`. Preserve the raw `assets/src/panel.html` input:
adding HTML whitespace would add DOM text nodes. Preserve exact resource bytes
when the test checks their contents.

After changing a fixture, run its owning test. For example:

```sh
bun run build
bun test --timeout=60000 tests/package/assets-installed.test.ts
bun run typecheck
```

Keep generated package manifests, output from the compiler, deliberate invalid
programs, and source-position-sensitive inputs in their existing test setup.
This includes mixed consumer programs whose `@ts-expect-error` comments depend
on the next line. Formatting such a program can change which error it checks.
The `.mjs` typecheck is part of `bun run typecheck`.
