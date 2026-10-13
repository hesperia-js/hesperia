# Routing

Reader: a junior TypeScript engineer familiar with browser navigation and Hesperia components.

For application file setup, the HTML shell, titles, layouts, and boundary views,
start with [getting started](getting-started.md).

`Router` coordinates route admission, detached preparation, and terminal DOM
installation. For a manually assembled router, create one for a same-origin
document and call `navigate()` for the initial route and later programmatic
transitions. Generated filesystem applications create the router and perform
the initial navigation during startup.

Generated filesystem applications may run under a host-supplied mount path; the
standalone default is `/`. A mount of `/dashboard` matches the browser URL
`/dashboard/todos` against the application route `/todos`, while the browser
address and history entries keep `/dashboard/todos`. The prefix is
segment-bounded, so `/dashboardish` is outside that mount. The compiled route
table is mount-neutral and can be used under more than one mount. Use
`navigation.href()` to create links to mounted application routes; ordinary
browser URL and literal anchor resolution keep browser semantics.

## Route declarations

Filesystem routes use a `+route.ts` declaration next to the route's page, such
as `src/routes/+route.ts` or `src/routes/admin/+route.ts`. The
declaration's `guard` admits or redirects a navigation on the client. `load` is
server-only metadata for the route build, and literal `headers` describe its
response policy; neither is executed as browser route code.

```ts
import { route } from "hesperia/routing";

const guard = () => true;

export default route({
  guard,
  load: async () => ({ serverOnly: true }),
  headers: { "cache-control": "private" },
});
```

The compiler associates this declaration with its conventional filesystem
route, extracts the client-safe guard, and keeps server members out of the
browser manifest. A guard may return `true`, `false`, a `redirect(...)` result,
or a promise of one of those outcomes.

## Component departure checks

An outgoing component can veto a route transition while it has unfinished work.
Import `beforeLeave` from `hesperia/navigation` and register the check inside
the component:

```tsx
import { beforeLeave } from "hesperia/navigation";

export function Editor() {
  const dirty = () => true;
  beforeLeave(async () => !dirty());
  return <button>Save</button>;
}
```

The callback receives the current navigation context and returns a boolean or
a promise of a boolean. `true` allows departure and `false` vetoes it. The
registration belongs to the component owner and disappears when that owner is
released. This is separate from route admission: incoming guards run before
outgoing departure checks.

The same entry point exports `navigation`, a facade for the active application
window's browser Navigation API. Its `navigate()` method applies the
application's mount prefix. Its `href()` method returns the browser-facing URL,
so `navigation.href("/settings")` returns `/dashboard/settings` and
`navigation.navigate("/settings")` reaches that route when the app is mounted
at `/dashboard`. Set the standalone mount with `mountURL` in
`hesperia.config.ts` or `hesperia.config.json`; a host adapter can select
another mount for the same captured build. See [project configuration and
hosting](project-configuration.md#application-mount-and-generated-assets).

Changing only the URL fragment, such as `/guide#examples` to `/guide#reference`, keeps the current page and its component state. The router runs the current route's guards, applies the requested history change, and focuses and scrolls to the fragment target. It does not run departure checks because the page remains active. Removing the fragment also retains the page. Back and Forward restore the saved focus and scroll position for the destination history entry, including entries whose URLs contain fragments.

An explicit Navigation API request to the current URL with its unchanged
fragment, such as another push to `/guide#reference`, keeps the current page and
skips route guards. A Navigation API request that changes the path or query
still goes through route presentation.

## History state

`NavigationOptions.state` is tracked with an internal entry identity so repeated URLs and state values remain distinct. Read the author value for the latest committed route through `router.state`; `history.state` exposes the author value for the current physical History entry. Explicit `null` and `undefined` values are preserved. Hesperia's tracking fields do not appear in `router.state`, `history.state`, or `PopStateEvent.state` for tracked entries.

Constructing a router installs shared tracking for direct `history.pushState()` and `history.replaceState()` calls on its window. The current entry is recorded without adding a history entry. Direct browser-method calls retain their native behavior: they change history without rendering a route or dispatching `popstate`. A direct write that changes the entry URL, such as `replaceState()` adding a query, keeps the History and `PopStateEvent.state` projections on the author value after reload and traversal, even after the router releases its write-method patches. An explicit `navigate(location.href, { history: "none" })` adopts the current entry and its author state without writing another entry. Navigation API entry state is separate from classic History state and survives a document reload.

The browser performs structured cloning and validates whether a URL can update the current entry; receiver checks and synchronous History errors remain visible. For direct pushState() and replaceState() calls, an empty URL string (including an argument that converts to one), null, undefined, or an omitted URL keeps the current document URL. Non-empty relative URL strings resolve against document.baseURI, including an applicable base element. A replacement preserves the entry's identity; a push creates a distinct entry, including when application code makes a nested history call while its state is being cloned. Tracking is shared between callers and released after its final user is disposed, including when route cleanup throws. Generated startup installs tracking before evaluating the application shell and configuration; constructing a router later does not identify earlier history entries retroactively.

Browser Back and Forward use the standard Navigation API when available. The
History-event fallback supplies the same Hesperia navigation methods over
entries Hesperia has tracked since startup. It cannot list entries created
before tracking began, and it does not intercept direct `window.location`
changes. Unknown entry keys and Back/Forward beyond the tracked list return
results whose promises reject with `InvalidStateError`. Both paths run admission
and departure checks and cancel superseded work. The native path publishes
terminal presentation after its navigation transition finishes. For a legacy
fragment traversal, presentation waits for both route acceptance and the
corresponding `hashchange` event, whichever arrives last. This prevents browser
processing from immediately undoing the restored focus or scroll position. These
compatibility limits do not establish full native Navigation API parity.

While the router owns route presentation, it sets `history.scrollRestoration` to `"manual"` so browser restoration does not compete with the saved route position. Disposal restores the previous setting if it is still `"manual"`. User focus and scrolling during a pending navigation still take precedence over automatic route presentation.

Fallback Back or Forward can move the address before route checks finish while
keeping the current page mounted. If departure checks veto the move, the adapter
restores the previous tracked entry. This approved timing difference does not
permit skipping the checks or losing tracked entries. See the
[compatibility audit](navigation-fallback.md) for the tested platform limits.

## Route stylesheet readiness

Generated route metadata names the loading, destination, and applicable error
CSS compositions. The router waits for the matched loading composition in the
current document head before final admission. After guards and departure checks
allow the route, it installs the loading view with its styles active.
Destination CSS may still be loading while that view remains visible; the
destination component body does not run until its exact stylesheet group is
ready. Initial effects run after final placement with the selected CSS active.

Error CSS is prepared only when its boundary is selected. A failure in an
unused boundary stylesheet cannot block a successful destination. If the
selected error stylesheet fails, navigation `finished` rejects with the
rendering error even when a boundary displays it. Page and not-found views on
one route node can have separate destination compositions while sharing the
loading and ancestor styles.

`router.listenToLinks()` is independent and only intercepts ordinary same-origin primary-button links. Modified clicks, downloads, non-self targets, and other protocols remain native browser actions.

For the retention behavior of parked pages, see [History page cache](routing-cache.md).
