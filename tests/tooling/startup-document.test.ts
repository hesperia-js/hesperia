import { expect, test } from "bun:test";
import { browserStartupHtml, browserStartupSource } from "../../packages/tooling/src/startup.ts";

function startupEntry(document: string): string {
  const specifier = document.match(/import \{ start \} from ("[^"]+");/u)?.[1];

  if (!specifier) throw new Error("Emitted startup document has no entry import");

  return JSON.parse(specifier) as string;
}

test("emitted startup document resolves its entry from the selected mount at deep routes", () => {
  const cases = [
    {
      mountPath: "/",
      documentPath: "/section/deeper/page",
      expectedPath: "/assets/main-example.js",
    },
    {
      mountPath: "/dashboard",
      documentPath: "/dashboard/section/deeper/page",
      expectedPath: "/dashboard/assets/main-example.js",
    },
  ];

  for (const { mountPath, documentPath, expectedPath } of cases) {
    const html = browserStartupHtml("/assets/main-example.js", mountPath);
    const resolvedEntry = new URL(
      startupEntry(html),
      new URL(documentPath, "https://example.test"),
    );

    expect(resolvedEntry.pathname).toBe(expectedPath);

    expect(html).toContain(`await start(${JSON.stringify(mountPath)})`);
  }
});

test("compiled startup remains import-safe and takes the host-selected mount", () => {
  const source = browserStartupSource(true);
  const startDeclaration = source.indexOf("export async function start(mountPath: string)");
  const bootstrapCall = source.indexOf("await bootstrapApplication(window");

  expect(startDeclaration).toBeGreaterThanOrEqual(0);

  expect(bootstrapCall).toBeGreaterThan(startDeclaration);

  expect(source).toContain("}, { mountPath });");

  expect(source).not.toContain("/dashboard");
});
