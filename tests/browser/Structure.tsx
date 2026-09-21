import { type Component } from "hesperia";
import * as client from "hesperia/client";

export type RowValue = { id: string; label: string };

export const structureControls: {
  reorder(): void;
  updateRow(id: string, label: string): void;
  togglePanel(): void;
  replaceRaw(): void;
  dispose(): void;
} = {
  reorder: () => undefined,
  updateRow: () => undefined,
  togglePanel: () => undefined,
  replaceRaw: () => undefined,
  dispose: () => undefined,
};
let panelCleanups = 0;

export function getStructureControls() {
  return structureControls;
}

export function setStructureDispose(dispose: () => void) {
  Object.assign(structureControls, { dispose });
}

export function getPanelCleanupCount() {
  return panelCleanups;
}

function Row(props: Component.Props<RowValue>) {
  const local = client.state(0);
  return (
    <li data-row={props.id()}>
      <button on:click={() => local.update((value) => value + 1)}>
        {props.label()}:{local()}
      </button>
    </li>
  );
}

function Panel() {
  client.cleanup(() => {
    panelCleanups++;
  });
  return <aside id="panel">panel</aside>;
}

export default function Structure() {
  const rows = client.state<RowValue[]>([
    { id: "a", label: "A" },
    { id: "b", label: "B" },
    { id: "c", label: "C" },
  ]);
  const showPanel = client.state(true);
  const hostMarkup = client.state("<strong data-raw-host-content>host one</strong>");
  const fragmentMarkup = client.state(
    '<span data-raw-fragment="one">fragment one</span><span data-raw-fragment="two">fragment two</span>',
  );
  Object.assign(structureControls, {
    reorder() {
      rows.set([
        { id: "c", label: "C" },
        { id: "a", label: "A" },
        { id: "b", label: "B" },
      ]);
    },
    updateRow(_id: string, label: string) {
      rows.set([
        { id: "c", label: "C" },
        { id: "a", label: "A" },
        { id: "b", label },
      ]);
    },
    togglePanel() {
      showPanel.update((visible) => !visible);
    },
    replaceRaw() {
      hostMarkup.set(
        hostMarkup() === "<strong data-raw-host-content>host one</strong>"
          ? "<em data-raw-host-content>host two</em>"
          : "<strong data-raw-host-content>host three</strong>",
      );
      fragmentMarkup.set(
        fragmentMarkup().includes('data-raw-fragment="one"')
          ? '<span data-raw-fragment="three">fragment three</span><span data-raw-fragment="four">fragment four</span>'
          : '<span data-raw-fragment="five">fragment five</span><span data-raw-fragment="six">fragment six</span>',
      );
    },
  });
  return (
    <main id="structure">
      <section id="keyed-rows">
        <ul>
          {rows().map((row) => (
            <Row key={row.id} id={row.id} label={row.label} />
          ))}
        </ul>
      </section>
      <ul id="native-rows">
        {rows().map((row) => (
          <li key={row.id} data-native-row={row.id}>
            {showPanel() ? <span>{row.label}</span> : <em>{row.label}</em>}
          </li>
        ))}
      </ul>
      {showPanel() ? <Panel /> : <div id="panel-removed">removed</div>}
      {client.unsafeHTML(<article id="raw-host" />, hostMarkup())}
      {client.unsafeHTML(<></>, fragmentMarkup())}
      <section>{client.unsafeHTML(<article data-independent-raw="first" />, hostMarkup())}</section>
      <section>
        {client.unsafeHTML(<article data-independent-raw="second" />, hostMarkup())}
      </section>
      <svg>
        <foreignObject>
          <div>{client.unsafeHTML(<></>, '<a id="raw-integrated">native</a>')}</div>
        </foreignObject>
      </svg>
    </main>
  );
}
