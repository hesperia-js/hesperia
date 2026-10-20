interface ApplicationRoutingGlobals {
  savedDraft: Element | null;
  savedSlowEffects: HTMLElement | SVGElement;
  slowBodies: number;

  resetRoutingApi(): void;

  getRoutingMessageRequests(): number;
}

interface RouteOutcomeFixture {
  waitForSlowCommit(): Promise<unknown>;

  waitingForSlow: boolean;
}

interface PageTaskFixture {
  started: number;
  releases: number;
  aborts: number;
  release?: () => void;
}

declare global {
  interface Window {
    fixtureStartup: "pending" | "ready" | "failed";
    fixtureError: string;
    fixtureCssHeld: boolean;
    fixturePushState: History["pushState"];
    fixtureEffects: { name: string; color: string; display: string }[];
  }

  var beforeReloadMarker: boolean | undefined;

  var documentIdentity: number;

  var apiOutcome: string;

  var departures: number;

  var removals: number;

  var styleRevisions: number;

  var savedDraft: ApplicationRoutingGlobals["savedDraft"];

  var savedSlowEffects: ApplicationRoutingGlobals["savedSlowEffects"];

  var slowBodies: ApplicationRoutingGlobals["slowBodies"];

  var resetRoutingApi: ApplicationRoutingGlobals["resetRoutingApi"];

  var getRoutingMessageRequests: ApplicationRoutingGlobals["getRoutingMessageRequests"];

  var routeOutcomeFixture: RouteOutcomeFixture;

  var pageTaskFixture: PageTaskFixture;
}

export {};
