import { expect, test } from "bun:test";
import { capture, once, passive } from "../../packages/hesperia/src/events.ts";

test("event options preserve the handler while composing and overriding options", () => {
  const handler = (_event: Event) => undefined;

  const first = once(handler);
  const second = passive(first);
  const third = capture([handler, { once: false, capture: false }] as const);

  expect(first).toStrictEqual([handler, { once: true }]);

  expect(second).toStrictEqual([handler, { once: true, passive: true }]);

  expect(third).toStrictEqual([handler, { once: false, capture: true }]);

  expect(first[0]).toBe(handler);

  expect(second[0]).toBe(handler);
});

test("each event option result is independent of its input and other uses", () => {
  const handler = (_event: Event) => undefined;

  const input = [handler, { passive: false }] as const;
  const first = passive(input);
  const second = passive(input);

  expect(first).not.toBe(second);

  expect(first[1]).not.toBe(second[1]);

  expect(input[1].passive).toBe(false);

  expect(first[1].passive).toBe(true);

  expect(Object.isFrozen(first)).toBe(true);

  expect(Object.isFrozen(first[1])).toBe(true);
});
