import { afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { createRuntimeRoot } from "../../packages/hesperia/src/runtime/dom.ts";
import type { PreparedRoute } from "../../packages/hesperia/src/routing/navigation.ts";
import { RoutePresentation } from "../../packages/hesperia/src/routing/presentation.ts";

const cleanups: (() => void)[] = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function setup(html: string) {
  const platform = new Window({ url: "https://example.test/" });
  const window = platform as unknown as globalThis.Window;
  window.history.scrollRestoration = "auto";
  window.document.body.innerHTML = html;
  const runtime = createRuntimeRoot(window.document.body);
  const scrolls: number[][] = [];
  window.scrollTo = ((x: number, y: number) => {
    scrolls.push([x, y]);
  }) as typeof window.scrollTo;
  const announcements: string[] = [];
  const presentation = new RoutePresentation(window, (message) => announcements.push(message));
  const route: PreparedRoute = {
    owners: [runtime.owner],
    title: "Destination",

    install() {},

    dispose() {},
  };

  cleanups.push(() => {
    presentation.dispose();

    runtime.owner.dispose();

    platform.close();
  });

  return { platform, window, runtime, route, scrolls, announcements, presentation };
}

test("route focus prefers main over an earlier heading and temporary tabindex ends on blur", () => {
  const { window, presentation, route, announcements, scrolls } = setup(
    "<h1>Shell</h1><main>Page</main><button>Other</button>",
  );

  presentation.commit(route, "https://example.test/page", presentation.begin());

  const main = window.document.querySelector("main")!;

  expect(window.document.activeElement).toBe(main);

  expect(main.getAttribute("tabindex")).toBe("-1");

  expect(scrolls).toStrictEqual([[0, 0]]);

  expect(announcements).toStrictEqual(["Destination"]);

  window.document.querySelector("button")!.focus();

  expect(main.hasAttribute("tabindex")).toBe(false);
});

test("route presentation owns scroll restoration until disposal", () => {
  const { window, presentation } = setup("<main>Page</main>");

  expect(window.history.scrollRestoration).toBe("manual");

  presentation.dispose();

  expect(window.history.scrollRestoration).toBe("auto");
});

test.each([true, false])(
  "scroll events preserve the position's age relative to navigation: prior=%s",
  (prior) => {
    const { window, platform, presentation, route, scrolls } = setup("<main>Page</main>");
    let position = prior ? 240 : 0;

    Object.defineProperty(window, "scrollY", { get: () => position });

    const intent = presentation.begin();
    position = 240;

    platform.dispatchEvent(new platform.Event("scroll"));

    presentation.commit({ ...route, scroll: [0, 120] }, "https://example.test/page", intent);

    expect(scrolls).toStrictEqual(prior ? [[0, 120]] : []);
  },
);

test("no meaningful route target never makes html or body focusable", () => {
  const { window, presentation, route } = setup("<span>Page</span>");

  presentation.commit(route, "https://example.test/page", presentation.begin());

  expect(window.document.documentElement.hasAttribute("tabindex")).toBe(false);

  expect(window.document.body.hasAttribute("tabindex")).toBe(false);
});

test("new focus and scroll intent during preparation survive terminal metadata publication", () => {
  const { window, platform, presentation, route, scrolls, announcements } = setup(
    "<main>Page</main><input>",
  );
  const intent = presentation.begin();
  const input = window.document.querySelector("input")!;

  input.focus();

  platform.dispatchEvent(new platform.WheelEvent("wheel"));

  presentation.commit(route, "https://example.test/page", intent);

  expect(window.document.activeElement).toBe(input);

  expect(scrolls).toStrictEqual([]);

  expect(window.document.title).toBe("Destination");

  expect(announcements).toStrictEqual(["Destination"]);
});

test("a route fragment receives one scroll and focus; owner disposal removes temporary tabindex", () => {
  const { window, runtime, presentation, route, scrolls } = setup(
    '<main>Page</main><h2 id="details">Details</h2>',
  );
  const details = window.document.querySelector<HTMLElement>("#details")!;
  let fragmentScrolls = 0;
  details.scrollIntoView = () => {
    fragmentScrolls++;
  };

  presentation.commit(route, "https://example.test/page#details", presentation.begin());

  expect(window.document.activeElement).toBe(details);

  expect(fragmentScrolls).toBe(1);

  expect(scrolls).toStrictEqual([]);

  runtime.owner.dispose();

  expect(details.hasAttribute("tabindex")).toBe(false);
});

test("a newer focused control that is removed falls back to the committed route", () => {
  const { window, presentation, route } = setup("<main>Page</main><input>");
  const intent = presentation.begin();
  const input = window.document.querySelector("input")!;

  input.focus();

  input.remove();

  presentation.commit(route, "https://example.test/page", intent);

  expect(window.document.activeElement).toBe(window.document.querySelector("main"));
});

test("history restoration returns to the retained control and saved scroll position", () => {
  const { window, presentation, route, scrolls, announcements } = setup(
    '<main>Page</main><input id="search">',
  );
  const input = window.document.querySelector("input")!;

  input.focus();

  Object.defineProperties(window, {
    scrollX: { value: 12, configurable: true },
    scrollY: { value: 340, configurable: true },
  });

  const snapshot = presentation.capture();

  input.blur();

  presentation.commit(route, "https://example.test/page", presentation.begin(), snapshot);

  expect(window.document.activeElement).toBe(input);

  expect(scrolls).toStrictEqual([[12, 340]]);

  expect(announcements).toStrictEqual(["Destination"]);
});

test("history focus resolves a recreated control by id and rejects a disabled replacement", () => {
  const { window, presentation, route } = setup('<main>Page</main><input id="search">');
  const original = window.document.querySelector("input")!;

  original.focus();

  const snapshot = presentation.capture();
  const replacement = window.document.createElement("input");
  replacement.id = "search";

  original.replaceWith(replacement);

  presentation.commit(route, "https://example.test/page", presentation.begin(), snapshot);

  expect(window.document.activeElement).toBe(replacement);

  replacement.disabled = true;

  presentation.commit(route, "https://example.test/page", presentation.begin(), snapshot);

  expect(window.document.activeElement).toBe(window.document.querySelector("main"));
});

test("newer interaction wins over history restoration while explicit route targets override saved ones", () => {
  const { platform, window, presentation, route, scrolls } = setup(
    '<main id="content">Page</main><input id="search"><button>Other</button>',
  );

  window.document.querySelector("input")!.focus();

  const snapshot = presentation.capture();
  const intent = presentation.begin();
  const button = window.document.querySelector("button")!;

  button.focus();

  platform.dispatchEvent(new platform.WheelEvent("wheel"));

  presentation.commit(route, "https://example.test/page", intent, snapshot);

  expect(window.document.activeElement).toBe(button);

  expect(scrolls).toStrictEqual([]);

  presentation.commit(
    { ...route, focusTarget: "#content", scroll: [1, 25] },
    "https://example.test/page",
    presentation.begin(),
    snapshot,
  );

  expect(window.document.activeElement).toBe(window.document.querySelector("main"));

  expect(scrolls).toStrictEqual([[1, 25]]);
});

test("default navigation announcements use one persistent live region and release it on disposal", () => {
  const { window, route } = setup("<main>Page</main>");
  const presentation = new RoutePresentation(window);

  cleanups.push(() => presentation.dispose());

  const region = window.document.querySelector('[role="status"]')!;

  expect(region.textContent).toBe("");

  expect(region.getAttribute("aria-live")).toBe("polite");

  expect(region.getAttribute("aria-atomic")).toBe("true");

  presentation.commit(route, "https://example.test/first", presentation.begin());

  expect(region.textContent).toBe("Destination");

  presentation.commit(
    { ...route, title: "Second", announcement: "Account updated" },
    "https://example.test/second",
    presentation.begin(),
  );

  expect(window.document.querySelector('[role="status"]')).toBe(region);

  expect(region.textContent).toBe("Account updated");

  presentation.dispose();

  expect(region.isConnected).toBe(false);
});
