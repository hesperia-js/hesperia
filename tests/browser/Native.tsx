import { bind as element, cleanup, effect as observe, state, unsafeBind } from "hesperia/client";

const formEvents: string[] = [];
export function nativeFormEvents() {
  return formEvents.slice();
}

function NativeForm() {
  const result = state("");
  const controller = new AbortController();
  const form = (
    <form
      id="constructor-form"
      on:submit={(event) => {
        event.preventDefault();
        const data = new FormData(form);
        const address = new URL("/profile", window.location.href);
        address.searchParams.set("name", String(data.get("name")));
        result.set(address.pathname + address.search);
        form.dispatchEvent(new CustomEvent("profile-ready", { detail: address.pathname }));
      }}
    >
      <input id="constructor-name" name="name" value="Ada" />
      <button id="constructor-submit" type="submit">
        Read form
      </button>
      <output id="constructor-result">{result()}</output>
    </form>
  );
  observe(() => {
    form.addEventListener("profile-ready", (event) => formEvents.push(event.type), {
      signal: controller.signal,
    });
  });
  cleanup(() => controller.abort());
  return form;
}

export default function Native() {
  const circle = element<SVGCircleElement>();
  const field = element<HTMLInputElement>();
  const math = element<MathMLElement>();
  const optional = unsafeBind<HTMLSpanElement>();
  const bindings = state("");
  const eventResult = state("");
  const optionalValue = state("");

  observe(() => {
    optionalValue.set(optional() ? "present" : "absent");
  });

  observe(() => {
    bindings.set(
      [
        circle().namespaceURI,
        circle().r.baseVal.value,
        field().namespaceURI,
        math().namespaceURI,
      ].join("|"),
    );
  });

  const content = (
    <section id="native" style="color: rgb(255, 0, 0)">
      <svg viewBox="0 0 10 10">
        <a id="svg-link" href="#native">
          <circle id="circle" bind={circle} r={3} cx={5} cy={5} />
        </a>
        <foreignObject>
          <input
            id="native-input"
            bind={field}
            on:keydown={(event) => eventResult.set(event.key)}
          />
        </foreignObject>
      </svg>
      <math>
        <mi id="math-token" bind={math}>
          x
        </mi>
        <mtext>
          <span id="math-html">text</span>
        </mtext>
      </math>
      <button
        id="native-click"
        on:click={function (event) {
          eventResult.set(this.tagName + ":" + event.clientX);
        }}
      >
        Click
      </button>
      <output id="binding-result">{bindings()}</output>
      <output id="event-result">{eventResult()}</output>
      <span id="optional-native" bind={optional}>
        optional
      </span>
      <output id="optional-result">{optionalValue()}</output>
      <NativeForm />
    </section>
  );
  return content;
}
