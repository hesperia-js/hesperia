import { describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import {
  createHost,
  type CapturedBrowserBuild,
  type HostingAssetRecord,
  type HostingRecordV1,
} from "../../packages/hosting/src/index.ts";

interface Fixture {
  readonly build: CapturedBrowserBuild;
  readonly sources: ReadonlyMap<string, string>;
}

const sources = new Map([
  [
    "/assets/nested/start.js",
    "export async function start(mount) { document.documentElement.dataset.mount = mount; }",
  ],
  ["/assets/runtime/chunk.js", "export const answer = 42;"],
  ["/assets/styles/app.css", "body { color: rebeccapurple; }"],
]);

async function sha256Hex(value: string): Promise<string> {
  const bytes = await new Blob([value]).arrayBuffer();
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function fixture(mount = "/source"): Promise<Fixture> {
  const assets: HostingAssetRecord[] = [];
  const files = new Map<string, Blob>();

  for (const [path, source] of sources) {
    const contentType = path.endsWith(".css")
      ? "text/css; charset=utf-8"
      : "text/javascript; charset=utf-8";

    assets.push({ path, sha256: await sha256Hex(source), contentType });

    files.set(path, new Blob([source], { type: contentType }));
  }

  const hosting: HostingRecordV1 = {
    version: 1,
    mode: "production",
    standaloneMountURL: mount,
    startupAsset: "/assets/nested/start.js",
    assets,
  };
  return { build: { hosting, files }, sources };
}

function request(path: string, init?: RequestInit): Request {
  return new Request(`https://example.test${path}`, init);
}

describe("createHost", () => {
  test("preserves ampersands when a browser parses the transport document", async () => {
    const { build } = await fixture("/&copy;");
    const host = await createHost(build);
    const response = host.handle(request("/&copy;/page", { headers: { accept: "text/html" } }));
    const window = new Window({ url: "https://example.test/&copy;/page" });

    try {
      window.document.write(await response!.text());

      expect(window.document.querySelector("script")?.getAttribute("src")).toBe(
        "/&copy;/_hesperia/startup.js",
      );
    } finally {
      await window.happyDOM.close();
    }
  });

  test("serves browser path punctuation in mounts and captured asset keys", async () => {
    const { build } = await fixture("/@team/:scope+a");
    const path = "/assets/@team/start+a.js";
    const source = "export async function start() {}";
    const captured: CapturedBrowserBuild = {
      hosting: {
        ...build.hosting,
        startupAsset: path,
        assets: [{ path, sha256: await sha256Hex(source), contentType: "text/javascript" }],
      },
      files: new Map([[path, new Blob([source])]]),
    };
    const host = await createHost(captured);
    const document = host.handle(
      request("/@team/:scope+a/page", { headers: { accept: "text/html" } }),
    );

    expect(document?.status).toBe(200);

    expect(await document?.text()).toContain('src="/@team/:scope+a/_hesperia/startup.js"');

    expect(
      await host.handle(request("/@team/:scope+a/_hesperia/assets/@team/start+a.js"))?.text(),
    ).toBe(source);
  });

  test("serves the same captured nested assets below root and a selected mount", async () => {
    const { build } = await fixture("/");
    const host = await createHost(build, { mountURL: "/dashboard/" });

    expect(host.mount).toEqual({ pathname: "/dashboard", assetPath: "/dashboard/_hesperia" });

    const shell = host.handle(
      request("/dashboard/projects/42", { headers: { accept: "text/html" } }),
    );

    expect(shell).toBeInstanceOf(Response);

    expect(shell?.headers.get("content-type")).toBe("text/html; charset=utf-8");

    expect(await shell?.text()).toContain('src="/dashboard/_hesperia/startup.js"');

    const wrapper = host.handle(request("/dashboard/_hesperia/startup.js"));

    expect(wrapper?.headers.get("content-type")).toBe("text/javascript; charset=utf-8");

    const wrapperSource = await wrapper?.text();

    expect(wrapperSource).toContain('import { start } from "./assets/nested/start.js";');

    expect(wrapperSource).toContain('await start("/dashboard");');

    for (const [path, source] of sources) {
      const relative = path.slice("/assets/".length);
      const response = host.handle(request(`/dashboard/_hesperia/assets/${relative}`));

      expect(response?.status).toBe(200);

      expect(await response?.text()).toBe(source);
    }

    const rootHost = await createHost(build);
    const rootAsset = rootHost.handle(request("/_hesperia/assets/nested/start.js"));

    expect(rootHost.mount).toEqual({ pathname: "/", assetPath: "/_hesperia" });

    expect(await rootAsset?.text()).toBe(sources.get("/assets/nested/start.js"));
  });

  test("captures record, map and selection before its first asynchronous digest", async () => {
    const { build } = await fixture("/caf%C3%A9");
    const mutableHosting = build.hosting as unknown as {
      standaloneMountURL: string;
      startupAsset: string;
      assets: { path: string; sha256: string; contentType: string }[];
    };
    const mutableFiles = build.files as Map<string, Blob>;
    const selection = { mountURL: "/café/" };
    const originalSource = sources.get("/assets/nested/start.js")!;
    const pending = createHost(build, selection);

    mutableHosting.standaloneMountURL = "/mutated";
    mutableHosting.startupAsset = "/assets/runtime/chunk.js";
    mutableHosting.assets[0] = {
      path: "/assets/nested/start.js",
      sha256: "0".repeat(64),
      contentType: "text/plain",
    };

    mutableFiles.set("/assets/nested/start.js", new Blob(["replaced"]));

    selection.mountURL = "/mutated-selection";

    const host = await pending;

    expect(host.mount.pathname).toBe("/caf%C3%A9");

    const response = host.handle(request("/caf%C3%A9/_hesperia/assets/nested/start.js"));

    expect(await response?.text()).toBe(originalSource);
  });

  test("canonicalizes a raw Unicode override before saving it on the host", async () => {
    const { build } = await fixture("/saved");
    const host = await createHost(build, { mountURL: "/東京/café/" });

    expect(host.mount.pathname).toBe("/%E6%9D%B1%E4%BA%AC/caf%C3%A9");

    expect(host.mount.assetPath).toBe("/%E6%9D%B1%E4%BA%AC/caf%C3%A9/_hesperia");
  });

  test("treats omitted optional selection, empty selection and undefined mount as equivalent", async () => {
    const { build } = await fixture("/saved");
    const [omitted, empty, undefinedMount] = await Promise.all([
      createHost(build),
      createHost(build, {}),
      createHost(build, { mountURL: undefined }),
    ]);

    expect(empty.mount).toEqual(omitted.mount);

    expect(undefinedMount.mount).toEqual(omitted.mount);

    const unknownField = { mountURL: undefined, other: true } as unknown as { mountURL?: string };

    await expect(createHost(build, unknownField)).rejects.toThrow("unexpected fields");
  });

  test("uses GET and HEAD document classification and preserves backend fallthrough", async () => {
    const { build } = await fixture("/dashboard");
    const host = await createHost(build);

    const head = host.handle(
      request("/dashboard/settings", { method: "HEAD", headers: { accept: "text/html" } }),
    );

    expect(head?.status).toBe(200);

    expect(head?.headers.get("content-type")).toBe("text/html; charset=utf-8");

    expect(head?.body).toBeNull();

    expect(
      host.handle(request("/dashboard/settings", { headers: { accept: "text/html;q=0" } })),
    ).toBeUndefined();

    expect(
      host.handle(
        request("/dashboard/api/data", { method: "POST", headers: { accept: "text/html" } }),
      ),
    ).toBeUndefined();

    expect(
      host.handle(request("/dashboard/api/data", { headers: { accept: "application/json" } })),
    ).toBeUndefined();

    expect(
      host.handle(request("/dashboardish/page", { headers: { accept: "text/html" } })),
    ).toBeUndefined();

    expect(
      host.handle(request("/outside/page", { headers: { accept: "text/html" } })),
    ).toBeUndefined();
  });

  test("returns 404 for misses and malformed keys inside the managed namespace", async () => {
    const { build } = await fixture("/dashboard");
    const host = await createHost(build);

    const missing = host.handle(
      request("/dashboard/_hesperia/assets/missing.js", { headers: { accept: "text/html" } }),
    );

    expect(missing?.status).toBe(404);

    expect(missing?.headers.get("content-type")).toBeNull();

    const encodedSeparator = host.handle(request("/dashboard/_hesperia/assets/%2Fsecret.js"));

    expect(encodedSeparator?.status).toBe(404);

    expect(
      host.handle(request("/dashboard/_hesperia/unknown", { headers: { accept: "text/html" } }))
        ?.status,
    ).toBe(404);
  });

  test("applies ordinary document fallback after Fetch erases encoded dot-segment provenance", async () => {
    const { build } = await fixture("/dashboard");
    const host = await createHost(build);
    const normalized = request("/dashboard/_hesperia/%2E%2E/secret", {
      headers: { accept: "text/html" },
    });

    expect(new URL(normalized.url).pathname).toBe("/dashboard/secret");

    expect(host.handle(normalized)?.status).toBe(200);

    expect(host.handle(request("/dashboard/_hesperia/%2E%2E/secret"))).toBeUndefined();
  });

  test("rejects malformed records, mismatched maps, invalid digests and unsafe inventory paths", async () => {
    const badVersion = await fixture();
    (badVersion.build.hosting as unknown as { version: number }).version = 2;

    await expect(createHost(badVersion.build)).rejects.toThrow("version");

    const badMode = await fixture();
    (badMode.build.hosting as unknown as { mode: string }).mode = "preview";

    await expect(createHost(badMode.build)).rejects.toThrow("mode");

    const unexpectedField = await fixture();
    (unexpectedField.build.hosting as unknown as { debug: boolean }).debug = true;

    await expect(createHost(unexpectedField.build)).rejects.toThrow("unexpected fields");

    const nonCanonicalMount = await fixture("/saved/");

    await expect(createHost(nonCanonicalMount.build)).rejects.toThrow("canonical");

    const unknownFile = await fixture();

    (unknownFile.build.files as Map<string, Blob>).set("/assets/extra.js", new Blob(["extra"]));

    await expect(createHost(unknownFile.build)).rejects.toThrow("do not match");

    const wrongDigest = await fixture();
    (wrongDigest.build.hosting.assets[0] as { sha256: string }).sha256 = "f".repeat(64);

    await expect(createHost(wrongDigest.build)).rejects.toThrow("digest mismatch");

    const unsafeContentType = await fixture();
    (unsafeContentType.build.hosting.assets[0] as { contentType: string }).contentType =
      "text/javascript\r";

    await expect(createHost(unsafeContentType.build)).rejects.toThrow("contentType");

    for (const path of [
      "/assets/../private.js",
      "/assets/%2E%2E/private.js",
      "/assets/%2Fprivate.js",
      "/assets/%5Cprivate.js",
      "/assets/%00private.js",
      "/assets/bad%",
      "/assets//private.js",
      "/assets/private.js?query",
      "/assets/private.js#fragment",
    ]) {
      const unsafePath = await fixture();
      const assets = unsafePath.build.hosting.assets as unknown as { path: string }[];
      const files = unsafePath.build.files as Map<string, Blob>;
      const unsafeBlob = files.get(assets[0]!.path)!;

      files.delete(assets[0]!.path);

      assets[0]!.path = path;

      files.set(path, unsafeBlob);

      await expect(createHost(unsafePath.build)).rejects.toThrow("canonical path");
    }

    const missingStartup = await fixture();
    (missingStartup.build.hosting as unknown as { startupAsset: string }).startupAsset =
      "/assets/not-present.js";

    await expect(createHost(missingStartup.build)).rejects.toThrow("startupAsset");
  });
});
