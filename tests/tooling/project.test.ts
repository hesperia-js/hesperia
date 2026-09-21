import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  checkSources,
  initProject,
  prepareBuild,
  readProject,
  writeBuild,
} from "../../src/tooling/project.ts";
import { assetResponse, devProject, previewProject } from "../../src/tooling/server.ts";

const roots: string[] = [];
async function temporaryProject(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "hesperia-tooling-"));
  roots.push(root);
  return root;
}
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("project commands", () => {
  test("checks imported modules outside src in the same source snapshot", async () => {
    const root = await temporaryProject();
    await mkdir(join(root, "src/routes"), { recursive: true });
    await writeFile(
      join(root, "src/routes/+page.tsx"),
      'import { api } from "../../api.ts"; export default function Page() { return <main>{api}</main>; }',
    );
    await writeFile(join(root, "api.ts"), 'export { api } from "./backend.ts";');
    await writeFile(join(root, "backend.ts"), "export const api: string = 42;");
    const sources = await readProject(root);
    expect(sources.get(join(root, "api.ts"))).toContain('"./backend.ts"');
    expect(sources.get(join(root, "backend.ts"))).toContain("42");
    const diagnostics = checkSources(sources, root);
    expect(
      diagnostics.some(
        (item) => item.code === "TS2322" && item.filename === join(root, "backend.ts"),
      ),
    ).toBe(true);
    await expect(prepareBuild(root)).rejects.toThrow("checking failed");
  });

  test("the emitted command can initialize a project and reports invalid commands as failures", async () => {
    const root = await temporaryProject();
    const executable = resolve(import.meta.dir, "../../dist/tooling/cli.js");
    const invoke = async (...arguments_: string[]) => {
      const child = Bun.spawn([process.execPath, executable, ...arguments_], {
        cwd: root,
        stdout: "pipe",
        stderr: "pipe",
      });
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      return { code, stdout, stderr };
    };
    const help = await invoke("--help");
    expect(help.code).toBe(0);
    expect(help.stdout).toContain("hesperia preview");
    const created = await invoke("init", "app with spaces");
    expect(created.code).toBe(0);
    expect(await readFile(join(root, "app with spaces/src/routes/+page.tsx"), "utf8")).toContain(
      "client.state(0)",
    );
    const refused = await invoke("init", "app with spaces");
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain("empty destination");
    const unknown = await invoke("invented-command");
    expect(unknown.code).toBe(1);
    expect(unknown.stderr).toContain("Unknown Hesperia command");
  });

  test("creates the starter and refuses to overwrite a nonempty destination", async () => {
    const root = await temporaryProject();
    await initProject(root);
    const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
    expect(manifest.scripts).toStrictEqual({
      dev: "hesperia dev",
      build: "hesperia build",
      preview: "hesperia preview",
      check: "hesperia check",
    });
    const sources = await readProject(root);
    expect(
      [...sources.keys()].map((path) => path.slice(root.length).replaceAll("\\", "/")),
    ).toStrictEqual(["/app.tsx", "/app.config.ts", "/src/routes/+page.tsx"]);
    await writeFile(join(root, "notes.txt"), "keep me");
    await expect(initProject(root)).rejects.toThrow("empty destination");
    expect(await readFile(join(root, "notes.txt"), "utf8")).toBe("keep me");
  });

  test("type failures prevent publishing any build, including unreachable author modules", async () => {
    const root = await temporaryProject();
    await mkdir(join(root, "src"));
    await writeFile(
      join(root, "tsconfig.json"),
      JSON.stringify({ compilerOptions: { strict: true, noEmit: true }, include: ["src"] }),
    );
    await writeFile(
      join(root, "app.tsx"),
      'console.log("app"); export default function App() { return <html><head></head><body></body></html>; }',
    );
    await writeFile(join(root, "src/unreachable.ts"), "const value: string = 1;");
    const diagnostics = checkSources(await readProject(root));
    expect(
      diagnostics.some(
        (item) => item.code === "TS2322" && item.filename.endsWith("unreachable.ts"),
      ),
    ).toBe(true);
    await expect(prepareBuild(root)).rejects.toThrow("checking failed");
    expect(await readdir(root)).not.toContain(".hesperia");
  });

  test("project checking includes the root app shell and restricts document roots to that file", async () => {
    const root = await temporaryProject();
    await mkdir(join(root, "src"));
    const shell = join(root, "app.tsx");
    const source =
      "export default function App() { return <html><head><title>Hesperia</title></head><body><main>Ready</main></body></html>; }";
    await writeFile(shell, source);
    const snapshot = await readProject(root);
    expect(snapshot.get(shell)).toBe(source);
    expect(checkSources(snapshot, root)).toEqual([]);

    await writeFile(shell, source.replace("<head><title>Hesperia</title></head>", ""));
    expect(
      checkSources(await readProject(root), root).some(
        (item) => item.filename === shell && item.severity === "error",
      ),
    ).toBe(true);
    expect(checkSources(snapshot, root)).toEqual([]);

    await writeFile(shell, source);
    await writeFile(join(root, "src/nested.tsx"), source);
    expect(
      checkSources(await readProject(root), root).some(
        (item) => item.filename.endsWith("nested.tsx") && item.severity === "error",
      ),
    ).toBe(true);
  });

  test("the check command rejects compiler-invalid unreachable TSX before a build", async () => {
    const root = await temporaryProject();
    await mkdir(join(root, "src"));
    await writeFile(
      join(root, "app.tsx"),
      "export default function App() { return <html><head></head><body></body></html>; }",
    );
    await writeFile(
      join(root, "src/unreachable.tsx"),
      "export function Unreachable() { return <table><tr><td>invalid</td></tr></table>; }",
    );
    const child = Bun.spawn(
      [process.execPath, resolve(import.meta.dir, "../../dist/tooling/cli.js"), "check"],
      { cwd: root, stdout: "pipe", stderr: "pipe" },
    );
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(code).toBe(1);
    expect(stderr).toContain("unreachable.tsx: HES-HTML-CONTEXT:");
    expect(stdout).not.toContain("Hesperia checking passed");
    expect(await readdir(root)).not.toContain(".hesperia");
  });

  test("route collisions fail the emitted check command and prevent browser build preparation", async () => {
    const root = await temporaryProject();
    for (const group of ["(first)", "(second)"]) {
      const directory = join(root, "src/routes", group);
      await mkdir(directory, { recursive: true });
      await writeFile(
        join(directory, "+page.tsx"),
        "export default function Page() { return <main>page</main>; }",
      );
    }
    await writeFile(
      join(root, "app.tsx"),
      "export default function App() { return <html><head></head><body></body></html>; }",
    );
    const child = Bun.spawn(
      [process.execPath, resolve(import.meta.dir, "../../dist/tooling/cli.js"), "check"],
      { cwd: root, stdout: "pipe", stderr: "pipe" },
    );
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(code).toBe(1);
    expect(stdout).not.toContain("Hesperia checking passed");
    expect(stderr.match(/HES-ROUTE-SCAN:/gu)).toHaveLength(2);
    expect(stderr).toContain("(first)");
    expect(stderr).toContain("(second)");
    await expect(prepareBuild(root)).rejects.toThrow("checking failed");
    expect(await readdir(root)).not.toContain(".hesperia");
  });

  test("preview serves deep links as HTML while missing assets stay missing", async () => {
    const root = await temporaryProject();
    await writeBuild(root, {
      diagnostics: [],
      sources: [],
      files: new Map([
        ["/assets/main-test.js", new Blob(['document.body.dataset.loaded = "yes";'])],
        ["/index.html", new Blob(["<!doctype html><title>Preview</title>"])],
      ]),
    });
    const server = await previewProject(root, 0);
    try {
      const page = await fetch(new URL("/people/42?tab=details", server.url), {
        headers: { accept: "text/html" },
      });
      expect(page.status).toBe(200);
      expect(page.headers.get("content-type")).toBe("text/html; charset=utf-8");
      expect(await page.text()).toContain("<title>Preview</title>");
      const script = await fetch(new URL("/assets/main-test.js", server.url));
      expect(script.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
      expect(await script.text()).toContain("dataset.loaded");
      expect((await fetch(new URL("/missing.js", server.url))).status).toBe(404);
      expect(
        (await fetch(new URL("/assets/main-test.js", server.url), { method: "HEAD" })).headers.get(
          "content-type",
        ),
      ).toBe("text/javascript; charset=utf-8");
      expect((await fetch(server.url, { method: "POST" })).status).toBe(405);
    } finally {
      await server.close();
    }
  });

  test("builds browser assets with maps and publishes the rewritten entry after checking", async () => {
    const root = await temporaryProject();
    await mkdir(join(root, "src"));
    await writeFile(
      join(root, "tsconfig.json"),
      JSON.stringify({ compilerOptions: { strict: true, noEmit: true }, include: ["src"] }),
    );
    await writeFile(
      join(root, "app.tsx"),
      'document.body.setAttribute("data-application", "ready"); export default function App() { return <html><head></head><body></body></html>; }',
    );
    const built = await prepareBuild(root);
    expect(built.diagnostics).toStrictEqual([]);
    const scriptPath = [...built.files.keys()].find((path) => path.endsWith(".js"))!;
    expect(scriptPath).toMatch(/^\/assets\/main-.*\.js$/);
    expect([...built.files.keys()].some((path) => path.endsWith(".js.map"))).toBe(true);
    const html = await built.files.get("/index.html")!.text();
    expect(html).toContain(`src="${scriptPath}"`);
    expect(html).not.toContain("/src/main.ts");
    const scripts = await Promise.all(
      [...built.files].filter(([path]) => path.endsWith(".js")).map(([, file]) => file.text()),
    );
    expect(
      scripts.some((script) => script.includes('setAttribute("data-application", "ready")')),
    ).toBe(true);
    expect(scripts.some((script) => script.includes("oxc-parser"))).toBe(false);
    const record = JSON.parse(await built.files.get("/hesperia-build.json")!.text());
    expect(record.routeTable).toMatch(/^\/assets\/route-table-.*\.js$/u);
    expect(await built.files.get(record.routeTable)!.text()).toContain("routeTable");
    await writeBuild(root, built);
    expect(await readFile(join(root, ".hesperia/build/index.html"), "utf8")).toBe(html);
  });

  test("asset serving never maps a URL to arbitrary filesystem content", async () => {
    const files = new Map([["/index.html", new Blob(["shell"])]]);
    expect(assetResponse(files, new Request("http://localhost/%invalid")).status).toBe(400);
    expect(assetResponse(files, new Request("http://localhost/%2e%2e/package.json")).status).toBe(
      404,
    );
    expect(
      await assetResponse(
        files,
        new Request("http://localhost/", { method: "HEAD", headers: { accept: "text/html" } }),
      ).text(),
    ).toBe("");
  });

  test("development reload follows a successful rebuild and warnings reach its console", async () => {
    const root = await temporaryProject();
    await mkdir(join(root, "src"));
    await writeFile(
      join(root, "tsconfig.json"),
      JSON.stringify({ compilerOptions: { strict: true, noEmit: true }, include: ["src"] }),
    );
    await writeFile(
      join(root, "app.tsx"),
      'document.body.setAttribute("data-version", "first"); export default function App() { return <html><head></head><body></body></html>; }',
    );
    const reports: string[] = [];
    const server = await devProject(root, { port: 0, report: (message) => reports.push(message) });
    const abort = new AbortController();
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const events = await fetch(new URL("/__hesperia/events", server.url), {
        signal: AbortSignal.any([abort.signal, AbortSignal.timeout(15_000)]),
      });
      reader = events.body!.getReader();
      expect(new TextDecoder().decode((await reader.read()).value)).toContain(": connected");
      const waitForEvent = async (message: string) => {
        let received = "";
        while (!received.includes(message)) {
          const next = await reader!.read();
          if (next.done) throw new Error("Reload stream ended before rebuild");
          received += new TextDecoder().decode(next.value);
        }
      };
      await writeFile(
        join(root, "app.tsx"),
        'document.body.setAttribute("data-version", "second"); export default function App() { return <html><head></head><body></body></html>; }',
      );
      await waitForEvent('data: "reload"');
      const html = await (await fetch(server.url, { headers: { accept: "text/html" } })).text();
      expect(html.indexOf("/__hesperia/client.js")).toBeLessThan(html.indexOf("/assets/main-"));
      const path = html.match(/src="(\/assets\/[^"]+)"/)![1]!;
      const urls = new Set([new URL(path, server.url).href]);
      const scripts = new Map<string, string>();
      const scanner = new Bun.Transpiler({ loader: "js" });
      for (const url of urls) {
        const response = await fetch(url);
        expect(response.status).toBe(200);
        const source = await response.text();
        scripts.set(url, source);
        for (const dependency of scanner.scanImports(source)) {
          const target = new URL(dependency.path, url);
          expect(target.origin).toBe(server.url.origin);
          urls.add(target.href);
        }
      }
      const shell = [...scripts].find(([, source]) =>
        source.includes('setAttribute("data-version", "second")'),
      );
      expect(shell).toBeDefined();
      if (!shell) throw new Error("The rebuilt shell was absent from the served module graph");
      expect(
        (
          await fetch(new URL("/__hesperia/warnings", server.url), {
            method: "POST",
            headers: { origin: server.url.origin },
            body: "unsafeBind was used",
          })
        ).status,
      ).toBe(204);
      expect(reports).toStrictEqual(["unsafeBind was used"]);

      await writeFile(
        join(root, "app.tsx"),
        "export default function App() { return <html><body>missing head</body></html>; }",
      );
      await waitForEvent("Hesperia checking failed");
      expect(await (await fetch(shell[0])).text()).toBe(shell[1]);
      await writeFile(
        join(root, "app.tsx"),
        "export default function App() { return <html><head><title>App</title></head><body>ready</body></html>; }",
      );
      await waitForEvent('data: "reload"');
      const record = (await (await fetch(new URL("/hesperia-build.json", server.url))).json()) as {
        modules: { filename: string }[];
      };
      expect(record.modules.some((module) => module.filename === "app.tsx")).toBe(true);
    } finally {
      await reader?.cancel();
      abort.abort();
      await server.close();
    }
  }, 20_000);

  test("development checks changes in imported backend modules outside src", async () => {
    const root = await temporaryProject();
    await mkdir(join(root, "src"));
    await mkdir(join(root, "backend"));
    await writeFile(
      join(root, "app.tsx"),
      'import { label } from "./api.ts"; export default function App() { return <html><head><title>{label}</title></head><body></body></html>; }',
    );
    await writeFile(join(root, "api.ts"), 'export { label } from "./backend/operation.ts";');
    const operation = join(root, "backend/operation.ts");
    await writeFile(operation, 'export const label: string = "Backend";');
    const server = await devProject(root, { port: 0, report: () => undefined });
    const abort = new AbortController();
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const events = await fetch(new URL("/__hesperia/events", server.url), {
        signal: AbortSignal.any([abort.signal, AbortSignal.timeout(10000)]),
      });
      reader = events.body!.getReader();
      await reader.read();
      await writeFile(operation, "export const label: string = 42;");
      let received = "";
      while (!received.includes("Hesperia checking failed")) {
        const chunk = await reader.read();
        if (chunk.done)
          throw new Error("Development events ended before the dependency diagnostic");
        received += new TextDecoder().decode(chunk.value);
      }
      expect(received).toContain("Hesperia checking failed");
    } finally {
      abort.abort();
      await reader?.cancel().catch(() => undefined);
      await server.close();
    }
  }, 15000);
});
