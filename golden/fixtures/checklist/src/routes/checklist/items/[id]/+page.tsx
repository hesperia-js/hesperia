import { AsyncBoundary, type Component, type Page } from "hesperia";
import { api } from "../../../../api.ts";

async function ChecklistItemDetail(props: Component.Props<{ readonly id: string }>) {
  const detailView = api.items.detail(props.id());
  const detail = await detailView;
  const parkedList = api.items.list(undefined);
  const updateTask = api.items.updateWhileParked();

  function save(event: Event): void {
    event.preventDefault();

    const form = event.currentTarget as HTMLFormElement;
    const fields = new FormData(form);
    const item = detail();
    const label = String(fields.get("label") ?? "").trim();
    const done = (form.elements.namedItem("done") as HTMLInputElement).checked;

    if (!item || !label) return;

    void Promise.resolve(updateTask.run({ ...item, label, done })).catch(() => undefined);
  }

  return (
    <main id="checklist-item-detail" data-item-id={props.id()}>
      <h1>Checklist item</h1>
      <output id="detail-query-status">{detailView.status()}</output>
      <output id="parked-list-query-status">{parkedList.status()}</output>
      <output id="parked-list-query-pending">{String(parkedList.pending())}</output>
      <output id="detail-update-status">{updateTask.status()}</output>
      <output id="detail-route-label">{detail()?.label ?? "removed"}</output>
      <output id="detail-route-done">{String(detail()?.done ?? false)}</output>
      <form id="edit-checklist-item" on:submit={save}>
        <label>
          Label
          <input id="detail-edit-label" name="label" value={detail()?.label ?? ""} required />
        </label>
        <label>
          <input
            id="detail-edit-done"
            name="done"
            type="checkbox"
            checked={detail()?.done ?? false}
          />
          Done
        </label>
        <button id="save-checklist-item" type="submit">
          Save item
        </button>
      </form>
      <a id="return-to-checklist" href="/checklist">
        Return to checklist
      </a>
    </main>
  );
}

export default function ChecklistItemPage(props: Page.Props) {
  return (
    <AsyncBoundary fallback={<main id="checklist-item-loading">Loading item</main>}>
      <ChecklistItemDetail id={props.params.id} />
    </AsyncBoundary>
  );
}
