import { expect, test } from "bun:test";
import { createGraph, createQuery, defineContract } from "aeolia";
import { createContractApi } from "../../src/data/contract.ts";
import { Owner, type RuntimeContext } from "../../src/runtime/owner.ts";
import { Scheduler } from "../../src/runtime/scheduler.ts";

test("await uses the request state after opening a failed query starts another fetch", async () => {
  const requests: Array<{ resolve(value: string): void; reject(reason: unknown): void }> = [];
  let recoveryStarted!: () => void;
  const recoveryStart = new Promise<void>((resolve) => {
    recoveryStarted = resolve;
  });
  const query = createQuery({
    name: "member-recovery.query",
    key: () => "member-recovery/query",
    fetch: () =>
      new Promise<string>((resolve, reject) => {
        requests.push({ resolve, reject });
        if (requests.length === 2) recoveryStarted();
      }),
  });
  const contract = defineContract({ namespace: "member-recovery", operations: { query } });
  const graph = createGraph({ contract });
  const context: RuntimeContext = {
    document: {} as Document,
    container: {} as Element,
    nextGeneration: 0,
    scheduler: undefined!,
    warn: () => undefined,
    onError: (error: unknown) => {
      throw error;
    },
  };
  const firstOwner = new Owner(context, null, "first");
  context.scheduler = new Scheduler(firstOwner);
  const secondOwner = new Owner(context, null, "second");
  firstOwner.commit();
  secondOwner.commit();
  try {
    const first = createContractApi(firstOwner, graph, contract).query(undefined);
    const failure = new Error("first fetch failed");
    const initialCompletion = first.ready.catch(() => undefined);
    requests[0]!.reject(failure);
    await initialCompletion;
    expect(first.status()).toBe("failed");

    const second = createContractApi(secondOwner, graph, contract).query(undefined);
    expect(second.status()).toBe("fetching");
    expect(second.error()).toBeUndefined();
    const result = Promise.resolve(second).then(
      (read) => ({ kind: "resolved", value: read() }),
      (reason: unknown) => ({ kind: "rejected", reason }),
    );
    await recoveryStart;
    expect(requests).toHaveLength(2);
    requests[1]!.resolve("recovered");
    expect(await result).toStrictEqual({
      kind: "resolved",
      value: "recovered",
    });
    await second.ready;
    expect(second.value()).toBe("recovered");
  } finally {
    firstOwner.dispose();
    secondOwner.dispose();
    graph.dispose();
  }
});
