export default function Broken() {
  const failure = new Error("native navigation render failed");

  const fixture = globalThis as unknown as { routingPublicFixture: { renderFailure?: Error } };

  fixture.routingPublicFixture.renderFailure = failure;

  throw failure;
}
