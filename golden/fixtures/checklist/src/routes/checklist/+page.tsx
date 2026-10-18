import { AsyncBoundary, type Component } from "hesperia";
import * as client from "hesperia/client";
import { api, type ChecklistItem } from "../../api.ts";

interface ItemRowProps {
  readonly id: string;
  readonly label: string;
  readonly done: boolean;
  readonly onSelect: () => void;
  readonly onToggle: () => void;
  readonly onRemove: () => void;
}

function ItemRow(props: Component.Props<ItemRowProps>) {
  return (
    <li id={"row-" + props.id()} data-item-id={props.id()} data-item-done={String(props.done())}>
      <button
        id={"select-" + props.id()}
        type="button"
        data-item-label
        on:click={() => props.onSelect()}
      >
        {props.label()}
      </button>
      <label>
        <input
          id={"done-" + props.id()}
          type="checkbox"
          checked={props.done()}
          on:change={() => props.onToggle()}
        />
        Done
      </label>
      <button id={"remove-" + props.id()} type="button" on:click={() => props.onRemove()}>
        Remove
      </button>
      <a id={"detail-" + props.id()} href={"/checklist/items/" + props.id()}>
        Details
      </a>
    </li>
  );
}

async function SelectedDetail(props: Component.Props<{ id: string }>) {
  const view = api.items.detail(props.id());
  const detail = await view;
  return (
    <section id="selected-detail" data-detail-id={props.id()}>
      <h2>Selected item</h2>
      <output id="detail-label">{detail()?.label ?? "removed"}</output>
      <output id="detail-done">{String(detail()?.done ?? false)}</output>
    </section>
  );
}

const lifecycleCounts = { starts: 0, effectCleanups: 0, ownerCleanups: 0 };
const routeLifecycleCounts = { starts: 0, effectCleanups: 0, ownerCleanups: 0 };

function publishLifecycleCounts(): void {
  const report = document.querySelector<HTMLOutputElement>("#lifecycle-report");

  if (!report) return;

  report.dataset.effectStarts = String(lifecycleCounts.starts);
  report.dataset.effectCleanups = String(lifecycleCounts.effectCleanups);
  report.dataset.ownerCleanups = String(lifecycleCounts.ownerCleanups);
}

function LifecycleProbe() {
  client.effect(() => {
    lifecycleCounts.starts++;

    publishLifecycleCounts();

    return () => {
      lifecycleCounts.effectCleanups++;

      publishLifecycleCounts();
    };
  });

  client.cleanup(() => {
    lifecycleCounts.ownerCleanups++;

    publishLifecycleCounts();
  });

  return <span id="lifecycle-probe">Mounted lifecycle probe</span>;
}

function CachedRouteProbe() {
  const reportRef: { current: HTMLOutputElement | null } = { current: null };

  function publish(): void {
    const report =
      reportRef.current ?? document.querySelector<HTMLOutputElement>("#route-cache-lifecycle");

    if (!report) return;

    reportRef.current = report;
    report.dataset.effectStarts = String(routeLifecycleCounts.starts);
    report.dataset.effectCleanups = String(routeLifecycleCounts.effectCleanups);
    report.dataset.ownerCleanups = String(routeLifecycleCounts.ownerCleanups);
  }

  client.effect(() => {
    routeLifecycleCounts.starts++;

    publish();

    return () => {
      routeLifecycleCounts.effectCleanups++;

      publish();
    };
  });

  client.cleanup(() => {
    routeLifecycleCounts.ownerCleanups++;

    publish();
  });

  return (
    <output
      id="route-cache-lifecycle"
      data-effect-starts="0"
      data-effect-cleanups="0"
      data-owner-cleanups="0"
    />
  );
}

async function ChecklistWorkspace() {
  const selectedId = client.state("seed-a");
  const showProbe = client.state(true);
  const latestResponses = client.state(0);
  const items = await api.items.list(undefined);
  const createTask = api.items.create();
  const updateTask = api.items.update();
  const removeTask = api.items.remove();
  const latestTask = client.task<string, string>(() => async (value) => {
    // Keep this transport alive after task cancellation so a late response tests publication gating.
    const response = await fetch("/checklist-api/latest", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ value }),
    });

    if (!response.ok) throw new Error("Latest-run request failed: " + response.status);

    const result = (await response.json()) as { readonly value: string };

    latestResponses.update((count) => count + 1);

    return result.value;
  });

  function submitNewItem(event: Event): void {
    event.preventDefault();

    const form = event.currentTarget as HTMLFormElement;
    const fields = new FormData(form);
    const id = String(fields.get("id") ?? "").trim();
    const label = String(fields.get("label") ?? "").trim();

    if (!id || !label) return;

    void Promise.resolve(createTask.run({ id, label, done: false })).catch(() => undefined);

    form.reset();
  }

  function update(item: ChecklistItem): void {
    void Promise.resolve(updateTask.run({ ...item, done: !item.done })).catch(() => undefined);
  }

  function remove(id: string): void {
    void Promise.resolve(removeTask.run({ id })).catch(() => undefined);
  }

  function startLatest(value: string): void {
    void Promise.resolve(latestTask.run(value)).catch(() => undefined);
  }

  return (
    <main id="checklist">
      <h1>Checklist</h1>
      <form id="create-item" on:submit={submitNewItem}>
        <label>
          Item id
          <input id="new-item-id" name="id" required />
        </label>
        <label>
          Item label
          <input id="new-item-label" name="label" required />
        </label>
        <button type="submit">Create item</button>
      </form>

      <ul id="item-list">
        {items().map((item) => (
          <ItemRow
            key={item.id}
            id={item.id}
            label={item.label}
            done={item.done}
            onSelect={() => selectedId.set(item.id)}
            onToggle={() => update(item)}
            onRemove={() => remove(item.id)}
          />
        ))}
      </ul>

      <AsyncBoundary fallback={<p id="detail-loading">Loading selected item</p>}>
        <SelectedDetail key={selectedId()} id={selectedId()} />
      </AsyncBoundary>

      <section aria-label="Page-local browser state">
        <label>
          Draft note
          <input id="page-local-note" />
        </label>
        <label>
          <input id="page-local-choice" type="checkbox" />
          Retain this local choice
        </label>
      </section>

      <section aria-label="Latest-run task">
        <button id="run-older" type="button" on:click={() => startLatest("older")}>
          Run older
        </button>
        <button id="run-latest" type="button" on:click={() => startLatest("latest")}>
          Run latest
        </button>
        <output id="latest-task">
          {latestTask.status()}:{latestTask.value() ?? "none"}
        </output>
        <output id="latest-response-count">{String(latestResponses())}</output>
      </section>

      <section aria-label="Component lifecycle">
        <button
          id="toggle-probe"
          type="button"
          on:click={() => showProbe.update((visible) => !visible)}
        >
          Toggle probe
        </button>
        {showProbe() ? <LifecycleProbe /> : <span id="probe-hidden">Probe hidden</span>}
        <output
          id="lifecycle-report"
          data-effect-starts="0"
          data-effect-cleanups="0"
          data-owner-cleanups="0"
        />
      </section>

      <CachedRouteProbe />
    </main>
  );
}

export default function ChecklistPage() {
  return (
    <AsyncBoundary fallback={<main id="checklist-loading">Loading checklist</main>}>
      <ChecklistWorkspace />
    </AsyncBoundary>
  );
}
