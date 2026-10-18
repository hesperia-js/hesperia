import type { Component } from "hesperia";
import * as client from "hesperia/client";

const events: string[] = [];

export function errorEvents() {
  return events.slice();
}

function failErrorView() {
  throw new Error("Error view failed");
}

export function FailingContent() {
  const failed = client.state(false);
  const field = <input id="error-content-field" />;

  client.cleanup(() => events.push(`content cleanup:${field.isConnected}`));

  client.effect(() => {
    if (failed()) throw new Error("Content failed");
  });

  return (
    <section>
      {field}
      <button id="fail-content" on:click={() => failed.set(true)}>
        Fail content
      </button>
    </section>
  );
}

export function ErrorView(props: Component.Props<{ error: unknown }>) {
  const failed = client.state(false);
  const message = <span id="error-message">{(props.error() as Error).message}</span>;

  client.cleanup(() => events.push(`error cleanup:${message.isConnected}`));

  client.effect(() => {
    events.push(`error effect:${message.isConnected}`);

    if (failed()) failErrorView();
  });

  return (
    <section>
      {message}
      <button id="fail-error" on:click={() => failed.set(true)}>
        Fail error view
      </button>
    </section>
  );
}
