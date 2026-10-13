import * as client from "hesperia/client";
import * as eventHelpers from "hesperia/events";

export interface NativeEventDelivery {
  readonly id: string;
  readonly thisId: string;
  readonly thisIsCurrentTarget: boolean;
  readonly targetId: string | null;
  readonly currentTargetId: string | null;
  readonly eventIsExpected: boolean;
}

export const deliveries: NativeEventDelivery[] = [];
export const captureOrder: string[] = [];
let expectedPlainEvent: Event | undefined;

export function expectPlainEvent(event: Event): void {
  expectedPlainEvent = event;
}

export function recordDelivery(id: string, thisValue: Element, event: Event): void {
  const target = event.target;
  const currentTarget = event.currentTarget;

  deliveries.push({
    id,
    thisId: thisValue.id,
    thisIsCurrentTarget: thisValue === currentTarget,
    targetId: target instanceof Element ? target.id : null,
    currentTargetId: currentTarget instanceof Element ? currentTarget.id : null,
    eventIsExpected: event === expectedPlainEvent,
  });
}

export default function NativeEvents() {
  const helpersMatch = client.events.once === eventHelpers.once;

  const sharedOnce = eventHelpers.once(function (this: Element, event: MouseEvent) {
    recordDelivery(this.id, this, event);
  });
  const clientOnce = client.events.once(function (this: Element, event: MouseEvent) {
    recordDelivery(this.id, this, event);
  });
  const literalOnce = [
    function (this: Element, event: MouseEvent) {
      recordDelivery(this.id, this, event);
    },
    { once: true },
  ] as const;
  const activeNonPassive = [(event: Event) => event.preventDefault(), { passive: false }] as const;

  return (
    <main data-events-helpers-match={String(helpersMatch)}>
      <button
        id="plain-handler"
        type="button"
        on:click={function (this: Element, event: MouseEvent) {
          recordDelivery(this.id, this, event);
        }}
      >
        Plain handler
      </button>
      <button id="shared-once-a" type="button" on:click={sharedOnce}>
        Shared once A
      </button>
      <button id="shared-once-b" type="button" on:click={sharedOnce}>
        Shared once B
      </button>
      <button id="client-once" type="button" on:click={clientOnce}>
        Client helper once
      </button>
      <button id="literal-once" type="button" on:click={literalOnce}>
        Literal once pair
      </button>
      <section
        id="capture-outer"
        on:click={eventHelpers.capture(() => {
          captureOrder.push("outer-capture");
        })}
      >
        <section
          id="capture-inner"
          on:click={eventHelpers.capture(() => {
            captureOrder.push("inner-capture");
          })}
        >
          <div
            id="capture-bubble"
            on:click={() => {
              captureOrder.push("ancestor-bubble");
            }}
          >
            <button
              id="capture-target"
              type="button"
              on:click={() => {
                captureOrder.push("target-bubble");
              }}
            >
              Capture order target
            </button>
          </div>
        </section>
      </section>
      <button
        id="passive-probe"
        type="button"
        on:hesperia-golden-probe={eventHelpers.passive((event: Event) => event.preventDefault())}
      >
        Passive cancellation probe
      </button>
      <button id="active-probe" type="button" on:hesperia-golden-probe={activeNonPassive}>
        Default cancellation probe
      </button>
    </main>
  );
}
