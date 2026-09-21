import { expect, test } from "bun:test";
import { EditorProject } from "../../src/editor/project.ts";

test("native event completion works in unfinished attributes and replaces only the event name", () => {
  for (const markup of ["<button on:| />", "<button on:|", "<button on:dr|agend />"]) {
    const authored = `const emoji = "🐈";\r\nexport const App = () => ${markup}`;
    const offset = authored.indexOf("|");
    const source = authored.replace("|", "");
    const project = new EditorProject([{ filename: "events.tsx", source }]);
    try {
      const items = project.completions("events.tsx", offset);
      const drag = items.find((item) => item.label === "dragstart");
      expect(drag).toBeDefined();
      expect(items.some((item) => item.label === "dragStart")).toBe(false);
      expect(drag?.insertText).toBe("dragstart");
      expect(drag?.replacement).toStrictEqual({
        start: source.indexOf("on:") + 3,
        end: source.indexOf("on:") + 3 + (markup.includes("dr|agend") ? 7 : 0),
      });
      if (markup.includes("dr|"))
        expect(items.every((item) => item.label.startsWith("dr"))).toBe(true);
      else
        for (const event of ["click", "dragend", "mouseenter", "mouseleave", "keydown"])
          expect(items.some((item) => item.label === event)).toBe(true);
    } finally {
      project.dispose();
    }
  }
});

test("event completion uses the matching DOM event map for complete and unfinished JSX", () => {
  for (const [markup, event] of [
    ["<button on:| />", "htmlEvent"],
    ["<svg><circle on:| /></svg>", "svgEvent"],
    ["<math><mi on:| /></math>", "mathEvent"],
    ["<svg><foreignObject><button on:| /></foreignObject></svg>", "htmlEvent"],
    [
      '<math><annotation-xml encoding={"text/html"}><button on:| /></annotation-xml></math>',
      "htmlEvent",
    ],
    ["<button on:html| />", "htmlEvent"],
    ["<svg><circle on:svg| /></svg>", "svgEvent"],
    ["<math><mi on:math| /></math>", "mathEvent"],
  ] as const) {
    const authored = `declare global {
      interface HTMLElementEventMap { htmlEvent: MouseEvent }
      interface SVGElementEventMap { svgEvent: MouseEvent }
      interface MathMLElementEventMap { mathEvent: MouseEvent }
    }
    export const App = () => ${markup}`;
    const project = new EditorProject([
      { filename: "events.tsx", source: authored.replace("|", "") },
    ]);
    try {
      const items = project.completions("events.tsx", authored.indexOf("|"));
      expect(items.find((item) => item.label === event)?.detail).toContain("MouseEvent");
      for (const other of ["htmlEvent", "svgEvent", "mathEvent"].filter((name) => name !== event))
        expect(items.some((item) => item.label === other)).toBe(false);
    } finally {
      project.dispose();
    }
  }
});

test("native event completion stays out of expressions, strings, comments and components", () => {
  for (const source of [
    'export const text = "on:|";',
    'export const App = () => <button title="on:|" />;',
    'export const App = () => <button>{"on:|"}</button>;',
    "export const App = () => <button data-on:dr| />;",
    "export const App = () => <Child on:| />;",
    "// on:|\nexport const value = 1;",
  ]) {
    const project = new EditorProject([
      { filename: "events.tsx", source: source.replace("|", "") },
    ]);
    try {
      expect(
        project
          .completions("events.tsx", source.indexOf("|"))
          .some((item) => item.label === "dragstart"),
      ).toBe(false);
    } finally {
      project.dispose();
    }
  }
});
