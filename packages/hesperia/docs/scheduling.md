# Scheduling callbacks

Use `hesperia/scheduling` to debounce or throttle a callback. The utilities work
in components, shared modules and standalone code. They do not capture a
Hesperia component owner, run a form, refresh a query or retry an operation
automatically.

Each call returns a promise for its eventual callback outcome. Callback failures
reject that promise. A callback may return a value, a promise or a thenable.

## Debounce

`debounce(callback, wait, options?)` waits until calls stop arriving for `wait`
milliseconds. By default, it invokes the callback with the latest arguments and
settles the waiting calls with the same result:

```ts
import { debounce } from "hesperia/scheduling";

const normalizeLater = debounce((value: string) => value.trim(), 200);
const first = normalizeLater("first");
const second = normalizeLater(" second ");

console.log(await Promise.all([first, second])); // ["second", "second"]
```

`wait` must be an integer from `0` through `2_147_483_647`. Host timers can run
later than requested; this is not a precise execution deadline.

| Option           | Default | Behavior                                                                                                                                                                                 |
| ---------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `leading`        | `false` | Start the first call immediately. Another call during that window schedules a trailing invocation with the latest arguments. A lone leading call does not also run at the trailing edge. |
| `rejectOnCancel` | `false` | When true, a newer queued call rejects the superseded queued calls instead of sharing its result with them.                                                                              |
| `signal`         | Absent  | Abort queued and future calls when this signal aborts. Construction with an already-aborted signal throws.                                                                               |

The waiting window begins before a leading callback runs. An asynchronous
callback does not extend that window until it settles.

The returned function provides these controls:

| Member              | Meaning                                                                                                               |
| ------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `pending`           | The most recent queued call's promise, or `null` when no call waits.                                                  |
| `pendingCount`      | Number of waiting calls. Already-started callbacks are excluded.                                                      |
| `flush()`           | Start a queued trailing invocation immediately. Returns `undefined`; await the original call promises for its result. |
| `cancel(reason?)`   | Cancel queued work. Future calls remain usable unless the configured signal has aborted.                              |
| `ref()` / `unref()` | Return the same scheduling function. See host liveness below.                                                         |

## Throttle

`throttle(callback, limit, interval, options?)` limits how often a callback starts
and can also limit concurrent callbacks:

```ts
import { throttle } from "hesperia/scheduling";

const run = throttle((value: number) => value * 2, 2, 1_000, {
  concurrency: 1,
  maxPending: 20,
});

const results = await Promise.all([run(1), run(2), run(3)]);
console.log(results); // [2, 4, 6]
```

`limit` must be a positive safe integer. `interval` must be an integer from `0`
through `2_147_483_647` milliseconds. Starting a callback consumes rate
capacity. Its active concurrency slot is released when its result settles,
including rejection.

| Option        | Default    | Behavior                                                                                                                                   |
| ------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `concurrency` | `Infinity` | Maximum active callbacks. A finite value must be a positive safe integer.                                                                  |
| `maxPending`  | `Infinity` | Maximum waiting calls. A finite value must be a nonnegative safe integer. There is no implicit queue cap.                                  |
| `overflow`    | `"queue"`  | Queue calls in arrival order. With `"drop"`, reject a call that cannot start immediately. Reaching `maxPending` also rejects the new call. |
| `strict`      | `false`    | Use a rolling interval when true. Otherwise rate capacity resets at fixed window boundaries established by invocation.                     |
| `signal`      | Absent     | Abort queued and future calls. Construction with an already-aborted signal throws.                                                         |

A rejected overload call has error code `ERR_THROTTLED`. It does not enter the
queue or start the callback.

Throttle exposes `pending`, `pendingCount`, `cancel(reason?)`, `ref()` and
`unref()` with the same waiting-call distinctions as debounce. It also exposes:

| Member                   | Meaning                                                                                     |
| ------------------------ | ------------------------------------------------------------------------------------------- |
| `activeCount`            | Number of callbacks whose results have not settled.                                         |
| `hasImmediateCapacity()` | Whether a new call could start immediately at this observation. It does not reserve a slot. |

Throttle has no `flush()` method. Cancelling it rejects queued work and resets
its rate accounting, while callbacks already started keep their active slots
until settlement.

## Cancellation and explicit lifetimes

Cancellation rejects waiting calls with an `AbortError`. A supplied cancellation
reason is retained as its `cause`. Signal abortion also rejects future calls;
calling `cancel()` alone does not permanently close the utility.

The portable signal path uses `AbortSignal.any()` when available so another
listener cannot suppress its abort notification. On older hosts without that
facility, an earlier listener calling `stopImmediatePropagation()` can delay
queue cancellation until the scheduler next checks the signal. The Node entry
uses Node's protected abort-listener facility.

Neither cancellation mechanism can stop an arbitrary callback that already
started. Pass an appropriate signal to cancellable work inside that callback
when it needs its own physical cancellation:

```ts
import { debounce } from "hesperia/scheduling";

const lifetime = new AbortController();
const loadLater = debounce(
  (name: string) =>
    fetch(`/search?name=${encodeURIComponent(name)}`, {
      signal: lifetime.signal,
    }),
  200,
  { signal: lifetime.signal },
);

// At the lifetime's actual end:
lifetime.abort();
```

Inside a compiled component, an explicit
`client.cleanup(() => lifetime.abort())` can connect this lifetime to component
removal. A shared module utility should instead use its shared owner's lifetime.
Creating or calling the utility inside a component does not establish that
connection automatically. Existing owner-bound Hesperia resources still reject
work after their owner ends; the scheduler cannot keep them alive.

Handle the returned promises, including cancellation and callback failures.
Flushing is an execution request, not a promise to wait for all running work.
There is no automatic form submission, task invocation, retry, query
invalidation or replay.

## Host liveness and callback receiver

In a browser, `ref()` and `unref()` are chainable no-ops. They return the same
function, do not change pending work and do not cancel anything.

On Node, these methods control whether current and future utility timers keep
the process alive. An unreferenced timer may never run if nothing else keeps
the process alive. A promise by itself does not give an unreferenced timer a
process-liveness guarantee. Cancellation remains separate from ref/unref.

The callback's `this` is the returned scheduling function, even if that function
was invoked with another receiver through `call` or `apply`. Arrow functions
retain their normal lexical `this`. The utility preserves the callback's
`name` and `length` on its wrapper.

The Node reference surface is documented in the
[Node utility guide](https://nodejs.org/api/util.html#utildebouncefn-wait-options).
Hesperia provides a portable implementation when a compatible native utility is
unavailable. Runtime selection does not change the explicit lifetime contract
or add component binding.
