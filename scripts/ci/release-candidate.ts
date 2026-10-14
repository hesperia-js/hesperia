import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";

export interface ReleaseCandidate {
  schema: 1;
  version: string;
  channel: string;
  commit: string;
  packages: { name: string; version: string; file: string; integrity: string }[];
}

export const releaseNotices = ["LICENSE", "COPYING", "LICENSE-COMMERCIAL.md"] as const;

export function archiveIntegrity(bytes: Uint8Array): string {
  return `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
}

/** Parse provenance and verify all supplied archive hashes without rebuilding any package. */
export async function readReleaseCandidate(directory: string): Promise<ReleaseCandidate> {
  const value = JSON.parse(
    await readFile(resolve(directory, "manifest.json"), "utf8"),
  ) as ReleaseCandidate;

  assert.ok(
    value.schema === 1 && typeof value.version === "string" && typeof value.channel === "string",
    "Invalid candidate manifest",
  );

  assert.match(value.commit, /^[a-f0-9]{40}$/, "Invalid candidate commit");

  assert.ok(
    Array.isArray(value.packages) && value.packages.length > 0,
    "Candidate has no packages",
  );

  const names = new Set<string>();
  const files = new Set<string>();

  for (const package_ of value.packages) {
    assert.ok(
      typeof package_.name === "string" && package_.name.length > 0,
      "Invalid candidate package name",
    );

    assert.ok(
      !names.has(package_.name) && !files.has(package_.file),
      "Duplicate candidate package or archive",
    );

    names.add(package_.name);

    files.add(package_.file);

    assert.equal(package_.version, value.version, "Candidate package version differs");

    assert.match(
      package_.file,
      /^archives\/[A-Za-z0-9][A-Za-z0-9._-]*\.tgz$/,
      "Candidate archive path must stay inside archives",
    );

    assert.equal(
      archiveIntegrity(await readFile(resolve(directory, package_.file))),
      package_.integrity,
      `Candidate archive hash differs for ${package_.name}`,
    );
  }

  return value;
}

/** Read the manifest inside the archive that will be installed and published. */
export async function packedManifest(archive: string): Promise<Record<string, unknown>> {
  return JSON.parse(new TextDecoder().decode(await packedFile(archive, "package.json"))) as Record<
    string,
    unknown
  >;
}

/** Read a packed file without extracting it into the checkout or consumer workspace. */
export async function packedFile(archive: string, file: string): Promise<Uint8Array> {
  const archivePath = resolve(archive);
  // GNU tar interprets a Windows drive colon in the archive argument as a remote host.
  const child = Bun.spawn(["tar", "-xOf", `./${basename(archivePath)}`, `package/${file}`], {
    cwd: dirname(archivePath),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [status, output, error] = await Promise.all([
    child.exited,
    new Response(child.stdout).arrayBuffer(),
    new Response(child.stderr).text(),
  ]);

  assert.equal(status, 0, `Cannot read packed manifest: ${error}`);

  return new Uint8Array(output);
}
