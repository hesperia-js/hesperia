// oxlint-disable-next-line no-unused-vars -- Preserve the authored routing input from the saved control.
import type { Component } from "hesperia";
import { client } from "hesperia";
import { beforeLeave } from "hesperia/navigation";

function GuardedEditor() {
  const dirty = client.state(true);

  beforeLeave(() => {
    const fixture = globalThis as unknown as {
      routingPublicFixture: {
        beforeLeaveChecks: number;
        reloadEnabled: boolean;
        reloadTrace: string[];
        reloadTimeline: string[];
      };
    };

    fixture.routingPublicFixture.beforeLeaveChecks += 1;

    const reload = fixture.routingPublicFixture.reloadEnabled;

    if (reload) {
      fixture.routingPublicFixture.reloadTrace.push("editor:started");

      fixture.routingPublicFixture.reloadTimeline.push("editor:started");
    }

    const allowed = !dirty();

    if (reload) {
      fixture.routingPublicFixture.reloadTrace.push("editor:settled");

      fixture.routingPublicFixture.reloadTimeline.push("editor:settled");
    }

    return allowed;
  });

  // prettier-ignore
  return <button id="allow-leave" on:click={() => dirty.set(false)}>Allow leave</button>;
}

export default function Home() {
  const fixture = globalThis as unknown as {
    routingPublicFixture: { homeBodies: number; homeInstance?: string };
  };

  fixture.routingPublicFixture.homeBodies += 1;

  fixture.routingPublicFixture.homeInstance = crypto.randomUUID();

  const reloadState = client.state(0);

  const check = (
    globalThis as unknown as {
      routingPublicReloadCheck: (name: string) => boolean | Promise<boolean>;
    }
  ).routingPublicReloadCheck;

  beforeLeave(() => check("page"));

  const removeGuard = client.state(false);

  // prettier-ignore
  return <main id="home" data-bodies={String(fixture.routingPublicFixture.homeBodies)} data-home-instance={fixture.routingPublicFixture.homeInstance}>
    <button id="bump-page-state" on:click={() => reloadState.set(reloadState() + 1)}>Page state</button>
    <output id="page-state">{String(reloadState())}</output>
    {!removeGuard() ? <GuardedEditor /> : null}
    <button id="remove-guard" on:click={() => removeGuard.set(true)}>Remove guard</button>
    {!removeGuard() ? <span id="guard-mounted">guard mounted</span> : <span id="guard-removed">guard removed</span>}
    <a href="/target" id="home-target">Target</a>
  </main>;
}
