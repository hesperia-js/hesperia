import { expect, spyOn, test } from "bun:test";
import * as filesystem from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { prepareBuild, ProjectError, writeBuild } from "../../../packages/tooling/src/project.ts";
import { previewProject, type ProjectServer } from "../../../packages/tooling/src/server.ts";
import { linkFrameworkPackages, unlinkFrameworkPackages } from "../fixture-dependencies.ts";

type Restorable = { mockRestore(): void };
type TrackedSpy = { readonly spy: Restorable; readonly restored: () => boolean };

async function withCleanup(
  body: () => Promise<void>,
  actions: readonly (() => void | Promise<void> | undefined)[],
): Promise<void> {
  let failed = false;
  let failure: unknown;

  try {
    await body();
  } catch (error) {
    failed = true;
    failure = error;
  }

  const errors: unknown[] = [];

  for (const action of actions) {
    try {
      await action();
    } catch (error) {
      errors.push(error);
    }
  }

  if (failed && errors.length)
    throw new AggregateError([failure, ...errors], "Source-swap test and cleanup failed", {
      cause: failure,
    });

  if (failed) throw failure;

  if (errors.length) throw new AggregateError(errors, "Source-swap cleanup failed");
}

function containsPath(parent: string, child: string): boolean {
  const suffix = relative(resolve(parent), resolve(child));

  return (
    suffix === "" || (!isAbsolute(suffix) && suffix !== ".." && !suffix.startsWith(`..${sep}`))
  );
}

test("public capture rejects swaps before canonical resolution and final byte open", async () => {
  const native = { ...filesystem };
  const root = await native.mkdtemp(join(tmpdir(), "hesperia-source-swap-"));
  let outside: string | undefined;
  let server: ProjectServer | undefined;
  let serverStopped = false;
  let spySetupUncertain = false;
  let activeSpies = 0;
  let unclosedHandles = 0;
  let dependenciesUnlinked = false;
  let directorySaved = false;
  let directoryLinked = false;
  let fileSaved = false;
  let fileLinked = false;

  await withCleanup(async () => {
    await linkFrameworkPackages(root);
    await native.mkdir(join(root, "src", "routes"), { recursive: true });
    await native.writeFile(
      join(root, "app.tsx"),
      `export default function App(props: { children: () => unknown }) {
  return <html><head></head><body>{props.children()}</body></html>;
}
`,
    );
    await native.writeFile(
      join(root, "src", "routes", "+page.tsx"),
      "export default function Home() { return <main>Public file host</main>; }\n",
    );
    await native.writeFile(join(root, "hesperia.config.json"), JSON.stringify({ mountURL: "/" }));

    const publicRoot = join(root, "public");
    const directory = join(publicRoot, "swap");
    const savedDirectory = join(root, "saved-source");
    const savedFile = join(root, "saved-file.bin");
    const outsideRoot = await native.mkdtemp(`${root}-outside-`);
    outside = outsideRoot;

    await native.mkdir(publicRoot);
    await native.writeFile(join(publicRoot, "retained.bin"), "last successful bytes");
    await native.writeFile(join(outsideRoot, "contained.bin"), "outside bytes");
    await writeBuild(root, await prepareBuild(root));

    const recordPath = join(root, ".hesperia", "build", "hesperia-build.json");
    const published = await native.readFile(recordPath);

    server = await previewProject(root, 0);

    await native.mkdir(directory);
    await native.writeFile(join(directory, "contained.bin"), "contained bytes");

    const canonicalRoot = await native.realpath(root);
    const canonicalDirectory = await native.realpath(directory);
    const canonicalOutside = await native.realpath(outsideRoot);
    const victim = await native.realpath(join(publicRoot, "retained.bin"));
    const outsideFile = join(canonicalOutside, "contained.bin");
    const outsideInfo = await native.stat(outsideFile, { bigint: true });
    const victimInfo = await native.stat(victim, { bigint: true });

    expect(outsideInfo.dev !== victimInfo.dev || outsideInfo.ino !== victimInfo.ino).toBe(true);

    const matches = (path: unknown, expected: string) =>
      typeof path === "string" && relative(resolve(path), resolve(expected)) === "";
    const fromOutside = (path: string) =>
      containsPath(outsideRoot, path) || containsPath(canonicalOutside, path);
    const fixtureTarget = (path: unknown) =>
      typeof path === "string" &&
      [
        victim,
        join(directory, "contained.bin"),
        join(canonicalDirectory, "contained.bin"),
        join(outsideRoot, "contained.bin"),
        outsideFile,
      ].some((candidate) => matches(path, candidate));

    async function assertRejected(): Promise<void> {
      let result: Awaited<ReturnType<typeof prepareBuild>> | undefined;
      let failure: unknown;

      try {
        result = await prepareBuild(root);
      } catch (error) {
        failure = error;
      }

      expect(result).toBeUndefined();
      expect(failure).toBeInstanceOf(ProjectError);

      if (!(failure instanceof ProjectError))
        throw new Error("The source swap must reject preparation");

      expect(failure.message).toContain("public source changed during capture");
      expect(failure.watch).toBeDefined();

      const paths = failure.watch!.map((item) => (item.kind === "file" ? item.file : item.dir));

      expect(
        paths.some((path) => containsPath(root, path) || containsPath(canonicalRoot, path)),
      ).toBe(true);
      expect(paths.some(fromOutside)).toBe(false);
      expect(await native.readFile(recordPath)).toEqual(published);

      const retained = await fetch(new URL("/retained.bin", server!.url));

      expect(retained.status).toBe(200);
      expect(await retained.text()).toBe("last successful bytes");
    }

    let outsideReads = 0;

    function trackSpy<T extends Restorable>(
      spies: TrackedSpy[],
      create: () => T,
      restored: () => boolean,
    ): T {
      spySetupUncertain = true;
      const spy = create();
      spies.push({ spy, restored });
      activeSpies++;
      spySetupUncertain = false;
      return spy;
    }

    function guardReads(
      spies: TrackedSpy[],
      armed: () => boolean,
      beforeRead: (path: unknown) => Promise<void>,
    ): void {
      const readSpy = trackSpy(
        spies,
        () => spyOn(filesystem, "readFile"),
        () => filesystem.readFile === native.readFile,
      );
      readSpy.mockImplementation(((...args: Parameters<typeof filesystem.readFile>) => {
        if (!armed() || typeof args[0] !== "string" || !fixtureTarget(args[0]))
          return Reflect.apply(native.readFile, native, args);

        return (async () => {
          try {
            if (fromOutside(await native.realpath(args[0] as string))) outsideReads++;
          } catch {
            // The delegated read still owns missing-path errors.
          }

          return Reflect.apply(native.readFile, native, args);
        })();
      }) as typeof filesystem.readFile);

      const openSpy = trackSpy(
        spies,
        () => spyOn(filesystem, "open"),
        () => filesystem.open === native.open,
      );
      openSpy.mockImplementation(((...args: Parameters<typeof filesystem.open>) => {
        if (!fixtureTarget(args[0])) return Reflect.apply(native.open, native, args);

        return (async () => {
          await beforeRead(args[0]);
          const handle: Awaited<ReturnType<typeof filesystem.open>> = await Reflect.apply(
            native.open,
            native,
            args,
          );

          if (armed()) {
            unclosedHandles++;
            let handleClosed = false;

            try {
              const originalClose = handle.close;
              const closeHandle = trackSpy(
                spies,
                () => spyOn(handle, "close"),
                () => handle.close === originalClose,
              );
              closeHandle.mockImplementation(((...closeArgs: Parameters<typeof handle.close>) =>
                Reflect.apply(originalClose, handle, closeArgs).then(() => {
                  if (!handleClosed) {
                    handleClosed = true;
                    unclosedHandles--;
                  }
                })) as typeof handle.close);

              const held = await handle.stat({ bigint: true });

              if (held.dev === outsideInfo.dev && held.ino === outsideInfo.ino) {
                const originalRead = handle.readFile;
                const readHandle = trackSpy(
                  spies,
                  () => spyOn(handle, "readFile"),
                  () => handle.readFile === originalRead,
                );
                readHandle.mockImplementation(((...readArgs: unknown[]) => {
                  outsideReads++;
                  return Reflect.apply(originalRead, handle, readArgs);
                }) as typeof handle.readFile);
              }
            } catch (error) {
              try {
                await handle.close();
              } catch (cleanup) {
                throw new AggregateError(
                  [error, cleanup],
                  "Outside handle inspection and close failed",
                  {
                    cause: error,
                  },
                );
              }

              throw error;
            }
          }

          return handle;
        })();
      }) as typeof filesystem.open);
    }

    async function verifyReadGuards(): Promise<void> {
      expect(outsideReads).toBe(0);

      expect(await filesystem.readFile(outsideFile, "utf8")).toBe("outside bytes");
      expect(outsideReads).toBe(1);

      const handle = await filesystem.open(outsideFile, "r");

      try {
        expect(await handle.readFile("utf8")).toBe("outside bytes");
      } finally {
        await handle.close();
      }

      expect(outsideReads).toBe(2);
      outsideReads = 0;
    }

    function restoreSpies(spies: TrackedSpy[]): void {
      const errors: unknown[] = [];

      for (const { spy, restored } of spies.reverse()) {
        try {
          spy.mockRestore();

          if (!restored()) throw new Error("Source-swap spy binding was not restored");

          activeSpies--;
        } catch (error) {
          errors.push(error);
        }
      }

      if (errors.length) throw new AggregateError(errors, "Source-swap spy restoration failed");
    }

    let listed = false;
    let directorySwapped = false;
    const directorySpies: TrackedSpy[] = [];

    await withCleanup(async () => {
      const readdirSpy = trackSpy(
        directorySpies,
        () => spyOn(filesystem, "readdir"),
        () => filesystem.readdir === native.readdir,
      );
      readdirSpy.mockImplementation(((...args: Parameters<typeof filesystem.readdir>) => {
        if (!matches(args[0], directory) && !matches(args[0], canonicalDirectory))
          return Reflect.apply(native.readdir, native, args);

        return (async () => {
          const result = await Reflect.apply(native.readdir, native, args);
          listed = true;
          return result;
        })();
      }) as typeof filesystem.readdir);

      const lstatSpy = trackSpy(
        directorySpies,
        () => spyOn(filesystem, "lstat"),
        () => filesystem.lstat === native.lstat,
      );
      lstatSpy.mockImplementation(((...args: Parameters<typeof filesystem.lstat>) => {
        if (
          !listed ||
          directorySwapped ||
          (!matches(args[0], directory) && !matches(args[0], canonicalDirectory))
        )
          return Reflect.apply(native.lstat, native, args);

        return (async () => {
          const result = await Reflect.apply(native.lstat, native, args);

          if (listed && !directorySwapped) {
            directorySwapped = true;
            await native.rename(directory, savedDirectory);
            directorySaved = true;
            await native.symlink(
              outsideRoot,
              directory,
              process.platform === "win32" ? "junction" : "dir",
            );
            directoryLinked = true;
          }

          return result;
        })();
      }) as typeof filesystem.lstat);

      guardReads(
        directorySpies,
        () => directorySwapped,
        async () => undefined,
      );
      await assertRejected();

      expect(directorySwapped).toBe(true);
      await verifyReadGuards();
    }, [
      () => restoreSpies(directorySpies),
      () =>
        directoryLinked
          ? native.unlink(directory).then(() => {
              directoryLinked = false;
            })
          : undefined,
      () =>
        directorySaved
          ? native.rename(savedDirectory, directory).then(() => {
              directorySaved = false;
            })
          : undefined,
    ]);

    expect(filesystem.readdir).toBe(native.readdir);
    expect(filesystem.lstat).toBe(native.lstat);
    expect(filesystem.open).toBe(native.open);
    expect(filesystem.readFile).toBe(native.readFile);

    let fileSwapped = false;
    const fileSpies: TrackedSpy[] = [];
    const replaceFile = async (path: unknown) => {
      if (fileSwapped || !matches(path, victim)) return;

      fileSwapped = true;
      await native.rename(victim, savedFile);
      fileSaved = true;
      await native.symlink(outsideFile, victim, "file");
      fileLinked = true;
    };

    await withCleanup(async () => {
      guardReads(fileSpies, () => fileSwapped, replaceFile);
      await assertRejected();

      expect(fileSwapped).toBe(true);
      await verifyReadGuards();
    }, [
      () => restoreSpies(fileSpies),
      () =>
        fileLinked
          ? native.unlink(victim).then(() => {
              fileLinked = false;
            })
          : undefined,
      () =>
        fileSaved
          ? native.rename(savedFile, victim).then(() => {
              fileSaved = false;
            })
          : undefined,
    ]);

    expect(filesystem.open).toBe(native.open);
    expect(filesystem.readFile).toBe(native.readFile);

    const recovered = await prepareBuild(root);

    expect("publicFiles" in recovered).toBe(true);

    if (!("publicFiles" in recovered)) throw new Error("Expected a recovered public build");

    expect(await recovered.publicFiles.get("/retained.bin")!.text()).toBe("last successful bytes");
    expect(await native.readFile(recordPath)).toEqual(published);

    const response = await fetch(new URL("/retained.bin", server!.url));

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("last successful bytes");
  }, [
    async () => {
      if (server) await server.close();

      serverStopped = true;
    },
    async () => {
      if (
        !serverStopped ||
        spySetupUncertain ||
        activeSpies !== 0 ||
        unclosedHandles !== 0 ||
        directorySaved ||
        directoryLinked ||
        fileSaved ||
        fileLinked
      )
        throw new Error(`Source-swap dependencies retained after incomplete cleanup: ${root}`);

      await unlinkFrameworkPackages(root);
      dependenciesUnlinked = true;
    },
    () => {
      if (
        !serverStopped ||
        spySetupUncertain ||
        activeSpies !== 0 ||
        unclosedHandles !== 0 ||
        !dependenciesUnlinked ||
        directorySaved ||
        directoryLinked ||
        fileSaved ||
        fileLinked
      )
        throw new Error(`Source-swap root retained after incomplete cleanup: ${root}`);

      return native.rm(root, { recursive: true, force: true });
    },
    () => {
      if (!outside) return;
      if (
        !serverStopped ||
        spySetupUncertain ||
        activeSpies !== 0 ||
        unclosedHandles !== 0 ||
        directorySaved ||
        directoryLinked ||
        fileSaved ||
        fileLinked
      )
        throw new Error(`Outside fixture retained after incomplete cleanup: ${outside}`);

      return native.rm(outside, { recursive: true, force: true });
    },
  ]);
}, 45_000);
