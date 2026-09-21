# Getting started with Hesperia

Reader: a TypeScript application author who knows JSX and wants to build their first Hesperia application.

Create a local application, configure its tools and startup, then add the document shell, routes, and page-specific head content. This guide describes the first browser milestone; the examples build a small task-workspace skeleton.

## Create an application from the local checkout

The current packages have version `0.0.0`. Use the built local packages for this experiment; a public `create` package is planned for the developer-experience milestone. The existing CLI already has `init`, `dev`, `check`, `build`, and `preview` commands.

For your current checkout, run the following in PowerShell. Choose a new application directory; `init` requires an empty destination. Bun is required, and the milestone uses Bun 1.4.2 and TypeScript 7.0.2.

```powershell
$workspace = 'C:/Users/werbe/Projects/hesperia'
$application = 'C:/Users/werbe/Projects/hesperia-todos'
$packages = 'C:/Users/werbe/Projects/hesperia-local-packages'

New-Item -ItemType Directory -Force -Path $packages | Out-Null

bun install --cwd "$workspace/aeolia"
bun run --cwd "$workspace/aeolia" build
bun install --cwd "$workspace/hesperia"
bun run --cwd "$workspace/hesperia" build

Push-Location "$workspace/aeolia"
bun pm pack --destination $packages --ignore-scripts
Pop-Location
Push-Location "$workspace/hesperia"
bun pm pack --destination $packages --ignore-scripts
Pop-Location

bun "$workspace/hesperia/dist/tooling/cli.js" init $application
```

Stop if a command fails. Before installing the generated application, replace its placeholder dependencies with the packed local versions:

```powershell
$manifestPath = "$application/package.json"
$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
$manifest.dependencies.hesperia = "$packages/hesperia-0.0.0.tgz"
$manifest.dependencies.aeolia = "$packages/aeolia-0.0.0.tgz"
$manifest | Add-Member -MemberType NoteProperty -Name overrides -Force -Value @{
  aeolia = "$packages/aeolia-0.0.0.tgz"
}
$manifest | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $manifestPath

Set-Location $application
bun install
bun run dev
```

The override makes Hesperia's Aeolia peer resolve to the same unpublished local package. Packing copies the built packages into the application installation; later framework edits require rebuilding, repacking, and refreshing the application's installed packages. This is the current local testing setup, not the planned final installation experience.

Open the URL printed by the server. Edit the generated files using the examples below. Development changes currently cause a full browser reload.

## Application scripts

The starter writes these scripts in the application's `package.json`:

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
| `bun run check`           | Check authored TypeScript/TSX and refresh generated route declarations.                |
| `bun run build`           | Produce browser assets under `.hesperia/build`.                                        |
| `bun run preview`         | Serve the existing build. Run `build` first. Default port: 4173.                       |
| `bun run dev --port 3000` | Use a chosen port. `preview` accepts the same option; `0` selects a free port.         |

Keep `.hesperia/`, `node_modules/`, and `hesperia.d.ts` out of version control. The starter supplies these ignore entries.

## Files at a glance

Paths below are relative to your application root.

```text
app.tsx                         HTML, head, body, and the route outlet
app.config.ts                   Optional application startup settings
hesperia.config.json            Optional compiler/build settings
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

The declaration also recognizes `load` and `headers`, but these are server-oriented metadata and are not executed or applied as browser loaders or HTTP response headers in this milestone. A client guard cannot secure a backend; the backend must enforce its own access rules.

To prevent leaving a component with unsaved work, register `client.navigation.beforeLeave(...)` in that component. See [navigation behavior](routing.md) for its callback and ordering rules.

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

Import your adapted data API directly from an ordinary module, such as `src/api.ts`; it is not an `app.config.ts` property. The current manual adapter is `withAeolia(graph, contract)` from `hesperia/aeolia`. See [the data guide](data.md) when connecting a backend.

## Compiler/build settings: `hesperia.config.json`

This optional file lives at the application root. It is plain JSON, so omit comments and trailing commas.

If you create the file before choosing settings, put `{}` in it. A blank file is invalid JSON. The editor reports that error on the config file while retaining code navigation with the last valid settings or defaults; command-line checking and builds require the file to be repaired.

An absent file uses these defaults:

```json
{
  "allowUnsafeHTML": false,
  "resolutionOverrides": {
    "browser": {}
  }
}
```

| Setting                       | Purpose                                                                                                                                                                                                         |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `allowUnsafeHTML`             | Boolean; defaults to `false`. Enables compilation of the explicit unsafe raw-HTML operation. It does not sanitize HTML or suppress runtime enforcement and development warnings. Ordinary JSX does not need it. |
| `resolutionOverrides.browser` | An object mapping exact import names to replacement modules for browser checking and builds. Defaults to an empty map. If `resolutionOverrides` is supplied, its `browser` object is required.                  |

These are the supported top-level settings; unknown top-level keys are errors. Routing is discovered under `src/routes`; there is no route-root setting here. Startup settings such as `pageCacheSize` belong in `app.config.ts`.

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

The replacement still undergoes browser checking. This setting cannot make a server-only library work in a browser. Direct environment access remains forbidden in browser code; deployment-setting imports are deferred. See [compiler behavior](compiler.md) for resolution and supported syntax.

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
  "include": ["app.tsx", "app.config.ts", "src", "hesperia.d.ts"]
}
```

Hesperia generates `hesperia.d.ts` at the application root. Include it in the application's TypeScript project and leave it out of version control. Use the starter's `jsx: "preserve"` setting and Hesperia's checker/editor integration; the aspirational `jsx: "hesperia-jsx"` value is not currently supported by TypeScript.

Hesperia's checker associates each page with its filesystem route. Raw `tsc` does not supply that per-file context just because `hesperia.d.ts` is included. Use `bun run check` and the [Hesperia VS Code extension](../editors/vscode/README.md) for authored diagnostics and route-aware page inputs.

## Enable Hesperia checking in VS Code

Installing the Hesperia application package does not install the editor extension. Without the extension, VS Code's ordinary TypeScript checker can report `JSX element implicitly has type 'any' because no interface 'JSX.IntrinsicElements' exists.` Hesperia supplies its native-element checking declarations through its own checker; the generated route declaration file alone does not supply them to the ordinary editor checker.

For this milestone, build the development extension and open your application with it loaded. In PowerShell, adjust the application path to your actual project:

```powershell
$framework = 'C:/Users/werbe/Projects/hesperia/hesperia'
$application = 'C:/Users/werbe/Projects/hesperia-todos'

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
