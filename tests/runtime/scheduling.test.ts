import { describe, expect, test } from "bun:test";
import * as portable from "../../packages/hesperia/src/scheduling.ts";
import * as nodeEntry from "../../packages/hesperia/src/scheduling/node.ts";

function thrownBy(action: () => unknown): unknown {
  try {
    action();
  } catch (error) {
    return error;
  }

  throw new Error("Expected construction to throw");
}

for (const [entry, scheduling] of [
  ["portable", portable],
  ["Node entry under Bun", nodeEntry],
] as const) {
  describe(`scheduling ${entry}`, () => {
    const { debounce, throttle } = scheduling;

    test("coalesces and flushes the latest arguments through an asynchronous callback", async () => {
      const gate = Promise.withResolvers<string>();
      const calls: string[] = [];
      const run = debounce((value: string) => {
        calls.push(value);
        return gate.promise;
      }, 60_000);
      const first = run("first");
      const latest = run("latest");

      expect(run.pending).toBe(latest);
      expect(run.pendingCount).toBe(2);
      expect(run.unref().ref()).toBe(run);
      expect(run.flush()).toBeUndefined();
      expect(calls).toEqual(["latest"]);
      expect(run.pending).toBeNull();
      gate.resolve("settled");
      expect(await Promise.all([first, latest])).toEqual(["settled", "settled"]);
    });

    test("keeps the leading call and rejects only superseded trailing calls", async () => {
      const calls: string[] = [];
      const run = debounce(
        (value: string) => {
          calls.push(value);
          return value;
        },
        60_000,
        { leading: true, rejectOnCancel: true },
      );
      const first = run("leading");
      const superseded = run("superseded").catch((error: unknown) => error);
      const latest = run("trailing");

      expect(await superseded).toMatchObject({ name: "AbortError", code: "ABORT_ERR" });
      run.flush();
      expect(await Promise.all([first, latest])).toEqual(["leading", "trailing"]);
      expect(calls).toEqual(["leading", "trailing"]);
    });

    test("cancels queued debounce work without closing the wrapper", async () => {
      const run = debounce((value: string) => value, 60_000);
      const rejected = run("waiting").catch((error: unknown) => error);
      const reason = { source: "cancel" };

      run.cancel(reason);
      const error = await rejected;
      expect(error).toMatchObject({ name: "AbortError", code: "ABORT_ERR" });
      expect((error as Error).cause).toBe(reason);
      expect(run.pendingCount).toBe(0);
      const later = run("later");
      run.flush();
      expect(await later).toBe("later");
    });

    test("forwards signal abortion to queued and future calls", async () => {
      const controller = new AbortController();
      const reason = { source: "signal" };
      const run = debounce((value: string) => value, 60_000, { signal: controller.signal });
      const queued = run("queued").catch((error: unknown) => error);

      controller.abort(reason);
      const queuedError = await queued;
      expect(queuedError).toMatchObject({ name: "AbortError", code: "ABORT_ERR" });
      expect((queuedError as Error).cause).toBe(reason);
      const futureError = await run("future").catch((error: unknown) => error);
      expect(futureError).toMatchObject({
        name: "AbortError",
        code: "ABORT_ERR",
      });
      expect((futureError as Error).cause).toBe(reason);
      expect(run.pendingCount).toBe(0);
    });

    test("propagates synchronous callback failures", async () => {
      const failure = new Error("callback failure");
      const run = debounce(() => {
        throw failure;
      }, 60_000);
      const observed = run().catch((error: unknown) => error);

      run.flush();
      expect(await observed).toBe(failure);
    });

    test("runs the trailing callback when its timer expires", async () => {
      const calls: string[] = [];
      const run = debounce((value: string) => {
        calls.push(value);
        return value;
      }, 0);

      expect(await run("timer")).toBe("timer");
      expect(calls).toEqual(["timer"]);
      expect(run.pendingCount).toBe(0);
    });

    test("drains a bounded throttle queue after the active callback settles", async () => {
      const gate = Promise.withResolvers<void>();
      const started: string[] = [];
      const run = throttle(
        async (value: string) => {
          started.push(value);
          if (value === "first") await gate.promise;
          return value;
        },
        3,
        60_000,
        { concurrency: 1, maxPending: 1 },
      );
      const first = run("first");
      const second = run("second");
      const overflow = run("overflow").catch((error: unknown) => error);

      expect(started).toEqual(["first"]);
      expect(run.activeCount).toBe(1);
      expect(run.pending).toBe(second);
      expect(run.pendingCount).toBe(1);
      expect(run.hasImmediateCapacity()).toBe(false);
      expect(await overflow).toMatchObject({ code: "ERR_THROTTLED" });
      gate.resolve();
      expect(await Promise.all([first, second])).toEqual(["first", "second"]);
      expect(started).toEqual(["first", "second"]);
      expect(run.pendingCount).toBe(0);
      run.cancel();
    });

    test("drops overflow and keeps the active callback alive", async () => {
      const gate = Promise.withResolvers<void>();
      const started: string[] = [];
      const run = throttle(
        async (value: string) => {
          started.push(value);
          await gate.promise;
          return value;
        },
        1,
        60_000,
        { concurrency: 1, overflow: "drop" },
      );
      const active = run("active");
      const dropped = await run("dropped").catch((error: unknown) => error);

      expect(dropped).toMatchObject({ code: "ERR_THROTTLED" });
      expect(started).toEqual(["active"]);
      gate.resolve();
      expect(await active).toBe("active");
      run.cancel();
    });

    test("cancels queued throttle work but admits work after the active call settles", async () => {
      const gate = Promise.withResolvers<void>();
      const started: string[] = [];
      const run = throttle(
        async (value: string) => {
          started.push(value);
          if (value === "active") await gate.promise;
          return value;
        },
        1,
        60_000,
        { concurrency: 1 },
      );
      const active = run("active");
      const queued = run("queued").catch((error: unknown) => error);
      const reason = { source: "throttle cancel" };

      expect(run.unref().ref()).toBe(run);
      run.cancel(reason);
      const error = await queued;
      expect(error).toMatchObject({ name: "AbortError", code: "ABORT_ERR" });
      expect((error as Error).cause).toBe(reason);
      expect(run.activeCount).toBe(1);
      expect(run.pendingCount).toBe(0);
      gate.resolve();
      expect(await active).toBe("active");
      expect(await run("later")).toBe("later");
      expect(started).toEqual(["active", "later"]);
      run.cancel();
    });

    test("holds strict-window work until cancellation resets capacity", async () => {
      const started: number[] = [];
      const run = throttle(
        (value: number) => {
          started.push(value);
          return value;
        },
        1,
        60_000,
        { strict: true },
      );

      expect(await run(1)).toBe(1);
      const queued = run(2).catch((error: unknown) => error);
      expect(run.pendingCount).toBe(1);
      expect(run.hasImmediateCapacity()).toBe(false);
      expect(run.unref().ref()).toBe(run);
      expect(started).toEqual([1]);
      run.cancel();
      expect(await queued).toMatchObject({ name: "AbortError", code: "ABORT_ERR" });
      expect(await run(3)).toBe(3);
      expect(started).toEqual([1, 3]);
      run.cancel();
    });

    test("aborts queued throttle calls without stopping an active callback", async () => {
      const controller = new AbortController();
      const gate = Promise.withResolvers<void>();
      const started: string[] = [];
      const run = throttle(
        async (value: string) => {
          started.push(value);
          await gate.promise;
          return value;
        },
        1,
        60_000,
        { concurrency: 1, signal: controller.signal },
      );
      const active = run("active");
      const queued = run("queued").catch((error: unknown) => error);
      const reason = { source: "throttle signal" };

      controller.abort(reason);
      const queuedError = await queued;
      expect(queuedError).toMatchObject({ name: "AbortError", code: "ABORT_ERR" });
      expect((queuedError as Error).cause).toBe(reason);
      const futureError = await run("future").catch((error: unknown) => error);
      expect(futureError).toMatchObject({
        name: "AbortError",
        code: "ABORT_ERR",
      });
      expect((futureError as Error).cause).toBe(reason);
      expect(run.activeCount).toBe(1);
      gate.resolve();
      expect(await active).toBe("active");
      expect(started).toEqual(["active"]);
    });

    test("propagates asynchronous throttle failures", async () => {
      const failure = new Error("async failure");
      const run = throttle(() => Promise.reject(failure), 1, 0);

      expect(await run().catch((error: unknown) => error)).toBe(failure);
      run.cancel();
    });

    test("rejects invalid public arguments and pre-aborted signals", () => {
      const callback = () => undefined;
      const invalid: Array<readonly [() => unknown, string]> = [
        [() => Reflect.apply(debounce, undefined, [null, 1]), "ERR_INVALID_ARG_TYPE"],
        [() => Reflect.apply(debounce, undefined, [callback, -1]), "ERR_OUT_OF_RANGE"],
        [() => Reflect.apply(debounce, undefined, [callback, 1, null]), "ERR_INVALID_ARG_TYPE"],
        [
          () => Reflect.apply(debounce, undefined, [callback, 1, { leading: 1 }]),
          "ERR_INVALID_ARG_TYPE",
        ],
        [
          () => Reflect.apply(debounce, undefined, [callback, 1, { rejectOnCancel: 1 }]),
          "ERR_INVALID_ARG_TYPE",
        ],
        [() => Reflect.apply(throttle, undefined, [null, 1, 1]), "ERR_INVALID_ARG_TYPE"],
        [() => Reflect.apply(throttle, undefined, [callback, 0, 1]), "ERR_OUT_OF_RANGE"],
        [() => Reflect.apply(throttle, undefined, [callback, 1, -1]), "ERR_OUT_OF_RANGE"],
        [
          () => Reflect.apply(throttle, undefined, [callback, 1, 1, { concurrency: 0 }]),
          "ERR_OUT_OF_RANGE",
        ],
        [
          () => Reflect.apply(throttle, undefined, [callback, 1, 1, { maxPending: -1 }]),
          "ERR_OUT_OF_RANGE",
        ],
        [
          () => Reflect.apply(throttle, undefined, [callback, 1, 1, { overflow: "discard" }]),
          "ERR_INVALID_ARG_VALUE",
        ],
        [
          () => Reflect.apply(throttle, undefined, [callback, 1, 1, { strict: 1 }]),
          "ERR_INVALID_ARG_TYPE",
        ],
        [
          () => Reflect.apply(throttle, undefined, [callback, 1, 1, { signal: null }]),
          "ERR_INVALID_ARG_TYPE",
        ],
      ];

      for (const [construct, code] of invalid) expect(thrownBy(construct)).toMatchObject({ code });

      const controller = new AbortController();
      const reason = { source: "pre-aborted" };
      controller.abort(reason);
      expect(thrownBy(() => debounce(callback, 1, { signal: controller.signal }))).toMatchObject({
        name: "AbortError",
        code: "ABORT_ERR",
        cause: reason,
      });
      expect(thrownBy(() => throttle(callback, 1, 1, { signal: controller.signal }))).toMatchObject(
        {
          name: "AbortError",
          code: "ABORT_ERR",
          cause: reason,
        },
      );
    });
  });
}
