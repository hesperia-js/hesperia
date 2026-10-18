import { expect, test } from "bun:test";

test("the owner reports a failing behavior assertion", () => {
  expect("regressed behavior").toBe("expected behavior");
});
