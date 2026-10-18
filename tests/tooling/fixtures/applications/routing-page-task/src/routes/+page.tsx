import { api } from "../../api";
import { client } from "hesperia";

type TaskFixture = {
  started: number;
  releases: number;
  aborts: number;
  release?: (() => void) | undefined;
};

export default function TaskPage() {
  const shared = api.shared();

  const fixture = globalThis as unknown as { pageTaskFixture: TaskFixture };

  const task = client.task<void, string>(
    ({ signal }) =>
      () =>
        new Promise<string>((resolve) => {
          fixture.pageTaskFixture.started += 1;

          const release = () => {
            fixture.pageTaskFixture.releases += 1;

            fixture.pageTaskFixture.release = undefined;

            shared.set("settled");

            resolve("done");
          };

          fixture.pageTaskFixture.release = release;

          signal.addEventListener(
            "abort",
            () => {
              fixture.pageTaskFixture.aborts += 1;

              fixture.pageTaskFixture.release = undefined;
            },
            { once: true },
          );
        }),
  );

  const marker = <span id="task-effect" data-runs="0" data-value="" />;

  client.effect(() => {
    marker.dataset.value = shared();

    marker.dataset.runs = String(Number(marker.dataset.runs) + 1);
  });

  return (
    <main id="task">
      <button
        id="start"
        on:click={() => {
          void task.run();
        }}
      >
        Start
      </button>
      <a id="task-other" href="/other">
        Other
      </a>
      <output id="task-status">{task.status()}</output>
      {marker}
    </main>
  );
}
