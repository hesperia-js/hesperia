import * as client from "hesperia/client";

export default function Page() {
  const count = client.state(0);

  return (
    <main>
      <h1>Welcome to Hesperia</h1>
      <p>Your application is ready for its first route.</p>
      <button type="button" on:click={() => count.update((value) => value + 1)}>
        Count: {count()}
      </button>
    </main>
  );
}
