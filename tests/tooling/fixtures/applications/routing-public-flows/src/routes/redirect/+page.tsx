export default function Redirect() {
  const fixture = globalThis as unknown as { routingPublicFixture: { redirectBodies: number } };

  fixture.routingPublicFixture.redirectBodies += 1;

  // prettier-ignore
  return <main id="redirect">Redirect</main>;
}
