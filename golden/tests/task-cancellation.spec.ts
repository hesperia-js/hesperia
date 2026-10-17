import { expect, test } from "@playwright/test";

type TaskOutcome = { kind: "resolved"; value: string } | { kind: "rejected"; name: string };

type TaskHarness = {
  currentId(): number | undefined;

  cancel(): void;

  resolveBackend(value: string): void;

  backendSettled(): Promise<void>;

  outcome(): Promise<TaskOutcome>;
};

declare global {
  interface Window {
    hesperiaGoldenTask: TaskHarness;
  }
}

test("a cancelled task stays cancelled after its backend completes late", async ({ page }) => {
  const errors: string[] = [];

  page.on("pageerror", (error) => errors.push(error.message));

  await page.goto("/task-cancellation");

  await expect(page.locator("html")).toHaveAttribute("data-ready", "true");

  const outcome = page.locator("#task-outcome");

  await expect(outcome).toHaveText("idle:none");

  await page.getByRole("button", { name: "Start task" }).click();

  await expect(outcome).toHaveText("pending:none");

  const runId = await page.evaluate(() => window.hesperiaGoldenTask.currentId());

  expect(runId).toBeGreaterThan(0);

  await page.getByRole("button", { name: "Cancel task" }).click();

  await expect(outcome).toHaveText("cancelled:none");

  expect(await page.evaluate(() => window.hesperiaGoldenTask.outcome())).toStrictEqual({
    kind: "rejected",
    name: "AbortError",
  });

  await page.evaluate(() => window.hesperiaGoldenTask.resolveBackend("late backend result"));

  await page.evaluate(() => window.hesperiaGoldenTask.backendSettled());

  await expect(outcome).toHaveText("cancelled:none");

  expect(errors).toStrictEqual([]);
});
