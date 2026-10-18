import { expect, test, type ElementHandle, type Page, type Route } from "@playwright/test";

interface Item {
  readonly id: string;
  readonly label: string;
  readonly done: boolean;
}

type Action =
  | { readonly kind: "create"; readonly item: Item }
  | { readonly kind: "update"; readonly id: string; readonly done: boolean }
  | { readonly kind: "remove"; readonly id: string };

interface PendingCall {
  readonly method: string;
  readonly path: string;
  readonly body: unknown;
  readonly route: Route;
  readonly finished: Promise<void>;
  readonly finish: () => void;
  claimed: boolean;
  completed: boolean;
}

interface RequestWaiter {
  readonly method: string;
  readonly path: string;
  readonly resolve: (call: PendingCall) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

class ControlledBackend {
  readonly trace: Record<string, unknown>[] = [];
  private readonly calls: PendingCall[] = [];
  private readonly waiters: RequestWaiter[] = [];
  private readonly handler = (route: Route): Promise<void> => this.capture(route);

  constructor(private readonly page: Page) {}

  async install(): Promise<void> {
    await this.page.route("**/checklist-api/**", this.handler);
  }

  async take(method: string, path: string): Promise<PendingCall> {
    const existing = this.find(method, path);

    if (existing) {
      existing.claimed = true;
      return existing;
    }

    return await new Promise<PendingCall>((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = this.waiters.findIndex((waiter) => waiter.timer === timer);

        if (index >= 0) this.waiters.splice(index, 1);

        reject(
          new Error(
            "Timed out waiting for " +
              method +
              " " +
              path +
              "; observed " +
              JSON.stringify(this.trace),
          ),
        );
      }, 8_000);

      this.waiters.push({ method, path, resolve, reject, timer });

      this.dispatchWaiters();
    });
  }

  async replyJson(call: PendingCall, status: number, body: unknown): Promise<void> {
    await this.reply(call, status, body);
  }

  async replyEmpty(call: PendingCall, status: number): Promise<void> {
    await this.reply(call, status);
  }

  requestCount(method: string, path: string): number {
    return this.calls.filter((call) => call.method === method && call.path === path).length;
  }

  async close(): Promise<void> {
    for (const waiter of this.waiters.splice(0)) {
      clearTimeout(waiter.timer);

      waiter.reject(new Error("Controlled backend closed before its request arrived"));
    }

    await Promise.all(
      this.calls
        .filter((call) => !call.completed)
        .map(async (call) => {
          try {
            await this.reply(call, 503, { error: "test cleanup" });
          } catch {
            call.finish();
          }
        }),
    );

    await this.page.unroute("**/checklist-api/**", this.handler);
  }

  private async capture(route: Route): Promise<void> {
    const request = route.request();
    const rawBody = request.postData();
    let body: unknown;

    if (rawBody) {
      try {
        body = JSON.parse(rawBody) as unknown;
      } catch {
        body = rawBody;
      }
    }

    let finish!: () => void;
    const finished = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const call: PendingCall = {
      method: request.method(),
      path: new URL(request.url()).pathname,
      body,
      route,
      finished,
      finish,
      claimed: false,
      completed: false,
    };

    this.calls.push(call);

    this.trace.push({ direction: "request", method: call.method, path: call.path, body });

    this.dispatchWaiters();

    await finished;
  }

  private async reply(call: PendingCall, status: number, body?: unknown): Promise<void> {
    if (call.completed)
      throw new Error("Request was already answered: " + call.method + " " + call.path);

    const options: Parameters<Route["fulfill"]>[0] = { status };

    if (body !== undefined) {
      options.contentType = "application/json";
      options.body = JSON.stringify(body);
    }

    await call.route.fulfill(options);

    call.completed = true;

    this.trace.push({ direction: "response", method: call.method, path: call.path, status, body });

    call.finish();

    await call.finished;
  }

  private find(method: string, path: string): PendingCall | undefined {
    return this.calls.find(
      (call) => !call.claimed && !call.completed && call.method === method && call.path === path,
    );
  }

  private dispatchWaiters(): void {
    for (let index = this.waiters.length - 1; index >= 0; index--) {
      const waiter = this.waiters[index]!;
      const call = this.find(waiter.method, waiter.path);

      if (!call) continue;

      call.claimed = true;

      this.waiters.splice(index, 1);

      clearTimeout(waiter.timer);

      waiter.resolve(call);
    }
  }
}

function initialItems(): Item[] {
  return [
    { id: "seed-a", label: "Alpha", done: false },
    { id: "seed-b", label: "Beta", done: true },
    { id: "seed-c", label: "Gamma", done: false },
  ];
}

async function replyList(backend: ControlledBackend, items: readonly Item[]): Promise<void> {
  const call = await backend.take("GET", "/checklist-api/items");

  await backend.replyJson(
    call,
    200,
    items.map((item) => ({ ...item })),
  );
}

async function replyDetail(
  backend: ControlledBackend,
  id: string,
  items: readonly Item[],
): Promise<void> {
  const call = await backend.take("GET", "/checklist-api/items/" + id);
  const item = items.find((candidate) => candidate.id === id) ?? null;

  await backend.replyJson(call, 200, item === null ? null : { ...item });
}

async function expectRenderedItems(page: Page, expected: readonly Item[]): Promise<void> {
  const rows = page.locator("#item-list li");

  await expect(async () => {
    const actual = await rows.evaluateAll((elements) =>
      elements.map((element) => ({
        id: element.getAttribute("data-item-id"),
        label: element.querySelector("[data-item-label]")?.textContent ?? "",
        done: element.getAttribute("data-item-done") === "true",
      })),
    );

    expect(actual).toStrictEqual(expected);
  }).toPass({ timeout: 5_000, intervals: [50, 100, 250, 500] });
}

async function captureRows(
  page: Page,
  ids: readonly string[],
): Promise<Map<string, ElementHandle>> {
  const rows = new Map<string, ElementHandle>();

  for (const id of ids) {
    const row = await page.locator("#row-" + id).elementHandle();

    expect(row, "row " + id + " should exist before the update").not.toBeNull();

    rows.set(id, row!);
  }

  return rows;
}

async function assertKeyedIdentity(
  page: Page,
  expected: readonly Item[],
  handles: Map<string, ElementHandle>,
): Promise<void> {
  const expectedIds = new Set(expected.map((item) => item.id));

  for (const item of expected) {
    const previous = handles.get(item.id);

    if (previous) {
      expect(
        await previous.evaluate(
          (node, id) => node === document.querySelector("#row-" + id),
          item.id,
        ),
        "keyed row identity should survive data updates for " + item.id,
      ).toBe(true);
    } else {
      const current = await page.locator("#row-" + item.id).elementHandle();

      expect(current, "new keyed row should be present for " + item.id).not.toBeNull();

      handles.set(item.id, current!);
    }
  }

  for (const [id, handle] of handles) {
    if (expectedIds.has(id)) continue;

    expect(
      await handle.evaluate((node) => node.isConnected),
      "removed row should detach: " + id,
    ).toBe(false);

    handles.delete(id);
  }
}

function cloneItems(items: readonly Item[]): Item[] {
  return items.map((item) => ({ ...item }));
}

function seededActions(seed: number): Action[] {
  let state = seed >>> 0;

  const next = (): number => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state;
  };

  const planner = initialItems();
  const kinds = ["create", "update", "remove", "update", "create", "remove", "update"] as const;
  const actions: Action[] = [];

  for (let index = 0; index < kinds.length; index++) {
    const kind = kinds[index]!;

    if (kind === "create") {
      const suffix = next().toString(36);
      const item = {
        id: "generated-" + index + "-" + suffix,
        label: "Generated " + suffix,
        done: false,
      };

      planner.push(item);

      actions.push({ kind, item });

      continue;
    }

    const targetIndex = next() % planner.length;
    const target = planner[targetIndex]!;

    if (kind === "update") {
      const updated = { ...target, done: !target.done };
      planner[targetIndex] = updated;

      actions.push({ kind, id: updated.id, done: updated.done });

      continue;
    }

    planner.splice(targetIndex, 1);

    actions.push({ kind, id: target.id });
  }

  return actions;
}

function applyExpectedAction(items: Item[], action: Action): void {
  if (action.kind === "create") {
    items.push({ ...action.item });

    return;
  }

  const index = items.findIndex((item) => item.id === action.id);

  if (index < 0) throw new Error("Seeded action targets missing item " + action.id);

  if (action.kind === "remove") {
    items.splice(index, 1);

    return;
  }

  items[index] = { ...items[index]!, done: action.done };
}

function applyBackendRequest(items: Item[], call: PendingCall, action: Action): Item | undefined {
  if (action.kind === "create") {
    const submitted = call.body as Item;

    expect(submitted).toStrictEqual(action.item);

    items.push({ ...submitted });

    return submitted;
  }

  if (action.kind === "update") {
    const submitted = call.body as Item;
    const index = items.findIndex((item) => item.id === action.id);

    expect(submitted).toStrictEqual({ ...items[index]!, done: action.done });

    items[index] = { ...submitted };
    return submitted;
  }

  expect(call.body).toBeUndefined();

  const index = items.findIndex((item) => item.id === action.id);

  if (index < 0) throw new Error("Backend action targets missing item " + action.id);

  items.splice(index, 1);

  return undefined;
}

test("compiled checklist CRUD revalidates live queries and releases component effects", async ({
  page,
}) => {
  const pageErrors: string[] = [];

  page.on("pageerror", (error) => pageErrors.push(error.message));

  const backend = new ControlledBackend(page);
  const backendItems = initialItems();

  try {
    await backend.install();

    await page.goto("/checklist");

    await replyList(backend, backendItems);

    await expectRenderedItems(page, backendItems);

    await replyDetail(backend, "seed-a", backendItems);

    await expect(page.locator("#detail-label")).toHaveText("Alpha");

    const rowHandles = await captureRows(page, ["seed-a", "seed-b", "seed-c"]);
    const checkboxA = await page.locator("#done-seed-a").elementHandle();

    expect(checkboxA).not.toBeNull();

    await page.locator("#new-item-id").fill("created-delta");

    await page.locator("#new-item-label").fill("Delta");

    await page.getByRole("button", { name: "Create item" }).click();

    const createCall = await backend.take("POST", "/checklist-api/items");
    const created: Item = { id: "created-delta", label: "Delta", done: false };

    expect(createCall.body).toStrictEqual(created);

    backendItems.push(created);

    await backend.replyJson(createCall, 201, created);

    await replyList(backend, backendItems);

    await expectRenderedItems(page, backendItems);

    await assertKeyedIdentity(page, backendItems, rowHandles);

    await page.locator("#done-seed-a").check();

    const updateCall = await backend.take("PUT", "/checklist-api/items/seed-a");
    const updated: Item = { id: "seed-a", label: "Alpha", done: true };

    expect(updateCall.body).toStrictEqual(updated);

    backendItems[0] = updated;

    await backend.replyJson(updateCall, 200, updated);

    const listRefresh = backend.take("GET", "/checklist-api/items");
    const detailRefresh = backend.take("GET", "/checklist-api/items/seed-a");
    const refreshes = await Promise.all([listRefresh, detailRefresh]);

    await backend.replyJson(refreshes[0]!, 200, cloneItems(backendItems));

    await backend.replyJson(refreshes[1]!, 200, { ...updated });

    await expectRenderedItems(page, backendItems);

    await expect(page.locator("#detail-label")).toHaveText("Alpha");

    await expect(page.locator("#detail-done")).toHaveText("true");

    await assertKeyedIdentity(page, backendItems, rowHandles);

    expect(
      await checkboxA!.evaluate((node) => node === document.querySelector("#done-seed-a")),
    ).toBe(true);

    await page.locator("#remove-seed-a").click();

    const removeCall = await backend.take("DELETE", "/checklist-api/items/seed-a");

    expect(removeCall.body).toBeUndefined();

    backendItems.splice(0, 1);

    await backend.replyEmpty(removeCall, 204);

    const removeListRefresh = backend.take("GET", "/checklist-api/items");
    const removeDetailRefresh = backend.take("GET", "/checklist-api/items/seed-a");
    const removeRefreshes = await Promise.all([removeListRefresh, removeDetailRefresh]);

    await backend.replyJson(removeRefreshes[0]!, 200, cloneItems(backendItems));

    await backend.replyJson(removeRefreshes[1]!, 200, null);

    await expectRenderedItems(page, backendItems);

    await expect(page.locator("#detail-label")).toHaveText("removed");

    await assertKeyedIdentity(page, backendItems, rowHandles);

    const lifecycle = page.locator("#lifecycle-report");

    await expect(lifecycle).toHaveAttribute("data-effect-starts", "1");

    await page.locator("#toggle-probe").click();

    await expect(page.locator("#probe-hidden")).toBeVisible();

    await expect(lifecycle).toHaveAttribute("data-effect-cleanups", "1");

    await expect(lifecycle).toHaveAttribute("data-owner-cleanups", "1");

    await page.locator("#toggle-probe").click();

    await expect(page.locator("#lifecycle-probe")).toBeVisible();

    await expect(lifecycle).toHaveAttribute("data-effect-starts", "2");

    expect(pageErrors).toStrictEqual([]);
  } finally {
    await backend.close();
  }
});

test("cached checklist pages restore controls and revalidate data changed on the detail route", async ({
  page,
}) => {
  const pageErrors: string[] = [];
  const backend = new ControlledBackend(page);
  const backendItems = initialItems();
  const traceSteps: string[] = [];
  const trace: Record<string, unknown> = { steps: traceSteps, requests: backend.trace };

  page.on("pageerror", (error) => pageErrors.push(error.message));

  try {
    await backend.install();

    await page.goto("/checklist");

    await replyList(backend, backendItems);

    await expectRenderedItems(page, backendItems);

    await replyDetail(backend, "seed-a", backendItems);

    await expect(page.locator("#detail-label")).toHaveText("Alpha");

    expect(backend.requestCount("GET", "/checklist-api/items")).toBe(1);

    expect(backend.requestCount("GET", "/checklist-api/items/seed-a")).toBe(1);

    traceSteps.push("initial list and selected-detail requests completed");

    const localNote = await page.locator("#page-local-note").elementHandle();
    const localChoice = await page.locator("#page-local-choice").elementHandle();
    const selectedDetailLabel = await page.locator("#detail-label").elementHandle();
    const selectedDetailDone = await page.locator("#detail-done").elementHandle();
    const lifecycle = await page.locator("#route-cache-lifecycle").elementHandle();

    expect(localNote).not.toBeNull();

    expect(localChoice).not.toBeNull();

    expect(selectedDetailLabel).not.toBeNull();

    expect(selectedDetailDone).not.toBeNull();

    expect(lifecycle).not.toBeNull();

    await expect(page.locator("#route-cache-lifecycle")).toHaveAttribute("data-effect-starts", "1");

    await expect(page.locator("#route-cache-lifecycle")).toHaveAttribute(
      "data-effect-cleanups",
      "0",
    );

    await expect(page.locator("#route-cache-lifecycle")).toHaveAttribute(
      "data-owner-cleanups",
      "0",
    );

    await page.locator("#page-local-note").fill("draft kept while detail is open");

    await page.locator("#page-local-choice").check();

    const initialNoteValue = await localNote!.evaluate((node) => (node as HTMLInputElement).value);
    const initialChoice = await localChoice!.evaluate((node) => (node as HTMLInputElement).checked);

    expect(initialNoteValue).toBe("draft kept while detail is open");

    expect(initialChoice).toBe(true);

    const detailURL = "/checklist/items/seed-a";

    await page.locator("#detail-seed-a").click();

    await expect(page).toHaveURL(new RegExp(`${detailURL}$`, "u"));

    const entryDetailRead = await backend.take("GET", "/checklist-api/items/seed-a");

    expect(backend.requestCount("GET", "/checklist-api/items/seed-a")).toBe(2);

    expect(entryDetailRead.body).toBeUndefined();

    await backend.replyJson(entryDetailRead, 200, { ...backendItems[0]! });

    await expect(page.locator("#detail-query-status")).toHaveText("ready");

    await expect(page.locator("#checklist-item-detail")).toBeVisible();

    traceSteps.push(
      "entry-time detail request completed with original data; the rendered query status reached ready",
    );

    await expect(page.locator("#detail-route-label")).toHaveText("Alpha");

    await expect(page.locator("#detail-route-done")).toHaveText("false");

    await expect(page.locator("#detail-update-status")).toHaveText("idle");

    await expect(page.locator("#parked-list-query-status")).toHaveText("ready");

    await expect(page.locator("#parked-list-query-pending")).toHaveText("false");

    expect(backend.requestCount("GET", "/checklist-api/items")).toBe(1);

    const effectReportValue = (name: string) =>
      lifecycle!.evaluate((node, attribute) => node.getAttribute(attribute), name);

    await expect.poll(() => effectReportValue("data-effect-cleanups")).toBe("1");

    expect(await effectReportValue("data-effect-starts")).toBe("1");

    expect(await effectReportValue("data-owner-cleanups")).toBe("0");

    const detailNote = await page.locator("#detail-edit-label").elementHandle();
    const detailDone = await page.locator("#detail-edit-done").elementHandle();

    expect(detailNote).not.toBeNull();

    expect(detailDone).not.toBeNull();

    await page.locator("#detail-edit-label").fill("Alpha changed while list is parked");

    await page.locator("#detail-edit-done").check();

    await page.locator("#save-checklist-item").click();

    const updateCall = await backend.take("PUT", "/checklist-api/items/seed-a");
    const updated: Item = { id: "seed-a", label: "Alpha changed while list is parked", done: true };

    expect(updateCall.body).toStrictEqual(updated);

    await expect(page.locator("#detail-update-status")).toHaveText("pending");

    backendItems[0] = updated;

    await backend.replyJson(updateCall, 200, updated);

    await expect(page.locator("#detail-update-status")).toHaveText("success");

    await expect(page.locator("#parked-list-query-status")).toHaveText("stale");

    await expect(page.locator("#parked-list-query-pending")).toHaveText("false");

    expect(backend.requestCount("GET", "/checklist-api/items")).toBe(1);

    const detailRefreshPromise = backend.take("GET", "/checklist-api/items/seed-a");
    const detailRefresh = await detailRefreshPromise;

    expect(detailRefresh).not.toBe(entryDetailRead);

    expect(backend.requestCount("GET", "/checklist-api/items/seed-a")).toBe(3);

    expect(backend.requestCount("GET", "/checklist-api/items")).toBe(1);

    traceSteps.push(
      "mutation task completed and distinct detail revalidation arrived; parked list stayed stale without a GET",
    );

    await backend.replyJson(detailRefresh, 200, { ...updated });

    await expect(page.locator("#detail-query-status")).toHaveText("ready");

    await expect(page.locator("#detail-route-label")).toHaveText(updated.label);

    await expect(page.locator("#detail-route-done")).toHaveText("true");

    expect(await selectedDetailLabel!.textContent()).toBe("Alpha");

    expect(await selectedDetailDone!.textContent()).toBe("false");

    traceSteps.push("parked selected-detail nodes retained their original rendered values");

    expect(await localNote!.evaluate((node) => (node as HTMLInputElement).value)).toBe(
      initialNoteValue,
    );

    expect(await localChoice!.evaluate((node) => (node as HTMLInputElement).checked)).toBe(true);

    const backNavigation = page.goBack();
    const listRefresh = await backend.take("GET", "/checklist-api/items");

    expect(backend.requestCount("GET", "/checklist-api/items")).toBe(2);

    traceSteps.push("list restoration reconnected value observers and requested fresh data");

    await backend.replyJson(listRefresh, 200, cloneItems(backendItems));

    await backNavigation;

    await expect(page).toHaveURL(/\/checklist$/u);

    await expect(page.locator("#checklist")).toBeVisible();

    await expectRenderedItems(page, backendItems);

    expect(
      await localNote!.evaluate((node) => node === document.querySelector("#page-local-note")),
    ).toBe(true);

    expect(
      await localChoice!.evaluate((node) => node === document.querySelector("#page-local-choice")),
    ).toBe(true);

    expect(await page.locator("#page-local-note").inputValue()).toBe(initialNoteValue);

    await expect(page.locator("#page-local-choice")).toBeChecked();

    await expect(page.locator("#row-seed-a")).toHaveAttribute("data-item-done", "true");

    expect(
      await selectedDetailLabel!.evaluate(
        (node) => node === document.querySelector("#detail-label"),
      ),
    ).toBe(true);

    expect(
      await selectedDetailDone!.evaluate((node) => node === document.querySelector("#detail-done")),
    ).toBe(true);

    await expect(page.locator("#detail-label")).toHaveText(updated.label);

    await expect(page.locator("#detail-done")).toHaveText("true");

    await expect.poll(() => effectReportValue("data-effect-starts")).toBe("2");

    expect(await effectReportValue("data-effect-cleanups")).toBe("1");

    expect(await effectReportValue("data-owner-cleanups")).toBe("0");

    await page.goForward();

    await expect(page).toHaveURL(new RegExp(`${detailURL}$`, "u"));

    await expect(page.locator("#checklist-item-detail")).toBeVisible();

    await expect(page.locator("#detail-route-label")).toHaveText(updated.label);

    await expect(page.locator("#detail-route-done")).toHaveText("true");

    expect(
      await detailNote!.evaluate((node) => node === document.querySelector("#detail-edit-label")),
    ).toBe(true);

    expect(
      await detailDone!.evaluate((node) => node === document.querySelector("#detail-edit-done")),
    ).toBe(true);

    await expect(page.locator("#detail-edit-label")).toHaveValue(updated.label);

    await expect(page.locator("#detail-edit-done")).toBeChecked();

    await expect.poll(() => effectReportValue("data-effect-cleanups")).toBe("2");

    expect(await effectReportValue("data-owner-cleanups")).toBe("0");

    trace.requests = [...backend.trace];

    expect(pageErrors).toStrictEqual([]);
  } catch (error) {
    trace.requests = [...backend.trace];
    trace.pageErrors = [...pageErrors];

    await test.info().attach("cache-refresh-trace.json", {
      body: JSON.stringify(trace, null, 2),
      contentType: "application/json",
    });

    throw error;
  } finally {
    await backend.close();
  }
});

test("seeded bounded checklist actions match an independent model and retain keyed rows", async ({
  page,
}) => {
  const seed = 0x17c0234;
  const actions = seededActions(seed);
  const trace: Record<string, unknown> = { seed, actions, completed: [] as Action[] };
  const backend = new ControlledBackend(page);
  const backendItems = initialItems();
  const expectedItems = initialItems();
  const completed: Action[] = [];
  const selected = { id: "seed-a" };
  const handles = new Map<string, ElementHandle>();

  try {
    await backend.install();

    await page.goto("/checklist");

    await replyList(backend, backendItems);

    await expectRenderedItems(page, expectedItems);

    await replyDetail(backend, selected.id, backendItems);

    await expect(page.locator("#detail-label")).toHaveText("Alpha");

    await assertKeyedIdentity(page, expectedItems, handles);

    for (const action of actions) {
      if (action.kind !== "create" && selected.id !== action.id) {
        await page.locator("#select-" + action.id).click();

        await replyDetail(backend, action.id, backendItems);

        selected.id = action.id;
      }

      let mutation: PendingCall;

      if (action.kind === "create") {
        await page.locator("#new-item-id").fill(action.item.id);

        await page.locator("#new-item-label").fill(action.item.label);

        await page.getByRole("button", { name: "Create item" }).click();

        mutation = await backend.take("POST", "/checklist-api/items");
      } else if (action.kind === "update") {
        await page.locator("#done-" + action.id).setChecked(action.done);

        mutation = await backend.take("PUT", "/checklist-api/items/" + action.id);
      } else {
        await page.locator("#remove-" + action.id).click();

        mutation = await backend.take("DELETE", "/checklist-api/items/" + action.id);
      }

      const backendResult = applyBackendRequest(backendItems, mutation, action);

      applyExpectedAction(expectedItems, action);

      completed.push(action);

      trace.completed = [...completed];
      trace.backendItems = cloneItems(backendItems);
      trace.expectedItems = cloneItems(expectedItems);
      trace.requests = [...backend.trace];

      if (action.kind === "remove") {
        await backend.replyEmpty(mutation, 204);
      } else {
        await backend.replyJson(mutation, action.kind === "create" ? 201 : 200, backendResult);
      }

      const listPromise = backend.take("GET", "/checklist-api/items");
      const affectedId = action.kind === "create" ? undefined : action.id;
      const detailPromise = affectedId
        ? backend.take("GET", "/checklist-api/items/" + affectedId)
        : Promise.resolve(undefined);
      const [listRefresh, detailRefresh] = await Promise.all([listPromise, detailPromise]);

      await backend.replyJson(listRefresh, 200, cloneItems(backendItems));

      if (detailRefresh && affectedId) {
        const selectedItem = backendItems.find((item) => item.id === affectedId) ?? null;

        await backend.replyJson(
          detailRefresh,
          200,
          selectedItem === null ? null : { ...selectedItem },
        );
      }

      await expectRenderedItems(page, expectedItems);

      await assertKeyedIdentity(page, expectedItems, handles);

      if (action.kind === "update") {
        await expect(page.locator("#detail-label")).toHaveText(
          expectedItems.find((item) => item.id === selected.id)?.label ?? "removed",
        );

        await expect(page.locator("#detail-done")).toHaveText(String(action.done));
      }

      if (action.kind === "remove")
        await expect(page.locator("#detail-label")).toHaveText("removed");
    }

    expect(actions.some((action) => action.kind === "create")).toBe(true);

    expect(actions.some((action) => action.kind === "update")).toBe(true);

    expect(actions.some((action) => action.kind === "remove")).toBe(true);
  } catch (error) {
    trace.completed = [...completed];
    trace.backendItems = cloneItems(backendItems);
    trace.expectedItems = cloneItems(expectedItems);
    trace.requests = [...backend.trace];

    await test.info().attach("seed-action-trace.json", {
      body: JSON.stringify(trace, null, 2),
      contentType: "application/json",
    });

    throw error;
  } finally {
    await backend.close();
  }
});

test("a cancelled latest-run task cannot publish its late response", async ({ page }) => {
  const backend = new ControlledBackend(page);

  try {
    await backend.install();

    await page.goto("/checklist");

    await replyList(backend, initialItems());

    await replyDetail(backend, "seed-a", initialItems());

    await expect(page.locator("#latest-task")).toHaveText("idle:none");

    await page.locator("#run-older").click();

    const older = await backend.take("POST", "/checklist-api/latest");

    expect(older.body).toStrictEqual({ value: "older" });

    await expect(page.locator("#latest-task")).toHaveText("pending:none");

    await page.locator("#run-latest").click();

    const latest = await backend.take("POST", "/checklist-api/latest");

    expect(latest.body).toStrictEqual({ value: "latest" });

    await expect(page.locator("#latest-task")).toHaveText("pending:none");

    await backend.replyJson(latest, 200, { value: "latest result" });

    await expect(page.locator("#latest-task")).toHaveText("success:latest result");

    await expect(page.locator("#latest-response-count")).toHaveText("1");

    const lateResponse = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/checklist-api/latest" &&
        response.request().postDataJSON() &&
        (response.request().postDataJSON() as { value?: unknown }).value === "older",
    );

    await backend.replyJson(older, 200, { value: "older result" });

    await lateResponse;

    await expect(page.locator("#latest-response-count")).toHaveText("2");

    await expect(page.locator("#latest-task")).toHaveText("success:latest result");
  } finally {
    await backend.close();
  }
});
