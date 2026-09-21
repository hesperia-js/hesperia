import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { prepareBuild, ProjectError, writeBuild } from "../../src/tooling/project.ts";
import { previewProject } from "../../src/tooling/server.ts";

test("generated public routing flows preserve ownership, shared freshness, and guard boundaries", async () => {
  const parent = resolve(import.meta.dir, "../../.hesperia");
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, "routing-public-flows-"));
  let server: Awaited<ReturnType<typeof previewProject>> | undefined;
  try {
    const sources = {
      "app.config.ts": `import type { AppConfiguration } from "hesperia";
export default { pageCacheSize: 1 } satisfies AppConfiguration;`,
      "app.tsx": `import type { Component, Rendered } from "hesperia";
import { client } from "hesperia";
import { Router } from "hesperia/routing";
import { api } from "./api";

Object.assign(globalThis, { routingPublicFixture: { beforeLeaveChecks: 0, homeBodies: 0, cachedBodies: 0, blockedBodies: 0, redirectBodies: 0, sharedUpdateDone: false, navigationResults: [], router: undefined } });
const originalNavigate = Router.prototype.navigate;
Router.prototype.navigate = function (this: Router, target, options) {
  (globalThis as unknown as { routingPublicFixture: { router: Router } }).routingPublicFixture.router = this;
  const result = originalNavigate.call(this, target, options);
  void result.then(outcome => {
    (globalThis as unknown as { routingPublicFixture: { navigationResults: unknown[] } }).routingPublicFixture.navigationResults.push(outcome);
  });
  return result;
};

export default function App(props: Component.Props<{ children: Rendered }>) {
  const shared = api.message("shared");
  const update = api.update();
  const fixture = globalThis as unknown as { routingPublicFixture: { sharedUpdateDone: boolean } };
  return <html><head><title>Public routing flows</title></head><body>
    <nav>
      <a id="nav-home" href="/">Home</a>
      <a id="nav-target" href="/target">Target</a>
      <a id="nav-blocked" href="/blocked">Blocked</a>
      <a id="nav-redirect" href="/redirect">Redirect</a>
      <a id="nav-cached" href="/cached">Cached</a>
      <a id="nav-user" href="/users/one?tab=first">User</a>
      <a id="nav-missing" href="/missing">Missing</a>
      <button id="update-shared" on:click={() => { fixture.routingPublicFixture.sharedUpdateDone = false; void update.run({ id: "shared" }).then(() => { fixture.routingPublicFixture.sharedUpdateDone = true; }); }}>Update shared</button>
      <output id="shared-shell">{shared.value()?.message ?? ""}</output>
    </nav>
    {props.children()}
  </body></html>;
}`,
      "api.ts": `import { affects, createGraph, createMutation, createQuery, defineContract } from "aeolia";
import { withAeolia } from "hesperia/aeolia";
const message = createQuery({
  name: "message",
  key: (id: string) => id,
  fetch: async (id, { abortSignal }) => {
    const response = await fetch("/api/message/" + id, { signal: abortSignal });
    if (!response.ok) throw new Error(await response.text());
    return await response.json() as { message: string };
  },
});
const update = createMutation({
  name: "message.update",
  run: async (input: { id: string }, { abortSignal }) => {
    const response = await fetch("/api/update", { method: "POST", body: JSON.stringify(input), signal: abortSignal });
    if (!response.ok) throw new Error(await response.text());
    return await response.json() as { ok: true };
  },
  affects: [affects(message, { select: (input: { id: string }) => input.id, on: "revalidate" })],
});
const contract = defineContract({ namespace: "public-routing", operations: { message, update } });
const graph = createGraph({ contract });
export const api = withAeolia(graph, contract);`,
      "src/routes/+layout.tsx": `import type { Component, Rendered } from "hesperia";
export default function Layout(props: Component.Props<{ children: Rendered }>) {
  return <section id="route-layout">{props.children()}</section>;
}`,
      "src/routes/+loading.tsx": `export default function Loading() { return <span id="loading">Loading</span>; }`,
      "src/routes/+not-found.tsx": `export default function NotFound() { return <main id="not-found">Not found</main>; }`,
      "src/routes/+page.tsx": `import type { Component } from "hesperia";
import { client } from "hesperia";

function GuardedEditor() {
  const dirty = client.state(true);
  client.navigation.beforeLeave(() => {
    const fixture = globalThis as unknown as { routingPublicFixture: { beforeLeaveChecks: number } };
    fixture.routingPublicFixture.beforeLeaveChecks += 1;
    return !dirty();
  });
  return <button id="allow-leave" on:click={() => dirty.set(false)}>Allow leave</button>;
}

export default function Home() {
  const fixture = globalThis as unknown as { routingPublicFixture: { homeBodies: number } };
  fixture.routingPublicFixture.homeBodies += 1;
  const removeGuard = client.state(false);
  return <main id="home" data-bodies={String(fixture.routingPublicFixture.homeBodies)}>
    {!removeGuard() ? <GuardedEditor /> : null}
    <button id="remove-guard" on:click={() => removeGuard.set(true)}>Remove guard</button>
    {!removeGuard() ? <span id="guard-mounted">guard mounted</span> : <span id="guard-removed">guard removed</span>}
    <a href="/target" id="home-target">Target</a>
  </main>;
}`,
      "src/routes/cached/+page.tsx": `import { api } from "../../../api";
import { effect } from "hesperia/client";
export default async function Cached() {
  const fixture = globalThis as unknown as { routingPublicFixture: { cachedBodies: number } };
  fixture.routingPublicFixture.cachedBodies += 1;
  const message = await api.message("shared");
  const marker = <span id="cached-effect" data-runs="0" data-cleanups="0" />;
  effect(() => {
    marker.dataset.value = message().message;
    marker.dataset.runs = String(Number(marker.dataset.runs) + 1);
    return () => { marker.dataset.cleanups = String(Number(marker.dataset.cleanups) + 1); };
  });
  return <main id="cached" data-bodies={String(fixture.routingPublicFixture.cachedBodies)}><span id="cached-message">{message().message}</span>{marker}<a id="cached-parking" href="/parking">Parking</a></main>;
}`,
      "src/routes/parking/+page.tsx": `export default function Parking() {
  return <main id="parking">Parking</main>;
}`,
      "src/routes/target/+page.tsx": `export default function Target() {
  return <main id="target">Target<a href="/">Home</a><a id="target-after" href="/after">After</a></main>;
}`,
      "src/routes/after/+page.tsx": `export default function After() {
  return <main id="after">After<a href="/">Home</a><a href="/cached">Cached</a></main>;
}`,
      "src/routes/users/[id]/+page.tsx": `import type { Page } from "hesperia";
export default function User(props: Page.Props<{ queryParams: { tab?: string } }>) {
  return <main id="user" data-param={props.params.id} data-tab={props.queryParams().get("tab") ?? ""}>
    User {props.params.id}
    <a id="user-tab-second" href="/users/one?tab=second">Second tab</a>
    <a id="user-tab-third" href="/users/one?tab=third">Third tab</a>
    <a id="user-two" href="/users/two?tab=third">User two</a>
  </main>;
}`,
      "src/routes/blocked/+route.ts": `import { route } from "hesperia/routing";
const guard = () => false;
export default route({ guard, load: () => "SERVER_BLOCKED_LOAD" });`,
      "src/routes/blocked/+page.tsx": `export default function Blocked() {
  const fixture = globalThis as unknown as { routingPublicFixture: { blockedBodies: number } };
  fixture.routingPublicFixture.blockedBodies += 1;
  return <main id="blocked">Blocked</main>;
}`,
      "src/routes/redirect/+route.ts": `import { redirect, route } from "hesperia/routing";
const guard = () => redirect("/after");
export default route({ guard, load: () => "SERVER_REDIRECT_LOAD" });`,
      "src/routes/redirect/+page.tsx": `export default function Redirect() {
  const fixture = globalThis as unknown as { routingPublicFixture: { redirectBodies: number } };
  fixture.routingPublicFixture.redirectBodies += 1;
  return <main id="redirect">Redirect</main>;
}`,
    };
    for (const [filename, source] of Object.entries(sources)) {
      const target = join(root, filename);
      await mkdir(resolve(target, ".."), { recursive: true });
      await writeFile(target, source);
    }

    let build: Awaited<ReturnType<typeof prepareBuild>>;
    try {
      build = await prepareBuild(root);
      await writeBuild(root, build);
    } catch (error) {
      if (error instanceof ProjectError)
        throw new Error(JSON.stringify(error.diagnostics, null, 2), { cause: error });
      throw error;
    }
    const javascript = await Promise.all(
      [...build.files.entries()]
        .filter(([filename]) => filename.endsWith(".js"))
        .map(([, file]) => file.text()),
    );
    expect(javascript.join("\n")).not.toContain("SERVER_BLOCKED_LOAD");
    expect(javascript.join("\n")).not.toContain("SERVER_REDIRECT_LOAD");

    server = await previewProject(root, 0);
    const script = `
      import assert from "node:assert/strict";
      import { chromium, firefox, webkit } from ${JSON.stringify(pathToFileURL(resolve(import.meta.dir, "../../node_modules/playwright/index.mjs")).href)};
      for (const engine of [chromium, firefox, webkit]) {
        const browser = await engine.launch();
        try {
          const page = await browser.newPage();
          const errors = [];
          page.on("pageerror", error => errors.push(error.stack ?? error.message));
          const sharedRequests = [];
          let resolveInitial;
          const initialRequest = new Promise(resolve => resolveInitial = resolve);
          let resolveUpdated;
          const updatedRequest = new Promise(resolve => resolveUpdated = resolve);
          let releaseShared = false;
          const pendingShared = [];
          let updateRequest;
          let resolveMutation;
          const mutationRequest = new Promise(resolve => resolveMutation = resolve);
          await page.route("**/api/message/**", route => {
            const name = new URL(route.request().url()).pathname.split("/").pop();
            if (name === "shared") {
              sharedRequests.push(route);
              if (sharedRequests.length === 1) resolveInitial(route);
              else if (releaseShared) return route.fulfill({ json: { message: "updated while parked" } });
              else {
                pendingShared.push(route);
                if (sharedRequests.length === 2) resolveUpdated(route);
              }
              return;
            }
            return route.continue();
          });
          await page.route("**/api/update", route => {
            updateRequest = route;
            resolveMutation(route);
          });
          await page.goto(${JSON.stringify(server.url.href)});
          await page.locator("#home").waitFor();

          assert.equal(await page.locator("#home").getAttribute("data-bodies"), "1", "Home body count");
          assert.equal(await page.locator("#guard-mounted").count(), 1, "Guard child mounted");
          await page.locator("#home-target").click();
          await page.waitForFunction(() => globalThis.routingPublicFixture.beforeLeaveChecks === 1);
          assert.equal(new URL(page.url()).pathname, "/", "Dirty navigation vetoed");
          assert.equal(await page.locator("#target").count(), 0, "Vetoed target absent");
          assert.equal(await page.evaluate(() => globalThis.routingPublicFixture.beforeLeaveChecks), 1, "Veto callback count");

          await page.locator("#allow-leave").click();
          await page.locator("#home-target").click();
          await page.locator("#target").waitFor();
          assert.equal(await page.evaluate(() => globalThis.routingPublicFixture.beforeLeaveChecks), 2, "Allowed callback count");
          await page.evaluate(() => history.back());
          await page.locator("#home").waitFor();
          const home = await page.locator("#home").elementHandle();
          if (!home) throw new Error("Cached Home page is missing");
          await page.locator("#remove-guard").click();
          await page.locator("#guard-removed").waitFor();
          await page.locator("#home-target").click();
          await page.locator("#target").waitFor();
          assert.equal(await page.evaluate(() => globalThis.routingPublicFixture.beforeLeaveChecks), 2, "Released callback count");
          await page.locator("#target-after").click();
          await page.locator("#after").waitFor();

          await page.locator("#nav-cached").click();
          const initial = await initialRequest;
          await initial.fulfill({ json: { message: "initial" } });
          await page.locator("#cached").waitFor();
          assert.equal(await page.locator("#cached-message").textContent(), "initial", "Initial shared value");
          const cached = await page.locator("#cached").elementHandle();
          if (!cached) throw new Error("Cached page is missing");
          const bodyCount = await page.locator("#cached").getAttribute("data-bodies");
          const cachedEffect = await page.locator("#cached-effect").elementHandle();
          if (!cachedEffect) throw new Error("Cached effect marker is missing");
          assert.equal(await cachedEffect.getAttribute("data-runs"), "1");
          assert.equal(await cachedEffect.getAttribute("data-value"), "initial", "Initial effect value");
          await page.locator("#cached-parking").click();
          await page.locator("#parking").waitFor();
          await page.locator("#update-shared").click();
          await mutationRequest;
          if (!updateRequest) throw new Error("The shared update request was not observed");
          await updateRequest.fulfill({ json: { ok: true } });
          await updatedRequest;
          releaseShared = true;
          for (const request of pendingShared.splice(0))
            await request.fulfill({ json: { message: "updated while parked" } });
          try {
            await page.waitForFunction(() => document.querySelector("#shared-shell")?.textContent === "updated while parked", null, { timeout: 3000 });
          } catch (error) {
            throw new Error("Shared shell did not refresh: text=" + await page.locator("#shared-shell").textContent() + "; requests=" + sharedRequests.length + "; cached=" + await page.locator("#cached").count(), { cause: error });
          }
          await page.waitForFunction(() => globalThis.routingPublicFixture.sharedUpdateDone);
          assert.equal(await page.evaluate((node) => node.querySelector("#cached-message")?.textContent, cached), "initial", "Parked DOM remained unchanged");
          assert.equal(await cachedEffect.getAttribute("data-runs"), "1", "Parked effect did not rerun");
          assert.equal(await cachedEffect.getAttribute("data-value"), "initial", "Parked effect value remained unchanged");
          assert.equal(await cachedEffect.getAttribute("data-cleanups"), "1", "Parked cleanup count");
          await page.evaluate(() => history.back());
          await page.locator("#cached").waitFor();
          assert.equal(await page.evaluate((node) => node === document.querySelector("#cached"), cached), true, "Cached node identity");
          assert.equal(await page.locator("#cached").getAttribute("data-bodies"), bodyCount, "Cached body count");
          assert.equal(await page.locator("#cached-message").textContent(), "updated while parked", "Shared value after restore");
          assert.equal(await cachedEffect.getAttribute("data-runs"), "2", "Restored effect reran");
          assert.equal(await cachedEffect.getAttribute("data-value"), "updated while parked", "Restored effect saw current value");
          assert.equal(await cachedEffect.getAttribute("data-cleanups"), "1", "Restored effect did not duplicate cleanup");

          await page.locator("#nav-blocked").click();
          await page.waitForFunction(() => globalThis.routingPublicFixture.navigationResults.some(result => result.url.endsWith("/blocked") && result.status === "denied"));
          assert.equal(new URL(page.url()).pathname, "/cached", "False route guard veto");
          assert.equal(await page.locator("#blocked").count(), 0, "Blocked page was not prepared");
          assert.equal(await page.evaluate(() => globalThis.routingPublicFixture.blockedBodies), 0, "Blocked page body did not run");
          await page.locator("#nav-redirect").click();
          await page.locator("#after").waitFor();
          await page.waitForFunction(() => globalThis.routingPublicFixture.navigationResults.some(result => result.url.endsWith("/after") && result.status === "committed"));
          assert.equal(new URL(page.url()).pathname, "/after", "Redirect guard target");
          assert.equal(await page.locator("#redirect").count(), 0, "Redirect page was not prepared");
          assert.equal(await page.evaluate(() => globalThis.routingPublicFixture.redirectBodies), 0, "Redirect page body did not run");

          await page.locator("#nav-user").click();
          await page.locator("#user").waitFor();
          assert.equal(new URL(page.url()).pathname, "/users/one", "Parameterized route path");
          assert.equal(await page.locator("#user").getAttribute("data-param"), "one");
          assert.equal(await page.locator("#user").getAttribute("data-tab"), "first");
          const userOne = await page.locator("#user").elementHandle();
          if (!userOne) throw new Error("Parameterized page is missing");

          await page.locator("#user-tab-second").click();
          await page.waitForURL("**/users/one?tab=second");
          await page.waitForFunction(
            () => document.querySelector("#user")?.getAttribute("data-tab") === "second",
          );
          assert.equal(
            await page.evaluate((node) => node === document.querySelector("#user"), userOne),
            true,
            "Anchor query update retained page identity",
          );

          await page.evaluate(() => {
            const fixture = globalThis.routingPublicFixture;
            fixture.router.updateQuery("tab", "third", { history: "push" });
          });
          await page.waitForFunction(
            () => document.querySelector("#user")?.getAttribute("data-tab") === "third",
          );
          assert.equal(new URL(page.url()).pathname, "/users/one", "Query update path");
          assert.equal(new URL(page.url()).search, "?tab=third", "Query update URL");
          assert.equal(
            await page.evaluate((node) => node === document.querySelector("#user"), userOne),
            true,
            "Query update retained page identity",
          );

          await page.locator("#user-two").click();
          await page.waitForURL("**/users/two?tab=third");
          await page.waitForFunction(
            () => document.querySelector("#user")?.getAttribute("data-param") === "two",
          );
          assert.equal(new URL(page.url()).pathname, "/users/two", "Changed parameter path");
          assert.equal(await page.locator("#user").getAttribute("data-param"), "two");
          assert.equal(await page.locator("#user").getAttribute("data-tab"), "third");
          assert.equal(
            await page.evaluate((node) => node !== document.querySelector("#user"), userOne),
            true,
            "Changed parameter remounted page",
          );

          await page.locator("#nav-missing").click();
          await page.locator("#not-found").waitFor();
          assert.equal(new URL(page.url()).pathname, "/missing", "Not-found route path");
          assert.equal(await page.locator("#not-found").textContent(), "Not found");
          assert.equal(await page.locator("#user").count(), 0, "Not-found replaced page");
          assert.deepEqual(errors, []);
          console.log(engine.name() + " public routing flows verified");
        } catch (error) {
          throw new Error(engine.name() + " public routing flow failed", { cause: error });
        } finally { await browser.close(); }
      }
    `;
    const child = Bun.spawn(["node", "--input-type=module", "--eval", script], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const [status, output, errors] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    if (status !== 0) throw new Error(`Generated public routing flow failed\n${output}\n${errors}`);
    expect(output.trim().split(/\r?\n/u)).toStrictEqual([
      "chromium public routing flows verified",
      "firefox public routing flows verified",
      "webkit public routing flows verified",
    ]);
  } finally {
    await server?.close();
    await rm(root, { recursive: true, force: true });
  }
}, 90_000);
