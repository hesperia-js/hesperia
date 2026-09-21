import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { devProject, type ProjectServer } from "../../src/tooling/server.ts";

interface BuildRecord {
  readonly checkingInputs: readonly { filename: string; digest: string }[];
}

function sourceDigest(source: string): string {
  return `sha256-${new Bun.CryptoHasher("sha256").update(source).digest("hex")}`;
}

async function nextEvent(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  expected: string,
): Promise<string> {
  let received = "";
  while (!received.includes(expected)) {
    const chunk = await reader.read();
    if (chunk.done) throw new Error(`Development events ended before ${expected}`);
    received += new TextDecoder().decode(chunk.value);
  }
  return received;
}

test("development captures and watches external package declarations", async () => {
  const parent = resolve(import.meta.dir, "../../.hesperia");
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, "checking-inputs-"));
  let server: ProjectServer | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const library = join(root, "node_modules/declaration-package");
    await mkdir(join(library, "types"), { recursive: true });
    await mkdir(join(root, "src/routes"), { recursive: true });
    await writeFile(
      join(library, "package.json"),
      JSON.stringify({
        name: "declaration-package",
        type: "module",
        exports: {
          ".": {
            types: "./types/api.d.ts",
            browser: "./browser.js",
            default: "./browser.js",
          },
        },
      }),
    );
    const initialDeclaration = "export declare const label: string;";
    const repairedDeclaration = 'export declare const label: "updated";';
    const declaration = join(library, "types/api.d.ts");
    await writeFile(declaration, initialDeclaration);
    await writeFile(join(library, "browser.js"), 'export const label = "initial";');
    await writeFile(
      join(root, "hesperia.config.json"),
      JSON.stringify({
        resolutionOverrides: { browser: { "chosen-library": "declaration-package" } },
      }),
    );
    await writeFile(
      join(root, "app.tsx"),
      'import { label } from "chosen-library"; export default function App() { return <html><head><title>{label.toUpperCase()}</title></head><body>{label}</body></html>; }',
    );

    const reports: string[] = [];
    server = await devProject(root, { port: 0, report: (message) => reports.push(message) });
    const initialRecord = (await (
      await fetch(new URL("/hesperia-build.json", server.url))
    ).json()) as BuildRecord;
    const initialInput = initialRecord.checkingInputs.find(
      (input) => input.filename === "node_modules/declaration-package/types/api.d.ts",
    );
    expect(initialInput?.digest).toBe(sourceDigest(initialDeclaration));

    const events = await fetch(new URL("/__hesperia/events", server.url), {
      signal: AbortSignal.timeout(15_000),
    });
    reader = events.body!.getReader();
    const connected = await reader.read();
    expect(new TextDecoder().decode(connected.value)).toContain(": connected");

    await writeFile(declaration, "export declare const label: number;");
    const diagnostic = await nextEvent(reader, "Hesperia checking failed");
    expect(diagnostic).toContain('data: "ProjectError: Hesperia checking failed"');
    expect(reports).toContain("ProjectError: Hesperia checking failed");
    const failedRecord = (await (
      await fetch(new URL("/hesperia-build.json", server.url))
    ).json()) as BuildRecord;
    expect(failedRecord).toStrictEqual(initialRecord);

    await writeFile(declaration, repairedDeclaration);
    await nextEvent(reader, 'data: "reload"');
    const repairedRecord = (await (
      await fetch(new URL("/hesperia-build.json", server.url))
    ).json()) as BuildRecord;
    const repairedInput = repairedRecord.checkingInputs.find(
      (input) => input.filename === "node_modules/declaration-package/types/api.d.ts",
    );
    expect(repairedInput?.digest).toBe(sourceDigest(repairedDeclaration));
    expect(repairedInput?.digest).not.toBe(initialInput?.digest);
    expect(repairedRecord).not.toStrictEqual(initialRecord);
  } finally {
    await reader?.cancel().catch(() => undefined);
    await server?.close();
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
