# Getting started with Hesperia

Reader: a TypeScript application author who knows JSX and wants to build their first Hesperia application.

Create a local application, configure its tools and startup, then add the document shell, routes, and page-specific head content. This guide uses the frontend-only starter to build a small task-workspace skeleton.

## Create an application

Run the creator from the `alpha` release channel with Bun:

```sh
bunx create-hesperia@alpha hesperia-todos --host none
cd hesperia-todos
bun run dev
```

The creator installs matching Hesperia packages and their dependencies. Open the
URL printed by the development server, then continue with
[application scripts](#application-scripts) below.

The creator defaults to an Elysia host. Without `--host`, an interactive terminal prompts for the host; Enter selects Elysia and option 2 selects no host. This guide uses `--host none` for a frontend-only application. See [the Elysia guide](../packages/elysia/docs/elysia.md) for the default starter's server and typed client.

### Use a local framework checkout

To test unpublished framework changes, create an application from locally built Hesperia packages.
The installed application checks use package archives and dependency overrides.
Aeolia comes from the exact published `1.0.0-alpha.1` dependency.

Run the following in PowerShell. Set `$framework` to the Hesperia checkout and
choose a new or empty application directory. The setup uses Bun 1.4.2 and
TypeScript 7.0.2. `--no-install` leaves dependency installation until the local
archives are configured.

```powershell
$framework = 'C:/work/hesperia'
$application = 'C:/work/hesperia-todos'
$packages = Join-Path $env:TEMP ("hesperia-packages-" + [guid]::NewGuid())

New-Item -ItemType Directory -Force -Path $packages | Out-Null

bun install --cwd $framework
bun run --cwd $framework build

function Pack-Local($directory) {
  $before = @(Get-ChildItem -LiteralPath $packages -Filter '*.tgz' | ForEach-Object FullName)
  Push-Location $directory
  try {
    bun pm pack --destination $packages --ignore-scripts | Out-Host
    if ($LASTEXITCODE -ne 0) { throw "Packing failed: $directory" }
  } finally { Pop-Location }
  $created = @(Get-ChildItem -LiteralPath $packages -Filter '*.tgz' |
    Where-Object { $_.FullName -notin $before })
  if ($created.Count -ne 1) { throw "Expected one tarball from $directory" }
  return $created[0].FullName.Replace('\', '/')
}

$runtime = Pack-Local "$framework/packages/hesperia"
$compiler = Pack-Local "$framework/packages/compiler"
$hosting = Pack-Local "$framework/packages/hosting"
$tooling = Pack-Local "$framework/packages/tooling"
$languageServer = Pack-Local "$framework/packages/language-server"
bun "$framework/packages/create-hesperia/dist/cli.js" $application --host none --no-install
```

Stop if a command fails. Before installing the generated application, replace its placeholder dependencies with the packed local versions:

```powershell
$manifestPath = "$application/package.json"
$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
$manifest.dependencies.hesperia = $runtime
$manifest.dependencies.aeolia = '1.0.0-alpha.1'
$manifest.devDependencies.'@hesperia/tooling' = $tooling
$manifest.devDependencies.'@hesperia/language-server' = $languageServer
$manifest | Add-Member -MemberType NoteProperty -Name overrides -Force -Value @{
  aeolia = '1.0.0-alpha.1'
  hesperia = $runtime
  '@hesperia/compiler' = $compiler
  '@hesperia/hosting' = $hosting
  '@hesperia/tooling' = $tooling
  '@hesperia/language-server' = $languageServer
}
$manifest | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $manifestPath

Set-Location $application
bun install
bun run dev
```

The overrides supply the local runtime, compiler, hosting, tooling, and
language-server packages throughout the dependency graph, with one exact
published Aeolia version. The frontend starter does not need the Elysia adapter,
Elysia, or Eden. Tooling still depends on `@hesperia/hosting` for development and
production serving. Other pinned dependencies are installed normally.

Packing copies the built artifacts into the application installation; later framework edits require rebuilding, repacking, and refreshing the application's installed packages. These commands use the current local workflow; they do not establish published-package installation.

Open the URL printed by the server and edit the generated files using the examples below. CSS-only revisions update styles in place when the executable output is unchanged. Changes to executable output request a full document reload through the application's departure checks. A failed rebuild keeps the last successful revision visible.

## Application scripts

The frontend-only starter writes these scripts in the application's `package.json`:

```json
{
  "scripts": {
    "dev": "hesperia dev",
    "check": "hesperia check",
    "build": "hesperia build",
    "preview": "hesperia preview"
  }
}
```

This is the scripts section, not a replacement for the whole manifest.

| Command                   | Purpose                                                                                |
| ------------------------- | -------------------------------------------------------------------------------------- |
| `bun run dev`             | Check, build, and serve the application; watch changes and reload. Default port: 5173. |
| `bun run check`           | Run the Hesperia compiler, Oxlint, and Oxfmt; refresh generated route declarations.    |
| `bun run check --fix`     | Write formatting and safe lint fixes, then check again.                                |
| `bun run build`           | Produce browser assets under `.hesperia/build`.                                        |
| `bun run preview`         | Serve the existing production build. Run `build` first. Default port: 4173.            |
| `bun run dev --port 3000` | Use a chosen port. `preview` accepts the same option; `0` selects a free port.         |

The installed `hesperia init` command serves an existing production build from the application root. It accepts no arguments and does not create an application. `preview` is an alias for that production server with an optional `--port` argument. The default Elysia starter has its own preview/start scripts for the generated server.

`check` does not rewrite authored files. `check --fix` may change authored files and supported configuration files; it applies safe fixes, not lint suggestions or dangerous fixes. Compiler errors and remaining lint or format errors still fail the command. See [project checks and fixes](../packages/tooling/docs/project-configuration.md#project-checks-and-fixes) for its file scope.

Keep `.hesperia/`, `node_modules/`, and `hesperia.d.ts` out of version control. The starter supplies these ignore entries.

## Files at a glance

Paths below are relative to your application root.

```text
app.tsx                         HTML, head, body, and the route outlet
app.config.ts                   Optional application startup settings
hesperia.config.json            Optional data-only compiler/build settings
hesperia.config.ts              TypeScript alternative with plugins (use one config file)
hesperia.d.ts                   Generated route types; do not edit
src/
  routes/
    +page.tsx                   /
    +layout.tsx                 Shared wrapper for all routes
    +loading.tsx                Default loading view
    +error.tsx                  Default rendering error view
    +not-found.tsx              Default unmatched-URL view
    todos/
      +page.tsx                 /todos
      +layout.tsx               Wrapper for /todos and its descendants
      +route.ts                 Navigation guard for this branch
      [id]/
        +page.tsx               /todos/123
```

The six `+` filenames shown here are the recognized route files. Component files default-export a component; `+route.ts` default-exports a `route(...)` declaration. Ordinary helper files do not become routes. A folder needs a `+page.tsx` to supply its own page, but it can supply a layout or boundary for descendants without having a page itself.

## The HTML shell: `app.tsx`

Put this file at the application root, alongside `package.json`, rather than under `src/routes`.

```tsx
// app.tsx
import type { Component, Rendered } from "hesperia";

export default function App(props: Component.Props<{ children: Rendered }>) {
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="description" content="My Hesperia application" />
        <title>My app</title>
      </head>
      <body>
        <header>
          <nav>
            <a href="/">Home</a>
            <a href="/todos">Todos</a>
          </nav>
        </header>
        {props.children()}
      </body>
    </html>
  );
}
```

`props.children()` is the route outlet: the place where Hesperia inserts the active layout/page tree. It is a reactive accessor, so call it in the returned JSX. Omitting it leaves your routes without a visible outlet.

The shell supplies one `<html>` element with `<head>` and `<body>`. Put default titles, metadata, and other document-wide head content here. Page and layout components supply content inside the shell; they do not return another document. Generated startup installs the shell and starts routing, so you do not add a manual `mount(...)` call or import every page into `app.tsx`.

## Pages: `+page.tsx`

```tsx
// src/routes/+page.tsx
export default function Home() {
  return (
    <main>
      <h1>Home</h1>
      <div>Your application starts here.</div>
    </main>
  );
}
```

Use ordinary anchors for navigation. The generated router handles normal same-origin link clicks, while modified clicks, downloads, and links targeting another window retain browser behavior.

The current compiler rejects some native HTML compositions whose parsing rules are not yet modeled, such as table row insertion. Paragraphs are supported when their authored static tree matches the browser parser, including phrasing children such as `<strong>`, `<br />`, and `<img />`; direct block nesting such as `<p><div>…</div></p>` remains a `HES-HTML-CONTEXT` error. Consult the [native element guide](native-elements.md) when a valid browser tree is outside this compiler profile.

## Page titles and metadata

For a fixed application title, change `<title>` in `app.tsx`. For a page-specific title, the current browser implementation supports setting `document.title` in an effect. The same approach can update an existing metadata element from the shell.

```tsx
// src/routes/todos/+page.tsx
import * as client from "hesperia/client";

export default function Todos() {
  client.effect(() => {
    const previousTitle = document.title;
    const description = document.querySelector('meta[name="description"]');
    const previousDescription = description?.getAttribute("content");

    document.title = "Todos | My app";
    description?.setAttribute("content", "Manage your tasks");

    return () => {
      document.title = previousTitle;
      if (description) {
        if (previousDescription === null) description.removeAttribute("content");
        else if (previousDescription !== undefined)
          description.setAttribute("content", previousDescription);
      }
    };
  });

  return (
    <main>
      <h1>Todos</h1>
      <input aria-label="New task" />
      <a href="/todos/123?tab=notes">Open task 123</a>
    </main>
  );
}
```

The effect runs after the page is installed. Its returned cleanup restores the preceding title and description when the page is parked in the history cache or removed. When a cached page returns, its effects run again and reapply its metadata. A page without its own title effect uses the restored shell title.

For a title derived from reactive data, read that data inside the effect so subsequent changes update the title. Give a head field one active owner; independently changing the same title or metadata element from both a layout and a page needs coordination that this example does not provide.

There is currently no recognized `+head.tsx`, `<Head>` component, or filesystem-page `metadata` export. This example uses browser DOM operations, not a dedicated Hesperia head-management API. It updates the live browser document and does not provide server-rendered metadata. The lower-level router's `PreparedRoute.title` option is not an export consumed from `+page.tsx`.

## Shared content: `+layout.tsx`

```tsx
// src/routes/todos/+layout.tsx
import type { Component, Rendered } from "hesperia";

export default function TodosLayout(props: Component.Props<{ children: Rendered }>) {
  return (
    <section aria-label="Todo workspace">
      <div>Task workspace</div>
      {props.children()}
    </section>
  );
}
```

A layout wraps its directory's page and descendant routes. Layouts nest from the route root inward. For `/todos/123`, the tree is `app.tsx` → root layout, if present → todos layout → task page. Shared layouts remain mounted when navigating within their branch. Use `props.children()` here too.

The current generated router supplies layouts with children; it supplies route parameters and the query accessor to pages. Do not assume a layout receives `Page.Props` inputs.

## Folder names and page inputs

| Folder        | Example URL              | Page input                               |
| ------------- | ------------------------ | ---------------------------------------- |
| `todos`       | `/todos`                 | Static segment                           |
| `[id]`        | `/todos/123`             | `params.id: string`                      |
| `[[id]]`      | `/todos` or `/todos/123` | `params.id?: string`                     |
| `[...path]`   | `/files/a/b`             | `params.path: readonly string[]`         |
| `[[...path]]` | `/files` or `/files/a/b` | `params.path?: readonly string[]`        |
| `(account)`   | Adds no URL segment      | Groups routes and shared layouts         |
| `_components` | Adds no routes           | Excludes the folder from route discovery |

```tsx
// src/routes/todos/[id]/+page.tsx
import type { Page } from "hesperia";

export default function Todo(props: Page.Props<{ queryParams: { tab?: string } }>) {
  return (
    <main>
      <h1>Task {props.params.id}</h1>
      <div>Tab: {props.queryParams().get("tab") ?? "details"}</div>
    </main>
  );
}
```

The checker derives `id` from the filename; unknown route parameter names fail checking. Query declarations name the keys you intend to read, with string values and optional keys allowed. They do not validate or convert the URL: `.get("tab")` returns a string or `null`. Changing only the query keeps the page instance and updates its accessor; changing route parameters creates a new page lifetime. See [page inputs](page-props.md) for the full typing rules.

Groups still need unambiguous URLs: `(one)/+page.tsx` and `(two)/+page.tsx` both claiming `/` cause a route collision.

## Loading: `+loading.tsx`

```tsx
// src/routes/+loading.tsx
export default function Loading() {
  return <div role="status">Loading page…</div>;
}
```

The nearest loading file along the destination route's ancestry supplies its loading view. After navigation checks allow the move, Hesperia presents the loading region while preserving applicable shared layouts. A nested `+loading.tsx` overrides the root view for that branch.

An applicable loading file also supplies the async boundary for a filesystem page that awaits data. Keep the loading component synchronous. Loading views receive no page route parameters or query accessor.

Without an applicable loading file, Hesperia still installs an async boundary and leaves the route area empty while the page module or its async descendants settle. Development emits a warning recommending a root loading skeleton. The general rule still applies to async components outside filesystem pages: they need an enclosing async boundary. Start with a root `src/routes/+loading.tsx` when the application needs a visible transition.

## Rendering errors: `+error.tsx`

```tsx
// src/routes/+error.tsx
import type { Component } from "hesperia";

export default function RouteError(props: Component.Props<{ error: unknown }>) {
  return (
    <main>
      <h1>Something went wrong</h1>
      <div>{String(props.error())}</div>
      <a href="/">Go home</a>
    </main>
  );
}
```

Rendering faults reach the nearest applicable error boundary. If that fallback itself fails, the fault continues outward. The error view receives an error accessor, `props.error()`; there is no supplied retry/reset callback. Recovery remains author-controlled. For a real application, choose a suitable public error message instead of displaying arbitrary error details.

## Unmatched URLs: `+not-found.tsx`

```tsx
// src/routes/+not-found.tsx
export default function NotFound() {
  return (
    <main>
      <h1>Page not found</h1>
      <a href="/">Go home</a>
    </main>
  );
}
```

When no page matches a URL, Hesperia looks for an applicable not-found file, including nested ones for matching branches. A root file provides the application-wide fallback. Without one, an unmatched route raises a fault. This is browser presentation; it does not configure an HTTP 404 response from a server.

## Navigation rules: `+route.ts`

```ts
// src/routes/old-todos/+route.ts
import { redirect, route } from "hesperia/routing";

const guard = () => redirect("/todos");

export default route({ guard });
```

Place this beside `src/routes/old-todos/+page.tsx` to redirect that page before its content is prepared. A guard can return `true` to allow navigation, `false` to veto it, or `redirect(...)`; async results are also accepted. Parent branch guards apply to descendants. The guard must be a referenced binding, as above.

```tsx
// src/routes/old-todos/+page.tsx
export default function OldTodos() {
  return null;
}
```

The declaration also recognizes `load` and `headers`, but Hesperia does not execute `load` as a browser loader or apply `headers` as HTTP response headers. A client guard cannot secure a backend; the backend must enforce its own access rules.

To prevent leaving a component with unsaved work, import `beforeLeave` from `hesperia/navigation` and register it inside that component. See [navigation behavior](routing.md) for its callback and ordering rules.

## Application settings: `app.config.ts`

```ts
// app.config.ts
import type { AppConfiguration } from "hesperia";

export default { pageCacheSize: 5 } satisfies AppConfiguration;
```

This optional root module default-exports the startup configuration object. Currently `pageCacheSize` is its only supported setting; unknown settings fail startup.

| Setting         | Default | Accepted values and behavior                                                                                                                                             |
| --------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `pageCacheSize` | `5`     | A nonnegative safe integer. Counts inactive pages; the visible page is additional. `0` disables inactive-page caching. When full, the earliest cached page is destroyed. |

Cached pages keep their component instance and DOM. Their reactive updates pause and their effects clean up while inactive. Restoration resumes reactivity and runs effects again. See [the page cache guide](routing-cache.md) for tasks and history-entry ownership.

Import your adapted data API directly from an ordinary module, such as `src/api.ts`; it is not an `app.config.ts` property. The current manual adapter is `withAeolia(graph, contract)` from `hesperia/aeolia`. See [the data guide](data.md) when connecting a backend. For Elysia HTTP routes and Eden's typed client, see [the Elysia guide](../packages/elysia/docs/elysia.md).

## Compiler/build settings

Use `hesperia.config.json` or `hesperia.config.ts` at the application root. The JSON form is data only, so omit comments and trailing commas. The TypeScript form also registers plugins. Having both files is an error. See [project configuration and plugins](../packages/tooling/docs/project-configuration.md) for typed configuration, custom imports, and fixed public values.

If you create the file before choosing settings, put `{}` in it. A blank file is invalid JSON. The editor reports that error on the config file while retaining code navigation with the last valid settings or defaults; command-line checking and builds require the file to be repaired.

An absent file uses these defaults:

```json
{
  "allowUnsafeHTML": false,
  "allowUnsafeEmbed": false,
  "mountURL": "/",
  "resolutionOverrides": {
    "browser": {}
  }
}
```

| Setting                       | Purpose                                                                                                                                                                                                                                |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `allowUnsafeHTML`             | Boolean; defaults to `false`. Enables compilation of the explicit unsafe raw-HTML operation. It does not sanitize HTML or suppress runtime enforcement and development warnings. Ordinary JSX does not need it.                        |
| `allowUnsafeEmbed`            | Boolean; defaults to `false`. Allows an Embed rooted in this compiled project to request sandbox tokens beyond `allow-scripts`; the Embed must list each requested token. Direct mounts without compiled project policy remain strict. |
| `mountURL`                    | Path-only application prefix; defaults to `/`. It prefixes route navigation and the generated `/_hesperia/` asset namespace; for example, `/dashboard` uses `/dashboard/_hesperia/`. It cannot include a query or fragment.            |
| `resolutionOverrides.browser` | An object mapping exact import names to replacement modules for browser checking and builds. Defaults to an empty map. If `resolutionOverrides` is supplied, its `browser` object is required.                                         |
| `public`                      | Explicit fixed browser values, imported from `hesperia/config/public`. The check/build command generates their declarations.                                                                                                           |

JSON also accepts `public` for fixed browser values; TypeScript additionally accepts `plugins`. Unknown top-level keys are errors. Routing is discovered under `src/routes`; there is no route-root setting here. Startup settings such as `pageCacheSize` belong in `app.config.ts`.

For example, if a dependency needs a browser replacement:

```json
{
  "resolutionOverrides": {
    "browser": {
      "some-package": "./src/browser-replacement.ts"
    }
  }
}
```

This is an optional illustration: supply a real replacement module with the exports your application needs before using it. The key matches the complete import text `"some-package"`, not `"some-package/subpath"`; wildcard keys are unsupported. Relative replacement paths resolve from the configuration directory, and a replacement can instead name another installed package. Use forward slashes in module paths on Windows too.

The replacement still undergoes browser checking. This setting cannot make a server-only library work in a browser. Direct environment access remains forbidden in browser code; deployment-setting imports are deferred. See [compiler behavior](../packages/compiler/docs/compiler.md) for resolution and supported syntax.

## TypeScript and generated route declarations

Keep the starter's TypeScript setup:

```json
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ESNext", "DOM"],
    "jsx": "preserve",
    "strict": true,
    "noEmit": true,
    "allowImportingTsExtensions": true,
    "skipLibCheck": true
  },
  "include": ["app.tsx", "app.config.ts", "hesperia.config.ts", "src", "hesperia.d.ts"]
}
```

Hesperia generates `hesperia.d.ts` at the application root. Include it in the application's TypeScript project and leave it out of version control. Use the starter's `jsx: "preserve"` setting and Hesperia's checker/editor integration; the aspirational `jsx: "hesperia-jsx"` value is not currently supported by TypeScript.

Hesperia's checker associates each page with its filesystem route. Raw `tsc` does not supply that per-file context just because `hesperia.d.ts` is included. Use `bun run check` and the [Hesperia VS Code extension](../editors/vscode/README.md) for authored diagnostics and route-aware page inputs.

## Enable Hesperia checking in VS Code

Installing the Hesperia application package does not install the editor extension. Without the extension, VS Code's ordinary TypeScript checker can report `JSX element implicitly has type 'any' because no interface 'JSX.IntrinsicElements' exists.` Hesperia supplies its native-element checking declarations through its own checker; the generated route declaration file alone does not supply them to the ordinary editor checker.

Build the development extension and open your application with it loaded. In PowerShell, set the paths to your checkout and application:

```powershell
$workspace = 'C:/work/hesperia-workspace'
$framework = Join-Path $workspace 'hesperia'
$application = 'C:/work/hesperia-todos'

bun run --cwd $framework build
bun install --cwd "$framework/editors/vscode"
bun run --cwd "$framework/editors/vscode" build
code --new-window --extensionDevelopmentPath="$framework/editors/vscode" $application
```

The `code` command must be available in your terminal. The current extension requires VS Code 1.137.0 or later, Bun on the editor process's PATH, a trusted application workspace, and a resolvable installed Hesperia package. Open the application itself as the workspace folder. This launches a development instance; it does not install the extension permanently.

Open root `app.tsx` or a `.tsx` file under `src/`. The language indicator should say **Hesperia TSX**, rather than **TypeScript React**. If it stays in the ordinary TypeScript mode, check the extension's activation and the Hesperia output channel. If `bun run check` reports the same missing-JSX error, investigate that as a checker problem rather than dismissing it as ordinary editor diagnostics.

Keep `jsx: "preserve"`. Adding React types or a catch-all JSX declaration would supply the wrong types or hide errors; neither is the intended setup.

## First checks when something looks wrong

- Nothing appears: check that `app.tsx` and each enclosing layout render `props.children()`.
- A route never appears: check the exact `+page.tsx` name, its default export, and whether a parent directory starts with `_`.
- An async page has no visible waiting view: add an applicable `+loading.tsx`; filesystem pages otherwise use an empty waiting boundary.
- A query value is absent: handle `null` from `.get(...)`; declaring the key does not create or validate a value.
- An imported library fails checking: read the authored diagnostic and check its browser compatibility. The compiler deliberately rejects unsupported syntax and server capabilities.
- Your framework edit has no effect: rebuild and refresh the local packages installed in the dummy application.
