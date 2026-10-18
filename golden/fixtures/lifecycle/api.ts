import { createGraph, createQuery, createStream, defineContract } from "aeolia";
import { withAeolia } from "hesperia/aeolia";

type PendingQuery = {
  readonly key: string;
  readonly resolve: (value: string) => void;
  readonly reject: (reason: unknown) => void;
  settled: boolean;
};

type StreamSession = {
  readonly id: number;
  readonly queue: number[];
  waiting: ((result: IteratorResult<number>) => void) | undefined;
  ended: boolean;
};

const queries: PendingQuery[] = [];
const queryCounts = new Map<string, number>();
const queryWaiters = new Map<string, Array<{ count: number; resolve: () => void }>>();
const queryCleanups = new Map<string, number>();
const queryCleanupWaiters = new Map<string, Array<{ count: number; resolve: () => void }>>();
const streamWaiters: Array<{ opens: number; aborts: number; resolve: () => void }> = [];
let streamOpens = 0;
let streamAborts = 0;
let currentSession: StreamSession | undefined;

function markStreamProgress(): void {
  for (let index = streamWaiters.length - 1; index >= 0; index--) {
    const waiter = streamWaiters[index]!;

    if (streamOpens < waiter.opens || streamAborts < waiter.aborts) continue;

    streamWaiters.splice(index, 1);

    waiter.resolve();
  }
}

function readQuery(key: string): Promise<string> {
  queryCounts.set(key, (queryCounts.get(key) ?? 0) + 1);

  const waiters = queryWaiters.get(key) ?? [];

  for (let index = waiters.length - 1; index >= 0; index--) {
    const waiter = waiters[index]!;

    if ((queryCounts.get(key) ?? 0) < waiter.count) continue;

    waiters.splice(index, 1);

    waiter.resolve();
  }

  queryWaiters.set(key, waiters);

  return new Promise<string>((resolve, reject) => {
    queries.push({ key, resolve, reject, settled: false });
  });
}

const numbers = createStream<string, number, string>({
  name: "lifecycle.numbers",
  key: (channel) => channel,
  open: (_channel, { abortSignal }): AsyncIterable<number> => {
    const session: StreamSession = {
      id: ++streamOpens,
      queue: [],
      waiting: undefined,
      ended: false,
    };
    currentSession = session;

    markStreamProgress();

    const end = () => {
      session.ended = true;

      session.waiting?.({ done: true, value: undefined });

      session.waiting = undefined;
    };

    abortSignal.addEventListener(
      "abort",
      () => {
        streamAborts++;

        if (currentSession === session) currentSession = undefined;

        end();

        markStreamProgress();
      },
      { once: true },
    );

    return {
      [Symbol.asyncIterator]() {
        return {
          next(): Promise<IteratorResult<number>> {
            if (session.ended) return Promise.resolve({ done: true, value: undefined });

            if (session.queue.length > 0)
              return Promise.resolve({ done: false, value: session.queue.shift()! });

            return new Promise((resolve) => {
              session.waiting = resolve;
            });
          },

          return(): Promise<IteratorResult<number>> {
            end();

            return Promise.resolve({ done: true, value: undefined });
          },
        };
      },
    };
  },
});

const read = createQuery<string, string, string>({
  name: "lifecycle.read",
  key: (key) => key,
  fetch: (key) => readQuery(key),
});

const contract = defineContract({
  namespace: "hesperia.golden.lifecycle",
  operations: { events: { numbers }, queries: { read } },
});
const graph = createGraph({ contract, idleMs: 50 });

export const api = withAeolia(graph, contract);

export function emitNumber(value: number): void {
  const session = currentSession;

  if (!session || session.ended) return;

  if (session.waiting) {
    const resolve = session.waiting;
    session.waiting = undefined;

    resolve({ done: false, value });
  } else session.queue.push(value);
}

export function streamStats(): { readonly opens: number; readonly aborts: number } {
  return { opens: streamOpens, aborts: streamAborts };
}

export function waitForStreamStats(opens: number, aborts: number): Promise<void> {
  if (streamOpens >= opens && streamAborts >= aborts) return Promise.resolve();

  return new Promise((resolve) => streamWaiters.push({ opens, aborts, resolve }));
}

export function queryRequestCount(key: string): number {
  return queryCounts.get(key) ?? 0;
}

export function waitForQueryRequests(key: string, count: number): Promise<void> {
  if (queryRequestCount(key) >= count) return Promise.resolve();

  return new Promise((resolve) => {
    const waiters = queryWaiters.get(key) ?? [];

    waiters.push({ count, resolve });

    queryWaiters.set(key, waiters);
  });
}

function takePendingQuery(key: string): PendingQuery {
  const query = queries.find((candidate) => candidate.key === key && !candidate.settled);

  if (!query) throw new Error(`No pending query request for ${key}`);

  query.settled = true;
  return query;
}

export function resolveQuery(key: string, value: string): void {
  takePendingQuery(key).resolve(value);
}

export function rejectQuery(key: string, reason: unknown): void {
  takePendingQuery(key).reject(reason);
}

export function recordQueryCleanup(key: string): void {
  const count = (queryCleanups.get(key) ?? 0) + 1;

  queryCleanups.set(key, count);

  const waiters = queryCleanupWaiters.get(key) ?? [];

  for (let index = waiters.length - 1; index >= 0; index--) {
    const waiter = waiters[index]!;

    if (count < waiter.count) continue;

    waiters.splice(index, 1);

    waiter.resolve();
  }

  queryCleanupWaiters.set(key, waiters);
}

export function queryCleanupCount(key: string): number {
  return queryCleanups.get(key) ?? 0;
}

export function waitForQueryCleanups(key: string, count: number): Promise<void> {
  if (queryCleanupCount(key) >= count) return Promise.resolve();

  return new Promise((resolve) => {
    const waiters = queryCleanupWaiters.get(key) ?? [];

    waiters.push({ count, resolve });

    queryCleanupWaiters.set(key, waiters);
  });
}

export function disposeGraph(): void {
  graph.dispose();
}
