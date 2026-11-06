import assert from "node:assert/strict";
import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** @typedef {typeof import("hesperia/scheduling")} SchedulingApi */

/** @returns {{ promise: Promise<void>, resolve: () => void }} */
function deferred() {
  /** @type {() => void} */
  let resolve = () => undefined;
  /** @type {Promise<void>} */
  const promise = new Promise((resolvePromise) => {
    resolve = () => resolvePromise();
  });

  return { promise, resolve: () => resolve() };
}

/** @param {number} milliseconds */
function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/**
 * @param {unknown} value
 * @returns {{ then: (resolve: (value: unknown) => void) => void }}
 */
function foreignThenable(value) {
  return {
    // This fixture exercises callback-result promise assimilation.
    // oxlint-disable-next-line unicorn/no-thenable
    then(resolve) {
      queueMicrotask(() => resolve(value));
    },
  };
}

/** @param {number} startedAt @param {number} targetElapsed */
async function waitUntilElapsed(startedAt, targetElapsed) {
  const remaining = targetElapsed - (performance.now() - startedAt);

  if (remaining > 0) await delay(remaining);

  return performance.now() - startedAt;
}

/** @template Value @param {() => Value} callback */
function captureCall(callback) {
  const before = performance.now();
  const value = callback();

  return { before, after: performance.now(), value };
}

/**
 * @param {string} reason
 * @param {Record<string, number>} measurements
 * @param {Array<{ cancel: () => void }>} utilities
 * @param {Promise<unknown>[]} calls
 */
async function failTimingPrecondition(reason, measurements, utilities, calls) {
  for (const utility of utilities) utility.cancel();

  await Promise.allSettled(calls);

  const record = {
    kind: "scheduling-timing-precondition",
    status: "unsupported",
    measurement: "unmeasured",
    reason,
    measurements,
  };

  throw new Error(JSON.stringify(record));
}

/** @param {SchedulingApi} scheduling */
export async function verifySchedulingContract(scheduling) {
  const { debounce, throttle } = scheduling;

  assert.throws(() => Reflect.apply(debounce, undefined, [1, 1]), {
    name: "TypeError",
    code: "ERR_INVALID_ARG_TYPE",
  });
  assert.throws(() => debounce(() => undefined, -1), {
    name: "RangeError",
    code: "ERR_OUT_OF_RANGE",
  });
  assert.throws(() => throttle(() => undefined, 0, 1), {
    name: "RangeError",
    code: "ERR_OUT_OF_RANGE",
  });
  assert.throws(() => debounce(() => undefined, 2_147_483_648), {
    name: "RangeError",
    code: "ERR_OUT_OF_RANGE",
  });
  assert.throws(() => throttle(() => undefined, 1.5, 1), {
    name: "RangeError",
    code: "ERR_OUT_OF_RANGE",
  });
  assert.throws(
    () => Reflect.apply(throttle, undefined, [() => undefined, 1, 1, { overflow: "discard" }]),
    {
      name: "TypeError",
      code: "ERR_INVALID_ARG_VALUE",
    },
  );

  const alreadyAborted = new AbortController();
  const abortReason = { source: "already-aborted" };
  alreadyAborted.abort(abortReason);
  assert.throws(
    () => debounce(() => undefined, 1, { signal: alreadyAborted.signal }),
    (error) =>
      error instanceof Error &&
      error.name === "AbortError" &&
      Reflect.get(error, "code") === "ABORT_ERR" &&
      error.cause === abortReason,
  );

  /** @type {import("hesperia/scheduling").DebouncedFunction<typeof callback>} */
  let coalesced;
  /** @type {string[]} */
  const coalescedCalls = [];
  /** @this {unknown} @param {string} value */
  function callback(value) {
    assert.strictEqual(this, coalesced);
    coalescedCalls.push(value);
    return value;
  }
  coalesced = debounce(callback, 5);
  assert.equal(coalesced.name, "callback");
  assert.equal(coalesced.length, 1);
  const first = coalesced("first");
  const latest = coalesced("latest");
  assert.strictEqual(coalesced.pending, latest);
  assert.equal(coalesced.pendingCount, 2);
  assert.deepEqual(await Promise.all([first, latest]), ["latest", "latest"]);
  assert.deepEqual(coalescedCalls, ["latest"]);
  assert.equal(coalesced.pending, null);
  assert.equal(coalesced.pendingCount, 0);

  const debounceFailure = new Error("debounce callback failure");
  const failingDebounce = debounce(() => {
    throw debounceFailure;
  }, 5);
  const failedFirst = failingDebounce();
  const failedLatest = failingDebounce();
  const failedCalls = await Promise.all(
    [failedFirst, failedLatest].map((promise) =>
      promise.then(
        () => null,
        (error) => error,
      ),
    ),
  );
  assert.deepEqual(failedCalls, [debounceFailure, debounceFailure]);

  const debounceThenableValue = { source: "debounce-thenable" };
  const assimilatingDebounce = debounce(() => foreignThenable(debounceThenableValue), 0);
  assert.strictEqual(await assimilatingDebounce(), debounceThenableValue);

  /** @type {string[]} */
  const leadingCalls = [];
  /** @type {import("hesperia/scheduling").DebouncedFunction<typeof leadingCallback>} */
  let leading;
  /** @this {unknown} @param {string} value */
  function leadingCallback(value) {
    assert.strictEqual(this, leading);
    leadingCalls.push(value);
    return value;
  }
  leading = debounce(leadingCallback, 5, { leading: true });
  const immediate = leading("immediate");
  const trailing = leading("trailing");
  assert.deepEqual(await Promise.all([immediate, trailing]), ["immediate", "trailing"]);
  assert.deepEqual(leadingCalls, ["immediate", "trailing"]);

  /** @type {string[]} */
  const recursiveOrder = [];
  /** @type {Promise<unknown> | undefined} */
  let recursiveInner;
  let outerCallReturned = false;
  /** @type {import("hesperia/scheduling").DebouncedFunction<typeof recursiveCallback>} */
  let recursiveLeading;
  /** @param {string} value */
  function recursiveCallback(value) {
    if (value === "outer") {
      recursiveOrder.push("outer-start");
      recursiveInner = recursiveLeading("inner");
      recursiveOrder.push("inner-queued");
      assert.equal(outerCallReturned, false);
      return "outer";
    }

    assert.equal(outerCallReturned, true);
    recursiveOrder.push("inner-start");
    return value;
  }
  recursiveLeading = debounce(recursiveCallback, 5, { leading: true });
  const recursiveOuter = recursiveLeading("outer");
  outerCallReturned = true;
  recursiveOrder.push("outer-returned");
  assert.deepEqual(recursiveOrder, ["outer-start", "inner-queued", "outer-returned"]);
  assert.equal(await recursiveOuter, "outer");
  assert.ok(recursiveInner);
  assert.equal(await recursiveInner, "inner");
  assert.deepEqual(recursiveOrder, [
    "outer-start",
    "inner-queued",
    "outer-returned",
    "inner-start",
  ]);

  /** @type {string[]} */
  const loneLeadingCalls = [];
  const loneLeading = debounce(
    () => {
      loneLeadingCalls.push("called");
      return "lone";
    },
    5,
    { leading: true },
  );
  assert.equal(await loneLeading(), "lone");
  await delay(15);
  assert.deepEqual(loneLeadingCalls, ["called"]);

  /** @type {(value: string) => string} */
  const echo = (value) => value;
  const flushed = debounce(echo, 60_000);
  const flushPromise = flushed("flushed");
  assert.equal(flushed.flush(), undefined);
  assert.equal(await flushPromise, "flushed");
  assert.equal(flushed.pending, null);

  const superseded = debounce(echo, 60_000, { rejectOnCancel: true });
  const supersededResult = superseded("old").then(
    () => null,
    (error) => error,
  );
  const current = superseded("current");
  const supersededError = await supersededResult;
  assert.ok(supersededError instanceof Error);
  assert.equal(supersededError.name, "AbortError");
  assert.equal(Reflect.get(supersededError, "code"), "ABORT_ERR");
  assert.equal(superseded.flush(), undefined);
  assert.equal(await current, "current");

  const canceled = debounce(echo, 60_000);
  const canceledResult = canceled("waiting").then(
    () => null,
    (error) => error,
  );
  const cancellationReason = { source: "explicit-cancel" };
  canceled.cancel(cancellationReason);
  const cancellationError = await canceledResult;
  assert.ok(cancellationError instanceof Error);
  assert.equal(cancellationError.name, "AbortError");
  assert.equal(Reflect.get(cancellationError, "code"), "ABORT_ERR");
  assert.strictEqual(cancellationError.cause, cancellationReason);
  assert.equal(canceled.pending, null);
  const afterCancel = canceled("reusable");
  assert.equal(canceled.flush(), undefined);
  assert.equal(await afterCancel, "reusable");

  const dropGate = deferred();
  const dropStarted = deferred();
  /** @type {import("hesperia/scheduling").ThrottledFunction<(value: string) => Promise<string>>} */
  let dropping;
  /** @this {unknown} @param {string} value */
  async function dropCallback(value) {
    assert.strictEqual(this, dropping);
    dropStarted.resolve();
    await dropGate.promise;
    return value;
  }
  dropping = throttle(dropCallback, 1, 60_000, { concurrency: 1, overflow: "drop" });
  const activeDropCall = dropping("active");
  await dropStarted.promise;
  const droppedResult = await dropping("dropped").then(
    () => null,
    (error) => error,
  );
  assert.ok(droppedResult instanceof Error);
  assert.equal(Reflect.get(droppedResult, "code"), "ERR_THROTTLED");
  assert.equal(droppedResult.message, "The call was dropped by the throttled function");
  dropGate.resolve();
  assert.equal(await activeDropCall, "active");

  const firstGate = deferred();
  const secondGate = deferred();
  const secondStarted = deferred();
  const thirdStarted = deferred();
  /** @type {string[]} */
  const queueStarted = [];
  /** @type {import("hesperia/scheduling").ThrottledFunction<typeof queuedCallback>} */
  let queued;
  /** @this {unknown} @param {string} value */
  async function queuedCallback(value) {
    assert.strictEqual(this, queued);
    queueStarted.push(value);
    if (value === "one") await firstGate.promise;
    if (value === "two") {
      secondStarted.resolve();
      await secondGate.promise;
    }
    if (value === "three") thirdStarted.resolve();
    return value;
  }
  queued = throttle(queuedCallback, 3, 60_000, { concurrency: 1, maxPending: 2 });
  const one = queued("one");
  assert.deepEqual(queueStarted, ["one"]);
  const two = queued("two");
  const three = queued("three");
  assert.equal(queued.activeCount, 1);
  assert.equal(queued.pendingCount, 2);
  assert.strictEqual(queued.pending, three);
  assert.equal(queued.hasImmediateCapacity(), false);
  const maxPendingResult = await queued("over-limit").then(
    () => null,
    (error) => error,
  );
  assert.ok(maxPendingResult instanceof Error);
  assert.equal(Reflect.get(maxPendingResult, "code"), "ERR_THROTTLED");

  firstGate.resolve();
  await secondStarted.promise;
  assert.deepEqual(queueStarted, ["one", "two"]);
  assert.equal(queued.activeCount, 1);
  assert.equal(queued.pendingCount, 1);
  secondGate.resolve();
  await thirdStarted.promise;
  assert.deepEqual(queueStarted, ["one", "two", "three"]);
  assert.equal(queued.activeCount, 1);
  assert.equal(queued.pendingCount, 0);
  assert.deepEqual(await Promise.all([one, two, three]), ["one", "two", "three"]);
  assert.equal(queued.activeCount, 0);

  const cancellationGate = deferred();
  const cancellationStarted = deferred();
  /** @type {string[]} */
  const cancellationCalls = [];
  /** @param {string} value */
  async function cancellationCallback(value) {
    cancellationCalls.push(value);
    if (value === "active") {
      cancellationStarted.resolve();
      await cancellationGate.promise;
    }
    return value;
  }
  const cancellable = throttle(cancellationCallback, 1, 60_000, {
    concurrency: 1,
    maxPending: 2,
  });
  const activeBeforeCancel = cancellable("active");
  await cancellationStarted.promise;
  const queuedBeforeCancel = cancellable("queued-before").then(
    () => null,
    (error) => error,
  );
  const queuedAfterCancel = cancellable("queued-after").then(
    () => null,
    (error) => error,
  );
  assert.equal(cancellable.activeCount, 1);
  assert.equal(cancellable.pendingCount, 2);
  const throttleCancellationReason = { source: "throttle-cancel" };
  cancellable.cancel(throttleCancellationReason);
  const canceledQueue = await Promise.all([queuedBeforeCancel, queuedAfterCancel]);

  for (const error of canceledQueue) {
    assert.ok(error instanceof Error);
    assert.equal(error.name, "AbortError");
    assert.equal(Reflect.get(error, "code"), "ABORT_ERR");
    assert.strictEqual(error.cause, throttleCancellationReason);
  }

  assert.equal(cancellable.activeCount, 1);
  assert.equal(cancellable.pendingCount, 0);
  assert.deepEqual(cancellationCalls, ["active"]);
  cancellationGate.resolve();
  assert.equal(await activeBeforeCancel, "active");
  assert.equal(cancellable.activeCount, 0);
  assert.equal(cancellable.hasImmediateCapacity(), true);
  const reusableAfterCancel = cancellable("reusable");
  assert.deepEqual(cancellationCalls, ["active", "reusable"]);
  assert.equal(cancellable.activeCount, 1);
  assert.equal(await reusableAfterCancel, "reusable");
  assert.equal(cancellable.activeCount, 0);

  const throttleFailure = new Error("throttle callback failure");
  const failingThrottle = throttle(
    () => {
      throw throttleFailure;
    },
    1,
    0,
  );
  assert.strictEqual(
    await failingThrottle().then(
      () => null,
      (error) => error,
    ),
    throttleFailure,
  );

  const rejectionFailure = new Error("throttle async failure");
  const rejectingThrottle = throttle(() => Promise.reject(rejectionFailure), 1, 0);
  assert.strictEqual(
    await rejectingThrottle().then(
      () => null,
      (error) => error,
    ),
    rejectionFailure,
  );

  const throttleThenableValue = { source: "throttle-thenable" };
  const assimilatingThrottle = throttle(() => foreignThenable(throttleThenableValue), 1, 0);
  assert.strictEqual(await assimilatingThrottle(), throttleThenableValue);

  const capacityGates = [deferred(), deferred()];
  /** @type {string[]} */
  const capacityStarted = [];
  let capacityIndex = 0;
  /** @param {string} value */
  async function capacityCallback(value) {
    capacityStarted.push(value);
    const gate = capacityGates[capacityIndex++];

    if (gate === undefined) throw new Error("Unexpected extra capacity callback");

    await gate.promise;
    return value;
  }
  const capacity = throttle(capacityCallback, 2, 60_000, { concurrency: 2 });
  assert.equal(capacity.hasImmediateCapacity(), true);
  assert.equal(capacity.hasImmediateCapacity(), true);
  const capacityOne = capacity("one");
  const capacityTwo = capacity("two");
  assert.deepEqual(capacityStarted, ["one", "two"]);
  assert.equal(capacity.activeCount, 2);
  assert.equal(capacity.hasImmediateCapacity(), false);
  const [capacityFirst, capacitySecond] = capacityGates;
  assert.ok(capacityFirst);
  assert.ok(capacitySecond);
  capacityFirst.resolve();
  capacitySecond.resolve();
  assert.deepEqual(await Promise.all([capacityOne, capacityTwo]), ["one", "two"]);

  /** @type {number[]} */
  const fixedStarted = [];
  /** @type {number[]} */
  const strictStarted = [];
  const interval = 2_000;
  /** @param {number} value */
  function fixedCallback(value) {
    fixedStarted.push(value);
    return value;
  }
  const fixed = throttle(fixedCallback, 2, interval);
  /** @param {number} value */
  function strictCallback(value) {
    strictStarted.push(value);
    return value;
  }
  const strict = throttle(strictCallback, 2, interval, { strict: true });
  const windowStartedAt = performance.now();
  const firstFixed = captureCall(() => fixed(1));
  const firstStrict = captureCall(() => strict(1));
  await waitUntilElapsed(windowStartedAt, interval * 0.25);

  const secondFixed = captureCall(() => fixed(2));
  const secondStrict = captureCall(() => strict(2));
  const secondFixedAge = secondFixed.after - firstFixed.before;
  const secondStrictAge = secondStrict.after - firstStrict.before;

  if (secondFixedAge >= interval || secondStrictAge >= interval) {
    await failTimingPrecondition(
      "The second call missed the fixed-window sample",
      { interval, secondFixedAge, secondStrictAge },
      [fixed, strict],
      [firstFixed.value, firstStrict.value, secondFixed.value, secondStrict.value],
    );
  }

  await waitUntilElapsed(windowStartedAt, interval * 1.05);
  const thirdFixed = captureCall(() => fixed(3));
  const thirdStrict = captureCall(() => strict(3));
  const fourthFixed = captureCall(() => fixed(4));
  const fourthStrict = captureCall(() => strict(4));
  const fixedThirdAge = thirdFixed.before - firstFixed.after;
  const fixedFourthAge = fourthFixed.after - thirdFixed.before;
  const strictFirstExpiredAge = thirdStrict.before - firstStrict.after;
  const strictSecondStillActiveAge = thirdStrict.after - secondStrict.before;
  const strictFourthStillActiveAge = fourthStrict.after - secondStrict.before;

  if (
    fixedThirdAge < interval ||
    fixedFourthAge >= interval ||
    strictFirstExpiredAge < interval ||
    strictSecondStillActiveAge >= interval ||
    strictFourthStillActiveAge >= interval
  ) {
    await failTimingPrecondition(
      "The third call missed the fixed/rolling distinction window",
      {
        interval,
        fixedThirdAge,
        fixedFourthAge,
        strictFirstExpiredAge,
        strictSecondStillActiveAge,
        strictFourthStillActiveAge,
      },
      [fixed, strict],
      [
        firstFixed.value,
        firstStrict.value,
        secondFixed.value,
        secondStrict.value,
        thirdFixed.value,
        thirdStrict.value,
        fourthFixed.value,
        fourthStrict.value,
      ],
    );
  }

  assert.deepEqual(fixedStarted, [1, 2, 3, 4]);
  assert.deepEqual(strictStarted, [1, 2, 3]);
  assert.strictEqual(strict.pending, fourthStrict.value);
  assert.equal(strict.pendingCount, 1);
  assert.deepEqual(
    await Promise.all([firstFixed.value, secondFixed.value, thirdFixed.value, fourthFixed.value]),
    [1, 2, 3, 4],
  );
  assert.deepEqual(
    await Promise.all([
      firstStrict.value,
      secondStrict.value,
      thirdStrict.value,
      fourthStrict.value,
    ]),
    [1, 2, 3, 4],
  );
  assert.deepEqual(strictStarted, [1, 2, 3, 4]);

  return { status: "passed", assertions: "public scheduling behavior" };
}

/** @param {unknown[]} events @param {unknown} event */
function emit(events, event) {
  events.push(event);
  console.log(JSON.stringify({ event }));
}

async function runChildMode() {
  const [mode, secondArgument, thirdArgument, fourthArgument] = process.argv.slice(2);
  const expectedVersion = mode === "default-contract" ? undefined : secondArgument;
  const entryUrl = mode === "default-contract" ? secondArgument : thirdArgument;
  const defaultEntryUrl = mode === "default-contract" ? undefined : fourthArgument;
  const repoRoot = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
  const packageRoot = resolve(repoRoot, "packages/hesperia");

  if (mode === "default-contract") {
    if (!entryUrl?.startsWith("file:"))
      throw new Error("Expected the emitted default scheduling artifact file URL");

    const resolvedEntry = await realpath(fileURLToPath(entryUrl));
    const expectedEntry = await realpath(resolve(packageRoot, "dist/scheduling.js"));
    assert.equal(resolvedEntry, expectedEntry, "Expected the shipped default artifact, not source");
    const result = await verifySchedulingContract(await import(entryUrl));
    console.log(JSON.stringify({ ...result, runtime: "bun", entryUrl }));
    return;
  }

  if (mode === "native-contract" || mode === "fallback-contract") {
    if (!expectedVersion) throw new Error("Expected an exact Node runtime version");

    if (process.versions.node !== expectedVersion) {
      console.log(
        JSON.stringify({
          status: "unsupported",
          measurement: "unmeasured",
          expectedVersion,
          actualVersion: process.versions.node,
        }),
      );
      process.exitCode = 86;
      return;
    }

    if (!entryUrl?.startsWith("file:"))
      throw new Error("Expected the native scheduling artifact file URL from the package manifest");

    if (!defaultEntryUrl?.startsWith("file:"))
      throw new Error(
        "Expected the portable scheduling artifact file URL from the package manifest",
      );

    const resolvedUrl = import.meta.resolve("hesperia/scheduling");
    const resolvedEntry = await realpath(fileURLToPath(resolvedUrl));
    const expectedEntry = await realpath(fileURLToPath(entryUrl));
    assert.equal(resolvedEntry, expectedEntry, "Expected the emitted Node conditional entry");

    /** @type {{ status: string, assertions: string } | undefined} */
    let nativeReference;
    /** @type {{ debounce: number, throttle: number } | undefined} */
    let nativeDelegations;
    /** @type {{ status: string, assertions: string } | undefined} */
    let result;

    if (mode === "native-contract") {
      const nodeUtil = await import("node:util");
      const nativeApi = {
        debounce: Reflect.get(nodeUtil, "debounce"),
        throttle: Reflect.get(nodeUtil, "throttle"),
      };
      assert.equal(typeof nativeApi.debounce, "function");
      assert.equal(typeof nativeApi.throttle, "function");
      nativeReference = await verifySchedulingContract(nativeApi);

      const nativeUtilDefault = Reflect.get(nodeUtil, "default");
      const originalDebounce = Reflect.get(nativeUtilDefault, "debounce");
      const originalThrottle = Reflect.get(nativeUtilDefault, "throttle");
      /** @param {string} name */
      function getterDescriptor(name) {
        const descriptor = Object.getOwnPropertyDescriptor(nativeUtilDefault, name);
        assert.ok(descriptor?.configurable && descriptor.get);
        return descriptor;
      }
      const debounceDescriptor = getterDescriptor("debounce");
      const throttleDescriptor = getterDescriptor("throttle");
      const { syncBuiltinESMExports } = await import("node:module");

      /** @param {() => Promise<{ status: string, assertions: string }>} run */
      async function withNativeDelegationTracking(run) {
        const calls = { debounce: 0, throttle: 0 };
        /** @this {unknown} @param {unknown[]} arguments_ */
        function wrappedDebounce(...arguments_) {
          calls.debounce += 1;
          return Reflect.apply(originalDebounce, this, arguments_);
        }
        /** @this {unknown} @param {unknown[]} arguments_ */
        function wrappedThrottle(...arguments_) {
          calls.throttle += 1;
          return Reflect.apply(originalThrottle, this, arguments_);
        }
        try {
          Object.defineProperty(nativeUtilDefault, "debounce", {
            ...debounceDescriptor,
            get: () => wrappedDebounce,
          });
          Object.defineProperty(nativeUtilDefault, "throttle", {
            ...throttleDescriptor,
            get: () => wrappedThrottle,
          });
          syncBuiltinESMExports();
          return { result: await run(), calls };
        } finally {
          Object.defineProperty(nativeUtilDefault, "debounce", debounceDescriptor);
          Object.defineProperty(nativeUtilDefault, "throttle", throttleDescriptor);
          syncBuiltinESMExports();
        }
      }

      const failure = new Error("delegation probe failure");
      await assert.rejects(
        withNativeDelegationTracking(async () => {
          throw failure;
        }),
        failure,
      );
      assert.deepEqual(
        Object.getOwnPropertyDescriptor(nativeUtilDefault, "debounce"),
        debounceDescriptor,
      );
      assert.deepEqual(
        Object.getOwnPropertyDescriptor(nativeUtilDefault, "throttle"),
        throttleDescriptor,
      );
      assert.equal(Reflect.get(nodeUtil, "debounce"), originalDebounce);
      assert.equal(Reflect.get(nodeUtil, "throttle"), originalThrottle);

      const measured = await withNativeDelegationTracking(async () =>
        verifySchedulingContract(await import("hesperia/scheduling")),
      );
      result = measured.result;
      nativeDelegations = measured.calls;
      assert.ok(nativeDelegations.debounce > 0);
      assert.ok(nativeDelegations.throttle > 0);
    } else {
      result = await verifySchedulingContract(await import("hesperia/scheduling"));
    }

    assert.ok(result);
    const portableDefault = await verifySchedulingContract(await import(defaultEntryUrl));
    console.log(
      JSON.stringify({
        ...result,
        profile: mode === "native-contract" ? "native" : "fallback",
        runtime: process.versions.node,
        entryUrl: resolvedUrl,
        artifactPath: resolvedEntry,
        nativeReference: nativeReference?.status,
        nativeDelegations,
        portableDefault: portableDefault.status,
      }),
    );
    return;
  }

  if (mode === "liveness") {
    if (!expectedVersion) throw new Error("Expected an exact Node runtime version");

    if (process.versions.node !== expectedVersion) {
      console.log(
        JSON.stringify({
          status: "unsupported",
          measurement: "unmeasured",
          expectedVersion,
          actualVersion: process.versions.node,
        }),
      );
      process.exitCode = 86;
      return;
    }

    const { debounce, throttle } = await import("hesperia/scheduling");
    const [utility, action] = String(entryUrl).split(":");
    /** @type {unknown[]} */
    const events = [];
    console.log(JSON.stringify({ runtime: process.versions.node }));

    if (utility === "debounce") {
      const run = debounce(() => emit(events, "fired"), 100);
      if (action === "unref-before") run.unref();
      run();
      if (action === "unref-after") run.unref();
      if (action === "ref-after") {
        run.unref();
        assert.strictEqual(run.ref(), run);
      }
    } else if (utility === "throttle") {
      /** @param {unknown} value */
      function throttleEvent(value) {
        emit(events, value);
      }
      const run = throttle(throttleEvent, 1, 100);
      run("first");
      if (action === "unref-before") run.unref();
      run("second");
      if (action === "unref-after") run.unref();
      if (action === "ref-after") {
        run.unref();
        assert.strictEqual(run.ref(), run);
      }
    } else {
      throw new Error(`Unknown liveness utility ${utility}`);
    }

    console.log(JSON.stringify({ event: "armed" }));
    return;
  }

  throw new Error(`Unknown scheduling probe mode ${mode}`);
}

if (process.argv[1] !== undefined) {
  const invokedPath = pathToFileURL(resolve(process.argv[1])).href;

  if (invokedPath === import.meta.url) await runChildMode();
}
