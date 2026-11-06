import { expect, test } from "@playwright/test";

test("client.form captures native successful controls and submitter", async ({ page }) => {
  await page.goto("/form");

  await expect(page.locator("html")).toHaveAttribute("data-ready", "true");
  await expect(page.locator("#validation-status")).toHaveText("idle");

  await page.locator("#submit-save").click();

  await expect(page.locator("#schema-calls")).toHaveText("0");
  await expect(page.locator("#validation-status")).toHaveText("idle");
  await expect(page.locator("#captured-in-call")).toHaveText("not-run");

  await page.locator("#required").fill("Ada");
  await page.locator("#delay").fill("slow");
  await page.locator("#upload").setInputFiles({
    name: "receipt.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("hello"),
  });

  await expect(page.locator("#pending-dependent")).toHaveValue("before-run");

  await page.locator("#submit-save").click();

  await expect(page.locator("#validation-status")).toHaveText("pending");
  await expect(page.locator("#pending-dependent")).toHaveValue("during-pending");
  await expect(page.locator("#schema-calls")).toHaveText("1");
  await expect(page.locator("#captured-in-call")).toHaveText("true");

  await page.locator("#required").fill("Changed after invocation");
  await page.locator("#tag-one").fill("green");
  await page.locator("#tag-two").fill("yellow");
  await page.locator("#dotted").fill("Changed name");

  await page.locator("#release-validation").click();

  await expect(page.locator("#validation-status")).toHaveText("success");

  expect(JSON.parse((await page.locator("#validation-result").textContent()) ?? "")).toStrictEqual({
    required: "Ada",
    empty: "",
    "profile.name": "Ada Lovelace",
    pendingState: "before-run",
    "metadata[code]": "x7",
    ["__proto__"]: "literal",
    unrecognized: "kept",
    tags: ["red", "blue"],
    delay: "slow",
    upload: { file: "receipt.txt", type: "text/plain", size: 5 },
    intent: "save",
  });
  await expect(page.locator("#validation-error")).toHaveText("");

  await page.locator("#required").fill("invalid");
  await page.locator("#delay").fill("");
  await page.locator("#submit-draft").click();

  await expect(page.locator("#validation-status")).toHaveText("success");
  expect(JSON.parse((await page.locator("#validation-result").textContent()) ?? "")).toStrictEqual({
    issues: [{ message: "Enter a usable value", path: [{ key: "required" }] }],
  });

  await page.locator("#reset-validation").click();

  await expect(page.locator("#validation-status")).toHaveText("idle");
  await expect(page.locator("#validation-result")).toHaveText("");
  await expect(page.locator("#validation-error")).toHaveText("");
  await expect(page.locator("#required")).toHaveValue("invalid");
  expect(
    await page.locator("#upload").evaluate((node) => (node as HTMLInputElement).files?.length),
  ).toBe(1);

  await page.locator("#run-direct").click();

  await expect(page.locator("#validation-status")).toHaveText("success");
  expect(JSON.parse((await page.locator("#validation-result").textContent()) ?? "")).toStrictEqual({
    required: "direct",
    intent: "direct",
  });
});

test("form mapping faults and direct runs share the form task's latest authority", async ({
  page,
}) => {
  await page.goto("/form");

  await expect(page.locator("html")).toHaveAttribute("data-ready", "true");

  await page.locator("#mapped-submit").click();

  await expect(page.locator("#mapped-status")).toHaveText("success");
  expect(JSON.parse((await page.locator("#mapped-result").textContent()) ?? "")).toStrictEqual({
    required: "mapped",
    mappedOnly: "from-map",
  });

  await page.locator("#mapped-source").fill("map-fault");
  await page.locator("#mapped-submit").click();

  await expect(page.locator("#mapped-status")).toHaveText("failure");
  await expect(page.locator("#mapped-error")).toHaveText("Error:form mapping failed");

  const callsBeforeCaptureFailure = await page.locator("#schema-calls").textContent();

  await page.locator("#bad-capture").click();

  await expect(page.locator("#validation-status")).toHaveText("failure");
  await expect(page.locator("#validation-error")).not.toHaveText("");
  await expect(page.locator("#schema-calls")).toHaveText(callsBeforeCaptureFailure ?? "0");

  await page.locator("#required").fill("old");
  await page.locator("#delay").fill("slow");
  await page.locator("#submit-save").click();

  await expect(page.locator("#validation-status")).toHaveText("pending");

  await page.locator("#required").fill("latest");
  await page.locator("#delay").fill("");
  await page.locator("#submit-draft").click();

  await expect(page.locator("#validation-status")).toHaveText("success");
  expect(JSON.parse((await page.locator("#validation-result").textContent()) ?? "")).toMatchObject({
    required: "latest",
    intent: "draft",
  });

  await page.locator("#release-validation").click();

  expect(JSON.parse((await page.locator("#validation-result").textContent()) ?? "")).toMatchObject({
    required: "latest",
    intent: "draft",
  });

  await page.locator("#delay").fill("slow");
  await page.locator("#submit-save").click();
  await expect(page.locator("#validation-status")).toHaveText("pending");
  await page.locator("#run-direct").click();

  await expect(page.locator("#validation-status")).toHaveText("success");
  expect(JSON.parse((await page.locator("#validation-result").textContent()) ?? "")).toStrictEqual({
    required: "direct",
    intent: "direct",
  });

  await page.locator("#release-validation").click();

  expect(JSON.parse((await page.locator("#validation-result").textContent()) ?? "")).toStrictEqual({
    required: "direct",
    intent: "direct",
  });
});

test("disposing the mounted owner cancels an active form validation", async ({ page }) => {
  const pageErrors: string[] = [];

  page.on("pageerror", (error) => pageErrors.push(error.message));

  await page.goto("/form");

  await expect(page.locator("html")).toHaveAttribute("data-ready", "true");
  await page.locator("#required").fill("pending on disposal");
  await page.locator("#delay").fill("slow");
  await page.locator("#submit-save").click();
  await expect(page.locator("#validation-status")).toHaveText("pending");

  await page.locator("#remove").click();

  await expect(page.locator("html")).toHaveAttribute("data-disposed", "true");
  await expect(page.locator("#validation-form")).toHaveCount(0);

  await page.locator("#release-validation").click();

  await expect(page.locator("#provider-completions")).toHaveText("1");
  expect(pageErrors).toStrictEqual([]);
});
