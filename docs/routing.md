# Routing

Reader: a junior TypeScript engineer familiar with browser navigation and Hesperia components.

For application file setup, the HTML shell, titles, layouts, and boundary views,
start with [getting started](getting-started.md).

`Router` coordinates route admission, detached preparation, and terminal DOM
installation. For a manually assembled router, create one for a same-origin
document and call `navigate()` for the initial route and later programmatic
transitions. Generated filesystem applications create the router and perform
the initial navigation during startup.

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
Import the public `client` value and register the check through its
`navigation` namespace:

```tsx
import { client } from "hesperia";

export function Editor() {
  const dirty = () => true;
  client.navigation.beforeLeave(async () => !dirty());
  return <button>Save</button>;
}
```

The callback receives the current navigation context and returns a boolean or
a promise of a boolean. `true` allows departure and `false` vetoes it. The
registration belongs to the component owner and disappears when that owner is
released. This is separate from route admission: incoming guards run before
outgoing departure checks.

Changing only the URL fragment, such as `/guide#examples` to `/guide#reference`, keeps the current page and its component state. The router runs the current route's guards, applies the requested history change, and focuses and scrolls to the fragment target. It does not run departure checks because the page remains active. Removing the fragment also retains the page. Back and Forward restore the saved focus and scroll position for the destination history entry, including entries whose URLs contain fragments.

## History state

`NavigationOptions.state` is stored in a Hesperia-owned history envelope together with an internal entry identity. This keeps author data separate from the router's bookkeeping and allows repeated URLs and state values to remain distinct. Read the author value for the latest committed route through `router.state`; explicit `null` and `undefined` values are preserved.

Constructing a router now installs shared tracking for direct `history.pushState()` and `history.replaceState()` calls on its window. The current entry is recorded without adding a history entry. Native `history.state` contains the envelope; `router.state` contains the author payload for the committed route. Direct browser-method calls retain their native behavior: they change history without rendering a route or dispatching `popstate`. An explicit `navigate(location.href, { history: "none" })` adopts the current entry and its author state without writing another entry.

Native cloning, URL conversion, receiver checks, and synchronous errors remain in the browser. A replacement preserves the entry's identity; a push creates a distinct entry, including when application code makes a nested history call while its state is being cloned. Tracking is shared between callers and released after its final user is disposed, including when route cleanup throws. Generated startup installs tracking before evaluating the application shell and configuration; constructing a router later does not identify earlier history entries retroactively.

Browser Back and Forward use the standard Navigation API when available. The
History-event fallback covers the tested legacy traversal path; that bounded
coverage does not by itself establish universal Baseline 2024 parity. Both
paths run admission and departure checks and cancel superseded work. The native
path publishes terminal presentation after its navigation transition finishes.
For a legacy fragment traversal, presentation waits for both route acceptance
and the corresponding `hashchange` event, whichever arrives last. This prevents
browser processing from immediately undoing the restored focus or scroll
position.

While the router owns route presentation, it sets `history.scrollRestoration` to `"manual"` so browser restoration does not compete with the saved route position. Disposal restores the previous setting if it is still `"manual"`. User focus and scrolling during a pending navigation still take precedence over automatic route presentation.

The fallback may temporarily change the address during Back/Forward while keeping the current page mounted. If departure checks veto the move, it must restore the exact previous history entry. This approved timing difference does not permit skipping the checks or losing entries. See the [compatibility audit](navigation-fallback.md) for the tested platform limits and remaining implementation work.

`router.listenToLinks()` is independent and only intercepts ordinary same-origin primary-button links. Modified clicks, downloads, non-self targets, and other protocols remain native browser actions.

For the retention behavior of parked pages, see [History page cache](routing-cache.md).
