import { dlopen, ptr } from "bun:ffi";

export function admitCreatorWindowsConsole(onInterrupt) {
  if (process.platform !== "win32" || process.arch !== "x64" || Bun.version !== "1.4.4") {
    throw new Error("The prototype requires Windows x64 and Bun 1.4.4.");
  }
  if (typeof onInterrupt !== "function") throw new Error("An interrupt observer is required.");

  const library = dlopen("kernel32.dll", {
    GetCurrentProcess: { args: [], returns: "u64" },
    CreateJobObjectW: { args: ["ptr", "ptr"], returns: "u64" },
    AssignProcessToJobObject: { args: ["u64", "u64"], returns: "i32" },
    SetInformationJobObject: { args: ["u64", "u32", "ptr", "u32"], returns: "i32" },
    QueryInformationJobObject: { args: ["u64", "u32", "ptr", "u32", "ptr"], returns: "i32" },
    IsProcessInJob: { args: ["u64", "u64", "ptr"], returns: "i32" },
    FreeConsole: { args: [], returns: "i32" },
    AllocConsoleWithOptions: { args: ["ptr", "ptr"], returns: "i32" },
    GetConsoleProcessList: { args: ["ptr", "u32"], returns: "u32" },
    OpenProcess: { args: ["u32", "i32", "u32"], returns: "u64" },
    GetProcessTimes: { args: ["u64", "ptr", "ptr", "ptr", "ptr"], returns: "i32" },
    QueryFullProcessImageNameW: { args: ["u64", "u32", "ptr", "ptr"], returns: "i32" },
    GetProcessId: { args: ["u64"], returns: "u32" },
    GetExitCodeProcess: { args: ["u64", "ptr"], returns: "i32" },
    WaitForSingleObject: { args: ["u64", "u32"], returns: "u32" },
    CreateToolhelp32Snapshot: { args: ["u32", "u32"], returns: "u64" },
    Process32FirstW: { args: ["u64", "ptr"], returns: "i32" },
    Process32NextW: { args: ["u64", "ptr"], returns: "i32" },
    GetLastError: { args: [], returns: "u32" },
    SetLastError: { args: ["u32"], returns: "void" },
    CloseHandle: { args: ["u64"], returns: "i32" },
  });
  const api = library.symbols;
  const current = api.GetCurrentProcess();
  const inJob = new Int32Array(1);
  let job = 0n;
  let consoleAllocated = false;
  let installedObserver = false;
  const openMembers = new Map();

  function requireJobMembership(handle, expectedJob, label) {
    inJob[0] = 0;
    if (!api.IsProcessInJob(handle, expectedJob, ptr(inJob))) {
      throw new Error(label + ": IsProcessInJob failed.");
    }
    if (inJob[0] !== 1) throw new Error(label + ": process is not in the expected job.");
  }

  try {
    job = api.CreateJobObjectW(null, null);
    if (!job) throw new Error("CreateJobObjectW failed.");
    const limits = new Uint8Array(144);
    new DataView(limits.buffer).setUint32(16, 0x2000, true);
    if (!api.SetInformationJobObject(job, 9, ptr(limits), limits.byteLength)) {
      throw new Error("Could not set kill-on-close on the Creator test job.");
    }
    const configured = new Uint8Array(144);
    if (
      !api.QueryInformationJobObject(job, 9, ptr(configured), configured.byteLength, null) ||
      new DataView(configured.buffer).getUint32(16, true) !== 0x2000
    ) {
      throw new Error("Creator test job limits differ.");
    }
    if (!api.AssignProcessToJobObject(job, current)) {
      throw new Error("AssignProcessToJobObject failed before any fixture child was started.");
    }
    requireJobMembership(current, job, "Controller Creator-job check");

    if (!api.FreeConsole()) throw new Error("FreeConsole failed.");
    const options = new Uint8Array(12);
    const allocation = new Int32Array(1);
    new DataView(options.buffer).setInt32(0, 2, true);
    const hresult = api.AllocConsoleWithOptions(ptr(options), ptr(allocation));
    consoleAllocated = hresult === 0 && allocation[0] !== 0;
    if (hresult !== 0 || allocation[0] !== 1) {
      throw new Error(
        "Hidden console was not newly allocated: HRESULT=" +
          hresult +
          ", result=" +
          allocation[0] +
          ".",
      );
    }
    process.on("SIGINT", onInterrupt);
    installedObserver = true;

    function readLiveIdentity(handle, pid) {
      if (api.GetProcessId(handle) !== pid) throw new Error("Retained process PID changed.");
      requireJobMembership(handle, job, "PID " + pid);
      if (api.WaitForSingleObject(handle, 0) !== 0x102) {
        throw new Error("PID " + pid + " is not confirmed live by its retained handle.");
      }
      const times = [new Uint8Array(8), new Uint8Array(8), new Uint8Array(8), new Uint8Array(8)];
      if (!api.GetProcessTimes(handle, ...times.map((time) => ptr(time)))) {
        throw new Error("GetProcessTimes failed for " + pid + ".");
      }
      const creationFiletime = new DataView(times[0].buffer).getBigUint64(0, true).toString();
      const imageBuffer = new Uint16Array(32768);
      const imageSize = new Uint32Array([imageBuffer.length]);
      if (!api.QueryFullProcessImageNameW(handle, 0, ptr(imageBuffer), ptr(imageSize))) {
        throw new Error("Could not read image path for " + pid + ".");
      }
      const imagePath = new TextDecoder("utf-16le").decode(
        new Uint8Array(imageBuffer.buffer, 0, imageSize[0] * 2),
      );
      if (
        imagePath.replaceAll("/", "\\").toLowerCase() !==
        process.execPath.replaceAll("/", "\\").toLowerCase()
      ) {
        throw new Error("Unexpected process image for " + pid + ".");
      }
      if (api.WaitForSingleObject(handle, 0) !== 0x102) {
        throw new Error("PID " + pid + " exited while its identity was read.");
      }
      return { pid, creationFiletime, imagePath, handle };
    }

    function openVerifiedLiveMember(pid) {
      if (!Number.isSafeInteger(pid) || pid <= 0 || pid > 0xffffffff) {
        throw new Error("Invalid process identity.");
      }
      const handle = api.OpenProcess(0x00101000, 0, pid);
      if (!handle) throw new Error("OpenProcess failed for " + pid + ".");
      try {
        const identity = Object.freeze(readLiveIdentity(handle, pid));
        openMembers.set(handle, identity);
        return identity;
      } catch (error) {
        api.CloseHandle(handle);
        throw error;
      }
    }

    function recheckMember(member) {
      const retained = openMembers.get(member.handle);
      if (
        !retained ||
        retained.pid !== member.pid ||
        retained.creationFiletime !== member.creationFiletime
      ) {
        throw new Error("Unknown or changed retained member identity.");
      }
      const currentIdentity = readLiveIdentity(member.handle, member.pid);
      if (currentIdentity.creationFiletime !== retained.creationFiletime) {
        throw new Error("Retained process creation time changed.");
      }
      return {
        pid: retained.pid,
        creationFiletime: retained.creationFiletime,
        imagePath: retained.imagePath,
        live: true,
      };
    }

    function verifyExitedMember(member) {
      const retained = openMembers.get(member.handle);
      if (
        !retained ||
        retained.pid !== member.pid ||
        retained.creationFiletime !== member.creationFiletime
      ) {
        throw new Error("Unknown or changed retained member identity.");
      }
      if (
        api.GetProcessId(member.handle) !== member.pid ||
        api.WaitForSingleObject(member.handle, 0) !== 0
      ) {
        throw new Error("Retained member has not been observed exiting.");
      }
      const times = [new Uint8Array(8), new Uint8Array(8), new Uint8Array(8), new Uint8Array(8)];
      const exitCode = new Uint32Array(1);
      if (
        !api.GetProcessTimes(member.handle, ...times.map((time) => ptr(time))) ||
        !api.GetExitCodeProcess(member.handle, ptr(exitCode))
      ) {
        throw new Error("Could not read retained member exit identity.");
      }
      const creationFiletime = new DataView(times[0].buffer).getBigUint64(0, true).toString();
      if (
        creationFiletime !== retained.creationFiletime ||
        api.WaitForSingleObject(member.handle, 0) !== 0
      ) {
        throw new Error("Retained member exit identity changed.");
      }
      return {
        pid: retained.pid,
        creationFiletime,
        imagePath: retained.imagePath,
        exitCode: exitCode[0],
        exited: true,
      };
    }

    function verifyParent(child, parent) {
      if (child.pid === parent.pid) throw new Error("A process cannot be its own parent.");
      recheckMember(parent);
      recheckMember(child);
      const snapshot = api.CreateToolhelp32Snapshot(2, 0);
      if (
        !snapshot ||
        (typeof snapshot === "number" && !Number.isSafeInteger(snapshot)) ||
        BigInt(snapshot) === 0xffffffffffffffffn
      ) {
        throw new Error("CreateToolhelp32Snapshot failed.");
      }
      const entry = new Uint8Array(568);
      const view = new DataView(entry.buffer);
      view.setUint32(0, entry.byteLength, true);
      let matches = 0;
      let observedParent;
      let snapshotFailed = false;
      let snapshotFailure;
      let snapshotClosed = false;
      try {
        let next = api.Process32FirstW(snapshot, ptr(entry));
        if (!next) throw new Error("Process32FirstW failed.");
        let count = 0;
        while (next) {
          if (++count > 65536) throw new Error("Toolhelp process snapshot exceeded its bound.");
          if (view.getUint32(8, true) === child.pid) {
            matches++;
            observedParent = view.getUint32(32, true);
          }
          view.setUint32(0, entry.byteLength, true);
          api.SetLastError(0);
          next = api.Process32NextW(snapshot, ptr(entry));
        }
        const lastError = api.GetLastError();
        if (lastError !== 18) throw new Error("Process32NextW ended without ERROR_NO_MORE_FILES.");
      } catch (error) {
        snapshotFailed = true;
        snapshotFailure = error;
      } finally {
        snapshotClosed = Boolean(api.CloseHandle(snapshot));
      }
      if (snapshotFailed || !snapshotClosed) {
        const errors = [];
        if (snapshotFailed) errors.push(snapshotFailure);
        if (!snapshotClosed) errors.push(new Error("Toolhelp snapshot close failed."));
        throw new AggregateError(errors, "Could not verify the Toolhelp process snapshot.");
      }
      if (matches !== 1 || observedParent !== parent.pid) {
        throw new Error("The snapshot does not bind the child to the expected parent.");
      }
      const parentIdentity = recheckMember(parent);
      const childIdentity = recheckMember(child);
      return { parent: parentIdentity, child: childIdentity, observedParentPid: observedParent };
    }

    function census() {
      let capacity = 16;
      while (capacity <= 1024) {
        const ids = new Uint32Array(capacity);
        const count = api.GetConsoleProcessList(ptr(ids), capacity);
        if (count === 0) throw new Error("GetConsoleProcessList failed.");
        if (count > capacity) {
          capacity = count;
          continue;
        }
        return Array.from(ids.subarray(0, count));
      }
      throw new Error("The console process list exceeded its bound.");
    }

    return {
      allocation: { hresult, result: allocation[0], noWindowRequested: true },
      census,
      openVerifiedLiveMember,
      recheckMember,
      verifyExitedMember,
      verifyParent,
      closeMember(handle) {
        if (!openMembers.has(handle)) throw new Error("Unknown member handle.");
        if (!api.CloseHandle(handle)) throw new Error("CloseHandle failed for a member.");
        openMembers.delete(handle);
      },
      isDetached() {
        return !consoleAllocated;
      },
      async close() {
        if (openMembers.size > 0) throw new Error("Member handles are still retained.");
        if (installedObserver) process.removeListener("SIGINT", onInterrupt);
        if (consoleAllocated) {
          if (!api.FreeConsole()) throw new Error("FreeConsole cleanup failed.");
          consoleAllocated = false;
        }
        requireJobMembership(current, job, "Creator job retirement check");
        const deadline = Date.now() + 5000;
        let active;
        let limitTerminations;
        do {
          const accounting = new Uint8Array(48);
          if (
            !api.QueryInformationJobObject(job, 1, ptr(accounting), accounting.byteLength, null)
          ) {
            throw new Error("Could not query Creator test job accounting.");
          }
          active = new DataView(accounting.buffer).getUint32(40, true);
          limitTerminations = new DataView(accounting.buffer).getUint32(44, true);
          if (active === 1) break;
          await Bun.sleep(20);
        } while (Date.now() < deadline);
        if (active !== 1) throw new Error("Creator test job retained child processes.");
        if (limitTerminations !== 0)
          throw new Error("Creator test job recorded a limit termination.");
        const limits = new Uint8Array(144);
        if (!api.SetInformationJobObject(job, 9, ptr(limits), limits.byteLength)) {
          throw new Error("Could not disarm the empty Creator test job.");
        }
        if (job && !api.CloseHandle(job))
          throw new Error("CloseHandle failed for the Creator test job.");
        library.close();
        return { remainingMembers: active, limitTerminations, disarmed: true };
      },
    };
  } catch (error) {
    const cleanupErrors = [];
    if (installedObserver) {
      try {
        process.removeListener("SIGINT", onInterrupt);
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
    }
    if (consoleAllocated) {
      try {
        if (!api.FreeConsole()) cleanupErrors.push(new Error("FreeConsole cleanup failed."));
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
    }
    if (job) {
      try {
        if (!api.CloseHandle(job))
          cleanupErrors.push(new Error("Creator job handle close failed."));
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
    }
    try {
      library.close();
    } catch (cleanupError) {
      cleanupErrors.push(cleanupError);
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [error, ...cleanupErrors],
        "Creator console admission and cleanup failed.",
      );
    }
    throw error;
  }
}
