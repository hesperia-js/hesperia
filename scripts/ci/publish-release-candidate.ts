import assert from "node:assert/strict";
import { resolve } from "node:path";
import { preflightPublication } from "./check-release.ts";
import { verifyReleaseCandidate } from "./verify-release-candidate.ts";

async function publishReleaseCandidate() {
  const directory = process.env.HESPERIA_RELEASE_CANDIDATE_DIR;

  assert.ok(directory, "Supply the verified candidate directory");

  const candidate = await verifyReleaseCandidate(resolve(import.meta.dir, "../.."), directory);
  const pending = await preflightPublication(candidate);

  for (const package_ of pending) {
    const child: ReturnType<typeof Bun.spawn> = Bun.spawn(
      [
        "npm",
        "publish",
        resolve(directory, package_.file),
        "--access",
        "public",
        "--tag",
        candidate.channel,
        "--ignore-scripts",
        "--registry",
        "https://registry.npmjs.org",
      ],
      { stdout: "inherit", stderr: "inherit" },
    );

    assert.equal(
      await child.exited,
      0,
      `Publication failed for ${package_.name}; retry with these exact candidate archives`,
    );
  }

  console.log(
    `Published ${pending.length} archives; ${candidate.packages.length - pending.length} matching versions were already present`,
  );
}

if (import.meta.main) await publishReleaseCandidate();
