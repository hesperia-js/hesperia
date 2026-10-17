export default function Blocked() {
  const fixture = globalThis as unknown as { routingPublicFixture: { blockedBodies: number } };

  fixture.routingPublicFixture.blockedBodies += 1;

  // prettier-ignore
  return <main id="blocked">Blocked</main>;
}
