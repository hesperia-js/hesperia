# Component cleanup and disposal

Use `client.cleanup` to release work owned by a component. Cleanup runs once when
the component is destroyed. A parent runs its cleanup callbacks in reverse
registration order before its descendants are destroyed.

A cleanup callback can return a native Promise. Hesperia observes that Promise
and retains its rejection as a cleanup failure. Primitive return values are
ignored. An object or function that cannot be observed by the native Promise
operation produces a cleanup-observation fault. Hesperia does not read its
`then` property or retry the callback.

When you explicitly mount an application, the returned `MountedApplication`
provides two disposal methods:

- `dispose()` revokes the application immediately and returns a Promise that
  joins its owned cleanup. If it starts disposal, the Promise rejects with an
  `AggregateError` containing the original cleanup failures in invocation
  order. Those failures are not also sent to `onError`.
- `disposeSync()` revokes the application immediately and reports synchronous
  cleanup failures through `onError`. If it starts disposal, later asynchronous
  cleanup failures are also reported through that route once. A later
  `dispose()` joins the same cleanup outcome without running callbacks again.

The first method called determines how failures are reported. Neither method
runs a final render or effect pass. `settled()` continues to wait for rendering
and effects; use `dispose()` to wait for cleanup.

Owner-bound state writes are revoked when disposal begins, including writes
attempted after an `await` in a cleanup callback. Effect cleanup retains its
separate lifecycle.
