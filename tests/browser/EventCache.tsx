import { client } from "hesperia/client";

const calls: string[] = [];

export function eventCacheCalls() {
  return calls.slice();
}

export function CachedEventPage() {
  const sharedOnce = client.events.once(function (this: HTMLButtonElement, event: MouseEvent) {
    calls.push(`once:${this.id}:${event.currentTarget === this}`);
  });
  return (
    <main id="event-cache-one">
      <button id="event-cache-once-a" on:click={sharedOnce}>
        Once A
      </button>
      <button id="event-cache-once-b" on:click={sharedOnce}>
        Once B
      </button>
      <button id="event-cache-regular" on:click={() => calls.push("regular")}>
        Regular
      </button>
    </main>
  );
}

export function OtherEventPage() {
  return <main id="event-cache-two">Other</main>;
}
