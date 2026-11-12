import { expect, spyOn, test } from "bun:test";
import * as filesystem from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { readBuild } from "../../packages/hosting/src/index.ts";

async function fixture() {
  const output = await filesystem.mkdtemp(join(tmpdir(), "hesperia-read-build-"));

  const write = async (revision: string, mode = "production") => {
    const directory = `.captures/${revision === "old" ? "11111111-1111-1111-1111-111111111111" : "22222222-2222-2222-2222-222222222222"}/assets`;
    const assets = ["/assets/@team/main+a.js", "/assets/lazy.js"].map((path) => ({
      path,
      sha256: new Bun.CryptoHasher("sha256").update(revision).digest("hex"),
      contentType: "text/javascript",
    }));

    await filesystem.mkdir(join(output, directory, "@team"), { recursive: true });

    for (const asset of assets)
      await filesystem.writeFile(
        join(output, directory, asset.path.slice("/assets/".length)),
        revision,
      );

    await filesystem.writeFile(
      join(output, "hesperia-build.json"),
      JSON.stringify({
        hosting: {
          version: 1,
          mode,
          standaloneMountURL: "/@team",
          startupAsset: assets[0]!.path,
          assets,
        },
        assetDirectory: directory,
      }),
    );

    return join(output, directory);
  };

  return { output, write };
}

async function writePublicBuild(output: string, content = "captured public bytes") {
  const captureId = "33333333-3333-3333-3333-333333333333";
  const assetDirectory = `.captures/${captureId}/assets`;
  const publicDirectory = `.captures/${captureId}/public`;
  const assetPath = "/assets/@team/main.js";
  const assetBytes = "export function start() {}";
  const relativePath = "pages/café #%.txt";
  const urlPath = "/pages/caf%C3%A9%20%23%25.txt";
  const publicFilePath = join(output, publicDirectory, relativePath);
  const assets = [
    {
      path: assetPath,
      sha256: new Bun.CryptoHasher("sha256").update(assetBytes).digest("hex"),
      contentType: "text/javascript",
    },
  ];
  const publicFiles = [
    {
      relativePath,
      urlPath,
      sha256: new Bun.CryptoHasher("sha256").update(content).digest("hex"),
      contentType: "text/plain; charset=utf-8",
    },
  ];

  await filesystem.mkdir(join(output, assetDirectory, "@team"), { recursive: true });
  await filesystem.mkdir(join(output, publicDirectory, "pages"), { recursive: true });
  await filesystem.writeFile(join(output, assetDirectory, "@team", "main.js"), assetBytes);
  await filesystem.writeFile(publicFilePath, content);
  await filesystem.writeFile(
    join(output, "hesperia-build.json"),
    JSON.stringify({
      hosting: {
        version: 2,
        mode: "production",
        standaloneMountURL: "/@team",
        startupAsset: assetPath,
        assets,
        publicFiles,
      },
      assetDirectory,
      publicDirectory,
    }),
  );

  return { assetDirectory, publicDirectory, publicFilePath, relativePath, urlPath };
}

test("readBuild validates a copied deployment without an application source tree", async () => {
  const { output, write } = await fixture();

  try {
    const assets = await write("old");
    const captured = await readBuild(output);

    expect(captured.hosting.standaloneMountURL).toBe("/@team");

    expect(await captured.files.get("/assets/@team/main+a.js")!.text()).toBe("old");

    await filesystem.writeFile(join(assets, "lazy.js"), "modified");

    await expect(readBuild(output)).rejects.toThrow("digest mismatch");

    await filesystem.rm(join(assets, "lazy.js"));

    await expect(readBuild(output)).rejects.toThrow("asset is missing");

    await write("new", "development");

    await expect(readBuild(output)).rejects.toThrow(
      "Cannot serve a development build as production",
    );
  } finally {
    await filesystem.rm(output, { recursive: true, force: true });
  }
});

test("readBuild retries a capture removed during publication only when the record changes", async () => {
  const { output, write } = await fixture();
  const original = filesystem.readFile;
  let retired = false;
  const old = await write("old");
  const interception = spyOn(filesystem, "readFile").mockImplementation((async (
    ...arguments_: Parameters<typeof filesystem.readFile>
  ) => {
    const result = await original(...arguments_);

    if (!retired && String(arguments_[0]) === join(old, "@team", "main+a.js")) {
      retired = true;

      await write("new");

      await filesystem.rm(join(output, ".captures", "11111111-1111-1111-1111-111111111111"), {
        recursive: true,
        force: true,
      });
    }

    return result;
  }) as typeof filesystem.readFile);

  try {
    const captured = await readBuild(output);

    expect(retired).toBe(true);

    expect(await captured.files.get("/assets/lazy.js")!.text()).toBe("new");
  } finally {
    interception.mockRestore();

    await filesystem.rm(output, { recursive: true, force: true });
  }
});

test("readBuild bounds retries when publication keeps retiring captures", async () => {
  const { output, write } = await fixture();

  await write("old");

  const original = filesystem.readFile;
  let retirements = 0;
  const interception = spyOn(filesystem, "readFile").mockImplementation((async (
    ...arguments_: Parameters<typeof filesystem.readFile>
  ) => {
    const result = await original(...arguments_);
    const path = String(arguments_[0]);

    if (path.endsWith(join("@team", "main+a.js"))) {
      retirements++;
      const current = path.includes("11111111-1111") ? "old" : "new";

      await write(current === "old" ? "new" : "old");

      const retired = resolve(path, "..", "..", "..");

      expect(retired.startsWith(`${join(output, ".captures")}${sep}`)).toBe(true);

      await filesystem.rm(retired, { recursive: true, force: true });
    }

    return result;
  }) as typeof filesystem.readFile);

  try {
    await expect(readBuild(output)).rejects.toThrow("asset is missing");

    expect(retirements).toBe(3);
  } finally {
    interception.mockRestore();

    await filesystem.rm(output, { recursive: true, force: true });
  }
});

test("readBuild loads V2 public bytes from raw storage paths and rejects disk corruption", async () => {
  const output = await filesystem.mkdtemp(join(tmpdir(), "hesperia-read-public-build-"));

  try {
    const written = await writePublicBuild(output);
    const captured = await readBuild(output);

    expect(captured.hosting.version).toBe(2);

    if (!("publicFiles" in captured) || captured.hosting.version !== 2)
      throw new Error("Expected a V2 captured build");

    const publicFile = captured.publicFiles.get(written.urlPath);

    expect(publicFile).toBeInstanceOf(Blob);
    expect(publicFile?.type).toBe("text/plain; charset=utf-8");
    expect(await publicFile?.text()).toBe("captured public bytes");

    await filesystem.writeFile(written.publicFilePath, "changed on disk");

    await expect(readBuild(output)).rejects.toThrow("public file digest mismatch");

    expect(await publicFile?.text()).toBe("captured public bytes");

    await filesystem.rm(written.publicFilePath);

    await expect(readBuild(output)).rejects.toThrow("public file is missing");
  } finally {
    await filesystem.rm(output, { recursive: true, force: true });
  }
});

test("readBuild retains an explicitly persisted empty V2 public inventory", async () => {
  const { output, write } = await fixture();

  try {
    await write("old");

    const recordPath = join(output, "hesperia-build.json");
    const record = JSON.parse(await filesystem.readFile(recordPath, "utf8")) as {
      hosting: Record<string, unknown>;
      assetDirectory: string;
      publicDirectory?: string;
    };
    const captureId = "11111111-1111-1111-1111-111111111111";
    const publicDirectory = `.captures/${captureId}/public`;

    record.hosting.version = 2;
    record.hosting.publicFiles = [];
    record.publicDirectory = publicDirectory;

    await filesystem.mkdir(join(output, publicDirectory), { recursive: true });
    await filesystem.writeFile(recordPath, JSON.stringify(record));

    const captured = await readBuild(output);

    if (!("publicFiles" in captured))
      throw new Error("Expected readBuild to retain the V2 public file map");

    expect(captured.hosting.version).toBe(2);
    expect(captured.publicFiles).toBeInstanceOf(Map);
    expect(captured.publicFiles.size).toBe(0);
    expect(await captured.files.get("/assets/@team/main+a.js")!.text()).toBe("old");
  } finally {
    await filesystem.rm(output, { recursive: true, force: true });
  }
});

test("readBuild requires V2 public files to use the matching capture directory", async () => {
  const output = await filesystem.mkdtemp(join(tmpdir(), "hesperia-read-public-directory-"));

  try {
    await writePublicBuild(output);

    const recordPath = join(output, "hesperia-build.json");
    const record = JSON.parse(await filesystem.readFile(recordPath, "utf8")) as Record<
      string,
      unknown
    >;

    delete record.publicDirectory;
    await filesystem.writeFile(recordPath, JSON.stringify(record));

    await expect(readBuild(output)).rejects.toThrow("share the asset capture");

    record.publicDirectory = ".captures/44444444-4444-4444-4444-444444444444/public";
    await filesystem.writeFile(recordPath, JSON.stringify(record));

    await expect(readBuild(output)).rejects.toThrow("share the asset capture");
  } finally {
    await filesystem.rm(output, { recursive: true, force: true });
  }
});

test("readBuild rejects symlinks in a V2 public storage path", async () => {
  const output = await filesystem.mkdtemp(join(tmpdir(), "hesperia-read-public-link-"));
  const outside = await filesystem.mkdtemp(join(tmpdir(), "hesperia-public-target-"));

  try {
    const written = await writePublicBuild(output);
    const publicRoot = join(output, written.publicDirectory);
    const pagesPath = join(publicRoot, "pages");

    await filesystem.writeFile(join(outside, "café #%.txt"), "captured public bytes");
    await filesystem.rm(pagesPath, { recursive: true });
    await filesystem.symlink(outside, pagesPath, process.platform === "win32" ? "junction" : "dir");

    await expect(readBuild(output)).rejects.toThrow("symlinked public file path");
  } finally {
    await filesystem.rm(output, { recursive: true, force: true });
    await filesystem.rm(outside, { recursive: true, force: true });
  }
});
