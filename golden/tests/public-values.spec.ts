import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { expect, test, type Page, type Route } from "@playwright/test";

interface Observation {
  readonly ready: string | null;
  readonly omittedOwn: string | null;
  readonly omittedIsUndefined: string | null;
  readonly explicitUndefinedOwn: string | null;
  readonly explicitUndefinedIsUndefined: string | null;
  readonly explicitNullOwn: string | null;
  readonly explicitNullIsNull: string | null;
  readonly explicitUndefinedText: string | null;
  readonly explicitNullText: string | null;
}

interface MutantEvidence {
  readonly assetPath: string;
  readonly originalSha256: string;
  readonly mutantSha256: string;
  readonly removedSource: string;
}

const fixtureRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../fixtures/public-values");
const publicConsumerConfig = resolve(fixtureRoot, "tsconfig.public-consumer.json");
const publicShapeEntry = '["explicitUndefined"]: undefined,';
const execFileAsync = promisify(execFile);

async function readObservation(page: Page): Promise<Observation | null> {
  const shape = page.locator("#public-shape");

  if ((await shape.count()) === 0) return null;

  return shape.evaluate((element) => ({
    ready: element.getAttribute("data-ready"),
    omittedOwn: element.getAttribute("data-omitted-own"),
    omittedIsUndefined: element.getAttribute("data-omitted-is-undefined"),
    explicitUndefinedOwn: element.getAttribute("data-explicit-undefined-own"),
    explicitUndefinedIsUndefined: element.getAttribute("data-explicit-undefined-is-undefined"),
    explicitNullOwn: element.getAttribute("data-explicit-null-own"),
    explicitNullIsNull: element.getAttribute("data-explicit-null-is-null"),
    explicitUndefinedText: element.querySelector("#explicit-undefined-value")?.textContent ?? null,
    explicitNullText: element.querySelector("#explicit-null-value")?.textContent ?? null,
  }));
}

function assertPublicShape(observed: Observation | null): void {
  expect(observed).not.toBeNull();

  expect(observed!.ready).toBe("true");

  expect(observed!.omittedOwn).toBe("false");

  expect(observed!.omittedIsUndefined).toBe("true");

  expect(
    observed!.explicitUndefinedOwn,
    "Object.hasOwn(PUBLIC_SHAPE, 'explicitUndefined') must remain true",
  ).toBe("true");

  expect(observed!.explicitUndefinedIsUndefined).toBe("true");

  expect(observed!.explicitNullOwn).toBe("true");

  expect(observed!.explicitNullIsNull).toBe("true");

  expect(observed!.explicitUndefinedText).toBe("undefined");

  expect(observed!.explicitNullText).toBe("null");
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

test("compiled public values distinguish an omitted key from own undefined and null", async ({
  page,
}, testInfo) => {
  const pageErrors: string[] = [];

  page.on("pageerror", (error) => pageErrors.push(error.message));

  const response = await page.goto("/public-values");

  expect(response?.status()).toBe(200);

  await expect(page.locator("#public-shape")).toHaveAttribute("data-ready", "true");

  assertPublicShape(await readObservation(page));

  expect(pageErrors).toStrictEqual([]);

  await testInfo.attach("public-values-page-errors.json", {
    body: Buffer.from(JSON.stringify(pageErrors, null, 2)),
    contentType: "application/json",
  });
});

test("missing own undefined in an isolated emitted asset is caught by the same oracle", async ({
  page,
}, testInfo) => {
  const pageErrors: string[] = [];

  page.on("pageerror", (error) => pageErrors.push(error.message));

  let mutant: MutantEvidence | undefined;
  let setupError: string | undefined;
  const assetCandidates: {
    readonly path: string;
    readonly sha256: string;
    readonly snippets: readonly string[];
  }[] = [];

  const mutationRoute = async (route: Route): Promise<void> => {
    try {
      const response = await route.fetch();
      const original = await response.text();
      const positions: number[] = [];
      let searchFrom = 0;

      while (true) {
        const position = original.indexOf("explicitUndefined", searchFrom);

        if (position === -1) break;

        positions.push(position);

        searchFrom = position + "explicitUndefined".length;
      }

      if (positions.length > 0) {
        assetCandidates.push({
          path: new URL(route.request().url()).pathname,
          sha256: hash(original),
          snippets: positions.map((position) =>
            original.slice(Math.max(0, position - 100), position + 140),
          ),
        });
      }

      const first = original.indexOf(publicShapeEntry);

      if (first === -1) {
        await route.fulfill({ response });

        return;
      }

      if (original.indexOf(publicShapeEntry, first + publicShapeEntry.length) !== -1) {
        throw new Error("The generated PUBLIC_SHAPE entry appeared more than once in one asset");
      }

      if (mutant) throw new Error("The generated PUBLIC_SHAPE entry appeared in multiple assets");

      const changed = original.slice(0, first) + original.slice(first + publicShapeEntry.length);
      mutant = {
        assetPath: new URL(route.request().url()).pathname,
        originalSha256: hash(original),
        mutantSha256: hash(changed),
        removedSource: publicShapeEntry,
      };

      await route.fulfill({ response, body: changed });
    } catch (error) {
      setupError = error instanceof Error ? error.message : String(error);

      await route.continue();
    }
  };

  await page.route("**/assets/*.js", mutationRoute);

  const response = await page.goto("/public-values");

  expect(response?.status()).toBe(200);

  await expect(page.locator("#public-shape")).toHaveAttribute("data-ready", "true");

  expect(setupError).toBeUndefined();

  if (!mutant) {
    await testInfo.attach("public-values-asset-candidates.json", {
      body: Buffer.from(JSON.stringify(assetCandidates, null, 2)),
      contentType: "application/json",
    });
  }

  expect(mutant, "the exact emitted PUBLIC_SHAPE entry must be changed once").toBeDefined();

  const observed = await readObservation(page);

  expect(observed).toStrictEqual({
    ready: "true",
    omittedOwn: "false",
    omittedIsUndefined: "true",
    explicitUndefinedOwn: "false",
    explicitUndefinedIsUndefined: "true",
    explicitNullOwn: "true",
    explicitNullIsNull: "true",
    explicitUndefinedText: "undefined",
    explicitNullText: "null",
  });

  let oracleFailure: string | undefined;

  try {
    assertPublicShape(observed);
  } catch (error) {
    oracleFailure = error instanceof Error ? error.message : String(error);
  }

  expect(oracleFailure).toContain("Object.hasOwn(PUBLIC_SHAPE, 'explicitUndefined')");

  await page.unroute("**/assets/*.js", mutationRoute);

  const ordinaryResponse = await page.goto("/public-values");

  expect(ordinaryResponse?.status()).toBe(200);

  await expect(page.locator("#public-shape")).toHaveAttribute("data-ready", "true");

  const ordinaryObservation = await readObservation(page);

  assertPublicShape(ordinaryObservation);

  expect(pageErrors).toStrictEqual([]);

  await testInfo.attach("public-values-undefined-mutant.json", {
    body: Buffer.from(
      JSON.stringify({ mutant, observed, oracleFailure, ordinaryObservation, pageErrors }, null, 2),
    ),
    contentType: "application/json",
  });
});

test("generated declarations preserve public value types and omit absent keys", async ({
  browserName,
}) => {
  test.skip(browserName !== "chromium", "Run the declaration consumer once per suite");

  const tsc = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../../node_modules/typescript/bin/tsc",
  );
  const result = await execFileAsync(
    process.execPath,
    [tsc, "--noEmit", "--project", publicConsumerConfig],
    { cwd: fixtureRoot },
  );

  expect(result.stdout + result.stderr).toBe("");
});
