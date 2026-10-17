import { afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { mount } from "../../packages/hesperia/src/runtime/dom.ts";
import {
  compositionIds,
  compiledStylePlan,
  createCssLifecycleFixture,
  entryIds,
  ownerIds,
  styleIds,
  type CssLifecycleFixture,
} from "./css-lifecycle.fixture.ts";

const windows: Window[] = [];

afterEach(() => {
  for (const window of windows.splice(0)) window.close();
});

function fixture(): CssLifecycleFixture {
  const created = createCssLifecycleFixture();

  windows.push(created.window);

  return created;
}

function container(document: Document): Element {
  const target = document.createElement("div");

  document.body.appendChild(target);

  return target;
}

test("shared prepared CSS stays inactive until mounted owners activate it", async () => {
  const current = fixture();
  const firstTarget = container(current.document);
  const secondTarget = container(current.document);
  const thirdTarget = container(current.document);
  const component = current.makeComponent("red");
  const preload = current.runtime.preloadEntry(entryIds.red, current.head);
  const composition = current.runtime.prepareInstalledHead(compositionIds.red, current.head);
  const link = current.link(styleIds.red, "r1");
  const first = mount(firstTarget, component.definition, {});
  const second = mount(secondTarget, component.definition, {});

  expect(current.links()).toStrictEqual([link]);

  expect(current.mediaText(link)).toBe("not all");

  expect(firstTarget.querySelector("[data-hesperia-pending]")?.textContent).toBe("red");

  expect(secondTarget.querySelector("[data-hesperia-pending]")?.textContent).toBe("red");

  expect(component.effects).toStrictEqual([]);

  current.completeLoad(link);

  const [preloaded, installed] = await Promise.all([preload, composition]);

  await Promise.all([first.settled(), second.settled()]);

  expect(current.mediaText(link)).toBe("all");

  expect(component.effects).toHaveLength(2);

  expect(firstTarget.querySelector("[data-hesperia-pending]")).toBeNull();

  expect(secondTarget.querySelector("[data-hesperia-pending]")).toBeNull();

  const third = mount(thirdTarget, component.definition, {});

  expect(thirdTarget.querySelector("button")?.textContent).toBe("red");

  await third.settled();

  expect(component.effects).toHaveLength(3);

  first.dispose();

  expect(current.mediaText(link)).toBe("all");

  second.dispose();

  expect(current.mediaText(link)).toBe("all");

  third.dispose();

  expect(current.mediaText(link)).toBe("not all");

  preloaded.release();

  expect(link.parentNode).toBe(current.head);

  installed.release();

  expect(link.parentNode).toBeNull();
});

test("parent and child style references suspend once, resume, and release with their Owners", async () => {
  const current = fixture();
  const target = container(current.document);
  const tree = current.makeParentChildTree();
  const faults: unknown[] = [];
  const app = mount(target, tree.definition, {}, { onError: (error) => faults.push(error) });
  const link = current.link(styleIds.red, "r1");
  const parent = tree.parentOwners[0]!;
  const child = tree.childOwners[0]!;
  const childNode = tree.nodes.find((node) => node.localName === "i")!;

  current.completeLoad(link);

  await app.settled();

  expect(current.mediaText(link)).toBe("all");

  expect(childNode.isConnected).toBe(true);

  expect(tree.effects.filter((event) => event.startsWith("run:"))).toHaveLength(2);

  parent.suspend();

  child.suspend();

  expect(parent.state).toBe("suspended");

  expect(child.state).toBe("suspended");

  expect(current.mediaText(link)).toBe("not all");

  expect(childNode.isConnected).toBe(true);

  expect(tree.effects.filter((event) => event.startsWith("cleanup:"))).toHaveLength(2);

  parent.resume();

  await app.settled();

  expect(current.mediaText(link)).toBe("all");

  expect(childNode.isConnected).toBe(true);

  expect(tree.effects.filter((event) => event.startsWith("run:"))).toHaveLength(4);

  expect(faults).toStrictEqual([]);

  app.dispose();

  expect(current.links()).toHaveLength(0);
});

test("a successful revision retains mounted nodes without rerunning effects", async () => {
  const current = fixture();
  const target = container(current.document);
  const component = current.makeComponent("red");
  const app = mount(target, component.definition, {});
  const originalLink = current.link(styleIds.red, "r1");

  current.completeLoad(originalLink);

  await app.settled();

  const button = component.nodes[0]!;
  const initialEffects = [...component.effects];

  const pendingRevision = current.runtime.prepareRevision(
    compiledStylePlan("r2", "r1"),
    current.head,
  );
  const nextLink = current.link(styleIds.red, "r2");

  expect(current.mediaText(originalLink)).toBe("all");

  expect(current.mediaText(nextLink)).toBe("not all");

  current.completeLoad(nextLink);

  const revision = await pendingRevision;

  expect(current.mediaText(originalLink)).toBe("all");

  expect(current.mediaText(nextLink)).toBe("not all");

  revision.publish();

  expect(originalLink.parentNode).toBeNull();

  expect(current.mediaText(nextLink)).toBe("all");

  expect(target.querySelector("button")).toBe(button);

  expect(component.effects).toStrictEqual(initialEffects);

  app.dispose();

  expect(nextLink.parentNode).toBeNull();
});

test("a failed multi-vector revision preserves old active bytes after another vector loads", async () => {
  const current = fixture();
  const target = container(current.document);
  const component = current.makeComponent("red");
  const app = mount(target, component.definition, {});
  const originalRed = current.link(styleIds.red, "r1");

  current.completeLoad(originalRed);

  await app.settled();

  const bluePreparation = current.runtime.preloadEntry(entryIds.blue, current.head);
  const originalBlue = current.link(styleIds.blue, "r1");

  current.completeLoad(originalBlue);

  const blueLease = await bluePreparation;

  const pendingRevision = current.runtime.prepareRevision(
    compiledStylePlan("r2", "r2"),
    current.head,
  );
  const nextRed = current.link(styleIds.red, "r2");
  const nextBlue = current.link(styleIds.blue, "r2");

  current.completeLoad(nextRed);

  current.failLoad(nextBlue);

  await expect(pendingRevision).rejects.toMatchObject({ kind: "stylesheet-load" });

  expect(current.mediaText(originalRed)).toBe("all");

  expect(originalBlue.parentNode).toBe(current.head);

  expect(current.mediaText(originalBlue)).toBe("not all");

  expect(nextRed.parentNode).toBeNull();

  expect(nextBlue.parentNode).toBeNull();

  expect(component.nodes[0]!.isConnected).toBe(true);

  expect(component.effects.filter((event) => event.startsWith("run:"))).toHaveLength(1);

  app.dispose();

  blueLease.release();
});

test("publishing a revision staged before a new active vector fails without changing either root", async () => {
  const current = fixture();
  const redTarget = container(current.document);
  const blueTarget = container(current.document);
  const red = current.makeComponent("red");
  const blue = current.makeComponent("blue", ownerIds.blue, entryIds.blue);
  const redApp = mount(redTarget, red.definition, {});
  const originalRed = current.link(styleIds.red, "r1");

  current.completeLoad(originalRed);

  await redApp.settled();

  const pendingRevision = current.runtime.prepareRevision(
    compiledStylePlan("r2", "r2"),
    current.head,
  );
  const nextRed = current.link(styleIds.red, "r2");
  const blueApp = mount(blueTarget, blue.definition, {});
  const originalBlue = current.link(styleIds.blue, "r1");

  current.completeLoad(originalBlue);

  await blueApp.settled();

  current.completeLoad(nextRed);

  const revision = await pendingRevision;

  let failure: unknown;

  try {
    revision.publish();
  } catch (error) {
    failure = error;
  }

  expect(failure).toMatchObject({ kind: "style-revision-stale" });

  expect(originalRed.parentNode).toBe(current.head);

  expect(originalBlue.parentNode).toBe(current.head);

  expect(current.mediaText(originalRed)).toBe("all");

  expect(current.mediaText(originalBlue)).toBe("all");

  expect(nextRed.parentNode).toBeNull();

  expect(red.nodes[0]!.isConnected).toBe(true);

  expect(blue.nodes[0]!.isConnected).toBe(true);

  redApp.dispose();

  blueApp.dispose();
});

test("aborting and superseding staged revisions promptly release links", async () => {
  const current = fixture();
  const target = container(current.document);
  const component = current.makeComponent("red");
  const app = mount(target, component.definition, {});
  const originalLink = current.link(styleIds.red, "r1");

  current.completeLoad(originalLink);

  await app.settled();

  const controller = new AbortController();
  const reason = new Error("revision cancelled by caller");
  const aborted = current.runtime.prepareRevision(
    compiledStylePlan("r2", "r1"),
    current.head,
    controller.signal,
  );
  const abortedLink = current.link(styleIds.red, "r2");

  controller.abort(reason);

  await expect(aborted).rejects.toBe(reason);

  expect(abortedLink.parentNode).toBeNull();

  expect(current.mediaText(originalLink)).toBe("all");

  const superseded = current.runtime.prepareRevision(compiledStylePlan("r3", "r1"), current.head);
  const supersededLink = current.link(styleIds.red, "r3");
  const latest = current.runtime.prepareRevision(compiledStylePlan("r4", "r1"), current.head);
  const latestLink = current.link(styleIds.red, "r4");

  await expect(superseded).rejects.toMatchObject({ kind: "style-revision-superseded" });

  expect(supersededLink.parentNode).toBeNull();

  expect(current.mediaText(originalLink)).toBe("all");

  current.completeLoad(latestLink);

  const revision = await latest;

  revision.publish();

  expect(originalLink.parentNode).toBeNull();

  expect(current.mediaText(latestLink)).toBe("all");

  app.dispose();

  expect(latestLink.parentNode).toBeNull();
});

test("retiring one document head releases only its groups and permits same-root activation", async () => {
  const current = fixture();
  const target = container(current.document);
  const component = current.makeComponent("red");
  const app = mount(target, component.definition, {});
  const oldHead = current.head;
  const oldRed = current.link(styleIds.red, "r1", oldHead);

  current.completeLoad(oldRed);

  await app.settled();

  const rootOwner = component.owners[0]!;

  const otherWindow = new Window({ settings: { disableCSSFileLoading: true } });

  windows.push(otherWindow);

  const otherHead = otherWindow.document.head as unknown as HTMLHeadElement;
  const otherBluePreparation = current.runtime.preloadEntry(entryIds.blue, otherHead);
  const otherBlue = current.link(styleIds.blue, "r1", otherHead);

  current.completeLoad(otherBlue);

  const otherBlueLease = await otherBluePreparation;

  const newHead = current.document.createElement("head") as HTMLHeadElement;

  current.document.documentElement.replaceChild(newHead, oldHead);

  const replacementPreparation = current.runtime.preloadEntry(entryIds.red, newHead);
  const replacementRed = current.link(styleIds.red, "r1", newHead);

  expect(oldRed.parentNode).toBeNull();

  expect(otherBlue.parentNode).toBe(otherHead);

  expect(current.mediaText(otherBlue)).toBe("not all");

  current.completeLoad(replacementRed);

  const replacementLease = await replacementPreparation;

  replacementLease.activate(rootOwner);

  expect(current.mediaText(replacementRed)).toBe("all");

  expect(current.mediaText(otherBlue)).toBe("not all");

  app.dispose();

  expect(current.mediaText(replacementRed)).toBe("not all");

  replacementLease.release();

  otherBlueLease.release();

  expect(replacementRed.parentNode).toBeNull();

  expect(otherBlue.parentNode).toBeNull();
});
