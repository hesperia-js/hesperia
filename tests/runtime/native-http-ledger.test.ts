import { expect, test } from "bun:test";
import {
  NativeHttpWorkLedger,
  type NativeHttpRequestUseV1,
} from "../../packages/hesperia/src/runtime/native-http-work.ts";

function createLedgerUse() {
  const ledger = new NativeHttpWorkLedger(
    () => {},
    () => {},
    () => {
      throw new TypeError(
        "The retirement-only ledger fixture cannot authenticate a final response handoff",
      );
    },
    () => {},
  );
  const entry = {};
  const request = new Request("https://example.test/request");
  const use = ledger.acquire(entry, request);

  return { ledger, entry, request, use };
}

type UseRetirementOutcome =
  | { readonly kind: "fulfilled" }
  | { readonly kind: "rejected"; readonly reason: unknown };

interface TrackedNativeUse {
  readonly use: NativeHttpRequestUseV1;
  readonly outcome: Promise<UseRetirementOutcome>;
  readonly state: { settled: boolean };
  dispatched: boolean;
}

function trackNativeUse(uses: TrackedNativeUse[], use: NativeHttpRequestUseV1): TrackedNativeUse {
  const state = { settled: false };
  const outcome = use.retired.then(
    () => {
      state.settled = true;

      return { kind: "fulfilled" as const };
    },
    (reason: unknown) => {
      state.settled = true;

      return { kind: "rejected" as const, reason };
    },
  );
  const tracked = { use, outcome, state, dispatched: false };

  uses.push(tracked);

  return tracked;
}

function failTrackedUse(tracked: TrackedNativeUse, reason: unknown): void {
  if (tracked.dispatched) return;

  tracked.dispatched = true;
  tracked.use.failDispatch(reason);
}

function withTestDeadline<T>(
  operation: Promise<T>,
  description: string,
  timeoutMs = 3_000,
): Promise<T> {
  let timer!: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${description} did not settle before the test deadline`)),
      timeoutMs,
    );
  });

  return Promise.race([operation, deadline]).finally(() => clearTimeout(timer));
}

function finishTestCleanup(
  primaryFailure: { readonly error: unknown } | undefined,
  cleanupFailures: readonly unknown[],
  description: string,
): void {
  if (cleanupFailures.length > 0) {
    const cleanupFailure =
      cleanupFailures.length === 1
        ? cleanupFailures[0]
        : new AggregateError(cleanupFailures, `${description} cleanup failed`);

    if (primaryFailure) {
      try {
        console.error(
          `${description} cleanup failed after the primary test failure`,
          cleanupFailure,
        );
      } catch {
        // Preserve the primary failure if reporting is intercepted.
      }
    } else {
      throw cleanupFailure;
    }
  }

  if (primaryFailure) throw primaryFailure.error;
}

async function runWithTestCleanup(
  description: string,
  body: () => Promise<void>,
  cleanup: () => Promise<void>,
): Promise<void> {
  let primaryFailure: { readonly error: unknown } | undefined;
  const cleanupFailures: unknown[] = [];

  try {
    await body();
  } catch (error) {
    primaryFailure = { error };
  } finally {
    try {
      await cleanup();
    } catch (error) {
      cleanupFailures.push(error);
    }
  }

  finishTestCleanup(primaryFailure, cleanupFailures, description);
}

test("request-scope retirement binds once to the exact unclaimed ledger use", async () => {
  const uses: TrackedNativeUse[] = [];
  let resolveOriginal: (() => void) | undefined;
  let originalResolved = false;

  await runWithTestCleanup(
    "request-scope retirement ledger binding",
    async () => {
      const { ledger, entry, request, use: admittedUse } = createLedgerUse();
      const use = trackNativeUse(uses, admittedUse);
      const original = new Promise<void>((resolve) => {
        resolveOriginal = () => {
          if (originalResolved) return;

          originalResolved = true;
          resolve();
        };
      });

      expect(() => use.use.requestScopeRetired).toThrow(TypeError);

      expect(() => ledger.bindRequestScopeRetirement({}, request, use.use, original)).toThrow(
        TypeError,
      );

      const foreign = trackNativeUse(
        uses,
        ledger.acquire(entry, new Request("https://example.test/foreign")),
      );

      expect(() =>
        ledger.bindRequestScopeRetirement(entry, request, foreign.use, original),
      ).toThrow(TypeError);

      const sameUrlRequest = new Request(request.url);
      const sameUrlUse = trackNativeUse(uses, ledger.acquire(entry, sameUrlRequest));

      expect(sameUrlRequest).not.toBe(request);

      expect(() =>
        ledger.bindRequestScopeRetirement(entry, sameUrlRequest, use.use, original),
      ).toThrow(TypeError);

      ledger.bindRequestScopeRetirement(entry, request, use.use, original);

      expect(use.use.requestScopeRetired).toBe(original);

      expect(() => ledger.bindRequestScopeRetirement(entry, request, use.use, original)).toThrow(
        TypeError,
      );

      failTrackedUse(use, new Error("Finish the ledger use"));
      failTrackedUse(foreign, new Error("Finish the foreign ledger use"));

      if (resolveOriginal === undefined)
        throw new Error("The original retirement resolver was not installed");

      resolveOriginal();

      expect((await withTestDeadline(use.outcome, "bound use retirement")).kind).toBe("rejected");

      expect((await withTestDeadline(foreign.outcome, "foreign use retirement")).kind).toBe(
        "rejected",
      );

      const claimed = createLedgerUse();
      const claimedUse = trackNativeUse(uses, claimed.use);

      claimed.ledger.claim(claimed.entry, claimed.request);

      expect(() =>
        claimed.ledger.bindRequestScopeRetirement(
          claimed.entry,
          claimed.request,
          claimed.use,
          original,
        ),
      ).toThrow(TypeError);

      failTrackedUse(claimedUse, new Error("Finish the claimed ledger use"));

      await withTestDeadline(claimedUse.outcome, "claimed use retirement");

      const completed = createLedgerUse();
      const completedUse = trackNativeUse(uses, completed.use);

      failTrackedUse(completedUse, new Error("Complete the ledger use"));

      await withTestDeadline(completedUse.outcome, "completed use retirement");

      expect(() =>
        completed.ledger.bindRequestScopeRetirement(
          completed.entry,
          completed.request,
          completed.use,
          original,
        ),
      ).toThrow(TypeError);

      expect(sameUrlUse.state.settled).toBe(false);
    },
    async () => {
      const cleanupFailures: unknown[] = [];

      if (resolveOriginal) {
        try {
          resolveOriginal();
        } catch (error) {
          cleanupFailures.push(error);
        }
      }

      for (const tracked of uses) {
        try {
          failTrackedUse(tracked, new Error("Clean up the ledger use"));
        } catch (error) {
          cleanupFailures.push(error);
        }
      }

      try {
        await withTestDeadline(
          Promise.all(uses.map(({ outcome }) => outcome)).then(() => undefined),
          "ledger use cleanup retirement",
        );
      } catch (error) {
        cleanupFailures.push(error);
      }

      if (cleanupFailures.length > 0)
        throw new AggregateError(cleanupFailures, "Ledger binding test cleanup failed");
    },
  );
}, 20_000);
