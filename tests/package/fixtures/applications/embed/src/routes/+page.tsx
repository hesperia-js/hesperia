import { Embed } from "hesperia/embed";
import { mount } from "hesperia";
import * as client from "hesperia/client";
import { registerProjectPolicy } from "hesperia/runtime";

function Unsafe() {
  return <Embed name="unsafe" sandbox="allow-scripts allow-same-origin" srcdoc="<p>unsafe</p>" />;
}

function PermissiveChild() {
  return <Embed name="nested" sandbox="allow-scripts allow-same-origin" srcdoc="<p>nested</p>" />;
}

const RegisteredChild = registerProjectPolicy(PermissiveChild, { allowUnsafeEmbed: true });

function NestedRoot() {
  return <RegisteredChild />;
}

export default function Page() {
  const wrapper = client.bind<HTMLElement>();

  const sandbox = client.state("allow-scripts");

  const loads = client.state(0);

  const status = client.state("idle");

  let direct: ReturnType<typeof mount> | undefined;

  client.cleanup(() => direct?.dispose());

  function attempt(kind: "unsafe" | "nested") {
    direct?.dispose();

    direct = mount(
      document.querySelector("#direct-target")!,
      kind === "unsafe" ? Unsafe : NestedRoot,
      {},
      {
        onError: (error) => status.update(() => String(error)),
      },
    );

    if (document.querySelector('iframe[name="' + kind + '"]')) status.update(() => "mounted");
  }

  return (
    <main>
      <Embed
        bind={wrapper}
        name="primary"
        sandbox={sandbox()}
        srcdoc="<p>primary</p>"
        title="Primary frame"
        width={320}
        aspectRatio="16 / 9"
        on:load={client.events.once((event: Event) =>
          loads.update((value) => value + (event.type === "load" ? 1 : 0)),
        )}
        on:error={
          [
            (event: Event) => {
              event.preventDefault();

              status.update(() => (event.defaultPrevented ? "canceled" : "passive"));
            },
            { passive: true },
          ] as const
        }
      />
      <button
        id="binding"
        on:click={() =>
          status.update(() =>
            wrapper().isSameNode(
              document.querySelector('iframe[name="primary"]')?.parentElement ?? null,
            )
              ? "bound"
              : "unbound",
          )
        }
      >
        Binding
      </button>
      <button id="change" on:click={() => sandbox.update(() => "allow-scripts allow-same-origin")}>
        Change permission
      </button>
      <button id="unsafe" on:click={() => attempt("unsafe")}>
        Unsafe root
      </button>
      <button id="nested" on:click={() => attempt("nested")}>
        Nested policy
      </button>
      <output id="loads">{loads()}</output>
      <output id="status">{status()}</output>
      <div id="direct-target"></div>
    </main>
  );
}
