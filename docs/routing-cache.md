# History page cache

The browser router can retain inactive route component lifetimes for history
restoration. A retained page keeps its component owners, native nodes, bindings,
and local state. Its reactive rendering and effects are paused while it is out
of the document. Effect cleanup runs when the page is parked; restoration
resumes the existing observers and runs effects again without executing the
component bodies.

A query invalidated while the page is parked may remain stale while it has no
value observers. Restoring the page reconnects those observers, and Aeolia
schedules a refresh even when no `revalidateAfterMs` is configured. The retained
value remains available until the request settles; a page that renders a loading
view from `pending` shows it during that refresh. Fresh queries are not fetched
again merely because a cached page returns, and failed queries keep their
existing recovery limits.

The cache is keyed by the internal history entry identity. A URL is not a
sufficient key because several entries may have the same URL. Query-only
history entries may alias one page lifetime. Traversing to one of those entries
updates the existing query accessor to that entry's snapshot and leaves the
page's ordinary local state at its latest value.

The limit counts inactive page lifetimes in addition to the current page. The
default is five. A zero limit disables future history retention. The outgoing
page remains available while a pending navigation is admitted so cancellation
can restore it, even when the configured limit is zero. When the limit is full,
the earliest retained page is evicted first. Eviction disposes the actual owner
tree and therefore cancels its lifetime-bound tasks.

Pages may finish tasks that were already running when they were parked. Those
tasks can settle and update shared data, but a parked page performs no reactive
DOM or effect work. A page's departure checks still run before restoration or
replacement, so an unsettled author-owned task can veto leaving the page.

Shared layouts that remain part of the active route stay mounted and continue
to react. A parked page suffix is retained separately from those ancestors. It
must not be disposed when a shared ancestor is cleaned up, and resuming the
ancestor must not reactivate the parked suffix.

The route-host integration uses two internal lifecycle hooks on a prepared
route:

- `park(preserving)` detaches and suspends the outgoing suffix while preserving
  its owner identity.
- `restore(preserving)` reattaches and resumes that suffix without rerunning
  component bodies.

Installation accepts an internal preservation set so the host can retain the
outgoing owner tree before the next route becomes visible. The public route
authoring API does not need a second cache callback registry.

Candidates may also provide `prepareLoading(inputs)`. The router calls it only
after incoming guards and outgoing departure checks pass. Its prepared route is
an intermediate composition: it may park the outgoing page, but it does not
write history or run terminal title, focus, scroll, or announcement work. The
final `prepare(inputs)` result replaces that intermediate composition. If the
navigation is cancelled before the final result commits, the intermediate
composition is disposed and the parked outgoing page is restored.
