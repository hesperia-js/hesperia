import { afterEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import { createForm } from "../../packages/hesperia/src/validation/form.ts";
import { Owner, type RuntimeContext } from "../../packages/hesperia/src/runtime/owner.ts";

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
}

const windows: Window[] = [];
const owners: Owner[] = [];

afterEach(() => {
  for (const owner of owners.splice(0)) owner.dispose();

  for (const window of windows.splice(0)) window.close();
});

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });

  return { promise, resolve };
}

function schema<Input, Output>(
  validate: (
    value: unknown,
  ) => StandardSchemaV1.Result<Output> | Promise<StandardSchemaV1.Result<Output>>,
): StandardSchemaV1<Input, Output> {
  return {
    "~standard": {
      version: 1,
      vendor: "hesperia-form-tests",
      validate,
    },
  };
}

function createOwner(): { owner: Owner; window: Window } {
  const window = new Window();
  const context = {
    document: window.document,
    container: window.document.body,
    onError: (error: unknown) => {
      throw error;
    },
    warn: () => undefined,
    nextGeneration: 0,
    scheduler: undefined,
  } as unknown as RuntimeContext;
  const owner = new Owner(context, null, "form-test");

  owner.commit();
  owners.push(owner);
  windows.push(window);

  return { owner, window };
}

describe("owner-bound form validation", () => {
  test("resolves transformed values and preserves invalid issue paths as a successful check", async () => {
    const { owner } = createOwner();
    const issues: StandardSchemaV1.Issue[] = [
      { message: "literal field name", path: ["address.city"] },
      { message: "nested path", path: ["address", "city"] },
    ];
    const validator = schema<string, { city: string }>((input) => {
      const city = String(input).trim();

      if (city.length === 0) return { issues };

      return { value: { city } };
    });
    const form = createForm(owner, validator);

    const valid = await form.run("  Oslo ");

    expect(valid).toEqual({ value: { city: "Oslo" } });
    expect(form.status()).toBe("success");
    expect(form.value()).toEqual(valid);

    const invalid = await form.run("");

    expect(invalid).toEqual({ issues });
    expect(form.status()).toBe("success");
    expect(form.pending()).toBe(false);
    expect(form.error()).toBeUndefined();
    expect(form.value()).toEqual({ issues });
  });

  test("invokes synchronous validation before run returns and records sync and async provider faults", async () => {
    const { owner } = createOwner();
    const synchronousFailure = new Error("synchronous provider failed");
    const asynchronousFailure = new Error("asynchronous provider failed");
    let invoked = false;
    const validator = schema<string, string>((input) => {
      if (input === "sync") {
        invoked = true;

        return { value: "validated synchronously" };
      }

      if (input === "sync-failure") throw synchronousFailure;

      return Promise.reject(asynchronousFailure);
    });
    const form = createForm(owner, validator);
    const synchronous = form.run("sync");

    expect(invoked).toBe(true);

    await expect(synchronous).resolves.toEqual({ value: "validated synchronously" });

    const syncFault = form.run("sync-failure");

    await expect(syncFault).rejects.toBe(synchronousFailure);
    expect(form.status()).toBe("failure");
    expect(form.error()).toBe(synchronousFailure);

    const asyncFault = form.run("async-failure");

    expect(form.status()).toBe("pending");

    await expect(asyncFault).rejects.toBe(asynchronousFailure);
    expect(form.status()).toBe("failure");
    expect(form.error()).toBe(asynchronousFailure);
  });

  test("new runs clear prior results and errors, while reset returns idle and fences late results", async () => {
    const { owner } = createOwner();
    const issue = { message: "invalid" } satisfies StandardSchemaV1.Issue;
    const providerFailure = new Error("provider failed");
    const pendingResults: Deferred<StandardSchemaV1.Result<string>>[] = [];
    const validator = schema<string, string>((input) => {
      if (input === "issues") return { issues: [issue] };

      if (input === "failure") return Promise.reject(providerFailure);

      const result = deferred<StandardSchemaV1.Result<string>>();

      pendingResults.push(result);

      return result.promise;
    });
    const form = createForm(owner, validator);

    await expect(form.run("issues")).resolves.toEqual({ issues: [issue] });

    const afterIssues = form.run("pending-after-issues");

    expect(form.status()).toBe("pending");
    expect(form.pending()).toBe(true);
    expect(form.value()).toBeUndefined();
    expect(form.error()).toBeUndefined();

    form.reset();

    await expect(afterIssues).rejects.toBe(afterIssues.signal.reason);

    expect(form.status()).toBe("idle");
    expect(form.pending()).toBe(false);
    expect(form.value()).toBeUndefined();
    expect(form.error()).toBeUndefined();

    pendingResults[0]!.resolve({ value: "late after reset" });

    await expect(pendingResults[0]!.promise).resolves.toEqual({
      value: "late after reset",
    });

    expect(form.status()).toBe("idle");
    expect(form.value()).toBeUndefined();

    await expect(form.run("failure")).rejects.toBe(providerFailure);

    expect(form.status()).toBe("failure");
    expect(form.error()).toBe(providerFailure);

    const afterFailure = form.run("pending-after-failure");

    expect(form.status()).toBe("pending");
    expect(form.pending()).toBe(true);
    expect(form.value()).toBeUndefined();
    expect(form.error()).toBeUndefined();

    form.reset();

    await expect(afterFailure).rejects.toBe(afterFailure.signal.reason);

    pendingResults[1]!.resolve({ value: "late after second reset" });

    await expect(pendingResults[1]!.promise).resolves.toEqual({
      value: "late after second reset",
    });

    expect(form.status()).toBe("idle");
    expect(form.value()).toBeUndefined();
    expect(form.error()).toBeUndefined();
  });

  test("reset leaves a reentrant replacement run in control of form state", async () => {
    const { owner } = createOwner();
    const validations: Deferred<StandardSchemaV1.Result<string>>[] = [];
    const validator = schema<string, string>(() => {
      const validation = deferred<StandardSchemaV1.Result<string>>();

      validations.push(validation);

      return validation.promise;
    });
    const form = createForm(owner, validator);
    const original = form.run("original");
    let replacement: ReturnType<typeof form.run> | undefined;

    original.signal.addEventListener("abort", () => {
      replacement = form.run("replacement");
    });

    form.reset();

    expect(original.signal.aborted).toBe(true);
    expect(replacement).toBeDefined();
    expect(replacement?.signal.aborted).toBe(false);
    expect(form.status()).toBe("pending");

    await expect(original).rejects.toBe(original.signal.reason);

    validations[0]!.resolve({ value: "late original result" });

    await expect(validations[0]!.promise).resolves.toEqual({
      value: "late original result",
    });

    expect(form.status()).toBe("pending");
    expect(form.value()).toBeUndefined();

    validations[1]!.resolve({ value: "replacement result" });

    await expect(replacement!).resolves.toEqual({ value: "replacement result" });

    expect(form.status()).toBe("success");
    expect(form.value()).toEqual({ value: "replacement result" });
  });
});
