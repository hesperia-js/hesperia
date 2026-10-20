import assert from "node:assert/strict";
import type { Page } from "@playwright/test";

export type NavigationMode = "fallback" | "native";

interface NavigationWitness {
  readonly navigationAvailable: boolean;
  readonly explicitlyDisabled: boolean;
  readonly traversals: string[];
  readonly admissions: { readonly url: string; readonly type: string }[];
}

declare global {
  interface Window {
    goldenNavigationWitness?: NavigationWitness;
  }
}

export async function selectNavigationMode(
  page: Page,
  mode: NavigationMode,
): Promise<readonly string[]> {
  await page.goto("/health");

  const missing = await page.evaluate(() => {
    const browser = window as Window & {
      NavigateEvent?: typeof NavigateEvent;
      NavigationPrecommitController?: unknown;
    };
    return [
      ...(browser.navigation?.currentEntry ? [] : ["Navigation.currentEntry"]),
      ...(typeof browser.NavigateEvent?.prototype.intercept === "function"
        ? []
        : ["NavigateEvent.intercept"]),
      ...(typeof browser.NavigationPrecommitController === "function"
        ? []
        : ["NavigationPrecommitController"]),
    ];
  });

  if (mode === "native" && missing.length > 0) return missing;

  await page.addInitScript((selected: NavigationMode) => {
    if (selected === "fallback")
      Object.defineProperty(window, "navigation", { configurable: true, value: undefined });

    const witness: NavigationWitness = {
      navigationAvailable: window.navigation !== undefined,
      explicitlyDisabled:
        selected === "fallback" &&
        Object.hasOwn(window, "navigation") &&
        window.navigation === undefined,
      traversals: [],
      admissions: [],
    };
    window.goldenNavigationWitness = witness;

    window.addEventListener("popstate", () => witness.traversals.push(window.location.href));

    if (selected !== "native") return;

    const prototype = NavigateEvent.prototype;
    const intercept = prototype.intercept;
    prototype.intercept = function (options) {
      const precommit = options?.precommitHandler;

      if (!precommit) return Reflect.apply(intercept, this, [options]);

      const destination = this.destination;
      const navigationType = this.navigationType;
      return Reflect.apply(intercept, this, [
        {
          ...options,
          async precommitHandler(controller) {
            await Reflect.apply(precommit, this, [controller]);

            witness.admissions.push({ url: destination.url, type: navigationType });
          },
        } satisfies NavigationInterceptOptions,
      ]);
    };
  }, mode);

  return [];
}

export async function assertNavigationMode(
  page: Page,
  mode: NavigationMode,
): Promise<NavigationWitness> {
  const witness = await page.evaluate(() => window.goldenNavigationWitness);

  assert.ok(witness, "Navigation mode witness is missing");

  assert.equal(
    witness.navigationAvailable,
    mode === "native",
    "Actual Navigation API availability disagrees with requested mode",
  );

  if (mode === "native") {
    assert.ok(
      witness.admissions.some((item) => item.type === "traverse"),
      "Native traversal never completed an intercepted precommit admission",
    );
  } else {
    assert.equal(
      witness.explicitlyDisabled,
      true,
      "Fallback was not explicitly selected before startup",
    );

    assert.ok(
      witness.traversals.length >= 2,
      "Fallback did not observe both real History traversals",
    );
  }

  return witness;
}
