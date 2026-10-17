export default function Other() {
  return (
    <main id="other">
      <button id="back" on:click={() => history.back()}>
        Back
      </button>
      <a id="other-evict" href="/evict">
        Evict
      </a>
    </main>
  );
}
