# Cached page lifecycle

The route host owns page cache entries. A cached entry retains one `Owner`
subtree and the native nodes created by that subtree. The host parks those
nodes outside the mounted container, then calls `owner.suspend()`. The runtime
marks the subtree suspended, disconnects its reactive observers, releases feed
listeners, disconnects binding membership observers, and runs each registered
effect cleanup once. Component bodies do not run again.

Restoration has the reverse ordering. The host must put the retained native
nodes back into their rendered position before calling `owner.resume()`. Resume
marks the complete subtree mounted, reconnects binding observers and feed
listeners, and tracks each retained render work item against the current
readables. That refreshes the DOM from the newest stored values. It then runs
effects in the existing children-first, sibling, and registration order. The
component bodies remain untouched.

The host must keep cached page owners separate from visible shared layouts.
Disposing a layout must not dispose an inactive cached page, and restoring one
history entry must resume only that entry's subtree. A cached page task may
continue and settle its Aeolia stores while the page is suspended; those
settlements do not render the parked DOM or run the page's effects. Eviction is
different from suspension: the host calls `owner.dispose(reason)`, which keeps
the existing cancellation, cleanup, binding release, and native-node removal
behavior.

These methods are runtime integration seams for the route host. They are not
an authored lifecycle callback API. The host should use the history entry as
the cache identity, preserve query-entry sharing of the existing page owner,
and apply its configured FIFO bound before evicting entries.
