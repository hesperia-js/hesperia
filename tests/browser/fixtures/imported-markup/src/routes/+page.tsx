import * as client from "hesperia/client";
import { mount } from "hesperia";
import Fragment from "../fragment.html" with { type: "html" };
import Panel from "../panel.html" with { type: "html" };

export default function Page() {
  const title = client.state("initial");
  const clicks = client.state(0);
  const listener = client.state<() => void>(() => clicks.update((current) => current + 1));
  const boundId = client.state("missing");
  const rows = client.state<string[]>([]);
  const first = client.unsafeBind<HTMLButtonElement>();
  const second = client.unsafeBind<HTMLButtonElement>();
  const badSriState = client.state("idle");

  return (
    <main>
      <button id="show-panels" on:click={() => rows.set(["first", "second"])}>
        Show panels
      </button>
      <button
        id="mount-direct"
        on:click={() => {
          const frame = document.createElement("iframe");
          frame.id = "direct-frame";
          frame.srcdoc = "<!doctype html><html><head></head><body></body></html>";

          frame.addEventListener(
            "load",
            () => {
              try {
                const target = frame.contentDocument?.body;

                if (!target) throw new Error("The second Document has no body target");

                mount(target, Panel, { id: "direct", title: "direct" });
              } catch (error) {
                const output = document.querySelector<HTMLOutputElement>("#direct-error");

                if (output)
                  output.textContent = error instanceof Error ? error.message : String(error);
              }
            },
            { once: true },
          );

          document.body.append(frame);
        }}
      >
        Mount directly into second Document
      </button>
      <button id="update" on:click={() => title.set("updated")}>
        Update title
      </button>
      <button id="replace-listener" on:click={() => listener.set(() => clicks.set(10))}>
        Replace listener
      </button>
      <button id="inspect" on:click={() => boundId.set(first()?.id ?? "missing")}>
        Inspect bind
      </button>
      <button id="remove-first" on:click={() => rows.set(["second"])}>
        Remove first
      </button>
      <button id="remove-all" on:click={() => rows.set([])}>
        Remove all
      </button>
      <button
        id="load-managed-bad-sri"
        on:click={async () => {
          badSriState.set("pending");

          try {
            const { mountBadMarkup } = await import("../bad-sri.tsx");
            const target = document.querySelector<HTMLElement>("#managed-bad-sri-target");

            if (!target) throw new Error("The managed bad-SRI target was not found");

            await mountBadMarkup(target);

            badSriState.set("mounted");
          } catch (error) {
            badSriState.set(`rejected: ${error instanceof Error ? error.message : String(error)}`);
          }
        }}
      >
        Load bad-SRI imported markup
      </button>
      <div id="managed-bad-sri-target" class="managed-bad-sri-target"></div>
      {rows().map((id) => (
        <Panel
          key={id}
          id={id}
          title={id === "first" ? title() : id}
          bind={id === "first" ? first : second}
          on:click={id === "second" ? ([listener(), { once: true }] as const) : listener()}
        />
      ))}
      <Fragment />
      <output id="direct-error"></output>
      <output id="managed-bad-sri-state">{badSriState()}</output>
      <output id="bound-id">{boundId()}</output>
      <output id="clicks">{clicks()}</output>
    </main>
  );
}
