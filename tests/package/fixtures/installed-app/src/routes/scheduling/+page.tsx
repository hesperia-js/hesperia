import * as client from "hesperia/client";
import { debounce } from "hesperia/scheduling";

function SchedulingControl() {
  const result = client.state("idle");
  const lifetime = new AbortController();
  const run = debounce((value: string) => result.set(value), 20, {
    signal: lifetime.signal,
  });

  client.cleanup(() => {
    lifetime.abort();
    document.documentElement.dataset.installedSchedulingCleanup = "true";
  });

  const schedule = () => {
    void run("packed scheduling").catch(() => undefined);
  };

  return (
    <section id="installed-scheduling-control">
      <button id="installed-schedule" type="button" on:click={schedule}>
        Run scheduling utility
      </button>
      <output id="installed-scheduling-result">{result()}</output>
    </section>
  );
}

export default function SchedulingPage() {
  const removed = client.state(false);

  return (
    <main>
      {!removed() ? <SchedulingControl /> : <span id="installed-scheduling-removed">Removed</span>}
      <button id="remove-installed-scheduling" type="button" on:click={() => removed.set(true)}>
        Remove scheduling utility
      </button>
      <a id="leave-installed-scheduling" href="deep/link">
        Leave scheduling
      </a>
    </main>
  );
}
