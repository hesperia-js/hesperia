import * as client from "hesperia/client";
import { debounce } from "hesperia/scheduling";

export default function SchedulingPage() {
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
    <main>
      <button id="installed-schedule" type="button" on:click={schedule}>
        Run scheduling utility
      </button>
      <output id="installed-scheduling-result">{result()}</output>
      <a id="leave-installed-scheduling" href="deep/link">
        Leave scheduling
      </a>
    </main>
  );
}
