import { expect, spyOn, test } from "bun:test";
import { API } from "typescript/unstable/async";
import { openCheckingProject } from "../../packages/compiler/src/checking.ts";

test("repeated session disposal shares one cleanup promise", async () => {
  const session = await openCheckingProject([
    { filename: "dispose-twice.ts", source: "export const value = 1;" },
  ]);
  const first = session.dispose();
  const second = session.dispose();

  expect(second).toBe(first);

  await Promise.all([first, second]);
});

test(
  "snapshot setup failure waits for checker cleanup and preserves both failures",
  async () => {
    const checkingFailure = new Error("snapshot setup failed");
    const cleanupFailure = new Error("checker cleanup failed");
    let enterClose!: () => void;
    let releaseClose!: () => void;
    const closeEntered = new Promise<void>((resolve) => {
      enterClose = resolve;
    });
    const closeGate = new Promise<void>((resolve) => {
      releaseClose = resolve;
    });
    const updateSnapshot = spyOn(API.prototype, "updateSnapshot").mockImplementation(async () => {
      throw checkingFailure;
    });
    const close = spyOn(API.prototype, "close").mockImplementation(async () => {
      enterClose();

      await closeGate;
      throw cleanupFailure;
    });

    try {
      let settled = false;
      const rejected = openCheckingProject([
        { filename: "failed-snapshot.ts", source: "export const value = 1;" },
      ]).then(
        () => {
          throw new Error("checking unexpectedly succeeded");
        },
        (error: unknown) => error,
      );

      void rejected.then(() => {
        settled = true;
      });

      await closeEntered;

      expect(settled).toBe(false);

      releaseClose();

      const error = await rejected;

      expect(error).toBeInstanceOf(AggregateError);

      expect(error).toMatchObject({
        cause: checkingFailure,
        errors: [checkingFailure, cleanupFailure],
        message: "TypeScript checking and cleanup failed",
      });

      expect(close).toHaveBeenCalledTimes(1);
    } finally {
      releaseClose();

      updateSnapshot.mockRestore();

      close.mockRestore();
    }
  },
  { timeout: 10_000 },
);
