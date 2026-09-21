/**
 * The adopted WinterTC registry revision recorded by browser builds.
 *
 * Browser targets activate no runtime key from this registry. Their `browser` condition is a
 * separate Hesperia convention. Builds use this fixed descriptor without fetching live data;
 * updating the registry is an explicit compiler change.
 */
export const runtimeKeyRegistry = Object.freeze({
  /** Immutable canonical registry source for this revision. */
  source:
    "https://raw.githubusercontent.com/WinterTC55/runtime-keys/a55623cb670debc4abd8059de1cff2cc31d5a6f2/runtime-keys.json",
  /** Git commit fixing the registry content independently of its declared schema version. */
  revision: "a55623cb670debc4abd8059de1cff2cc31d5a6f2",
  /** SHA-256 of the exact UTF-8 registry bytes at the pinned source. */
  digest: "sha256-05a0e8da7538015cd4aa185f43a99859b1954f045e0632bd727e57bfecc396c5",
});
