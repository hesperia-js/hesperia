import { createGraph, createQuery, defineContract, type QueryStore } from "aeolia";
import { reset, withAeolia } from "hesperia/aeolia";

const recovery = createQuery({
  name: "browser.async-recovery",
  key: (name: string) => name,
  fetch: async (name, { abortSignal }) => {
    const response = await fetch(`/api/async-recovery/${name}`, { signal: abortSignal });

    if (!response.ok) throw new Error(await response.text());

    const result = (await response.json()) as { readonly value: string | null };
    return result.value ?? undefined;
  },
});

const contract = defineContract({
  namespace: "browser.async-recovery",
  operations: { recovery },
});
const graph = createGraph({ contract });
const graphApi = graph.api;
export const api = withAeolia(graph, contract);

interface CapturedSource {
  readonly source: QueryStore<unknown>;
  readonly view: { readonly source: QueryStore<unknown> };
  accessor?: () => unknown;
}

const captured = new Map<string, CapturedSource>();
let nextResetId = 0;
const resets = new Map<
  number,
  | { readonly id: number; readonly status: "pending" }
  | { readonly id: number; readonly status: "fulfilled" }
  | {
      readonly id: number;
      readonly status: "rejected";
      readonly error: { readonly name: string; readonly message: string };
    }
>();

export function captureQuery<T>(name: string, view: { readonly source: QueryStore<T> }): void {
  if (!captured.has(name))
    captured.set(name, {
      source: view.source as QueryStore<unknown>,
      view: view as { readonly source: QueryStore<unknown> },
    });
}

export function captureAccessor<T>(name: string, accessor: () => T): void {
  const entry = captured.get(name);

  if (entry && entry.accessor === undefined) entry.accessor = accessor;
}

export function beginReset(kind: "bridge" | "graph"): number {
  const id = ++nextResetId;

  resets.set(id, { id, status: "pending" });

  const result = kind === "bridge" ? reset(api) : graph.reset();

  void result.then(
    () => resets.set(id, { id, status: "fulfilled" }),
    (error: unknown) => {
      const reason = error instanceof Error ? error : new Error(String(error));

      resets.set(id, {
        id,
        status: "rejected",
        error: { name: reason.name, message: reason.message },
      });
    },
  );

  return id;
}

export function resetState(id: number) {
  return resets.get(id) ?? { id, status: "missing" as const };
}

export function resetIdentity(name: string) {
  const original = captured.get(name);
  const current = graphApi.recovery(name);
  return {
    graphApi: graph.api === graphApi,
    key: original?.source.key === current.key,
    graph: original?.source.graph === current.graph,
    value: original?.source.value === current.value,
    currentValue: original?.source.value.get(),
    resetVersion: graph.resetVersion.get(),
  };
}

export function savedQueryValue(name: string) {
  return captured.get(name)?.source.value.get();
}

export function savedSourceState(name: string) {
  const source = captured.get(name)?.source;
  return {
    status: source?.status.get(),
    pending: source?.pending.get(),
    value: source?.value.get(),
    valueIsUndefined: source?.value.get() === undefined,
  };
}

export function probeStaleAccessor(name: string) {
  try {
    return { threw: false as const, value: captured.get(name)?.accessor?.() };
  } catch (error) {
    return errorState(error);
  }
}

function errorState(error: unknown) {
  const reason = error instanceof Error ? error : new Error(String(error));
  const kind = "kind" in reason && typeof reason.kind === "string" ? reason.kind : undefined;
  return { threw: true as const, name: reason.name, message: reason.message, kind };
}

export function probeDisposedViewSource(name: string) {
  try {
    return { threw: false as const, source: captured.get(name)?.view.source.key };
  } catch (error) {
    return errorState(error);
  }
}
