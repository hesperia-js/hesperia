#!/usr/bin/env python3
"""Run the prepared VS Code editor fixture and observe Linux processes."""

from __future__ import annotations

import argparse
import ast
import hashlib
import json
import os
import pathlib
import re
import select
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import traceback
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any


TEST_BUDGET_SECONDS = 120
PROCESS_POLL_SECONDS = 0.02
RAW_CREATOR_GATE_TIMEOUT_SECONDS = 15
TRACE_TIMESTAMP_RE = re.compile(r"^(\d+)(?:\.(\d+))?\s+")
EXIT_RE = re.compile(r"\+\+\+ exited with (\d+) \+\+\+$")
SIGNAL_RE = re.compile(r"\+\+\+ killed by (SIG[A-Z0-9]+)(?: \(.*\))? \+\+\+$")
SPAWN_RE = re.compile(r"\b(clone3?|fork|vfork)\(.*\)\s+=\s+(\d+)(?:\s|$)")
EXEC_RE = re.compile(r'^(?:\d+(?:\.\d+)?\s+)?execve\("((?:[^"\\]|\\.)*)",')
SUCCESSFUL_EXEC_RE = re.compile(r"(?:^|\s)(?:execve\(|<\.\.\. execve resumed>).*\)\s+=\s+0(?:\s|$)")
SUCCESSFUL_EXECVEAT_RE = re.compile(r"(?:^|\s)(?:execveat\(|<\.\.\. execveat resumed>).*\)\s+=\s+0(?:\s|$)")


class CaptureError(RuntimeError):
    pass


class IncompleteProcArgv(CaptureError):
    def __init__(self, pid: int, stage: str, proc: dict[str, Any], detail: str):
        super().__init__(detail)

        self.pid = pid
        self.stage = stage
        self.proc = proc


class IncompleteProcExecutable(CaptureError):
    def __init__(self, pid: int, stage: str, proc: dict[str, Any], detail: str):
        super().__init__(detail)

        self.pid = pid
        self.stage = stage
        self.proc = proc


class ZombieProcSample(ProcessLookupError):
    def __init__(self, pid: int, stage: str, proc: dict[str, Any]):
        super().__init__(f"PID {pid} became a zombie during /proc image sampling: {stage}")

        self.pid = pid
        self.stage = stage
        self.proc = proc


def utc_now() -> str:
    return utc_at_ns(time.time_ns())


def utc_time_ns(value: str) -> int:
    match = re.fullmatch(
        r"(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})",
        value,
    )

    if match is None:
        raise CaptureError("Native process image observation has an invalid timestamp")

    offset = "+00:00" if match.group(3) == "Z" else match.group(3)

    try:
        parsed = datetime.fromisoformat(match.group(1) + offset).astimezone(timezone.utc)
    except ValueError as error:
        raise CaptureError("Native process image observation has an invalid timestamp") from error

    epoch = datetime(1970, 1, 1, tzinfo=timezone.utc)
    elapsed = parsed - epoch
    whole_seconds = elapsed.days * 86_400 + elapsed.seconds
    fraction = int((match.group(2) or "").ljust(9, "0"))
    return whole_seconds * 1_000_000_000 + fraction


def utc_at_ns(value: int) -> str:
    seconds, nanoseconds = divmod(value, 1_000_000_000)
    whole = datetime.fromtimestamp(seconds, timezone.utc).strftime("%Y-%m-%dT%H:%M:%S")
    return f"{whole}.{nanoseconds:09d}Z"


def sample_proc(pid: int, stage: str = "native process observation") -> tuple[dict[str, Any], int, int]:
    started_ns = time.time_ns()
    proc = parse_proc(pid, stage)
    return proc, started_ns, time.time_ns()


def write_json(path: pathlib.Path, value: object) -> None:
    path.write_text(json.dumps(value, separators=(",", ":")), encoding="utf-8")


def read_json(path: pathlib.Path) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise CaptureError(f"Could not read current-run editor evidence: {path}") from error


def require_exact_keys(value: object, keys: set[str], label: str) -> dict[str, Any]:
    if not isinstance(value, dict) or set(value) != keys:
        raise CaptureError(f"{label} has missing or unexpected fields")

    return value


def valid_timestamp(value: object) -> bool:
    if not isinstance(value, str):
        return False

    try:
        utc_time_ns(value)

        return True
    except CaptureError:
        return False


def parse_proc(pid: int, stage: str = "native process observation") -> dict[str, Any]:
    root = pathlib.Path("/proc") / str(pid)

    def read_proc_text(name: str) -> str:
        try:
            return (root / name).read_text(encoding="utf-8")
        except FileNotFoundError as error:
            raise FileNotFoundError(
                f"/proc identity sample unavailable: {json.dumps({'pid': pid, 'stage': stage, 'field': name, 'error': str(error)}, separators=(',', ':'))}"
            ) from error
        except ProcessLookupError as error:
            raise ProcessLookupError(
                f"/proc identity sample unavailable: {json.dumps({'pid': pid, 'stage': stage, 'field': name, 'error': str(error)}, separators=(',', ':'))}"
            ) from error
        except OSError as error:
            raise CaptureError(
                f"/proc identity sample read failed: {json.dumps({'pid': pid, 'stage': stage, 'field': name, 'error': f'{type(error).__name__}: {error}'}, separators=(',', ':'))}"
            ) from error

    stat = read_proc_text("stat")
    close = stat.rfind(")")

    if close < 0:
        raise CaptureError(
            f"Malformed /proc stat record: {json.dumps({'pid': pid, 'stage': stage, 'stat': stat}, separators=(',', ':'))}"
        )

    fields = stat[close + 1 :].split()

    if len(fields) < 20:
        raise CaptureError(
            f"Short /proc stat record: {json.dumps({'pid': pid, 'stage': stage, 'statFields': fields}, separators=(',', ':'))}"
        )

    if fields[0] in {"X", "x"}:
        raise ProcessLookupError(
            f"PID {pid} has no live /proc image: {json.dumps({'stage': stage, 'state': fields[0]}, separators=(',', ':'))}"
        )

    try:
        start_ticks = int(fields[19])
    except ValueError as error:
        raise CaptureError(
            f"Malformed /proc starttime: {json.dumps({'pid': pid, 'stage': stage, 'value': fields[19]}, separators=(',', ':'))}"
        ) from error

    status: dict[str, str] = {}

    for line in read_proc_text("status").splitlines():
        key, separator, value = line.partition(":")

        if separator:
            status[key] = value.strip()

    raw_tgid = status.get("Tgid")
    raw_ppid = status.get("PPid")

    try:
        tgid = int(raw_tgid or "0")
        ppid = int(raw_ppid or "0")
    except ValueError as error:
        raise CaptureError(
            f"Malformed /proc status identity: {json.dumps({'pid': pid, 'stage': stage, 'Tgid': raw_tgid, 'PPid': raw_ppid}, separators=(',', ':'))}"
        ) from error

    if fields[0] == "Z":
        raise ZombieProcSample(
            pid,
            stage,
            {"pid": pid, "ppid": ppid, "tgid": tgid, "startTicks": start_ticks, "state": "Z"},
        )

    try:
        argv_bytes = (root / "cmdline").read_bytes()
    except FileNotFoundError as error:
        raise FileNotFoundError(
            f"/proc identity sample unavailable: {json.dumps({'pid': pid, 'stage': stage, 'field': 'cmdline', 'error': str(error)}, separators=(',', ':'))}"
        ) from error
    except ProcessLookupError as error:
        raise ProcessLookupError(
            f"/proc identity sample unavailable: {json.dumps({'pid': pid, 'stage': stage, 'field': 'cmdline', 'error': str(error)}, separators=(',', ':'))}"
        ) from error
    except OSError as error:
        raise CaptureError(
            f"/proc identity sample read failed: {json.dumps({'pid': pid, 'stage': stage, 'field': 'cmdline', 'error': f'{type(error).__name__}: {error}'}, separators=(',', ':'))}"
        ) from error

    argv_parts = argv_bytes.split(b"\0") if argv_bytes else []

    if argv_parts and not argv_parts[-1]:
        argv_parts.pop()

    argv = [os.fsdecode(arg) for arg in argv_parts]
    executable_link: str | None = None
    executable: str | None = None
    executable_error: str | None = None
    executable_link_missing = False

    try:
        executable_link = os.readlink(root / "exe")

        if not os.path.isabs(executable_link):
            executable_error = "kernel readlink target is not absolute"
        else:
            try:
                executable = str(pathlib.Path(executable_link).resolve(strict=True))
            except (OSError, RuntimeError) as error:
                executable_error = f"strict executable target resolution failed: {type(error).__name__}: {error}"
    except FileNotFoundError as error:
        executable_link_missing = True
        executable_error = f"kernel executable readlink failed: {type(error).__name__}: {error}"
    except OSError as error:
        executable_error = f"kernel executable readlink failed: {type(error).__name__}: {error}"

    observed = {
        "state": fields[0],
        "startTicks": start_ticks,
        "Tgid": raw_tgid,
        "tgid": tgid,
        "PPid": raw_ppid,
        "ppid": ppid,
        "procExeReadlinkTarget": executable_link,
        "executablePath": executable,
        "executableError": executable_error,
        "argv": argv,
    }
    missing: list[str] = []

    if start_ticks <= 0:
        missing.append("startTicks")

    if tgid <= 0:
        missing.append("tgid")

    if ppid <= 0:
        missing.append("ppid")

    if executable is None:
        missing.append("executablePath")

    if not argv:
        missing.append("argv")

    if missing:
        detail = f"Incomplete live /proc identity for PID {pid}: {json.dumps({'stage': stage, 'missingFields': missing, 'observed': observed}, separators=(',', ':'))}"

        if (
            missing == ["executablePath", "argv"]
            and executable_link_missing
            and tgid == pid
        ):
            raise IncompleteProcExecutable(
                pid,
                stage,
                {"pid": pid, "ppid": ppid, "tgid": tgid, "startTicks": start_ticks},
                detail,
            )

        if missing == ["argv"]:
            raise IncompleteProcArgv(
                pid,
                stage,
                {
                    "pid": pid,
                    "ppid": ppid,
                    "tgid": tgid,
                    "startTicks": start_ticks,
                    "executablePath": executable,
                    "argv": argv,
                },
                detail,
            )

        raise CaptureError(detail)

    return {
        "pid": pid,
        "ppid": ppid,
        "tgid": tgid,
        "startTicks": start_ticks,
        "executablePath": executable,
        "argv": argv,
    }


def pidfd_ready(fd: int) -> bool:
    poller = select.poll()

    poller.register(fd, select.POLLIN | select.POLLHUP | select.POLLERR)

    events = poller.poll(0)

    if any(flags & (select.POLLNVAL | select.POLLERR) for _, flags in events):
        raise CaptureError(f"Retained pidfd {fd} readiness descriptor is invalid")

    return any(flags & (select.POLLIN | select.POLLHUP) for _, flags in events)


def read_proc_kernel_identity(
    pid: int, stage: str, *, allow_zombie: bool = False
) -> dict[str, int | str]:
    root = pathlib.Path("/proc") / str(pid)

    try:
        stat = (root / "stat").read_text(encoding="utf-8")
        status = (root / "status").read_text(encoding="utf-8")
    except (FileNotFoundError, ProcessLookupError):
        raise
    except OSError as error:
        raise CaptureError(
            f"Could not reread retained /proc kernel identity: {json.dumps({'pid': pid, 'stage': stage, 'error': f'{type(error).__name__}: {error}'}, separators=(',', ':'))}"
        ) from error

    close = stat.rfind(")")

    if close < 0:
        raise CaptureError(f"Malformed /proc stat while checking retained PID {pid}: {stage}")

    fields = stat[close + 1 :].split()

    if len(fields) < 20:
        raise CaptureError(f"Short /proc stat while checking retained PID {pid}: {stage}")

    state = fields[0]

    if state in {"X", "x"} or (state == "Z" and not allow_zombie):
        raise ProcessLookupError(f"PID {pid} has no live /proc image while checking retained identity: {stage}")

    try:
        start_ticks = int(fields[19])
    except ValueError as error:
        raise CaptureError(f"Malformed /proc starttime while checking retained PID {pid}: {stage}") from error

    status_fields: dict[str, str] = {}

    for line in status.splitlines():
        key, separator, value = line.partition(":")

        if separator:
            status_fields[key] = value.strip()

    raw_tgid = status_fields.get("Tgid")
    raw_ppid = status_fields.get("PPid")

    try:
        tgid = int(raw_tgid or "0")
        ppid = int(raw_ppid or "0")
    except ValueError as error:
        raise CaptureError(f"Malformed /proc status while checking retained PID {pid}: {stage}") from error

    if pid <= 0 or start_ticks <= 0 or tgid != pid or ppid <= 0:
        raise CaptureError(
            f"Invalid /proc kernel identity while checking retained PID {pid}: "
            + json.dumps(
                {"stage": stage, "startTicks": start_ticks, "tgid": tgid, "ppid": ppid},
                separators=(",", ":"),
            )
        )

    identity: dict[str, int | str] = {"pid": pid, "tgid": tgid, "startTicks": start_ticks, "ppid": ppid}

    if allow_zombie:
        identity["state"] = state

    return identity


def validate_retained_generation(proc: dict[str, Any], pid: int, start_ticks: int, stage: str) -> None:
    if proc["pid"] != pid or proc["tgid"] != pid or proc["startTicks"] != start_ticks:
        raise CaptureError(f"PID generation changed while its pidfd was retained: {pid} ({stage})")


@dataclass
class Generation:
    pid: int
    ppid: int
    start_ticks: int
    pidfd: int
    attached_at: str
    executions: list[dict[str, Any]] = field(default_factory=list)
    parents: list[dict[str, Any]] = field(default_factory=list)
    ready_at: str | None = None
    current_image_complete: bool = False
    sample_started_ns: int | None = None
    sample_finished_ns: int | None = None
    current_proc: dict[str, Any] | None = None

    def observe(
        self,
        proc: dict[str, Any],
        sample_started_ns: int,
        sample_finished_ns: int,
        *,
        retain_sample: bool = False,
    ) -> None:
        if proc["pid"] != self.pid or proc["tgid"] != self.pid or proc["startTicks"] != self.start_ticks:
            raise CaptureError(f"PID generation changed while its pidfd was retained: {self.pid}")

        if sample_started_ns < 0 or sample_finished_ns < sample_started_ns:
            raise CaptureError(
                f"Invalid /proc sample interval for retained PID generation {self.pid}"
                f" (sample_started_ns={sample_started_ns}, "
                f"sample_finished_ns={sample_finished_ns}, retain_sample={retain_sample})"
            )

        image = {"executablePath": proc["executablePath"], "argv": proc["argv"]}

        if retain_sample or not self.executions or any(
            self.executions[-1][key] != image[key] for key in image
        ):
            self.executions.append({**image, "observedAt": utc_at_ns(sample_started_ns)})

        parent = {"pid": proc["ppid"], "observedAt": utc_at_ns(sample_started_ns)}

        if not self.parents or self.parents[-1]["pid"] != proc["ppid"]:
            self.parents.append(parent)

        self.current_proc = proc
        self.sample_started_ns = sample_started_ns
        self.sample_finished_ns = sample_finished_ns
        self.current_image_complete = True

    def mark_image_incomplete(self) -> None:
        self.current_proc = None
        self.sample_started_ns = None
        self.sample_finished_ns = None
        self.current_image_complete = False

    def qualify_after_exec(self, transition: dict[str, Any]) -> bool:
        if (
            not self.current_image_complete
            or self.current_proc is None
            or not self.executions
            or self.sample_started_ns is None
            or self.sample_finished_ns is None
            or self.sample_finished_ns < self.sample_started_ns
            or self.sample_started_ns <= transition["completionNs"]
            or self.current_proc["executablePath"] != transition["resolvedPath"]
            or self.executions[-1]["executablePath"] != self.current_proc["executablePath"]
            or self.executions[-1]["argv"] != self.current_proc["argv"]
        ):
            return False

        latest = self.executions[-1]

        if utc_time_ns(latest["observedAt"]) <= transition["completionNs"]:
            self.executions.append(
                {
                    "executablePath": self.current_proc["executablePath"],
                    "argv": self.current_proc["argv"],
                    "observedAt": utc_at_ns(self.sample_started_ns),
                }
            )

        return True

    def check_exit(self) -> bool:
        if pidfd_ready(self.pidfd):
            if self.ready_at is None:
                self.ready_at = utc_now()

            return True

        return False

    def identity(self) -> dict[str, Any]:
        return {
            "pid": self.pid,
            "parentPid": self.ppid,
            "procStarttimeTicks": self.start_ticks,
            "pidfdAttachedAt": self.attached_at,
            "pidfdReadyAt": self.ready_at,
            "executions": self.executions,
            "parents": self.parents,
        }


def defer_verified_zombie(
    generation: Generation,
    observed: dict[str, Any],
    reference: dict[str, Any],
    stage: str,
) -> None:
    if observed.get("state") != "Z":
        raise CaptureError(f"Retained process generation {generation.pid} was not verified as a zombie: {stage}")

    validate_retained_generation(observed, generation.pid, generation.start_ticks, stage)

    if observed["ppid"] != reference["ppid"]:
        raise CaptureError(f"Retained process parent changed during zombie verification: {generation.pid} ({stage})")

    generation.mark_image_incomplete()

    if generation.check_exit():
        return

    try:
        after = read_proc_kernel_identity(generation.pid, f"after {stage}", allow_zombie=True)
    except (FileNotFoundError, ProcessLookupError) as error:
        if generation.check_exit():
            return

        raise CaptureError(
            f"Retained process generation {generation.pid} lost kernel identity during zombie verification: {stage}"
        ) from error

    validate_retained_generation(after, generation.pid, generation.start_ticks, stage)

    if after["state"] != "Z" or after["ppid"] != observed["ppid"]:
        raise CaptureError(f"Retained process identity changed during zombie verification: {generation.pid} ({stage})")

    generation.check_exit()


def terminate_retained_generation(generation: Generation, forced_pids: list[int]) -> None:
    if generation.check_exit():
        return

    try:
        current = read_proc_kernel_identity(
            generation.pid,
            "before retained generation SIGKILL cleanup",
            allow_zombie=True,
        )
    except (FileNotFoundError, ProcessLookupError):
        if generation.check_exit():
            return

        raise

    validate_retained_generation(
        current,
        generation.pid,
        generation.start_ticks,
        "before retained generation SIGKILL cleanup",
    )

    if current["state"] == "Z":
        defer_verified_zombie(
            generation,
            current,
            current,
            "before retained generation SIGKILL cleanup",
        )

    if generation.check_exit():
        return

    signal.pidfd_send_signal(generation.pidfd, signal.SIGKILL)

    forced_pids.append(generation.pid)

    deadline = time.monotonic() + 5

    while time.monotonic() < deadline and not generation.check_exit():
        time.sleep(PROCESS_POLL_SECONDS)

    if generation.ready_at is None:
        raise CaptureError(f"Process remains alive through retained pidfd: {generation.pid}")


@dataclass
class PendingTraceGeneration:
    pid: int
    ppid: int
    start_ticks: int
    pidfd: int
    attached_at: str


@dataclass
class RawCreatorFixture:
    directory: pathlib.Path
    helper_script: pathlib.Path
    python_executable: str
    helper_pid: int | None = None
    helper_start_ticks: int | None = None
    helper_sample_started_ns: int | None = None
    helper_sample_finished_ns: int | None = None
    helper_first_parent_pid: int | None = None
    helper_attached_at: str | None = None
    helper_terminal_ns: int | None = None
    child_pid: int | None = None
    child_pidfd: int | None = None
    child_start_ticks: int | None = None
    child_attached_at: str | None = None
    adopted_ppid: int | None = None
    helper_released: bool = False
    child_released: bool = False
    completed: bool = False


@dataclass
class PendingPopenGeneration:
    role: str
    process: subprocess.Popen[bytes]
    pidfd: int
    attached_at: str
    stderr_path: pathlib.Path | None = None


def capture_popen_stderr(
    process: subprocess.Popen[bytes], stderr_path: pathlib.Path | None = None
) -> dict[str, Any]:
    limit = 16 * 1024

    if stderr_path is not None:
        try:
            size = stderr_path.stat().st_size
            with stderr_path.open("rb") as stream:
                content = stream.read(limit)
            return {
                "bytesAvailable": size,
                "text": content.decode("utf-8", errors="replace"),
                "truncated": size > limit,
                "eof": size <= limit,
            }
        except OSError as error:
            return {"error": f"{type(error).__name__}: {error}", "text": None}

    stream = process.stderr

    if stream is None:
        return {"bytesAvailable": 0, "text": "", "truncated": False, "eof": True}

    try:
        descriptor = stream.fileno()

        os.set_blocking(descriptor, False)
    except (OSError, ValueError) as error:
        return {"error": f"{type(error).__name__}: {error}", "text": None}

    captured = bytearray()
    eof = False

    while len(captured) < limit:
        try:
            chunk = os.read(descriptor, min(8192, limit - len(captured)))
        except BlockingIOError:
            break
        except OSError as error:
            return {
                "bytesCaptured": len(captured),
                "text": captured.decode("utf-8", errors="replace"),
                "captureLimitReached": len(captured) == limit,
                "remainingBytes": "unknown",
                "eof": eof,
                "readError": f"{type(error).__name__}: {error}",
            }

        if not chunk:
            eof = True
            break

        captured.extend(chunk)

    limit_reached = len(captured) == limit
    return {
        "bytesCaptured": len(captured),
        "text": captured.decode("utf-8", errors="replace"),
        "captureLimitReached": limit_reached,
        "remainingBytes": None if eof else "unknown",
        "eof": eof,
    }


def popen_wait_outcome(process: subprocess.Popen[bytes]) -> dict[str, Any]:
    status = process.wait()

    if status < 0:
        number = -status

        try:
            name = signal.Signals(number).name
        except ValueError:
            name = None

        return {"kind": "signal", "signalNumber": number, "signalName": name}

    return {"kind": "exit", "status": status}


def popen_outcome_detail(
    role: str,
    pid: int,
    stage: str,
    pidfd_ready_before_cleanup: bool,
    wait_outcome: dict[str, Any],
    stderr: dict[str, Any],
    requested_signal: str | None = None,
) -> str:
    return "Popen startup outcome: " + json.dumps(
        {
            "role": role,
            "pid": pid,
            "stage": stage,
            "pidfdReadyBeforeCleanup": pidfd_ready_before_cleanup,
            "waitOutcome": wait_outcome,
            "requestedSignal": requested_signal,
            "stderr": stderr,
        },
        separators=(",", ":"),
    )


def retain_popen_generation(
    process: subprocess.Popen[bytes],
    role: str,
    pending: dict[int, PendingPopenGeneration],
    diagnostics: list[str],
    stderr_path: pathlib.Path | None = None,
) -> PendingPopenGeneration:
    pid = process.pid

    try:
        fd = os.pidfd_open(pid, 0)
    except OSError as error:
        status = process.poll()

        if status is not None:
            wait_outcome = popen_wait_outcome(process)
            stderr = capture_popen_stderr(process, stderr_path)
            detail = popen_outcome_detail(role, pid, "pidfd open", False, wait_outcome, stderr)

            diagnostics.append(f"{detail}; pidfdOpenError={type(error).__name__}: {error}")

            raise CaptureError(f"{role} Popen child exited before pidfd attachment: {detail}") from error

        raise CaptureError(
            f"Could not retain a pidfd for live {role} Popen child PID {pid}: {type(error).__name__}: {error}; refusing numeric-PID cleanup"
        ) from error

    attachment = PendingPopenGeneration(role, process, fd, utc_now(), stderr_path)
    pending[pid] = attachment
    return attachment


def admit_popen_generation(
    attachment: PendingPopenGeneration,
    pending: dict[int, PendingPopenGeneration],
    diagnostics: list[str],
) -> Generation:
    process = attachment.process
    role = attachment.role
    pid = process.pid
    fd = attachment.pidfd

    def fail_if_exited(stage: str) -> None:
        if not pidfd_ready(fd):
            return

        try:
            wait_outcome = popen_wait_outcome(process)
            stderr = capture_popen_stderr(process, attachment.stderr_path)
            detail = popen_outcome_detail(role, pid, stage, True, wait_outcome, stderr)

            diagnostics.append(detail)

            raise CaptureError(f"{role} Popen child exited before live /proc generation admission: {detail}")
        finally:
            pending.pop(pid, None)

            os.close(fd)

    def sample_failure(stage: str, error: BaseException) -> None:
        diagnostics.append(
            "Popen /proc identity sample failure: "
            + json.dumps(
                {"role": role, "pid": pid, "stage": stage, "detail": str(error)},
                separators=(",", ":"),
            )
        )

        if pidfd_ready(fd):
            fail_if_exited(stage)

        raise CaptureError(
            f"Could not attach live {role} Popen child generation: pid={pid}; sample={stage}; pidfdReady=false; detail={error}"
        ) from error

    fail_if_exited("before first /proc sample")

    try:
        first, _, _ = sample_proc(pid, f"{role} Popen first /proc sample")
    except (CaptureError, FileNotFoundError, ProcessLookupError) as error:
        sample_failure("first /proc sample", error)

    if first["tgid"] != pid:
        sample_failure(
            "first /proc sample",
            CaptureError(f"Popen process leader mismatch: expected pid/tgid={pid}, observed tgid={first['tgid']}"),
        )

    fail_if_exited("after first /proc sample")

    try:
        second, second_started_ns, second_finished_ns = sample_proc(pid, f"{role} Popen second /proc sample")
    except (CaptureError, FileNotFoundError, ProcessLookupError) as error:
        sample_failure("second /proc sample", error)

    if second["tgid"] != pid:
        sample_failure(
            "second /proc sample",
            CaptureError(f"Popen process leader mismatch: expected pid/tgid={pid}, observed tgid={second['tgid']}"),
        )

    identity_fields = ("pid", "tgid", "startTicks", "ppid", "executablePath", "argv")

    if any(first[field] != second[field] for field in identity_fields):
        sample_failure(
            "first-to-second /proc identity comparison",
            CaptureError(
                "Popen child identity changed across startup samples: "
                + json.dumps(
                    {
                        "first": {field: first[field] for field in identity_fields},
                        "second": {field: second[field] for field in identity_fields},
                    },
                    separators=(",", ":"),
                )
            ),
        )

    fail_if_exited("after second /proc sample")

    generation = Generation(pid, second["ppid"], second["startTicks"], fd, attachment.attached_at)

    generation.observe(second, second_started_ns, second_finished_ns)

    pending.pop(pid, None)

    return generation


def open_popen_generation(
    process: subprocess.Popen[bytes],
    role: str,
    pending: dict[int, PendingPopenGeneration],
    diagnostics: list[str],
    stderr_path: pathlib.Path | None = None,
) -> Generation:
    attachment = retain_popen_generation(process, role, pending, diagnostics, stderr_path)
    return admit_popen_generation(attachment, pending, diagnostics)


def open_generation(
    pid: int,
    pending: dict[int, PendingTraceGeneration],
    trace: dict[str, Any] | None = None,
) -> Generation | None:
    status_path = pathlib.Path("/proc") / str(pid) / "status"

    try:
        status_text = status_path.read_text(encoding="utf-8")
    except (FileNotFoundError, ProcessLookupError):
        return None
    except OSError as error:
        raise CaptureError(f"Could not read /proc thread-group identity for PID {pid}: {error}") from error

    status_fields: dict[str, str] = {}

    for line in status_text.splitlines():
        key, separator, value = line.partition(":")

        if separator:
            status_fields[key] = value.strip()

    raw_tgid = status_fields.get("Tgid")

    try:
        tgid = int(raw_tgid or "0")
    except ValueError as error:
        raise CaptureError(f"Malformed /proc thread-group identity for PID {pid}: Tgid={raw_tgid!r}") from error

    if tgid <= 0:
        raise CaptureError(f"Missing /proc thread-group identity for PID {pid}")

    if tgid != pid:
        return None

    if pid in pending:
        raise CaptureError(f"Traced process PID {pid} already has an unadmitted pidfd generation")

    try:
        before, _, _ = sample_proc(pid)
    except (IncompleteProcArgv, IncompleteProcExecutable) as error:
        before = error.proc

        if before["pid"] != pid or before["tgid"] != pid or before["startTicks"] <= 0 or before["ppid"] <= 0:
            raise CaptureError(f"Incomplete /proc argv sample lacks valid process-leader identity for PID {pid}") from error

        try:
            fd = os.pidfd_open(pid, 0)
        except ProcessLookupError:
            return None
        except OSError as open_error:
            raise CaptureError(f"Could not retain a pidfd for incomplete traced process {pid}: {open_error}") from open_error

        attachment: PendingTraceGeneration | None = None
        attached_at: str | None = None
        retained_identity: dict[str, int] | None = None

        try:
            attached_at = utc_now()

            try:
                retained_identity = read_proc_kernel_identity(pid, "incomplete argv pidfd attachment")
            except (FileNotFoundError, ProcessLookupError) as identity_error:
                if pidfd_ready(fd):
                    attachment = PendingTraceGeneration(pid, before["ppid"], before["startTicks"], fd, attached_at)
                    pending[pid] = attachment
                    return None

                raise CaptureError(f"Could not recheck incomplete traced process PID {pid} after pidfd attachment") from identity_error

            validate_retained_generation(
                retained_identity, pid, before["startTicks"], "incomplete argv pidfd attachment"
            )

            if isinstance(error, IncompleteProcExecutable) and retained_identity["ppid"] != before["ppid"]:
                raise CaptureError(f"Traced process parent changed after incomplete executable sample: {pid}") from error

            attachment = PendingTraceGeneration(pid, before["ppid"], before["startTicks"], fd, attached_at)
            pending[pid] = attachment

            if pidfd_ready(fd):
                return None
        except BaseException as failure_error:
            diagnostic_detail: str | None = None

            if isinstance(failure_error, CaptureError):
                try:
                    ready_started_ns = time.time_ns()
                    ready = pidfd_ready(fd)
                    ready_finished_ns = time.time_ns()
                    diagnostic_detail = (
                        str(failure_error)
                        + "; incompleteAttachmentDiagnostic="
                        + json.dumps(
                            {
                                "pid": pid,
                                "incompleteType": type(error).__name__,
                                "incompleteStage": error.stage,
                                "incompleteDetail": str(error),
                                "partialSample": before,
                                "attachedAt": attached_at,
                                "retainedKernelIdentity": retained_identity,
                                "pendingRegistered": attachment is not None and pending.get(pid) is attachment,
                                "failureReadinessProbe": {
                                    "ready": ready,
                                    "startedNs": ready_started_ns,
                                    "finishedNs": ready_finished_ns,
                                },
                            },
                            separators=(",", ":"),
                        )
                    )
                except BaseException:
                    pass

            if attachment is None or pending.get(pid) is not attachment:
                os.close(fd)

            if diagnostic_detail is not None:
                raise CaptureError(diagnostic_detail) from failure_error

            raise

        return None
    except (FileNotFoundError, ProcessLookupError):
        return None

    if before["tgid"] != tgid:
        raise CaptureError(f"Thread-group identity changed while opening traced process generation: {pid}")

    try:
        fd = os.pidfd_open(pid, 0)
    except ProcessLookupError:
        return None
    except OSError as error:
        raise CaptureError(f"Could not retain a pidfd for traced process {pid}: {error}") from error

    attachment = None

    try:
        attached_at = utc_now()

        if pidfd_ready(fd):
            os.close(fd)

            return None

        try:
            after, after_started_ns, after_finished_ns = sample_proc(pid)
        except (IncompleteProcArgv, IncompleteProcExecutable) as error:
            validate_retained_generation(
                error.proc, pid, before["startTicks"], "incomplete second /proc sample while opening pidfd"
            )

            attachment = PendingTraceGeneration(pid, error.proc["ppid"], error.proc["startTicks"], fd, attached_at)
            pending[pid] = attachment

            if pidfd_ready(fd):
                return None

            try:
                retained_identity = read_proc_kernel_identity(
                    pid, "incomplete second /proc sample pidfd recheck"
                )
            except (FileNotFoundError, ProcessLookupError) as identity_error:
                if pidfd_ready(fd):
                    return None

                raise CaptureError(
                    f"Could not recheck incomplete traced process PID {pid} after pidfd attachment"
                ) from identity_error

            validate_retained_generation(
                retained_identity, pid, attachment.start_ticks, "incomplete second /proc sample pidfd recheck"
            )

            if pidfd_ready(fd):
                return None

            return None

        if (
            after["pid"] != before["pid"]
            or after["tgid"] != before["tgid"]
            or after["startTicks"] != before["startTicks"]
        ):
            raise CaptureError(f"PID changed generation while opening pidfd: {pid}")

        if pidfd_ready(fd):
            os.close(fd)

            return None

        if trace is not None and not traced_parent_sample_ready(pid, after["ppid"], after_started_ns, trace):
            attachment = PendingTraceGeneration(pid, after["ppid"], after["startTicks"], fd, attached_at)
            pending[pid] = attachment

            return None

        generation = Generation(pid, after["ppid"], after["startTicks"], fd, attached_at)

        generation.observe(after, after_started_ns, after_finished_ns)

        return generation
    except BaseException:
        if attachment is None or pending.get(pid) is not attachment:
            os.close(fd)

        raise


def retry_pending_trace_generation(
    pid: int,
    pending: dict[int, PendingTraceGeneration],
    generations: dict[int, Generation],
    trace: dict[str, Any] | None,
) -> bool:
    attachment = pending[pid]

    if pidfd_ready(attachment.pidfd):
        if trace is None:
            return False

        creator_edges = trace["creations"].get(pid, [])

        if (
            len(creator_edges) != 1
            or creator_edges[0]["thread"]
            or creator_edges[0]["parentTid"] not in trace["files"]
        ):
            return False

        candidate_tids = set(trace["files"]) | set(trace["creations"]) | set(trace["exits"])
        members = {pid} | {
            tid
            for tid in candidate_tids
            if resolve_tgid(tid, trace["creations"], {}) == pid
        }

        if (
            not members <= set(trace["files"])
            or not members <= set(trace["exits"])
            or any(item["tid"] in members for item in trace["pendingSyscalls"])
        ):
            return False

        terminal_ns = max(trace_time_ns(trace["exits"][tid]["line"]) for tid in members)
        return (
            creator_edges[0]["startNs"]
            < utc_time_ns(attachment.attached_at)
            < terminal_ns
        )

    try:
        before = read_proc_kernel_identity(pid, "pending traced process before full /proc sample")
    except (FileNotFoundError, ProcessLookupError) as error:
        if pidfd_ready(attachment.pidfd):
            return False

        raise CaptureError(f"Pending traced process PID {pid} disappeared before its /proc argv identity completed") from error

    validate_retained_generation(before, pid, attachment.start_ticks, "pending traced process before full /proc sample")

    if pidfd_ready(attachment.pidfd):
        return False

    try:
        proc, sample_started_ns, sample_finished_ns = sample_proc(pid, "pending traced process full /proc sample")
    except (IncompleteProcArgv, IncompleteProcExecutable) as error:
        validate_retained_generation(
            error.proc, pid, attachment.start_ticks, "pending traced process incomplete argv sample"
        )

        if pidfd_ready(attachment.pidfd):
            return False

        try:
            after = read_proc_kernel_identity(pid, "pending traced process after incomplete /proc sample")
        except (FileNotFoundError, ProcessLookupError) as identity_error:
            if pidfd_ready(attachment.pidfd):
                return False

            raise CaptureError(f"Pending traced process PID {pid} disappeared during its /proc argv retry") from identity_error

        validate_retained_generation(
            after, pid, attachment.start_ticks, "pending traced process after incomplete /proc sample"
        )

        if pidfd_ready(attachment.pidfd):
            return False

        return False
    except (FileNotFoundError, ProcessLookupError) as error:
        if pidfd_ready(attachment.pidfd):
            return False

        raise CaptureError(f"Pending traced process PID {pid} lost its /proc identity before argv completion") from error

    validate_retained_generation(proc, pid, attachment.start_ticks, "pending traced process full /proc sample")

    if pidfd_ready(attachment.pidfd):
        return False

    try:
        after = read_proc_kernel_identity(pid, "pending traced process after complete /proc sample")
    except (FileNotFoundError, ProcessLookupError) as error:
        if pidfd_ready(attachment.pidfd):
            return False

        raise CaptureError(f"Pending traced process PID {pid} disappeared before complete admission") from error

    validate_retained_generation(after, pid, attachment.start_ticks, "pending traced process after complete /proc sample")

    if pidfd_ready(attachment.pidfd):
        return False

    if trace is not None and not traced_parent_sample_ready(pid, proc["ppid"], sample_started_ns, trace):
        return False

    generation = Generation(pid, proc["ppid"], proc["startTicks"], attachment.pidfd, attachment.attached_at)

    generation.observe(proc, sample_started_ns, sample_finished_ns)

    if pid in generations:
        raise CaptureError(f"Traced process PID {pid} already has an admitted process generation")

    try:
        pending.pop(pid)

        generations[pid] = generation
    except BaseException:
        if pid not in generations:
            try:
                pending[pid] = attachment
            except BaseException:
                os.close(attachment.pidfd)

        raise

    return False


def observe_retained_generation(generation: Generation) -> None:
    if generation.check_exit():
        return

    try:
        before = read_proc_kernel_identity(
            generation.pid, "before current /proc image sample", allow_zombie=True
        )
    except (FileNotFoundError, ProcessLookupError):
        if generation.check_exit():
            return

        generation.mark_image_incomplete()

        return

    validate_retained_generation(before, generation.pid, generation.start_ticks, "before current /proc image sample")

    if before["state"] == "Z":
        defer_verified_zombie(generation, before, before, "before current /proc image sample")

        return

    if generation.check_exit():
        return

    try:
        proc, sample_started_ns, sample_finished_ns = sample_proc(generation.pid)
    except ZombieProcSample as error:
        defer_verified_zombie(
            generation,
            error.proc,
            before,
            "zombie current /proc image sample",
        )

        return
    except IncompleteProcExecutable as error:
        generation.mark_image_incomplete()

        validate_retained_generation(
            error.proc, generation.pid, generation.start_ticks, "incomplete current executable sample"
        )

        if error.proc["ppid"] != before["ppid"]:
            generation.check_exit()

            return

        if generation.check_exit():
            return

        try:
            after = read_proc_kernel_identity(generation.pid, "after incomplete current executable sample")
        except (FileNotFoundError, ProcessLookupError):
            generation.check_exit()

            return

        validate_retained_generation(
            after, generation.pid, generation.start_ticks, "after incomplete current executable sample"
        )

        if after["ppid"] != before["ppid"]:
            generation.check_exit()

            return

        generation.check_exit()

        return
    except IncompleteProcArgv as error:
        validate_retained_generation(
            error.proc, generation.pid, generation.start_ticks, "incomplete current /proc argv sample"
        )

        if generation.check_exit():
            generation.mark_image_incomplete()

            return

        try:
            after = read_proc_kernel_identity(
                generation.pid, "after incomplete current /proc argv sample", allow_zombie=True
            )
        except (FileNotFoundError, ProcessLookupError):
            if generation.check_exit():
                generation.mark_image_incomplete()

                return

            raise CaptureError(
                f"Retained process generation {generation.pid} lost kernel identity during an incomplete argv sample"
            ) from error

        validate_retained_generation(
            after, generation.pid, generation.start_ticks, "after incomplete current /proc argv sample"
        )

        if after["state"] == "Z":
            defer_verified_zombie(generation, after, before, "after incomplete current /proc argv sample")

            return

        if after["ppid"] != before["ppid"]:
            generation.mark_image_incomplete()

            generation.check_exit()

            return

        generation.mark_image_incomplete()

        generation.check_exit()

        return
    except (FileNotFoundError, ProcessLookupError):
        if generation.check_exit():
            return

        generation.mark_image_incomplete()

        raise CaptureError(
            f"Retained process generation {generation.pid} lost /proc identity while its pidfd remained unready"
        )

    validate_retained_generation(
        proc, generation.pid, generation.start_ticks, "complete current /proc image sample"
    )

    try:
        after = read_proc_kernel_identity(
            generation.pid, "after complete current /proc image sample", allow_zombie=True
        )
    except (FileNotFoundError, ProcessLookupError) as error:
        if generation.check_exit():
            return

        raise CaptureError(f"Retained process generation {generation.pid} lost kernel identity after sampling") from error

    validate_retained_generation(
        after, generation.pid, generation.start_ticks, "after complete current /proc image sample"
    )

    if after["state"] == "Z":
        defer_verified_zombie(generation, after, before, "after complete current /proc image sample")

        return

    if proc["ppid"] != before["ppid"] or after["ppid"] != before["ppid"]:
        generation.mark_image_incomplete()

        generation.check_exit()

        return

    if generation.check_exit():
        return

    if 0 <= sample_finished_ns < sample_started_ns:
        generation.mark_image_incomplete()

        generation.check_exit()

        return

    generation.observe(proc, sample_started_ns, sample_finished_ns)

    generation.check_exit()


def traced_files(directory: pathlib.Path, prefix: str) -> dict[int, pathlib.Path]:
    result: dict[int, pathlib.Path] = {}

    for path in directory.glob(prefix + ".*"):
        suffix = path.name.rsplit(".", 1)[-1]

        if not suffix.isdecimal():
            raise CaptureError(f"Unexpected strace output name: {path.name}")

        pid = int(suffix)

        if pid <= 0:
            raise CaptureError(f"Ambiguous strace output PID: {pid}")

        if pid in result:
            if os.fspath(path) == os.fspath(result[pid]):
                continue

            raise CaptureError(f"Ambiguous strace output PID: {pid}")

        result[pid] = path

    return result


def raw_lines(path: pathlib.Path) -> list[bytes]:
    content = path.read_bytes()
    lines = content.splitlines(keepends=True)

    if lines and not lines[-1].endswith(b"\n"):
        lines.pop()

    return lines


def line_ref(path: pathlib.Path, line_number: int, line: bytes) -> dict[str, Any]:
    return {
        "file": path.name,
        "line": line_number,
        "sha256": hashlib.sha256(line.rstrip(b"\r\n")).hexdigest(),
    }


def exec_argv(line: str) -> list[str]:
    start = line.find("execve(")

    if start < 0:
        raise CaptureError("Could not locate the execve argument vector in raw strace output")

    comma = line.find(",", start + len("execve("))

    if comma < 0:
        raise CaptureError("Raw strace execve record has no argument-vector boundary")

    array_start = line.find("[", comma + 1)

    if array_start < 0:
        raise CaptureError("Raw strace execve record has no argument vector")

    depth = 0
    quoted = False
    escaped = False

    for index in range(array_start, len(line)):
        character = line[index]

        if quoted:
            if escaped:
                escaped = False
            elif character == "\\":
                escaped = True
            elif character == '"':
                quoted = False

            continue

        if character == '"':
            quoted = True
        elif character == "[":
            depth += 1
        elif character == "]":
            depth -= 1

            if depth == 0:
                try:
                    value = ast.literal_eval(line[array_start : index + 1])
                except (SyntaxError, ValueError) as error:
                    raise CaptureError("Raw strace execve argv vector is truncated or malformed") from error

                if not isinstance(value, list) or not value or not all(isinstance(item, str) for item in value):
                    raise CaptureError("Raw strace execve argv vector is not a nonempty string array")

                return value

    raise CaptureError("Raw strace execve argv vector is unterminated")


def scan_trace(directory: pathlib.Path, prefix: str, *, final: bool = False) -> dict[str, Any]:
    files = traced_files(directory, prefix)
    creations: dict[int, list[dict[str, Any]]] = {}
    exits: dict[int, dict[str, Any]] = {}
    execs: dict[int, list[dict[str, Any]]] = {}
    execveats: list[dict[str, Any]] = []
    cancelled_syscalls: list[dict[str, Any]] = []
    pending_syscalls: list[dict[str, Any]] = []

    for tid, path in files.items():
        pending: dict[str, Any] | None = None

        for line_number, raw in enumerate(raw_lines(path), start=1):
            line = raw.decode("utf-8", errors="strict").rstrip("\r\n")
            completion_line = line
            reference = line_ref(path, line_number, raw)
            started_reference = None
            interstitial_references: list[dict[str, Any]] = []
            unfinished = re.search(r"^(?:\d+(?:\.\d+)?\s+)?([A-Za-z_][A-Za-z_0-9]*)\(.*<unfinished \.\.\.>$", line)
            resumed = re.search(r"^(?:\d+(?:\.\d+)?\s+)?<\.\.\. ([A-Za-z_][A-Za-z_0-9]*) resumed>(.*)$", line)
            started_reference = None

            if unfinished:
                if unfinished.group(1) == "execveat":
                    raise CaptureError(
                        f"Unsupported pending execveat transition at {path.name}:{line_number}"
                    )

                if pending is not None:
                    raise CaptureError(f"Nested unfinished strace syscall at {path.name}:{line_number}")

                pending = {
                    "name": unfinished.group(1),
                    "prefix": line[: line.index("<unfinished ...>")],
                    "trace": reference,
                    "interstitial": [],
                }
                continue

            if resumed:
                if pending is None or pending["name"] != resumed.group(1):
                    raise CaptureError(f"Orphan or mismatched resumed strace syscall at {path.name}:{line_number}")

                line = pending["prefix"] + resumed.group(2)
                started_reference = pending["trace"]
                interstitial_references = pending["interstitial"]
                pending = None
            elif pending is not None:
                terminal = EXIT_RE.search(line) or SIGNAL_RE.search(line)

                if terminal:
                    cancelled_syscalls.append(
                        {
                            "tid": tid,
                            "unfinishedTrace": pending["trace"],
                            "interstitialTraces": pending["interstitial"],
                            "terminalTrace": reference,
                        }
                    )

                    pending = None
                else:
                    if re.search(r"--- SIG[A-Z0-9]+(?: \(.*\))? ---", line):
                        pending["interstitial"].append(reference)

                        continue

                    raise CaptureError(f"Unpaired unfinished strace syscall at {path.name}:{line_number}")

            reference_bundle = {"completion": reference}

            if started_reference is not None:
                reference_bundle["start"] = started_reference

                if interstitial_references:
                    reference_bundle["interstitial"] = interstitial_references

            spawn = SPAWN_RE.search(line)

            if spawn:
                if "..." in line[spawn.start() : spawn.end()] or spawn.group(1) not in ("clone", "clone3", "fork", "vfork"):
                    raise CaptureError(f"Truncated process-creation trace at {path.name}:{line_number}")

                child = int(spawn.group(2))

                if child <= 0:
                    raise CaptureError(f"Invalid traced child PID at {path.name}:{line_number}")

                call_name = spawn.group(1)
                clone_flags_match = re.search(r"\bflags=([^,})\s]+(?:\|[^,})\s]+)*)", line)
                clone_flags = set(clone_flags_match.group(1).split("|")) if clone_flags_match else set()
                safe_clone_flags = {
                    "CLONE_CHILD_CLEARTID",
                    "CLONE_CHILD_SETTID",
                    "SIGCHLD",
                }
                image_inheritance_safe = call_name == "fork" or (
                    call_name in ("clone", "clone3")
                    and bool(clone_flags)
                    and clone_flags <= safe_clone_flags
                )
                start_ns = trace_time_ns(line)
                completion_ns = trace_time_ns(completion_line)

                if start_ns > completion_ns or (started_reference is not None and start_ns == completion_ns):
                    raise CaptureError(f"Ambiguous process-creation interval at {path.name}:{line_number}")

                creations.setdefault(child, []).append(
                    {
                        "parentTid": tid,
                        "childTid": child,
                        "thread": "CLONE_THREAD" in line,
                        "imageInheritanceSafe": image_inheritance_safe,
                        "line": line,
                        "trace": reference_bundle,
                        "startNs": start_ns,
                        "completionNs": completion_ns,
                    }
                )

            exec_match = EXEC_RE.search(line)

            if exec_match and SUCCESSFUL_EXEC_RE.search(line):
                if "..." in line[exec_match.end() : line.find(")", exec_match.end()) if ")" in line[exec_match.end() :] else len(line)]:
                    raise CaptureError(f"Truncated exec trace at {path.name}:{line_number}")

                start_ns = trace_time_ns(line)
                completion_ns = trace_time_ns(completion_line)

                if start_ns > completion_ns or (started_reference is not None and start_ns == completion_ns):
                    raise CaptureError(f"Ambiguous exec interval at {path.name}:{line_number}")

                execs.setdefault(tid, []).append(
                    {
                        "path": exec_match.group(1),
                        "argv": exec_argv(line),
                        "line": line,
                        "trace": reference_bundle,
                        "startNs": start_ns,
                        "completionNs": completion_ns,
                    }
                )

            if SUCCESSFUL_EXECVEAT_RE.search(line):
                execveats.append(
                    {
                        "tid": tid,
                        "line": line,
                        "trace": reference_bundle,
                        "startNs": trace_time_ns(line),
                        "completionNs": trace_time_ns(completion_line),
                    }
                )

            exit_match = EXIT_RE.search(line)
            signal_match = SIGNAL_RE.search(line)

            if exit_match or signal_match:
                if tid in exits:
                    raise CaptureError(f"More than one terminal strace record for TID {tid}")

                outcome = (
                    {"kind": "exit", "status": int(exit_match.group(1))}
                    if exit_match
                    else {"kind": "signal", "signal": signal_match.group(1)}
                )
                exits[tid] = {"tid": tid, "outcome": outcome, "trace": reference_bundle, "line": line}

        if final and pending is not None:
            raise CaptureError(f"Strace ended with an unpaired unfinished syscall in {path.name}")

        if pending is not None:
            pending_syscalls.append({"tid": tid, "name": pending["name"], "trace": pending["trace"]})

    return {
        "files": files,
        "creations": creations,
        "exits": exits,
        "execs": execs,
        "execveats": execveats,
        "cancelledSyscalls": cancelled_syscalls,
        "pendingSyscalls": pending_syscalls,
    }


def read_tid_groups(generations: dict[int, Generation]) -> dict[int, int]:
    groups: dict[int, int] = {}

    for pid in generations:
        task = pathlib.Path("/proc") / str(pid) / "task"

        try:
            tids = list(task.iterdir())
        except (FileNotFoundError, ProcessLookupError):
            continue

        for path in tids:
            if path.name.isdecimal():
                groups[int(path.name)] = pid

    return groups


def remember_tid_groups(history: dict[int, int], generations: dict[int, Generation]) -> dict[int, int]:
    for tid, tgid in read_tid_groups(generations).items():
        previous = history.get(tid)

        if previous is not None and previous != tgid:
            raise CaptureError(f"Linux TID {tid} was reused across observed thread groups")

        history[tid] = tgid

    return history


def resolve_tgid(tid: int, creations: dict[int, list[dict[str, Any]]], live_groups: dict[int, int]) -> int:
    if tid in live_groups:
        return live_groups[tid]

    edges = creations.get(tid, [])

    if len(edges) > 1:
        raise CaptureError(f"Traced TID {tid} has ambiguous creator records")

    if not edges:
        return tid

    edge = edges[0]

    if not edge["thread"]:
        return tid

    return resolve_tgid(edge["parentTid"], creations, live_groups)


def owner_start(output: pathlib.Path, run_id: str, fingerprint: str, role: str) -> dict[str, Any] | None:
    path = output / f"{role}-start.json"

    if not path.exists():
        return None

    try:
        source = read_json(path)
    except CaptureError:
        return None

    value = require_exact_keys(
        source,
        {
            "format", "version", "runId", "populationFingerprint", "ownerId", "role",
            "pid", "ppid", "execPath", "argv", "startedAt",
        },
        f"{role} start receipt",
    )

    if (
        value["format"] != "hesperia-editor-owner-start"
        or value["version"] != 1
        or value["runId"] != run_id
        or value["populationFingerprint"] != fingerprint
        or value["ownerId"] != f"vscode-{role}-{run_id}"
        or value["role"] != role
        or not isinstance(value["pid"], int)
        or value["pid"] <= 0
        or not isinstance(value["ppid"], int)
        or value["ppid"] <= 0
        or not isinstance(value["execPath"], str)
        or not value["execPath"]
        or not isinstance(value["argv"], list)
        or not value["argv"]
        or not all(isinstance(arg, str) for arg in value["argv"])
        or not valid_timestamp(value["startedAt"])
    ):
        raise CaptureError(f"Malformed current-run {role} process-owned receipt")

    return value


def owner_exit(output: pathlib.Path, start: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any]] | None:
    role = start["role"]
    exit_path = output / f"{role}-exit.json"
    raw_path = output / f"{role}-coverage.json"

    if not exit_path.exists() or not raw_path.exists():
        return None

    try:
        exit_source = read_json(exit_path)
        raw_source = read_json(raw_path)
    except CaptureError:
        return None

    receipt = require_exact_keys(
        exit_source,
        {
            "format", "version", "runId", "populationFingerprint", "ownerId", "role",
            "pid", "ppid", "execPath", "argv", "startedAt", "exitCode", "coverageFile", "exitedAt",
        },
        f"{role} exit receipt",
    )
    raw = require_exact_keys(
        raw_source,
        {
            "format", "version", "runId", "populationFingerprint", "ownerId", "role",
            "pid", "ppid", "argv", "coverage",
        },
        f"{role} raw coverage",
    )

    if (
        receipt["format"] != "hesperia-editor-owner-exit"
        or receipt["version"] != 1
        or any(receipt.get(key) != start[key] for key in (
            "runId", "populationFingerprint", "ownerId", "role", "pid", "ppid", "execPath", "argv", "startedAt"
        ))
        or receipt["exitCode"] != 0
        or receipt["coverageFile"] != f"{role}-coverage.json"
        or not valid_timestamp(receipt["exitedAt"])
        or raw["format"] != "hesperia-editor-owner-coverage"
        or raw["version"] != 1
        or any(raw.get(key) != start[key] for key in (
            "runId", "populationFingerprint", "ownerId", "role", "pid", "ppid", "argv"
        ))
        or not isinstance(raw["coverage"], dict)
    ):
        raise CaptureError(f"Mismatched current-run {role} owner completion receipts")

    return receipt, raw


def find_execution(generation: Generation, predicate: Any, label: str) -> dict[str, Any]:
    matches = [image for image in generation.executions if predicate(image)]

    if len(matches) != 1:
        raise CaptureError(f"Could not bind one {label} executable/argv image to its pidfd generation")

    return matches[0]


def flag_value(argv: list[str], name: str) -> str | None:
    prefix = f"--{name}="

    for index, argument in enumerate(argv):
        if argument.startswith(prefix):
            return argument[len(prefix) :]

        if argument == f"--{name}" and index + 1 < len(argv):
            return argv[index + 1]

    return None


def has_bootstrap_runtime_anchor(argv: list[str]) -> bool:
    return any(
        argument.replace("\\", "/").lower().endswith("/resources/app/out/bootstrap-fork.js")
        for argument in argv
    )


def is_node_service_argv(argv: list[str]) -> bool:
    return (
        flag_value(argv, "type") == "utility"
        and flag_value(argv, "utility-sub-type") == "node.mojom.NodeService"
    )


def has_node_service_proc_history(
    generation: Generation, executable_path: str, transition: dict[str, Any]
) -> bool:
    native_argv = transition["argv"]
    native_title = (
        " ".join([executable_path, *native_argv[1:]])
        if transition["resolvedPath"] == executable_path and is_node_service_argv(native_argv)
        else None
    )

    return any(
        image["executablePath"] == executable_path
        and (
            is_node_service_argv(image["argv"])
            or (native_title is not None and image["argv"] == [native_title])
        )
        and utc_time_ns(image["observedAt"]) > transition["completionNs"]
        for image in generation.executions
    )


def trace_time_ns(line: str) -> int:
    match = TRACE_TIMESTAMP_RE.match(line)

    if not match or (match.group(2) is not None and len(match.group(2)) > 9):
        raise CaptureError("Raw strace transition has no unambiguous epoch timestamp")

    fraction = (match.group(2) or "").ljust(9, "0")
    return int(match.group(1)) * 1_000_000_000 + int(fraction or "0")


def verify_code_elf(path: str) -> str:
    try:
        resolved = str(pathlib.Path(path).resolve(strict=True))
        with open(resolved, "rb") as executable:
            header = executable.read(20)
    except OSError as error:
        raise CaptureError(f"Could not verify the selected Code executable ELF header: {error}") from error

    if (
        resolved != path
        or len(header) < 20
        or header[:4] != b"\x7fELF"
        or header[4] not in (1, 2)
        or header[5] not in (1, 2)
        or header[6] != 1
        or int.from_bytes(header[16:18], "little" if header[5] == 1 else "big") not in (2, 3)
        or int.from_bytes(header[18:20], "little" if header[5] == 1 else "big") == 0
        or not os.access(resolved, os.X_OK)
    ):
        raise CaptureError("Selected Code executable is not a canonical executable ELF image")

    return resolved


def exec_timeline(
    pid: int,
    trace: dict[str, Any],
    tid_groups: dict[int, int],
) -> tuple[list[dict[str, Any]], bool]:
    for item in trace["execveats"]:
        if resolve_tgid(item["tid"], trace["creations"], tid_groups) == pid:
            raise CaptureError(
                f"Unsupported successful execveat transition in PID generation {pid}: {item['line']}"
            )

    events = []

    for tid, items in trace["execs"].items():
        if resolve_tgid(tid, trace["creations"], tid_groups) != pid:
            continue

        for item in items:
            raw_path = item["path"]
            resolved_path = (
                os.path.realpath(raw_path)
                if raw_path != "/proc/self/exe" and os.path.isabs(raw_path)
                else None
            )

            events.append(
                {
                    "tid": tid,
                    "path": raw_path,
                    "resolvedPath": resolved_path,
                    "argv": item["argv"],
                    "trace": item["trace"],
                    "startNs": item["startNs"],
                    "completionNs": item["completionNs"],
                }
            )

    events.sort(key=lambda item: item["startNs"])

    if any(
        left["completionNs"] >= right["startNs"]
        for left, right in zip(events, events[1:])
    ):
        raise CaptureError(f"Overlapping or tied successful exec intervals make PID {pid} image order ambiguous")

    pending_exec = any(
        item["name"] in ("execve", "execveat")
        and resolve_tgid(item["tid"], trace["creations"], tid_groups) == pid
        for item in trace["pendingSyscalls"]
    )
    return events, pending_exec


def code_image_at(
    pid: int,
    before_ns: int,
    trace: dict[str, Any],
    tid_groups: dict[int, int],
    generations: dict[int, Generation],
    code_executable: str,
    visiting: set[tuple[int, int]] | None = None,
    excluded_transition: dict[str, Any] | None = None,
) -> str | None:
    path_key = (pid, before_ns)
    chain = set() if visiting is None else visiting

    if path_key in chain:
        raise CaptureError("Raw process image ancestry contains a cycle")

    chain.add(path_key)

    timeline, pending_exec = exec_timeline(pid, trace, tid_groups)

    if pending_exec:
        chain.remove(path_key)

        return None

    excluded_ref = (
        excluded_transition["trace"]["completion"]
        if excluded_transition is not None
        else None
    )

    def is_excluded(item: dict[str, Any]) -> bool:
        if excluded_ref is None:
            return False

        ref = item["trace"]["completion"]
        return all(ref.get(key) == excluded_ref.get(key) for key in ("file", "line", "sha256"))

    if any(
        not is_excluded(item)
        and item["startNs"] <= before_ns <= item["completionNs"]
        for item in timeline
    ):
        chain.remove(path_key)

        raise CaptureError(f"PID {pid} has an exec interval overlapping its image boundary")

    prior = [
        item
        for item in timeline
        if not is_excluded(item) and item["completionNs"] < before_ns
    ]

    if prior:
        transition = prior[-1]

        if transition["path"] == "/proc/self/exe":
            inherited = code_image_at(
                pid,
                transition["startNs"],
                trace,
                tid_groups,
                generations,
                code_executable,
                chain,
                transition,
            )

            chain.remove(path_key)

            generation = generations.get(pid)

            if (
                inherited == code_executable
                and generation is not None
                and any(image["executablePath"] == code_executable for image in generation.executions)
            ):
                return code_executable

            return None

        if transition["resolvedPath"] == code_executable:
            verify_code_elf(code_executable)

            generation = generations.get(pid)

            if generation is not None and any(
                image["executablePath"] == code_executable
                and transition["completionNs"] < utc_time_ns(image["observedAt"]) < before_ns
                for image in generation.executions
            ):
                chain.remove(path_key)

                return code_executable

        chain.remove(path_key)

        return None

    creator_edges = trace["creations"].get(pid, [])

    if (
        len(creator_edges) != 1
        or creator_edges[0]["thread"]
        or not creator_edges[0]["imageInheritanceSafe"]
    ):
        chain.remove(path_key)

        return None

    creator = creator_edges[0]
    creator_start_ns = creator["startNs"]
    creator_completion_ns = creator["completionNs"]

    if creator_completion_ns >= before_ns:
        chain.remove(path_key)

        raise CaptureError(f"PID {pid} creator interval overlaps its exec boundary")

    parent_pid = resolve_tgid(creator["parentTid"], trace["creations"], tid_groups)
    generation = generations.get(pid)

    if (
        generation is None
        or generation.ppid != parent_pid
        or not any(image["executablePath"] == code_executable for image in generation.executions)
    ):
        chain.remove(path_key)

        return None

    parent_timeline, parent_pending_exec = exec_timeline(parent_pid, trace, tid_groups)

    if parent_pending_exec:
        chain.remove(path_key)

        return None

    if any(
        item["startNs"] <= creator_completion_ns
        and item["completionNs"] >= creator_start_ns
        for item in parent_timeline
    ) or any(item["startNs"] <= before_ns <= item["completionNs"] for item in parent_timeline):
        chain.remove(path_key)

        raise CaptureError(f"PID {pid} image inheritance overlaps a parent exec interval")

    if any(
        creator_completion_ns <= item["startNs"]
        and item["completionNs"] < before_ns
        for item in parent_timeline
    ):
        chain.remove(path_key)

        raise CaptureError(f"PID {pid} image inheritance crosses a parent exec transition")

    inherited = code_image_at(
        parent_pid,
        creator_start_ns,
        trace,
        tid_groups,
        generations,
        code_executable,
        chain,
    )

    chain.remove(path_key)

    if inherited == code_executable:
        return code_executable

    return None


def native_execs_for_generation(
    pid: int,
    trace: dict[str, Any],
    tid_groups: dict[int, int],
    generations: dict[int, Generation],
    code_executable: str,
) -> list[dict[str, Any]]:
    timeline, _ = exec_timeline(pid, trace, tid_groups)
    resolved = []

    for event in timeline:
        resolved_path = event["resolvedPath"]

        if event["path"] == "/proc/self/exe":
            resolved_path = code_image_at(
                pid,
                event["startNs"],
                trace,
                tid_groups,
                generations,
                code_executable,
                excluded_transition=event,
            )

            if resolved_path is None:
                raise CaptureError(
                    f"TID {event['tid']} /proc/self/exe has no ordered retained Code ELF image proof"
                )

        resolved.append({**event, "resolvedPath": resolved_path})

    return resolved


def latest_native_exec(
    pid: int,
    trace: dict[str, Any],
    tid_groups: dict[int, int],
    generations: dict[int, Generation],
    code_executable: str,
) -> dict[str, Any] | None:
    timeline, pending_exec = exec_timeline(pid, trace, tid_groups)

    if pending_exec or not timeline:
        return None

    return native_execs_for_generation(pid, trace, tid_groups, generations, code_executable)[-1]


def raw_trace_tgid(tid: int, trace: dict[str, Any], visiting: set[int] | None = None) -> int:
    chain = set() if visiting is None else visiting

    if tid in chain:
        raise CaptureError("Raw thread-group ancestry contains a cycle")

    chain.add(tid)

    edges = trace["creations"].get(tid, [])

    if len(edges) > 1:
        raise CaptureError(f"Traced TID {tid} has ambiguous raw creator records")

    if not edges or not edges[0]["thread"]:
        return tid

    return raw_trace_tgid(edges[0]["parentTid"], trace, chain)


def raw_trace_tid_birth_ns(tid: int, trace: dict[str, Any]) -> int:
    edges = trace["creations"].get(tid, [])

    if len(edges) > 1:
        raise CaptureError(f"Traced TID {tid} has ambiguous raw creator records")

    if edges:
        return edges[0]["startNs"]

    path = trace["files"].get(tid)

    if path is None:
        raise CaptureError(f"Raw parent TID {tid} has no independently traced lifetime")

    for raw in raw_lines(path):
        line = raw.decode("utf-8", errors="strict").rstrip("\r\n")

        if line:
            return trace_time_ns(line)

    raise CaptureError(f"Raw parent TID {tid} has an empty trace")


def validate_complete_raw_process_tree(trace: dict[str, Any]) -> int:
    cached_root = trace.get("_rawOnlyCreatorTreeRoot")

    if isinstance(cached_root, int):
        return cached_root

    files = trace["files"]

    if trace["pendingSyscalls"] or trace["execveats"]:
        raise CaptureError("Raw-only creator proof has unresolved syscalls or unsupported execveat evidence")

    if set(trace["exits"]) != set(files):
        raise CaptureError("Raw-only creator proof lacks one terminal record for every traced TID")

    if set(trace["creations"]) - set(files):
        raise CaptureError("Raw-only creator proof contains a birth without its traced child file")

    roots = [tid for tid in files if not trace["creations"].get(tid)]

    if len(roots) != 1:
        raise CaptureError("Raw-only creator proof does not have exactly one raw process root")

    root_pid = roots[0]

    for tid, path in files.items():
        edges = trace["creations"].get(tid, [])

        if tid != root_pid and len(edges) != 1:
            raise CaptureError(f"Raw TID {tid} has no unique creation edge")

        if tid == root_pid and edges:
            raise CaptureError(f"Raw root TID {tid} has an unexpected creation edge")

        if edges and edges[0]["parentTid"] not in files:
            raise CaptureError(f"Raw TID {tid} has an untraced creator TID")

        lines = raw_lines(path)

        if not lines:
            raise CaptureError(f"Raw TID {tid} has an empty trace file")

        previous_ns: int | None = None
        terminal_indexes: list[int] = []

        for index, raw in enumerate(lines):
            line = raw.decode("utf-8", errors="strict").rstrip("\r\n")
            current_ns = trace_time_ns(line)

            if previous_ns is not None and current_ns < previous_ns:
                raise CaptureError(f"Raw TID {tid} has nonmonotonic trace timestamps")

            previous_ns = current_ns

            if EXIT_RE.search(line) or SIGNAL_RE.search(line):
                terminal_indexes.append(index)

        if terminal_indexes != [len(lines) - 1]:
            raise CaptureError(f"Raw TID {tid} has records after or multiple terminal trace records")

        terminal_ns = trace_time_ns(lines[-1].decode("utf-8", errors="strict").rstrip("\r\n"))

        if raw_trace_tid_birth_ns(tid, trace) >= terminal_ns:
            raise CaptureError(f"Raw TID {tid} terminal precedes its independently traced birth")

        raw_trace_tgid(tid, trace)

    root_group = raw_trace_tgid(root_pid, trace)

    for tid in files:
        current = raw_trace_tgid(tid, trace)
        seen: set[int] = set()

        while current != root_group:
            if current in seen:
                raise CaptureError("Raw process ancestry contains a cycle")

            seen.add(current)

            edges = trace["creations"].get(current, [])

            if len(edges) != 1 or edges[0]["thread"]:
                raise CaptureError(f"Raw process PID {current} has no unique process parent")

            current = raw_trace_tgid(edges[0]["parentTid"], trace)

    trace["_rawOnlyCreatorTreeRoot"] = root_group
    return root_group


def raw_process_group_closure(
    pid: int,
    trace: dict[str, Any],
    tid_groups: dict[int, int],
) -> tuple[set[int], int]:

    candidates = set(trace["files"]) | set(trace["creations"]) | set(trace["exits"])

    candidates.update(
        edge["parentTid"]
        for edges in trace["creations"].values()
        for edge in edges
    )

    members = {pid}

    for tid in candidates:
        raw_group = raw_trace_tgid(tid, trace)
        observed_group = tid_groups.get(tid)

        if observed_group is not None and observed_group != raw_group:
            raise CaptureError(f"Live TID {tid} conflicts with its independently reconstructed raw group")

        if raw_group == pid:
            members.add(tid)

    exit_tids = {
        tid
        for tid in trace["exits"]
        if raw_trace_tgid(tid, trace) == pid
    }

    if not members or members != exit_tids or any(tid not in trace["files"] for tid in members):
        raise CaptureError(f"Raw process group {pid} has incomplete traced TID closure")

    terminal_ns = max(trace_time_ns(trace["exits"][tid]["line"]) for tid in exit_tids)
    return members, terminal_ns


def raw_process_group_if_complete(
    pid: int,
    trace: dict[str, Any],
    tid_groups: dict[int, int],
) -> tuple[set[int], int] | None:
    candidates = set(trace["files"]) | set(trace["creations"]) | set(trace["exits"])

    candidates.update(
        edge["parentTid"]
        for edges in trace["creations"].values()
        for edge in edges
    )

    members = {pid}

    for tid in candidates:
        if raw_trace_tgid(tid, trace) == pid:
            members.add(tid)

    if any(raw_trace_tgid(item["tid"], trace) == pid for item in trace["pendingSyscalls"]):
        return None

    if any(raw_trace_tgid(item["tid"], trace) == pid for item in trace["execveats"]):
        raise CaptureError(f"Raw process group {pid} contains unsupported execveat evidence")

    if not members <= set(trace["files"]) or not members <= set(trace["exits"]):
        return None

    return raw_process_group_closure(pid, trace, tid_groups)


def traced_parent_sample_ready(pid: int, ppid: int, sample_started_ns: int, trace: dict[str, Any]) -> bool:
    edges = trace["creations"].get(pid, [])

    if len(edges) != 1 or edges[0]["thread"]:
        return True

    creator_pid = raw_trace_tgid(edges[0]["parentTid"], trace)

    if creator_pid == ppid:
        return True

    closure = raw_process_group_if_complete(creator_pid, trace, {})

    # Kernel adoption can precede strace's terminal record; admit a fresh sample after that record.
    return closure is not None and closure[1] < sample_started_ns


def confirm_traced_exit(
    generation: Generation,
    trace: dict[str, Any],
    tid_groups: dict[int, int],
) -> bool:
    """Strace can log closure after pidfd readiness; reobserve the retained handle after closure."""
    closure = raw_process_group_if_complete(generation.pid, trace, tid_groups)

    if closure is None or not pidfd_ready(generation.pidfd):
        return False

    observed_at = utc_now()
    terminal_ns = closure[1]

    if utc_time_ns(observed_at) < terminal_ns:
        raise CaptureError(f"Retained PID {generation.pid} readiness observation precedes its raw terminal")

    if generation.ready_at is None or utc_time_ns(generation.ready_at) < terminal_ns:
        generation.ready_at = observed_at

    return True


def create_raw_creator_fixture(temporary_root: pathlib.Path) -> RawCreatorFixture:
    directory = temporary_root / "raw-creator-fixture"

    directory.mkdir(mode=0o700)

    helper_script = directory / "creator.py"

    helper_script.write_text(
        """import os
import pathlib
import sys
import time

scope = pathlib.Path(sys.argv[1])
timeout = __TIMEOUT__

def wait_for_gate(name):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if (scope / "abort").exists():
            return False
        if (scope / name).exists():
            return True
        time.sleep(0.01)
    return False

def write_marker(name, value):
    temporary = scope / f"{name}-{os.getpid()}.tmp"
    temporary.write_text(value, encoding="ascii")
    temporary.replace(scope / name)

if not wait_for_gate("helper-retained"):
    raise SystemExit(81)

child = os.fork()
if child:
    os._exit(0)

temporary_marker = scope / f"child-pid-{os.getpid()}.tmp"
temporary_marker.write_text(str(os.getpid()), encoding="ascii")
temporary_marker.replace(scope / "child-pid")
if wait_for_gate("child-admitted"):
    write_marker("child-exited", "admitted")
else:
    write_marker("child-exited", "aborted")
os._exit(0)
""".replace("__TIMEOUT__", str(RAW_CREATOR_GATE_TIMEOUT_SECONDS)),
        encoding="utf-8",
    )

    return RawCreatorFixture(directory, helper_script, os.path.realpath(sys.executable))


def create_raw_creator_gate(fixture: RawCreatorFixture, name: str) -> None:
    path = fixture.directory / name

    try:
        with path.open("x", encoding="utf-8"):
            pass
    except FileExistsError as error:
        raise CaptureError(f"Linux raw-creator fixture gate already exists: {name}") from error


def raw_creator_child_edge(
    fixture: RawCreatorFixture,
    trace: dict[str, Any],
) -> tuple[int, dict[str, Any]] | None:
    if fixture.helper_pid is None or not fixture.helper_released:
        return None

    edges = [
        (child_pid, edge)
        for child_pid, child_edges in trace["creations"].items()
        for edge in child_edges
        if edge["parentTid"] == fixture.helper_pid and not edge["thread"]
    ]

    if not edges:
        return None

    if len(edges) != 1:
        raise CaptureError("Linux raw-creator fixture did not produce exactly one helper child")

    child_pid, edge = edges[0]

    if not raw_process_creation_is_supported(edge):
        raise CaptureError("Linux raw-creator fixture child has unsupported creation flags")

    child_pid_path = fixture.directory / "child-pid"

    if not child_pid_path.exists():
        return None

    try:
        reported_pid = int(child_pid_path.read_text(encoding="ascii"))
    except (OSError, ValueError) as error:
        raise CaptureError("Linux raw-creator fixture child identity marker is malformed") from error

    if reported_pid != child_pid:
        raise CaptureError("Linux raw-creator fixture child marker disagrees with its raw clone event")

    if fixture.child_pid is not None and fixture.child_pid != child_pid:
        raise CaptureError("Linux raw-creator fixture child PID changed after binding")

    fixture.child_pid = child_pid

    if fixture.child_pidfd is None:
        before = read_proc_kernel_identity(child_pid, "raw-creator child fixture binding")

        if before["ppid"] <= 0 or before["ppid"] == child_pid or before["startTicks"] <= 0:
            raise CaptureError("Linux raw-creator child has an invalid parent at fixture binding")

        proc_before = parse_proc(child_pid, "raw-creator child fixture argv binding")

        if (
            proc_before["pid"] != child_pid
            or proc_before["tgid"] != child_pid
            or proc_before["startTicks"] != before["startTicks"]
            or proc_before["ppid"] <= 0
            or proc_before["ppid"] == child_pid
            or os.path.realpath(proc_before["executablePath"]) != fixture.python_executable
            or proc_before["argv"] != [fixture.python_executable, str(fixture.helper_script), str(fixture.directory)]
        ):
            raise CaptureError("Linux raw-creator child did not match the current fixture script identity")

        try:
            child_pidfd = os.pidfd_open(child_pid, 0)
        except OSError as error:
            raise CaptureError(f"Could not retain a cleanup pidfd for raw-creator fixture child {child_pid}") from error

        try:
            attached_at = utc_now()
            after = read_proc_kernel_identity(child_pid, "raw-creator child fixture pidfd binding")

            validate_retained_generation(
                after, child_pid, before["startTicks"], "raw-creator child fixture pidfd binding"
            )

            if (
                edge["completionNs"] >= utc_time_ns(attached_at)
                or after["ppid"] <= 0
                or after["ppid"] == child_pid
                or pidfd_ready(child_pidfd)
            ):
                raise CaptureError("Linux raw-creator child changed before its scoped cleanup pidfd was bound")

            proc_after = parse_proc(child_pid, "raw-creator child fixture argv recheck")

            if (
                proc_after["startTicks"] != before["startTicks"]
                or proc_after["ppid"] <= 0
                or proc_after["ppid"] == child_pid
                or os.path.realpath(proc_after["executablePath"]) != fixture.python_executable
                or proc_after["argv"] != proc_before["argv"]
            ):
                raise CaptureError("Linux raw-creator child fixture identity changed during pidfd binding")

            fixture.child_pid = child_pid
            fixture.child_pidfd = child_pidfd
            fixture.child_start_ticks = int(before["startTicks"])
            fixture.child_attached_at = attached_at
        except BaseException:
            os.close(child_pidfd)

            raise

    return child_pid, edge


def observe_raw_creator_helper(
    fixture: RawCreatorFixture,
    generation: Generation,
    trace: dict[str, Any],
    generations: dict[int, Generation],
    output: pathlib.Path,
    run_id: str,
    population_fingerprint: str,
    gui_pid: int | None,
) -> None:
    if fixture.helper_released:
        return

    proc = generation.current_proc

    if (
        proc is None
        or os.path.realpath(proc["executablePath"]) != fixture.python_executable
        or proc["argv"] != [fixture.python_executable, str(fixture.helper_script), str(fixture.directory)]
    ):
        return

    if fixture.helper_pid is not None:
        if fixture.helper_pid != generation.pid:
            raise CaptureError("Linux raw-creator fixture started more than one helper generation")

        return

    host = owner_start(
        output,
        run_id,
        population_fingerprint,
        "extension-host",
    )

    if host is None or generations.get(host["pid"]) is None or gui_pid is None:
        return

    host_generation = generations[host["pid"]]
    creator_edges = trace["creations"].get(generation.pid, [])

    if not creator_edges:
        return

    if (
        len(creator_edges) != 1
        or creator_edges[0]["thread"]
        or not raw_process_creation_is_supported(creator_edges[0])
        or resolve_tgid(creator_edges[0]["parentTid"], trace["creations"], {}) != host_generation.pid
        or not generation.current_image_complete
        or not generation.parents
        or generation.parents[0]["pid"] != host_generation.pid
        or utc_time_ns(generation.attached_at) <= creator_edges[0]["completionNs"]
        or generation.check_exit()
        or host_generation.check_exit()
    ):
        raise CaptureError("Linux raw-creator helper is not a live child of the retained Extension Host")

    require_traced_ancestor(host_generation.pid, gui_pid, trace, {})

    if generation.sample_started_ns is None or generation.sample_finished_ns is None:
        raise CaptureError("Linux raw-creator helper has no complete retained first image sample")

    fixture.helper_pid = generation.pid
    fixture.helper_start_ticks = generation.start_ticks
    fixture.helper_sample_started_ns = generation.sample_started_ns
    fixture.helper_sample_finished_ns = generation.sample_finished_ns
    fixture.helper_first_parent_pid = generation.parents[0]["pid"]
    fixture.helper_attached_at = generation.attached_at

    create_raw_creator_gate(fixture, "helper-retained")

    fixture.helper_released = True


def raw_creator_child_adoption(
    fixture: RawCreatorFixture,
    helper_generation: Generation,
    child_pid: int,
    trace: dict[str, Any],
    tid_groups: dict[int, int],
) -> tuple[dict[str, int | str], int] | None:
    if fixture.child_pidfd is None or fixture.child_pid != child_pid:
        raise CaptureError("Linux raw-creator fixture child has no scoped cleanup pidfd")

    if (
        helper_generation.pid != fixture.helper_pid
        or helper_generation.start_ticks != fixture.helper_start_ticks
        or helper_generation.attached_at != fixture.helper_attached_at
        or not helper_generation.parents
        or helper_generation.parents[0]["pid"] != fixture.helper_first_parent_pid
        or not helper_generation.check_exit()
    ):
        return None

    creator_edge = trace["creations"].get(child_pid, [])

    if len(creator_edge) != 1 or creator_edge[0]["thread"] or creator_edge[0]["parentTid"] != fixture.helper_pid:
        raise CaptureError("Linux raw-creator fixture child lost its unique helper creation edge")

    helper_closure = raw_process_group_if_complete(fixture.helper_pid, trace, tid_groups)

    if helper_closure is None:
        return None

    _, helper_terminal_ns = helper_closure

    if not confirm_traced_exit(helper_generation, trace, tid_groups):
        return None

    helper_exit = trace["exits"].get(fixture.helper_pid)

    if helper_exit is None or helper_exit["outcome"] != {"kind": "exit", "status": 0}:
        raise CaptureError("Linux raw-creator helper did not have its expected successful raw terminal")

    helper_birth_ns = raw_trace_tid_birth_ns(fixture.helper_pid, trace)
    child_birth = creator_edge[0]

    if (
        fixture.helper_sample_started_ns is None
        or fixture.helper_sample_finished_ns is None
        or fixture.helper_sample_started_ns > fixture.helper_sample_finished_ns
        or fixture.helper_sample_finished_ns >= child_birth["startNs"]
        or child_birth["startNs"] > child_birth["completionNs"]
        or fixture.child_attached_at is None
        or utc_time_ns(fixture.child_attached_at) <= child_birth["completionNs"]
        or child_birth["completionNs"] >= helper_terminal_ns
        or helper_generation.ready_at is None
        or utc_time_ns(helper_generation.ready_at) < helper_terminal_ns
        or helper_birth_ns >= helper_terminal_ns
    ):
        raise CaptureError("Linux raw-creator helper was not retained before its child birth and terminal closure")

    if pidfd_ready(fixture.child_pidfd):
        raise CaptureError("Linux raw-creator fixture child exited before its post-adoption sample")

    try:
        before = read_proc_kernel_identity(child_pid, "raw-creator child after helper group closure")
        after = read_proc_kernel_identity(child_pid, "raw-creator child after adoption identity recheck")
    except (FileNotFoundError, ProcessLookupError):
        if pidfd_ready(fixture.child_pidfd):
            raise CaptureError("Linux raw-creator fixture child exited before its post-adoption sample")

        return None

    validate_retained_generation(after, child_pid, before["startTicks"], "raw-creator child adoption recheck")

    if before["startTicks"] != fixture.child_start_ticks:
        raise CaptureError("Linux raw-creator child starttime changed after scoped pidfd binding")

    if before["ppid"] != after["ppid"] or before["ppid"] == fixture.helper_pid or after["ppid"] <= 0:
        return None

    if pidfd_ready(fixture.child_pidfd):
        raise CaptureError("Linux raw-creator fixture child exited during its post-adoption identity check")

    fixture.adopted_ppid = int(after["ppid"])
    return after, helper_terminal_ns


def raw_creator_script_process(fixture: RawCreatorFixture, pid: int) -> bool:
    if fixture.helper_pid is None or pid == fixture.helper_pid:
        return False

    try:
        proc = parse_proc(pid, "raw-creator fixture admission deferral")
    except (FileNotFoundError, ProcessLookupError, IncompleteProcArgv, IncompleteProcExecutable):
        return False

    return (
        os.path.realpath(proc["executablePath"]) == fixture.python_executable
        and proc["argv"] == [fixture.python_executable, str(fixture.helper_script), str(fixture.directory)]
    )


def raw_creator_pending_child_pid(
    fixture: RawCreatorFixture,
    pid: int,
    trace: dict[str, Any],
    allow_script_probe: bool,
) -> bool:
    if fixture.helper_pid is None or fixture.child_released:
        return False

    edges = [
        child_pid
        for child_pid, child_edges in trace["creations"].items()
        for edge in child_edges
        if edge["parentTid"] == fixture.helper_pid and not edge["thread"]
    ]

    if len(set(edges)) > 1:
        raise CaptureError("Linux raw-creator fixture produced more than one process child")

    if edges:
        return pid == edges[0]

    marker = fixture.directory / "child-pid"

    if marker.is_file():
        try:
            return pid == int(marker.read_text(encoding="ascii"))
        except (OSError, ValueError) as error:
            raise CaptureError("Linux raw-creator fixture child identity marker is malformed") from error

    return allow_script_probe and raw_creator_script_process(fixture, pid)


def cleanup_raw_creator_child(
    fixture: RawCreatorFixture | None,
    forced_pids: list[int],
    cleanup_errors: list[dict[str, Any]],
    trace_directory: pathlib.Path,
    prefix: str,
    tid_groups: dict[int, int],
) -> None:
    if fixture is None:
        return

    if fixture.child_pid is None:
        child_pid_path = fixture.directory / "child-pid"

        if not child_pid_path.is_file() and fixture.helper_released:
            deadline = time.monotonic() + 5

            while time.monotonic() < deadline and not child_pid_path.is_file():
                time.sleep(PROCESS_POLL_SECONDS)

        if not child_pid_path.is_file():
            if fixture.helper_released:
                cleanup_errors.append(
                    {
                        "pid": fixture.helper_pid,
                        "error": "Raw-creator helper was released but did not publish its scoped child identity",
                    }
                )

            return

        try:
            fixture.child_pid = int(child_pid_path.read_text(encoding="ascii"))
        except (OSError, ValueError) as cleanup_error:
            cleanup_errors.append(
                {
                    "pid": fixture.helper_pid,
                    "error": f"Raw-creator child cleanup marker was malformed: {cleanup_error}",
                }
            )

            return

    if fixture.child_pidfd is None:
        deadline = time.monotonic() + 5
        exit_marker = fixture.directory / "child-exited"

        while time.monotonic() < deadline:
            try:
                trace = scan_trace(trace_directory, prefix)
                edges = trace["creations"].get(fixture.child_pid, [])
                closure = raw_process_group_if_complete(fixture.child_pid, trace, tid_groups)
                terminal = trace["exits"].get(fixture.child_pid)

                if (
                    exit_marker.is_file()
                    and exit_marker.read_text(encoding="ascii") == "aborted"
                    and len(edges) == 1
                    and not edges[0]["thread"]
                    and edges[0]["parentTid"] == fixture.helper_pid
                    and raw_process_creation_is_supported(edges[0])
                    and closure is not None
                    and closure[0] == {fixture.child_pid}
                    and terminal is not None
                    and terminal["outcome"] == {"kind": "exit", "status": 0}
                ):
                    return
            except BaseException as cleanup_error:
                cleanup_errors.append(
                    {
                        "pid": fixture.child_pid,
                        "error": f"Could not prove raw-creator child exit after abort: {cleanup_error}",
                    }
                )

                return

            time.sleep(PROCESS_POLL_SECONDS)

        cleanup_errors.append(
            {
                "pid": fixture.child_pid,
                "error": "Unadmitted raw-creator child did not reach a complete raw terminal after its abort gate was released",
            }
        )

        return

    try:
        if not pidfd_ready(fixture.child_pidfd):
            identity = read_proc_kernel_identity(
                fixture.child_pid, "before scoped raw-creator child failure cleanup"
            )

            validate_retained_generation(
                identity,
                fixture.child_pid,
                int(fixture.child_start_ticks or 0),
                "before scoped raw-creator child failure cleanup",
            )

            proc = parse_proc(fixture.child_pid, "before scoped raw-creator child failure cleanup")

            if (
                os.path.realpath(proc["executablePath"]) != fixture.python_executable
                or proc["argv"] != [fixture.python_executable, str(fixture.helper_script), str(fixture.directory)]
            ):
                raise CaptureError("Scoped raw-creator child argv changed before pidfd cleanup")

            if pidfd_ready(fixture.child_pidfd):
                return

            signal.pidfd_send_signal(fixture.child_pidfd, signal.SIGKILL)

            forced_pids.append(fixture.child_pid)

            deadline = time.monotonic() + 5

            while time.monotonic() < deadline and not pidfd_ready(fixture.child_pidfd):
                time.sleep(PROCESS_POLL_SECONDS)

            if not pidfd_ready(fixture.child_pidfd):
                cleanup_errors.append(
                    {
                        "pid": fixture.child_pid,
                        "procStarttimeTicks": fixture.child_start_ticks,
                        "error": "Scoped raw-creator child pidfd was not ready after SIGKILL cleanup",
                    }
                )
    except BaseException as cleanup_error:
        cleanup_errors.append(
            {
                "pid": fixture.child_pid,
                "procStarttimeTicks": fixture.child_start_ticks,
                "error": f"Scoped raw-creator child pidfd cleanup failed: {cleanup_error}",
            }
        )


def complete_raw_creator_fixture(
    fixture: RawCreatorFixture,
    generations: dict[int, Generation],
    trace: dict[str, Any],
    tid_groups: dict[int, int],
) -> None:
    if fixture.completed or not fixture.child_released or fixture.child_pid is None:
        return

    child_generation = generations.get(fixture.child_pid)

    if child_generation is None or not child_generation.check_exit():
        return

    closure = raw_process_group_if_complete(fixture.child_pid, trace, tid_groups)

    if closure is None:
        return

    members, terminal_ns = closure

    if not confirm_traced_exit(child_generation, trace, tid_groups):
        return

    terminal = trace["exits"].get(fixture.child_pid)
    child_births = trace["creations"].get(fixture.child_pid, [])

    if (
        members != {fixture.child_pid}
        or terminal is None
        or terminal["outcome"] != {"kind": "exit", "status": 0}
        or len(child_births) != 1
        or fixture.helper_terminal_ns is None
        or child_generation.start_ticks != fixture.child_start_ticks
        or not child_generation.parents
        or child_generation.parents[0]["pid"] != fixture.adopted_ppid
        or utc_time_ns(child_generation.attached_at) <= child_births[0]["completionNs"]
        or utc_time_ns(child_generation.attached_at) >= terminal_ns
        or fixture.child_attached_at is None
        or utc_time_ns(fixture.child_attached_at) >= terminal_ns
        or utc_time_ns(child_generation.parents[0]["observedAt"]) <= fixture.helper_terminal_ns
        or utc_time_ns(child_generation.parents[0]["observedAt"]) >= terminal_ns
        or child_births[0]["completionNs"] >= fixture.helper_terminal_ns
        or child_generation.ready_at is None
        or utc_time_ns(child_generation.ready_at) < terminal_ns
        or not (fixture.directory / "child-exited").is_file()
        or (fixture.directory / "child-exited").read_text(encoding="ascii") != "admitted"
    ):
        raise CaptureError("Linux raw-creator fixture child did not complete its adopted native-generation evidence")

    create_raw_creator_gate(fixture, "complete")

    fixture.completed = True


def release_raw_creator_child(
    fixture: RawCreatorFixture,
    generation: Generation,
    trace: dict[str, Any],
) -> None:
    if fixture.child_released or generation.pid != fixture.child_pid:
        return

    creator_edges = trace["creations"].get(generation.pid, [])

    if (
        len(creator_edges) != 1
        or creator_edges[0]["thread"]
        or creator_edges[0]["parentTid"] != fixture.helper_pid
        or fixture.helper_terminal_ns is None
        or fixture.adopted_ppid is None
        or fixture.child_start_ticks is None
        or generation.start_ticks != fixture.child_start_ticks
        or generation.ppid != fixture.adopted_ppid
        or not generation.parents
        or generation.parents[0]["pid"] != fixture.adopted_ppid
        or generation.sample_started_ns is None
        or generation.sample_finished_ns is None
        or generation.sample_started_ns > generation.sample_finished_ns
        or utc_time_ns(generation.attached_at) <= creator_edges[0]["completionNs"]
        or creator_edges[0]["completionNs"] >= fixture.helper_terminal_ns
        or utc_time_ns(generation.parents[0]["observedAt"]) <= fixture.helper_terminal_ns
        or pidfd_ready(generation.pidfd)
    ):
        raise CaptureError("Linux raw-creator fixture child was admitted outside its verified adopted generation")

    create_raw_creator_gate(fixture, "child-admitted")

    fixture.child_released = True


def release_raw_creator_abort(fixture: RawCreatorFixture | None) -> None:
    if fixture is None:
        return

    path = fixture.directory / "abort"

    if not path.exists():
        try:
            path.touch(exist_ok=False)
        except FileExistsError:
            pass


def raw_process_creation_is_supported(edge: dict[str, Any]) -> bool:
    spawn = SPAWN_RE.search(edge["line"])

    if not spawn or re.search(r"(?<![A-Z0-9_])(?:CLONE_PARENT|CLONE_NEWPID)(?![A-Z0-9_])", edge["line"]):
        return False

    call = spawn.group(1)

    if call in ("fork", "vfork"):
        return True

    if call not in ("clone", "clone3"):
        return False

    flags_match = re.search(r"\bflags=([^,})\s]+(?:\|[^,})\s]+)*)", edge["line"])

    if flags_match is None:
        return False

    flags = set(flags_match.group(1).split("|"))
    return bool(flags) and flags <= {
        "CLONE_CHILD_CLEARTID",
        "CLONE_CHILD_SETTID",
        "CLONE_CLEAR_SIGHAND",
        "CLONE_VM",
        "CLONE_VFORK",
        "SIGCHLD",
    }


def validate_raw_only_creator_proof(
    generation: Generation,
    creator_edge: dict[str, Any],
    raw_creator_pid: int,
    trace: dict[str, Any],
    tid_groups: dict[int, int],
    raw_files: dict[int, dict[str, Any]],
    generations: dict[int, Generation],
    code_executable: str,
    code_gui_pid: int | None,
) -> None:
    validate_complete_raw_process_tree(trace)

    if code_gui_pid is None or code_gui_pid <= 0:
        raise CaptureError("Raw-only reparent proof has no retained Code GUI generation")

    code_gui = generations.get(code_gui_pid)

    if code_gui is None or code_gui.pid != code_gui_pid or code_gui.start_ticks <= 0:
        raise CaptureError("Raw-only reparent proof has no retained Code GUI generation")

    if raw_creator_pid in generations:
        raise CaptureError(f"Raw-only creator fallback was selected for retained PID {raw_creator_pid}")

    group_cache: dict[int, tuple[set[int], int]] = {}

    def group(pid: int) -> tuple[set[int], int]:
        cached = group_cache.get(pid)

        if cached is None:
            cached = raw_process_group_closure(pid, trace, tid_groups)

            if any(tid not in raw_files for tid in cached[0]):
                raise CaptureError(f"Raw process group {pid} has an unmanifested TID trace")

            group_cache[pid] = cached

        return cached

    def retained_lifetime(pid: int, birth_ns: int, terminal_ns: int) -> None:
        retained = generations.get(pid)

        if retained is None:
            return

        if retained.pid != pid or retained.start_ticks <= 0 or retained.ready_at is None or not retained.parents:
            raise CaptureError(f"Retained raw ancestor {pid} has no complete pidfd generation proof")

        attached_ns = utc_time_ns(retained.attached_at)
        sampled_ns = utc_time_ns(retained.parents[0]["observedAt"])
        ready_ns = utc_time_ns(retained.ready_at)

        if birth_ns >= attached_ns or attached_ns > sampled_ns or sampled_ns >= terminal_ns or ready_ns < terminal_ns:
            raise CaptureError(f"Retained raw ancestor {pid} is not bound to its unique raw lifetime")

    child_first_parent = generation.parents[0] if generation.parents else None

    if child_first_parent is None or child_first_parent["pid"] != generation.ppid:
        raise CaptureError(f"Raw-only child {generation.pid} has no original retained parent sample")

    child_sample_ns = utc_time_ns(child_first_parent["observedAt"])
    child_attached_ns = utc_time_ns(generation.attached_at)
    child_ready_ns = utc_time_ns(generation.ready_at or "")
    child_members, child_terminal_ns = group(generation.pid)

    if (
        generation.pid not in child_members
        or creator_edge["startNs"] >= child_attached_ns
        or child_attached_ns > child_sample_ns
        or child_sample_ns >= child_terminal_ns
        or child_ready_ns < child_terminal_ns
        or child_first_parent["pid"] == raw_creator_pid
    ):
        raise CaptureError(f"Raw-only child {generation.pid} pidfd and parent sample do not bind its raw lifetime")

    if not raw_process_creation_is_supported(creator_edge):
        raise CaptureError(f"Raw-only child {generation.pid} has unsupported raw creator flags")

    creator_births = trace["creations"].get(raw_creator_pid, [])

    if (
        len(creator_births) != 1
        or creator_births[0]["thread"]
        or not raw_process_creation_is_supported(creator_births[0])
        or raw_trace_tgid(creator_edge["parentTid"], trace) != raw_creator_pid
        or creator_births[0]["startNs"] >= creator_edge["startNs"]
    ):
        raise CaptureError(f"Raw-only creator {raw_creator_pid} has no unique lifetime containing its child birth")

    creator_members, creator_terminal_ns = group(raw_creator_pid)
    creator_parent_tid = creator_edge["parentTid"]
    creator_parent_terminal = trace["exits"].get(creator_parent_tid)

    if (
        creator_parent_tid not in creator_members
        or raw_trace_tid_birth_ns(creator_parent_tid, trace) >= creator_edge["startNs"]
        or creator_parent_terminal is None
        or creator_edge["completionNs"] >= trace_time_ns(creator_parent_terminal["line"])
        or creator_edge["completionNs"] >= creator_terminal_ns
        or creator_terminal_ns >= child_sample_ns
    ):
        raise CaptureError(f"Raw-only creator {raw_creator_pid} did not exit completely before child {generation.pid} was sampled")

    process_groups = {
        resolve_tgid(tid, trace["creations"], tid_groups)
        for tid in trace["files"]
    }
    terminal_by_group: dict[int, int] = {}

    for pid in process_groups:
        terminal_by_group[pid] = group(pid)[1]

    sampled_parent_pid = int(child_first_parent["pid"])
    sampled_parent_terminal_ns = terminal_by_group.get(sampled_parent_pid)

    if sampled_parent_terminal_ns is not None and sampled_parent_terminal_ns <= child_sample_ns:
        raise CaptureError(f"Raw-only child {generation.pid} parent sample aliases an exited raw process")

    current = raw_creator_pid
    seen: set[int] = set()

    while current != code_gui_pid:
        if current in seen:
            raise CaptureError("Raw-only creator ancestry contains a cycle")

        seen.add(current)

        edges = trace["creations"].get(current, [])

        if len(edges) != 1 or edges[0]["thread"]:
            raise CaptureError(f"Raw-only creator PID {current} has an ambiguous process birth")

        birth = edges[0]

        if not raw_process_creation_is_supported(birth):
            raise CaptureError(f"Raw-only creator PID {current} has unsupported raw creation flags")

        _, terminal_ns = group(current)

        if birth["startNs"] >= terminal_ns:
            raise CaptureError(f"Raw-only creator PID {current} has an invalid raw lifetime")

        parent_pid = raw_trace_tgid(birth["parentTid"], trace)

        if parent_pid == current:
            raise CaptureError("Raw-only creator ancestry contains a cycle")

        _, parent_terminal_ns = group(parent_pid)
        parent_tid_terminal = trace["exits"].get(birth["parentTid"])

        if (
            raw_trace_tid_birth_ns(birth["parentTid"], trace) >= birth["startNs"]
            or
            parent_tid_terminal is None
            or birth["completionNs"] >= trace_time_ns(parent_tid_terminal["line"])
            or birth["completionNs"] >= parent_terminal_ns
        ):
            raise CaptureError(f"Raw-only creator PID {current} is not joined to its traced parent lifetime")

        timeline, pending_exec = exec_timeline(current, trace, {})

        if pending_exec or any(
            item["startNs"] < birth["startNs"] or item["completionNs"] >= terminal_ns
            for item in timeline
        ):
            raise CaptureError(f"Raw-only creator PID {current} has an unresolved or unjoined exec transition")

        retained_lifetime(current, birth["startNs"], terminal_ns)

        current = parent_pid

    gui_edges = trace["creations"].get(code_gui_pid, [])

    if len(gui_edges) != 1 or gui_edges[0]["thread"]:
        raise CaptureError("Retained Code GUI has no unique raw process birth")

    _, gui_terminal_ns = group(code_gui_pid)
    gui_birth_ns = gui_edges[0]["startNs"]

    if code_gui.ready_at is None or not code_gui.parents:
        raise CaptureError("Retained Code GUI generation has no complete parent sample or pidfd readiness")

    gui_attach_ns = utc_time_ns(code_gui.attached_at)
    gui_sample_ns = utc_time_ns(code_gui.parents[0]["observedAt"])
    gui_ready_ns = utc_time_ns(code_gui.ready_at)

    if (
        gui_birth_ns >= gui_attach_ns
        or gui_attach_ns > gui_sample_ns
        or gui_sample_ns >= gui_terminal_ns
        or gui_ready_ns < gui_terminal_ns
        or not any(image["executablePath"] == code_executable for image in code_gui.executions)
    ):
        raise CaptureError("Retained Code GUI generation is not bound to its unique raw lifetime")


def process_event(
    generation: Generation,
    trace: dict[str, Any],
    tid_groups: dict[int, int],
    raw_files: dict[int, dict[str, Any]],
    generations: dict[int, Generation],
    code_executable: str,
    code_gui_pid: int | None,
) -> dict[str, Any]:
    tgid = resolve_tgid(generation.pid, trace["creations"], tid_groups)

    if tgid != generation.pid:
        raise CaptureError(f"Refusing to treat a traced thread as process leader: {generation.pid}")

    exits = [
        item
        for tid, item in trace["exits"].items()
        if resolve_tgid(tid, trace["creations"], tid_groups) == generation.pid
    ]
    leader = [item for item in exits if item["tid"] == generation.pid]

    if len(leader) != 1 or generation.ready_at is None:
        raise CaptureError(f"Missing leader exit or retained pidfd readiness for PID generation {generation.pid}")

    members = {generation.pid} | {tid for tid, group in tid_groups.items() if group == generation.pid}

    for tid in trace["creations"]:
        if resolve_tgid(tid, trace["creations"], tid_groups) == generation.pid:
            members.add(tid)

    missing = members - set(trace["exits"])

    if missing:
        raise CaptureError(f"Missing independently traced TID exits for PID generation {generation.pid}: {sorted(missing)}")

    creator_edges = trace["creations"].get(generation.pid, [])
    creator: dict[str, Any] | None = None

    if creator_edges:
        if len(creator_edges) != 1 or creator_edges[0]["thread"]:
            raise CaptureError(f"Process leader {generation.pid} has an ambiguous or thread-only creator")

        parent_tid = creator_edges[0]["parentTid"]
        parent_tgid = resolve_tgid(parent_tid, trace["creations"], tid_groups)
        child_first_parent = generation.parents[0] if generation.parents else None

        if parent_tgid != generation.ppid:
            creator_edge = creator_edges[0]
            parent_generation = generations.get(parent_tgid)

            if parent_generation is None:
                validate_raw_only_creator_proof(
                    generation,
                    creator_edges[0],
                    parent_tgid,
                    trace,
                    tid_groups,
                    raw_files,
                    generations,
                    code_executable,
                    code_gui_pid,
                )
            else:
                parent_first_parent = (
                    parent_generation.parents[0]
                    if parent_generation is not None and parent_generation.parents
                    else None
                )
                candidate_tids = (
                    set(tid_groups)
                    | set(trace["files"])
                    | set(trace["exits"])
                    | set(trace["creations"])
                )

                candidate_tids.update(
                    edge["parentTid"]
                    for edges in trace["creations"].values()
                    for edge in edges
                )

                parent_members = {parent_tgid}

                parent_members.update(
                    tid
                    for tid in candidate_tids
                    if resolve_tgid(tid, trace["creations"], tid_groups) == parent_tgid
                )

                parent_exit_tids = {
                    tid
                    for tid in trace["exits"]
                    if resolve_tgid(tid, trace["creations"], tid_groups) == parent_tgid
                }

                if (
                    parent_generation is None
                    or parent_generation.pid != parent_tgid
                    or parent_generation.start_ticks <= 0
                    or parent_generation.ready_at is None
                    or parent_first_parent is None
                    or child_first_parent is None
                    or parent_members != parent_exit_tids
                    or any(tid not in trace["files"] for tid in parent_members)
                ):
                    raise CaptureError(f"Cannot prove complete retained creator-group closure for PID {generation.pid}")

                parent_group_exit_ns = max(
                    trace_time_ns(trace["exits"][tid]["line"])
                    for tid in parent_exit_tids
                )
                parent_first_sample_ns = utc_time_ns(parent_first_parent["observedAt"])
                parent_births = trace["creations"].get(parent_tgid, [])
                child_first_sample_ns = utc_time_ns(child_first_parent["observedAt"])

                if (
                    child_first_parent["pid"] != generation.ppid
                    or utc_time_ns(parent_generation.attached_at) > parent_first_sample_ns
                    or len(parent_births) != 1
                    or parent_births[0]["thread"]
                    or parent_births[0]["startNs"] >= utc_time_ns(parent_generation.attached_at)
                    or parent_first_sample_ns >= parent_group_exit_ns
                    or creator_edge["completionNs"] >= parent_group_exit_ns
                    or parent_group_exit_ns >= child_first_sample_ns
                    or utc_time_ns(parent_generation.ready_at) < parent_group_exit_ns
                    or re.search(r"(?<![A-Z0-9_])CLONE_PARENT(?![A-Z0-9_])", creator_edge["line"])
                ):
                    detail = f"Raw creator group does not prove reparenting before the first retained /proc parent sample for PID {generation.pid}"

                    try:
                        parent_attached_ns = utc_time_ns(parent_generation.attached_at)
                        parent_ready_ns = utc_time_ns(parent_generation.ready_at)
                        clone_parent = bool(re.search(r"(?<![A-Z0-9_])CLONE_PARENT(?![A-Z0-9_])", creator_edge["line"]))
                        flags_match = re.search(r"\bflags=([^,}\s)]+)", creator_edge["line"])
                        detail += "; reparentingDiagnostic=" + json.dumps(
                            {
                                "operands": {
                                    "childFirstParentMismatch": {"left": child_first_parent["pid"], "right": generation.ppid, "failed": child_first_parent["pid"] != generation.ppid},
                                    "parentAttachedAfterFirstSample": {"left": parent_attached_ns, "right": parent_first_sample_ns, "failed": parent_attached_ns > parent_first_sample_ns},
                                    "parentBirthNotBeforeAttachment": {"left": parent_births[0]["startNs"] if len(parent_births) == 1 else None, "right": parent_attached_ns, "failed": len(parent_births) != 1 or parent_births[0]["thread"] or parent_births[0]["startNs"] >= parent_attached_ns},
                                    "parentFirstSampleAtOrAfterGroupExit": {"left": parent_first_sample_ns, "right": parent_group_exit_ns, "failed": parent_first_sample_ns >= parent_group_exit_ns},
                                    "creationCompletedAtOrAfterParentExit": {"left": creator_edge["completionNs"], "right": parent_group_exit_ns, "failed": creator_edge["completionNs"] >= parent_group_exit_ns},
                                    "parentExitAtOrAfterChildFirstSample": {"left": parent_group_exit_ns, "right": child_first_sample_ns, "failed": parent_group_exit_ns >= child_first_sample_ns},
                                    "parentReadyBeforeGroupExit": {"left": parent_ready_ns, "right": parent_group_exit_ns, "failed": parent_ready_ns < parent_group_exit_ns},
                                    "cloneParentFlag": {"value": clone_parent, "failed": clone_parent},
                                },
                                "child": {
                                    "pid": generation.pid,
                                    "initialPpid": generation.ppid,
                                    "procStarttimeTicks": generation.start_ticks,
                                    "pidfdAttachedAt": generation.attached_at,
                                    "pidfdReadyAt": generation.ready_at,
                                    "firstParentSample": child_first_parent,
                                    "firstParentSampleStartedNs": child_first_sample_ns,
                                    "latestRetainedSampleStartedNs": generation.sample_started_ns,
                                    "latestRetainedSampleFinishedNs": generation.sample_finished_ns,
                                    "currentImageComplete": generation.current_image_complete,
                                },
                                "creator": {
                                    "parentTid": parent_tid,
                                    "parentPid": parent_tgid,
                                    "trace": creator_edge["trace"],
                                    "rawLine": creator_edge["line"],
                                    "startNs": creator_edge["startNs"],
                                    "completionNs": creator_edge["completionNs"],
                                    "flags": flags_match.group(1) if flags_match else None,
                                },
                                "retainedParent": {
                                    "pid": parent_generation.pid,
                                    "initialPpid": parent_generation.ppid,
                                    "procStarttimeTicks": parent_generation.start_ticks,
                                    "pidfdAttachedAt": parent_generation.attached_at,
                                    "pidfdReadyAt": parent_generation.ready_at,
                                    "firstParentSample": parent_first_parent,
                                    "firstParentSampleStartedNs": parent_first_sample_ns,
                                    "latestRetainedSampleStartedNs": parent_generation.sample_started_ns,
                                    "latestRetainedSampleFinishedNs": parent_generation.sample_finished_ns,
                                    "currentImageComplete": parent_generation.current_image_complete,
                                    "memberTids": sorted(parent_members),
                                    "exitTids": sorted(parent_exit_tids),
                                    "latestRawTerminalNs": parent_group_exit_ns,
                                },
                            },
                            separators=(",", ":"),
                        )
                    except BaseException:
                        pass

                    raise CaptureError(detail)
        else:
            if parent_tgid not in generations:
                child_first_parent = generation.parents[0] if generation.parents else None

                if child_first_parent is None or child_first_parent["pid"] != generation.ppid:
                    raise CaptureError(f"Missing original /proc parent sample for PID {generation.pid}")

                _, creator_terminal_ns = raw_process_group_closure(parent_tgid, trace, tid_groups)

                if creator_terminal_ns <= utc_time_ns(child_first_parent["observedAt"]):
                    raise CaptureError(f"Retained child {generation.pid} parent sample aliases an exited raw creator")

        creator = {
            "parentTid": parent_tid,
            "parentPid": parent_tgid,
            "childPid": generation.pid,
            "trace": creator_edges[0]["trace"],
        }

    if generation.pid not in raw_files:
        raise CaptureError(f"Missing raw strace file for observed process {generation.pid}")

    exec_events = [
        {
            "tid": item["tid"],
            "path": item["path"],
            "resolvedPath": item["resolvedPath"],
            "argv": item["argv"],
            "trace": item["trace"],
        }
        for item in native_execs_for_generation(
            generation.pid, trace, tid_groups, generations, code_executable
        )
    ]
    return {
        **generation.identity(),
        "executablePath": generation.executions[-1]["executablePath"],
        "procArgv": generation.executions[-1]["argv"],
        "threadGroupId": tgid,
        "outcome": leader[0]["outcome"],
        "traceExit": leader[0]["trace"],
        "threadExits": [
            {"tid": item["tid"], "outcome": item["outcome"], "trace": item["trace"]}
            for item in sorted(exits, key=lambda item: item["tid"])
        ],
        "execEvents": exec_events,
        "creator": creator,
        "traceFileSha256": raw_files[generation.pid]["sha256"],
    }


def trace_files_manifest(directory: pathlib.Path, prefix: str) -> tuple[list[dict[str, Any]], dict[int, dict[str, Any]]]:
    files: list[dict[str, Any]] = []
    by_pid: dict[int, dict[str, Any]] = {}

    for pid, path in sorted(traced_files(directory, prefix).items()):
        content = path.read_bytes()

        if not content or not content.endswith(b"\n"):
            raise CaptureError(f"Incomplete raw strace output: {path.name}")

        item = {"file": path.name, "pid": pid, "bytes": len(content), "sha256": hashlib.sha256(content).hexdigest()}

        files.append(item)

        by_pid[pid] = item

    return files, by_pid


def traced_parent_pid(tid: int, trace: dict[str, Any], tid_groups: dict[int, int]) -> int | None:
    edges = trace["creations"].get(tid, [])

    if len(edges) != 1 or edges[0]["thread"]:
        return None

    return resolve_tgid(edges[0]["parentTid"], trace["creations"], tid_groups)


def require_traced_ancestor(child_pid: int, ancestor_pid: int, trace: dict[str, Any], tid_groups: dict[int, int]) -> None:
    current = child_pid
    seen: set[int] = set()

    while current != ancestor_pid:
        if current in seen:
            raise CaptureError("Linux raw process ancestry contains a cycle")

        seen.add(current)

        parent = traced_parent_pid(current, trace, tid_groups)

        if parent is None:
            raise CaptureError(f"Linux raw process {child_pid} has no traced ancestry to {ancestor_pid}")

        current = parent


def code_launch_trace_identities(
    trace: dict[str, Any],
    code_launcher: str,
    code_executable: str,
    tid_groups: dict[int, int],
) -> tuple[dict[str, Any], dict[str, Any]]:
    launcher_path = os.path.realpath(code_launcher)
    executable_path = os.path.realpath(code_executable)
    launcher_matches = [
        (tid, item)
        for tid, items in trace["execs"].items()
        for item in items
        if os.path.realpath(item["path"]) == launcher_path and tid not in trace["creations"]
    ]
    cli_matches = [
        (tid, item)
        for tid, items in trace["execs"].items()
        for item in items
        if os.path.realpath(item["path"]) == executable_path
        and any(argument.replace("\\", "/").endswith("/resources/app/out/cli.js") for argument in item["argv"])
    ]

    if len(launcher_matches) != 1 or len(cli_matches) != 1:
        raise CaptureError("Raw strace could not distinguish one Code launcher wrapper and one Electron CLI generation")

    wrapper_pid, wrapper_exec = launcher_matches[0]
    cli_pid, cli_exec = cli_matches[0]

    if wrapper_pid == cli_pid:
        raise CaptureError("Code launcher shell wrapper and Electron CLI were conflated into one PID")

    wrapper_exit = trace["exits"].get(wrapper_pid)
    cli_exit = trace["exits"].get(cli_pid)

    if not wrapper_exit or not cli_exit:
        raise CaptureError("Code launcher wrapper or Electron CLI has no independent raw terminal record")

    require_traced_ancestor(cli_pid, wrapper_pid, trace, tid_groups)

    return (
        {
            "pid": wrapper_pid,
            "argv": wrapper_exec["argv"],
            "traceExec": wrapper_exec["trace"],
            "traceExit": wrapper_exit["trace"],
            "outcome": wrapper_exit["outcome"],
        },
        {
            "pid": cli_pid,
            "executablePath": executable_path,
            "argv": cli_exec["argv"],
            "traceExec": cli_exec["trace"],
            "traceExit": cli_exit["trace"],
            "outcome": cli_exit["outcome"],
        },
    )


def native_ack(
    args: argparse.Namespace,
    config: dict[str, Any],
    host: dict[str, Any],
    server: dict[str, Any],
    gui: Generation,
    generations: dict[int, Generation],
    tid_groups: dict[int, int],
    trace_directory: pathlib.Path,
    trace_prefix: str,
) -> dict[str, Any]:
    server_generation = generations.get(server["pid"])
    host_generation = generations.get(host["pid"])

    if server_generation is None or host_generation is None:
        raise CaptureError("Native owner receipt has no retained Linux pidfd generation")

    acknowledgement_samples: dict[int, tuple[int, int]] = {}
    acknowledgement_parent_pids: dict[int, int] = {}
    acknowledgement_proc_images: dict[int, dict[str, Any]] = {}

    for item, role, owner_parent_pid in (
        (host_generation, "extension-host", host["ppid"]),
        (gui, "code-gui", None),
    ):
        item.check_exit()

        if item.ready_at is not None:
            raise CaptureError("Extension Host or Code GUI exited before language-server acknowledgement")

        live, sample_started_ns, sample_finished_ns = sample_proc(item.pid)
        rejected_fields: list[str] = []

        if live["pid"] != item.pid:
            rejected_fields.append("pid")

        if live["startTicks"] != item.start_ticks:
            rejected_fields.append("startTicks")

        if live["tgid"] != item.pid:
            rejected_fields.append("tgid")

        if owner_parent_pid is not None and live["ppid"] != owner_parent_pid:
            rejected_fields.append("ppid (Extension Host owner role)")

        if rejected_fields:
            expected_identity = {
                "pid": item.pid,
                "startTicks": item.start_ticks,
                "tgid": item.pid,
            }

            if owner_parent_pid is not None:
                expected_identity["ppid"] = owner_parent_pid
            else:
                expected_identity["originalObservedParentPid"] = item.ppid

            rejected_sample = {
                "role": role,
                "expected": expected_identity,
                "observed": live,
                "sampleStartedAt": utc_at_ns(sample_started_ns),
                "sampleFinishedAt": utc_at_ns(sample_finished_ns),
                "rejectedFields": rejected_fields,
            }
            raise CaptureError(
                "Rejected native acknowledgement /proc sample: "
                + json.dumps(rejected_sample, separators=(",", ":"), sort_keys=True)
            )

        item.observe(live, sample_started_ns, sample_finished_ns, retain_sample=True)

        acknowledgement_proc_images[item.pid] = find_execution(
            item,
            lambda image: (
                image["observedAt"] == utc_at_ns(sample_started_ns)
                and image["executablePath"] == live["executablePath"]
                and image["argv"] == live["argv"]
            ),
            f"{role} acknowledgement /proc sample",
        )
        acknowledgement_samples[item.pid] = (sample_started_ns, sample_finished_ns)
        acknowledgement_parent_pids[item.pid] = live["ppid"]

    remember_tid_groups(tid_groups, generations)

    trace = scan_trace(trace_directory, trace_prefix)
    trace_hashes = _trace_file_hashes(trace_directory)
    code_path = os.path.realpath(args.code_executable)
    host_path = os.path.realpath(host["execPath"])
    server_path = os.path.realpath(server["execPath"])

    if not has_bootstrap_runtime_anchor(host["argv"]):
        raise CaptureError("Process-owned Extension Host runtime argv lacks its source role anchor")

    gui_image = acknowledgement_proc_images[gui.pid]
    server_image = find_execution(
        server_generation,
        lambda image: image["executablePath"] == server_path
        and any(
            argument.replace("\\", "/").endswith("packages/language-server/dist/cli.js")
            for argument in image["argv"]
        ),
        "language server",
    )
    gui_exec = latest_native_exec(gui.pid, trace, tid_groups, generations, code_path)
    host_exec = latest_native_exec(host_generation.pid, trace, tid_groups, generations, code_path)
    server_exec = latest_native_exec(server_generation.pid, trace, tid_groups, generations, code_path)

    if gui_exec is None or host_exec is None or server_exec is None:
        raise CaptureError("Native acknowledgement has a pending or missing successful exec transition")

    if not gui.qualify_after_exec(gui_exec):
        raise CaptureError("Code GUI has no complete current /proc sample after its latest successful exec")

    if not host_generation.qualify_after_exec(host_exec):
        raise CaptureError("Extension Host has no complete current /proc sample after its latest successful exec")

    if not server_generation.qualify_after_exec(server_exec):
        raise CaptureError("Language server has no complete /proc sample after its latest successful exec")

    if not has_node_service_proc_history(host_generation, host_path, host_exec):
        raise CaptureError("Extension Host has no NodeService /proc image sampled after its latest native exec")

    if gui.check_exit() or host_generation.check_exit():
        raise CaptureError("Extension Host or Code GUI exited while its acknowledgement image was sampled")

    if not confirm_traced_exit(server_generation, trace, tid_groups):
        raise CaptureError("Language server has no retained pidfd readiness after its raw terminal closure")

    acknowledged_at = utc_now()
    acknowledged_at_ns = utc_time_ns(acknowledged_at)
    server_event = process_event(
        server_generation,
        trace,
        tid_groups,
        trace_hashes,
        generations,
        args.code_executable,
        gui.pid,
    )

    if server_event["outcome"] != {"kind": "exit", "status": 0}:
        raise CaptureError("Language server did not exit normally according to strace")

    gui_proc_image = acknowledgement_proc_images[gui.pid]
    host_proc_image = acknowledgement_proc_images[host_generation.pid]
    server_proc_image = server_generation.executions[-1]

    if (
        gui_image["executablePath"] != code_path
        or gui_exec["resolvedPath"] != code_path
        or gui_proc_image["executablePath"] != code_path
        or code_image_at(
            gui.pid,
            utc_time_ns(acknowledged_at),
            trace,
            tid_groups,
            generations,
            code_path,
        ) != code_path
        or any(
            flag_value(gui_exec["argv"], name) != expected
            for name, expected in (
                ("user-data-dir", str(args.user_data_dir)),
                ("extensions-dir", str(args.extensions_dir)),
                ("extensionDevelopmentPath", str(args.extension_path)),
                ("extensionTestsPath", str(args.coverage_host_path)),
            )
        )
        or flag_value(gui_exec["argv"], "type") not in (None, "browser")
        or any(
            argument.replace("\\", "/").endswith("/resources/app/out/cli.js")
            for argument in gui_exec["argv"]
        )
        or host_exec["resolvedPath"] != host_path
        or flag_value(host_exec["argv"], "type") != "utility"
        or flag_value(host_exec["argv"], "utility-sub-type") != "node.mojom.NodeService"
        or host_proc_image["executablePath"] != host_path
        or host_generation.ppid != host["ppid"]
        or server_image["executablePath"] != server_path
        or server_exec["resolvedPath"] != server_path
        or server_proc_image["executablePath"] != server_path
        or not any(
            argument.replace("\\", "/").endswith("packages/language-server/dist/cli.js")
            for argument in server_exec["argv"]
        )
    ):
        raise CaptureError("Native acknowledgement role anchors do not match latest exec traces and retained generations")

    if gui.check_exit() or host_generation.check_exit():
        raise CaptureError("Extension Host or Code GUI exited before acknowledgement was serialized")

    if any(finished_ns > acknowledged_at_ns for _, finished_ns in acknowledgement_samples.values()):
        raise CaptureError("Native acknowledgement timestamp precedes a completed Host or GUI /proc sample")

    return {
        "format": "hesperia-editor-linux-native-language-server-exit-ack",
        "version": 1,
        "runId": config["runId"],
        "populationFingerprint": config["populationFingerprint"],
        "languageServerOwnerId": server["ownerId"],
        "languageServerOwnerExitedAt": read_json(args.output / "language-server-exit.json")["exitedAt"],
        "languageServer": {
            "pid": server_generation.pid,
            "parentPid": server_generation.ppid,
            "executablePath": server_proc_image["executablePath"],
            "procArgv": server_proc_image["argv"],
            "ownerArgv": server["argv"],
            "procStarttimeTicks": server_generation.start_ticks,
            "pidfdAttachedAt": server_generation.attached_at,
            "pidfdReadyAt": server_generation.ready_at,
            "outcome": server_event["outcome"],
            "traceExit": server_event["traceExit"],
            "threadExits": server_event["threadExits"],
        },
        "extensionHost": {
            "pid": host_generation.pid,
            "parentPid": acknowledgement_parent_pids[host_generation.pid],
            "executablePath": host_proc_image["executablePath"],
            "procArgv": host_proc_image["argv"],
            "ownerArgv": host["argv"],
            "procStarttimeTicks": host_generation.start_ticks,
            "pidfdAttachedAt": host_generation.attached_at,
            "sampleStartedAt": utc_at_ns(acknowledgement_samples[host_generation.pid][0]),
            "sampleFinishedAt": utc_at_ns(acknowledgement_samples[host_generation.pid][1]),
            "aliveObservedAt": acknowledged_at,
        },
        "codeGui": {
            "pid": gui.pid,
            "parentPid": acknowledgement_parent_pids[gui.pid],
            "executablePath": gui_proc_image["executablePath"],
            "procArgv": gui_proc_image["argv"],
            "procStarttimeTicks": gui.start_ticks,
            "pidfdAttachedAt": gui.attached_at,
            "sampleStartedAt": utc_at_ns(acknowledgement_samples[gui.pid][0]),
            "sampleFinishedAt": utc_at_ns(acknowledgement_samples[gui.pid][1]),
            "aliveObservedAt": acknowledged_at,
        },
        "fixture": {
            "userDataPath": str(args.user_data_dir),
            "extensionsPath": str(args.extensions_dir),
            "extensionPath": str(args.extension_path),
            "testHostPath": str(args.coverage_host_path),
        },
        "languageServerTraceExit": server_event["traceExit"],
        "acknowledgedAt": acknowledged_at,
    }


def _trace_file_hashes(directory: pathlib.Path) -> dict[int, dict[str, Any]]:
    result: dict[int, dict[str, Any]] = {}

    for path in directory.glob("native-process-trace.*"):
        suffix = path.name.rsplit(".", 1)[-1]

        if suffix.isdecimal():
            content = path.read_bytes()
            result[int(suffix)] = {"sha256": hashlib.sha256(content).hexdigest()}

    return result


def signal_retained_process(process: subprocess.Popen[bytes], generation: Generation, requested: int) -> dict[str, Any]:
    if generation.check_exit():
        status = process.wait(timeout=5)
    else:
        try:
            current = read_proc_kernel_identity(generation.pid, "before retained pidfd signal")
        except (FileNotFoundError, ProcessLookupError):
            current = None

        if current is None:
            if generation.check_exit():
                status = process.wait(timeout=5)
            else:
                raise CaptureError(f"Refusing signal without current kernel identity for PID {generation.pid}")
        elif current["tgid"] != generation.pid or current["startTicks"] != generation.start_ticks:
            raise CaptureError(f"Refusing signal after retained process generation changed: {generation.pid}")
        else:
            if generation.check_exit():
                status = process.wait(timeout=5)
            else:
                signal.pidfd_send_signal(generation.pidfd, requested)

                deadline = time.monotonic() + 5

                while time.monotonic() < deadline and not generation.check_exit():
                    time.sleep(PROCESS_POLL_SECONDS)

                if generation.ready_at is None:
                    raise CaptureError(f"Retained pidfd did not observe process termination: {generation.pid}")

                status = process.wait(timeout=5)

    if status < 0:
        return {"kind": "signal", "signal": signal.Signals(-status).name}

    return {"kind": "exit", "status": status}


def await_or_signal_retained_process(
    process: subprocess.Popen[bytes], generation: Generation, timeout: float, requested: int
) -> dict[str, Any]:
    deadline = time.monotonic() + timeout

    while time.monotonic() < deadline and not generation.check_exit():
        time.sleep(PROCESS_POLL_SECONDS)

    return signal_retained_process(process, generation, requested)


def fixture_active_process_ids(user_data: pathlib.Path, extensions: pathlib.Path) -> list[int]:
    active: list[int] = []

    for entry in pathlib.Path("/proc").iterdir():
        if not entry.name.isdecimal():
            continue

        try:
            argv = [os.fsdecode(part) for part in (entry / "cmdline").read_bytes().split(b"\0") if part]
        except (FileNotFoundError, ProcessLookupError, PermissionError):
            continue

        if any(
            value in argv or f"--user-data-dir={value}" in argv or f"--extensions-dir={value}" in argv
            for value in (str(user_data), str(extensions))
        ):
            active.append(int(entry.name))

    return sorted(active)


def _file_content_identity(path: pathlib.Path) -> dict[str, Any]:
    digest = hashlib.sha256()
    byte_count = 0
    with path.open("rb") as stream:
        while chunk := stream.read(1024 * 1024):
            byte_count += len(chunk)

            digest.update(chunk)
    return {"bytes": byte_count, "sha256": digest.hexdigest()}


def _copy_editor_result(
    source: pathlib.Path, destination: pathlib.Path
) -> dict[str, dict[str, Any]]:
    source_before = _file_content_identity(source)

    shutil.copyfile(source, destination)

    destination_identity = _file_content_identity(destination)
    source_after = _file_content_identity(source)

    if source_before != source_after:
        raise CaptureError(f"VS Code editor result changed while copying: {source}")

    if source_before != destination_identity:
        raise CaptureError(
            f"Copied VS Code editor result content does not match its source: {destination}"
        )

    return {
        "sourceBefore": source_before,
        "destinationIdentity": destination_identity,
        "sourceAfter": source_after,
    }


def _retain_editor_logs(
    user_data: pathlib.Path,
    stdout_path: pathlib.Path,
    stderr_path: pathlib.Path,
    extension_path: pathlib.Path,
    *,
    primary_passed: bool,
    primary_failure: str,
) -> dict[str, Any]:
    log_directory = user_data / "logs"
    evidence_directory = extension_path.parent / "editor-evidence" / "logs"
    receipt: dict[str, Any] = {
        "format": "hesperia-editor-log-retention",
        "version": 1,
        "primaryPassed": primary_passed,
        "primaryFailure": primary_failure,
        "retentionPassed": True,
        "optionalLogTree": {
            "source": str(log_directory),
            "destination": str(evidence_directory),
            "attempted": False,
            "error": None,
        },
        "streams": {},
        "rawStreamErrors": [],
    }

    try:
        if log_directory.is_dir():
            receipt["optionalLogTree"]["attempted"] = True

            shutil.copytree(log_directory, evidence_directory, symlinks=True)
    except BaseException as error:
        receipt["optionalLogTree"]["error"] = str(error)

    for log_path in (stdout_path, stderr_path):
        destination = evidence_directory / log_path.name
        stream_receipt: dict[str, Any] = {
            "source": str(log_path),
            "destination": str(destination),
            "required": primary_passed,
            "sourceBefore": None,
            "sourceAfter": None,
            "destinationIdentity": None,
            "verified": False,
            "error": None,
        }
        receipt["streams"][log_path.name] = stream_receipt

        try:
            if not log_path.is_file():
                raise FileNotFoundError(f"Editor stream was not created: {log_path}")

            evidence_directory.mkdir(parents=True, exist_ok=True)

            source_before = _file_content_identity(log_path)
            stream_receipt["sourceBefore"] = source_before

            shutil.copyfile(log_path, destination)

            destination_identity = _file_content_identity(destination)
            stream_receipt["destinationIdentity"] = destination_identity
            source_after = _file_content_identity(log_path)
            stream_receipt["sourceAfter"] = source_after

            if source_before != source_after:
                raise CaptureError(f"Editor stream changed during retention: {log_path.name}")

            if source_before != destination_identity:
                raise CaptureError(f"Retained editor stream content does not match its source: {log_path.name}")

            stream_receipt["verified"] = True
        except BaseException as error:
            stream_receipt["error"] = str(error)
            receipt["retentionPassed"] = False

            receipt["rawStreamErrors"].append(f"{log_path.name}: {error}")

    receipt_path = evidence_directory / "editor-log-retention.json"
    receipt["receiptPath"] = str(receipt_path)
    receipt["receiptWritten"] = True

    try:
        evidence_directory.mkdir(parents=True, exist_ok=True)

        write_json(receipt_path, receipt)
    except BaseException as error:
        receipt["receiptWritten"] = False
        receipt["receiptError"] = str(error)

        try:
            print(
                json.dumps(
                    {"editorLogRetentionReceiptFailure": str(error), "receipt": receipt},
                    separators=(",", ":"),
                ),
                file=sys.stderr,
            )
        except BaseException:
            pass

    return receipt


def main() -> int:
    parser = argparse.ArgumentParser()

    parser.add_argument("--code-launcher", required=True)

    parser.add_argument("--code-executable", required=True)

    parser.add_argument("--extension-path", required=True)

    parser.add_argument("--coverage-host-path", required=True)

    parser.add_argument("--trace-directory", required=True)

    args = parser.parse_args()
    args.code_launcher = os.path.realpath(args.code_launcher)
    args.code_executable = os.path.realpath(args.code_executable)
    extension_path = pathlib.Path(args.extension_path).resolve(strict=True)
    coverage_host_path = pathlib.Path(args.coverage_host_path).resolve(strict=True)
    args.extension_path = extension_path
    args.coverage_host_path = coverage_host_path
    trace_directory = pathlib.Path(args.trace_directory).resolve()
    output_path = os.environ.get("HESPERIA_EDITOR_COVERAGE_OUTPUT_DIR")
    config_path = os.environ.get("HESPERIA_EDITOR_COVERAGE_CONFIG")

    if not output_path or not config_path:
        raise CaptureError("Linux editor coverage requires the current-run configuration and output path")

    output = pathlib.Path(output_path).resolve(strict=True)
    args.output = output

    if trace_directory != output:
        raise CaptureError("Linux raw trace directory must be the current run output directory")

    if list(trace_directory.glob("native-process-trace.*")):
        raise CaptureError("Current run output already contains native strace files")

    config = read_json(pathlib.Path(config_path).resolve(strict=True))
    config = require_exact_keys(
        config,
        {
            "format", "version", "runId", "repoPath", "outputDirectory", "populationFingerprint",
            "testHostPath", "languageServerSourcePaths", "outputs",
            *(["supportConfigPath"] if "supportConfigPath" in config else []),
            *(["verificationControl"] if "verificationControl" in config else []),
        },
        "Editor capture configuration",
    )
    configured_test_host = pathlib.Path(config["testHostPath"]).resolve(strict=True)
    expected_coverage_host = configured_test_host.with_name("coverage-host.cjs")

    if (
        config["format"] != "hesperia-editor-coverage-config"
        or config["version"] != 1
        or config["outputDirectory"] != str(output)
        or configured_test_host != coverage_host_path.with_name("test-host.cjs")
        or expected_coverage_host != coverage_host_path
        or extension_path != configured_test_host.parent.parent
        or config.get("verificationControl") not in (None, "kill-extension-host", "kill-language-server")
    ):
        raise CaptureError("Linux editor runner configuration does not match prepared current-run inputs")

    repo = pathlib.Path(config["repoPath"]).resolve(strict=True)
    verification = config.get("verificationControl")
    observer_started_at = utc_now()
    prefix = "native-process-trace"
    temporary_root = pathlib.Path(tempfile.mkdtemp(prefix="hesperia-vscode-"))
    user_data = temporary_root / "user-data"
    extensions = temporary_root / "extensions"
    args.user_data_dir = user_data
    args.extensions_dir = extensions
    workspace = temporary_root / "workspace"

    (workspace / "src").mkdir(parents=True)

    (workspace / "node_modules" / "@hesperia").mkdir(parents=True)

    (workspace / "node_modules" / "hesperia").symlink_to(repo / "packages" / "hesperia", target_is_directory=True)

    (workspace / "node_modules" / "@hesperia" / "language-server").symlink_to(
        repo / "packages" / "language-server", target_is_directory=True
    )

    (workspace / "package.json").write_text(
        '{"name":"hesperia-editor-test","private":true,"type":"module"}', encoding="utf-8"
    )

    (workspace / "hesperia.config.json").write_text("", encoding="utf-8")

    (workspace / "tsconfig.json").write_text(
        '{"compilerOptions":{"strict":true,"skipLibCheck":true,"lib":["ESNext","DOM"],"target":"ESNext","module":"ESNext","moduleResolution":"Bundler","types":[]}}',
        encoding="utf-8",
    )

    (workspace / "api.ts").write_text('export const message = "ready";', encoding="utf-8")

    (workspace / "app.tsx").write_text(
        'import { message } from "./api";\nexport default function App(){ return <html><head><title>Shell</title></head><body><main>{message}</main></body></html>; }',
        encoding="utf-8",
    )

    (workspace / "src" / "App.tsx").write_text(
        'import { message } from "../api"; export function App(){\n const emoji = "🐈"; const field = <input />;\n return <div title={field.value}>{message}{field.missing()}</div>;\n}',
        encoding="utf-8",
    )

    xvfb = shutil.which("Xvfb")
    strace = shutil.which("strace")

    if not xvfb or not strace:
        raise CaptureError("Linux editor requires the prepared Xvfb and strace executables")

    xvfb = os.path.realpath(xvfb)
    strace = os.path.realpath(strace)
    version = subprocess.run([strace, "--version"], check=True, text=True, capture_output=True).stdout.splitlines()

    if not version or not version[0].startswith("strace -- version "):
        raise CaptureError("Could not identify the actual strace executable version")

    raw_creator_fixture = (
        create_raw_creator_fixture(temporary_root)
        if verification is None
        else None
    )
    gui_arguments = [
        "--no-sandbox",
        f"--extensionDevelopmentPath={extension_path}",
        f"--extensionTestsPath={coverage_host_path}",
        f"--user-data-dir={user_data}",
        f"--extensions-dir={extensions}",
        "--disable-workspace-trust",
        "--disable-gpu",
        "--skip-welcome",
        "--skip-release-notes",
        "--new-window",
        str(workspace),
    ]
    trace_prefix = str(trace_directory / prefix)
    strace_arguments = ["-ff", "-ttt", "-v", "-s", "8192", "-e", "trace=%process", "-o", trace_prefix, "--", args.code_launcher, *gui_arguments]
    command = [strace, *strace_arguments]
    environment = dict(os.environ)
    environment["DONT_PROMPT_WSL_INSTALL"] = "1"
    raw_creator_environment = (
        "HESPERIA_LINUX_RAW_CREATOR_PYTHON",
        "HESPERIA_LINUX_RAW_CREATOR_SCRIPT",
        "HESPERIA_LINUX_RAW_CREATOR_SCOPE",
    )

    for name in raw_creator_environment:
        environment.pop(name, None)

    if raw_creator_fixture is not None:
        environment["HESPERIA_LINUX_RAW_CREATOR_PYTHON"] = raw_creator_fixture.python_executable
        environment["HESPERIA_LINUX_RAW_CREATOR_SCRIPT"] = str(raw_creator_fixture.helper_script)
        environment["HESPERIA_LINUX_RAW_CREATOR_SCOPE"] = str(raw_creator_fixture.directory)

    stdout_path = temporary_root / "editor-stdout.log"
    stderr_path = temporary_root / "editor-stderr.log"
    generations: dict[int, Generation] = {}
    pending_trace_generations: dict[int, PendingTraceGeneration] = {}
    tid_groups: dict[int, int] = {}
    pending_popen: dict[int, PendingPopenGeneration] = {}
    startup_diagnostics: list[str] = []
    supervisor: subprocess.Popen[bytes] | None = None
    supervisor_generation: Generation | None = None
    display_server: subprocess.Popen[bytes] | None = None
    display_generation: Generation | None = None
    display_outcome: dict[str, Any] | None = None
    trace_snapshot: dict[str, Any] | None = None
    code_wrapper_identity: dict[str, Any] | None = None
    code_cli_identity: dict[str, Any] | None = None
    gui_generation: Generation | None = None
    failure = ""
    passed = False
    display_read_fd: int | None = None
    control: dict[str, Any] | None = None
    control_path: pathlib.Path | None = None

    try:
        display_read_fd, display_write_fd = os.pipe()

        try:
            display_server = subprocess.Popen(
                [xvfb, "-displayfd", str(display_write_fd), "-screen", "0", "1280x800x24", "-nolisten", "tcp", "-ac"],
                cwd=repo,
                env=environment,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.PIPE,
                pass_fds=(display_write_fd,),
            )

            retain_popen_generation(display_server, "Xvfb server", pending_popen, startup_diagnostics)
        finally:
            os.close(display_write_fd)

        display_deadline = time.monotonic() + 10
        display_data = b""
        display_poller = select.poll()

        display_poller.register(display_read_fd, select.POLLIN | select.POLLHUP | select.POLLERR)

        while b"\n" not in display_data and time.monotonic() < display_deadline:
            if not display_poller.poll(100):
                if display_server.poll() is not None:
                    break

                continue

            chunk = os.read(display_read_fd, 64)

            if not chunk:
                break

            display_data += chunk

        os.close(display_read_fd)

        display_read_fd = None

        if not re.fullmatch(rb"\d+\n", display_data):
            detail = capture_popen_stderr(display_server)
            raise CaptureError(
                "Xvfb did not publish a valid isolated display number: "
                + json.dumps(detail, separators=(",", ":"))
            )

        display_generation = admit_popen_generation(
            pending_popen[display_server.pid], pending_popen, startup_diagnostics
        )
        environment["DISPLAY"] = f":{display_data.decode('ascii').strip()}"
        with stdout_path.open("wb") as stdout, stderr_path.open("wb") as stderr:
            supervisor = subprocess.Popen(command, cwd=repo, env=environment, stdout=stdout, stderr=stderr)
            supervisor_generation = open_popen_generation(
                supervisor, "strace supervisor", pending_popen, startup_diagnostics, stderr_path
            )
            deadline = time.monotonic() + TEST_BUDGET_SECONDS
            ack_written = False

            while time.monotonic() < deadline:
                trace_snapshot = scan_trace(trace_directory, prefix)
                files = trace_snapshot["files"]

                for pid in files:
                    if raw_creator_fixture is not None and raw_creator_pending_child_pid(
                        raw_creator_fixture,
                        pid,
                        trace_snapshot,
                        pid not in generations,
                    ):
                        if pid in generations:
                            raise CaptureError("Linux raw-creator child was admitted before its adoption checks")

                        child_binding = raw_creator_child_edge(
                            raw_creator_fixture,
                            trace_snapshot,
                        )

                        if child_binding is None:
                            continue

                        child_pid, _ = child_binding
                        helper_generation = generations.get(raw_creator_fixture.helper_pid or -1)

                        if helper_generation is None:
                            continue

                        adoption = raw_creator_child_adoption(
                            raw_creator_fixture,
                            helper_generation,
                            child_pid,
                            trace_snapshot,
                            tid_groups,
                        )

                        if adoption is None:
                            continue

                        _, raw_creator_fixture.helper_terminal_ns = adoption

                    generation = generations.get(pid)

                    if generation is None:
                        if pid in pending_trace_generations:
                            retry_pending_trace_generation(
                                pid, pending_trace_generations, generations, trace_snapshot
                            )

                            generation = generations.get(pid)
                        else:
                            attached = open_generation(pid, pending_trace_generations, trace_snapshot)

                            if attached is not None:
                                generations[pid] = attached
                                generation = attached
                    else:
                        observe_retained_generation(generation)

                    if generation is not None and raw_creator_fixture is not None:
                        release_raw_creator_child(raw_creator_fixture, generation, trace_snapshot)

                    if generation is not None:
                        generation.check_exit()

                trace_snapshot = scan_trace(trace_directory, prefix)

                remember_tid_groups(tid_groups, generations)

                for role in ("extension-host", "language-server"):
                    owner = owner_start(output, config["runId"], config["populationFingerprint"], role)

                    if owner is not None:
                        generation = generations.get(owner["pid"])

                        if generation is None or generation.start_ticks <= 0:
                            continue

                        owner_path = os.path.realpath(owner["execPath"])

                        if role == "extension-host":
                            if not has_bootstrap_runtime_anchor(owner["argv"]):
                                raise CaptureError(
                                    "Process-owned Extension Host runtime argv lacks its source role anchor"
                                )
                        else:
                            image = find_execution(
                                generation,
                                lambda item, owner_path=owner_path: item["executablePath"] == owner_path
                                and any(
                                    argument.replace("\\", "/").endswith(
                                        "packages/language-server/dist/cli.js"
                                    )
                                    for argument in item["argv"]
                                ),
                                role,
                            )

                        latest = latest_native_exec(
                            generation.pid,
                            trace_snapshot,
                            tid_groups,
                            generations,
                            args.code_executable,
                        )

                        if latest is None:
                            continue

                        if not generation.qualify_after_exec(latest):
                            continue

                        if (
                            latest["resolvedPath"] != owner_path
                            or generation.executions[-1]["executablePath"] != owner_path
                            or (role == "extension-host" and not is_node_service_argv(latest["argv"]))
                        ):
                            raise CaptureError(f"Latest native exec does not match the {role} owner generation")

                        if role == "extension-host" and not has_node_service_proc_history(
                            generation, owner_path, latest
                        ):
                            raise CaptureError(
                                "Extension Host has no NodeService /proc image sampled after its latest native exec"
                            )

                        if role == "language-server" and not any(
                            argument.replace("\\", "/").endswith(
                                "packages/language-server/dist/cli.js"
                            )
                            for argument in owner["argv"]
                        ):
                            raise CaptureError(f"Process-owned {role} runtime argv lacks its source role anchor")

                        if (
                            generation.ppid != owner["ppid"]
                            or not generation.parents
                            or generation.parents[-1]["pid"] != owner["ppid"]
                        ):
                            raise CaptureError(f"Native {role} parent PID differs from its owner receipt")

                host_start = owner_start(output, config["runId"], config["populationFingerprint"], "extension-host")
                server_start = owner_start(output, config["runId"], config["populationFingerprint"], "language-server")
                user_data_value = str(user_data)
                extensions_value = str(extensions)
                gui_candidates = []

                for generation in generations.values():
                    if generation.check_exit() and generation is not gui_generation:
                        continue

                    latest = latest_native_exec(
                        generation.pid,
                        trace_snapshot,
                        tid_groups,
                        generations,
                        args.code_executable,
                    )

                    if latest is None:
                        continue

                    if latest["resolvedPath"] != args.code_executable or not generation.qualify_after_exec(latest):
                        continue

                    if (
                        generation.executions[-1]["executablePath"] == args.code_executable
                        and code_image_at(
                            generation.pid,
                            utc_time_ns(utc_now()),
                            trace_snapshot,
                            tid_groups,
                            generations,
                            args.code_executable,
                        )
                        == args.code_executable
                        and not any(argument.replace("\\", "/").endswith("/resources/app/out/cli.js") for argument in latest["argv"])
                        and flag_value(latest["argv"], "user-data-dir") == user_data_value
                        and flag_value(latest["argv"], "extensions-dir") == extensions_value
                        and flag_value(latest["argv"], "extensionDevelopmentPath") == str(extension_path)
                        and flag_value(latest["argv"], "extensionTestsPath") == str(coverage_host_path)
                        and flag_value(latest["argv"], "type") in (None, "browser")
                    ):
                        gui_candidates.append(generation)

                unique_gui = {candidate.pid: candidate for candidate in gui_candidates}

                if len(unique_gui) > 1:
                    raise CaptureError("More than one isolated Code GUI generation matches the current run")

                current_gui_generation = next(iter(unique_gui.values()), None)

                if current_gui_generation is not None:
                    if gui_generation is None:
                        gui_generation = current_gui_generation
                    elif current_gui_generation is not gui_generation:
                        raise CaptureError("Isolated Code GUI generation changed after its first qualified binding")

                if raw_creator_fixture is not None and current_gui_generation is not None:
                    for generation in generations.values():
                        observe_raw_creator_helper(
                            raw_creator_fixture,
                            generation,
                            trace_snapshot,
                            generations,
                            output,
                            config["runId"],
                            config["populationFingerprint"],
                            current_gui_generation.pid,
                        )

                    complete_raw_creator_fixture(
                        raw_creator_fixture,
                        generations,
                        trace_snapshot,
                        tid_groups,
                    )

                start_path = output / "extension-host-deactivate-start.json"

                if verification:
                    ready_path = output / "owner-kill-ready.json"

                    if ready_path.exists():
                        if not host_start or not server_start or not current_gui_generation:
                            raise CaptureError("Linux postassertion kill barrier has no bound Host, LS, or GUI generation")

                        target_role = "extension-host" if verification == "kill-extension-host" else "language-server"
                        target_start = host_start if target_role == "extension-host" else server_start
                        report_source = workspace / "editor-result.json"

                        if report_source.exists() and not (output / "editor-result.json").exists():
                            shutil.copy2(report_source, output / "editor-result.json")

                        if not (output / "editor-result.json").exists():
                            raise CaptureError("Postassertion native kill control has no original editor result report")

                        report = read_json(output / "editor-result.json")

                        if not isinstance(report, dict) or report.get("passed") is not True or not isinstance(report.get("checks"), list) or len(report["checks"]) != 19:
                            raise CaptureError("Postassertion native kill control did not preserve all original 19 assertions")

                        ready = require_exact_keys(
                            read_json(ready_path),
                            {"format", "version", "runId", "populationFingerprint", "mode", "extensionHostPid", "assertionsCompletedAt"},
                            "Linux owner kill barrier",
                        )

                        if (
                            ready["format"] != "hesperia-editor-owner-kill-ready"
                            or ready["version"] != 1
                            or ready["runId"] != config["runId"]
                            or ready["populationFingerprint"] != config["populationFingerprint"]
                            or ready["mode"] != verification
                            or ready["extensionHostPid"] != host_start["pid"]
                            or not valid_timestamp(ready["assertionsCompletedAt"])
                        ):
                            raise CaptureError("Linux postassertion kill barrier does not match this run")

                        target_generation = generations.get(target_start["pid"])

                        if target_generation is None or target_generation.check_exit():
                            raise CaptureError("Linux postassertion kill target has no live retained pidfd")

                        current_target, target_sample_started_ns, target_sample_finished_ns = sample_proc(
                            target_generation.pid, "postassertion kill target /proc image sample"
                        )
                        target_path = os.path.realpath(target_start["execPath"])

                        if (
                            current_target["tgid"] != target_generation.pid
                            or current_target["startTicks"] != target_generation.start_ticks
                            or current_target["ppid"] != target_start["ppid"]
                            or target_generation.ppid != target_start["ppid"]
                            or current_target["executablePath"] != target_path
                        ):
                            raise CaptureError("Linux postassertion kill target changed owner generation before pidfd signaling")

                        target_generation.observe(
                            current_target, target_sample_started_ns, target_sample_finished_ns
                        )

                        latest_target_exec = latest_native_exec(
                            target_generation.pid,
                            trace_snapshot,
                            tid_groups,
                            generations,
                            args.code_executable,
                        )

                        if (
                            latest_target_exec is None
                            or not target_generation.qualify_after_exec(latest_target_exec)
                            or latest_target_exec["resolvedPath"] != target_path
                            or target_generation.executions[-1]["executablePath"] != target_path
                        ):
                            raise CaptureError("Linux postassertion kill target has no current successful owner exec")

                        if target_role == "extension-host":
                            if (
                                not has_bootstrap_runtime_anchor(target_start["argv"])
                                or not is_node_service_argv(latest_target_exec["argv"])
                            ):
                                raise CaptureError("Linux Extension Host kill target lacks runtime and native NodeService role anchors")

                            if not has_node_service_proc_history(
                                target_generation, target_path, latest_target_exec
                            ):
                                raise CaptureError(
                                    "Linux Extension Host kill target has no Code NodeService proc image sampled after its latest native exec"
                                )
                        else:
                            if not any(
                                argument.replace("\\", "/").endswith(
                                    "packages/language-server/dist/cli.js"
                                )
                                for argument in target_start["argv"]
                            ) or not any(
                                argument.replace("\\", "/").endswith(
                                    "packages/language-server/dist/cli.js"
                                )
                                for argument in latest_target_exec["argv"]
                            ):
                                raise CaptureError("Linux language-server kill target lacks its compiled CLI role anchor")

                            find_execution(
                                target_generation,
                                lambda image: image["executablePath"] == target_path
                                and any(
                                    argument.replace("\\", "/").endswith(
                                        "packages/language-server/dist/cli.js"
                                    )
                                    for argument in image["argv"]
                                ),
                                target_role,
                            )

                        target_image = target_generation.executions[-1]
                        control = {
                            "format": "hesperia-editor-linux-native-owner-kill-control",
                            "version": 1,
                            "runId": config["runId"],
                            "populationFingerprint": config["populationFingerprint"],
                            "mode": verification,
                            "role": target_role,
                            "pid": target_generation.pid,
                            "parentPid": target_generation.ppid,
                            "executablePath": target_image["executablePath"],
                            "procArgv": target_image["argv"],
                            "ownerArgv": target_start["argv"],
                            "procStarttimeTicks": target_generation.start_ticks,
                            "pidfdAttachedAt": target_generation.attached_at,
                            "assertionsCompletedAt": ready["assertionsCompletedAt"],
                            "requestedSignal": "SIGKILL",
                        }
                        control_path = output / "owner-kill-control.json"

                        if control_path.exists():
                            raise CaptureError("Linux owner kill control already exists")

                        if target_generation.check_exit():
                            raise CaptureError("Linux postassertion kill target exited before pidfd signaling")

                        control["signalSentAt"] = utc_now()

                        signal.pidfd_send_signal(target_generation.pidfd, signal.SIGKILL)

                        deadline = time.monotonic() + 5

                        while time.monotonic() < deadline and not target_generation.check_exit():
                            time.sleep(PROCESS_POLL_SECONDS)

                        if target_generation.ready_at is None:
                            raise CaptureError(f"Linux pidfd did not observe SIGKILL termination for {target_role}")

                        trace_snapshot = scan_trace(trace_directory, prefix)
                        target_exit = trace_snapshot["exits"].get(target_generation.pid)

                        if not target_exit or target_exit["outcome"] != {"kind": "signal", "signal": "SIGKILL"}:
                            raise CaptureError("Raw strace did not independently record the requested owner SIGKILL")

                        confirm_traced_exit(target_generation, trace_snapshot, tid_groups)

                        control["pidfdReadyAt"] = target_generation.ready_at
                        control["outcome"] = target_exit["outcome"]
                        control["traceExit"] = target_exit["trace"]

                        raise CaptureError(f"Private native owner kill control terminated {target_role} PID {target_generation.pid}")
                elif start_path.exists() and not ack_written and host_start and server_start and current_gui_generation:
                    server_done = owner_exit(output, server_start)

                    if server_done:
                        server_receipt, _ = server_done
                        server_generation = generations.get(server_start["pid"])
                        host_generation = generations.get(host_start["pid"])

                        if server_generation and host_generation:
                            leader_exit = trace_snapshot["exits"].get(server_generation.pid)
                            all_server_threads_exited = all(
                                tid in trace_snapshot["exits"]
                                for tid in trace_snapshot["files"]
                                if resolve_tgid(tid, trace_snapshot["creations"], tid_groups) == server_generation.pid
                            )

                            if leader_exit and all_server_threads_exited and server_generation.ready_at:
                                if leader_exit["outcome"] != {"kind": "exit", "status": server_receipt["exitCode"]}:
                                    raise CaptureError("Raw strace LS outcome disagrees with the process-owned exit receipt")

                                current_gui_generation.check_exit()

                                host_generation.check_exit()

                                if current_gui_generation.ready_at is not None or host_generation.ready_at is not None:
                                    raise CaptureError("Host or Code GUI exited before the independent LS exit acknowledgement")

                                ack = native_ack(
                                    args,
                                    config,
                                    host_start,
                                    server_start,
                                    current_gui_generation,
                                    generations,
                                    tid_groups,
                                    trace_directory,
                                    prefix,
                                )
                                ack_path = output / "language-server-native-exit-ack.json"

                                if ack_path.exists():
                                    raise CaptureError("Linux native language-server acknowledgement already exists")

                                write_json(ack_path, ack)

                                ack_written = True

                if gui_generation and gui_generation.check_exit():
                    break

                if supervisor.poll() is not None and gui_generation is None:
                    raise CaptureError("Xvfb/strace exited before the actual isolated Code GUI was observed")

                time.sleep(PROCESS_POLL_SECONDS)
            else:
                if pending_trace_generations:
                    pending_ids = sorted(
                        pid
                        for pid, attachment in pending_trace_generations.items()
                        if not pidfd_ready(attachment.pidfd)
                        or not retry_pending_trace_generation(
                            pid, pending_trace_generations, generations, trace_snapshot
                        )
                    )

                    if pending_ids:
                        raise CaptureError(f"Traced process leaders still lacked complete /proc identity at the editor deadline: {pending_ids}")

                raise CaptureError(f"Linux VS Code editor test exceeded {TEST_BUDGET_SECONDS} seconds")

        if pending_trace_generations:
            pending_ids = sorted(
                pid
                for pid, attachment in pending_trace_generations.items()
                if not pidfd_ready(attachment.pidfd)
                or not retry_pending_trace_generation(
                    pid, pending_trace_generations, generations, trace_snapshot
                )
            )

            if pending_ids:
                raise CaptureError(f"Traced process leaders still lacked complete /proc identity at normal GUI exit: {pending_ids}")

        if supervisor is None:
            raise CaptureError("Editor supervisor was not launched")

        supervisor_status = supervisor.wait(timeout=10)

        if supervisor_generation is None or not supervisor_generation.check_exit():
            raise CaptureError("Retained strace pidfd did not observe the descendant tree exit")

        if supervisor_status != 0:
            raise CaptureError(f"Xvfb/strace editor process tree exited with status {supervisor_status}")

        workspace_result = workspace / "editor-result.json"

        if workspace_result.exists() and not (output / "editor-result.json").exists():
            _copy_editor_result(workspace_result, output / "editor-result.json")

        if not (output / "editor-result.json").exists():
            raise CaptureError("VS Code exited without the existing editor result report")

        result = read_json(output / "editor-result.json")

        if not isinstance(result, dict) or result.get("passed") is not True or not isinstance(result.get("checks"), list) or len(result["checks"]) != 19:
            raise CaptureError("The original VS Code extension host did not complete all 19 checks")

        if not ack_written:
            raise CaptureError("Native LS exit acknowledgement was not written before normal deactivation completed")

        if raw_creator_fixture is not None and not raw_creator_fixture.completed:
            raise CaptureError("Linux raw-creator fixture did not complete before normal editor shutdown")

        remember_tid_groups(tid_groups, generations)

        trace_snapshot = scan_trace(trace_directory, prefix, final=True)
        trace_files, trace_hashes = trace_files_manifest(trace_directory, prefix)
        native_events = []

        for pid, generation in sorted(generations.items()):
            generation.check_exit()

            if not confirm_traced_exit(generation, trace_snapshot, tid_groups):
                raise CaptureError(f"Retained PID {pid} has no raw-closure readiness confirmation")

        for pid, generation in sorted(generations.items()):
            native_events.append(
                process_event(
                    generation,
                    trace_snapshot,
                    tid_groups,
                    trace_hashes,
                    generations,
                    args.code_executable,
                    gui_generation.pid,
                )
            )

        host_start = owner_start(output, config["runId"], config["populationFingerprint"], "extension-host")
        server_start = owner_start(output, config["runId"], config["populationFingerprint"], "language-server")

        if not host_start or not server_start:
            raise CaptureError("Missing native owner receipts after the editor GUI exited")

        for event in native_events:
            if event["pid"] == host_start["pid"]:
                event["ownerRole"] = "extension-host"
                event["ownerArgv"] = host_start["argv"]

            if event["pid"] == server_start["pid"]:
                event["ownerRole"] = "language-server"
                event["ownerArgv"] = server_start["argv"]

        if not gui_generation:
            raise CaptureError("Native observation missed the actual Code GUI generation")

        remember_tid_groups(tid_groups, generations)

        code_wrapper_identity, code_cli_identity = code_launch_trace_identities(
            trace_snapshot, args.code_launcher, args.code_executable, tid_groups
        )

        require_traced_ancestor(gui_generation.pid, code_cli_identity["pid"], trace_snapshot, tid_groups)

        process_scope = fixture_active_process_ids(user_data, extensions)
        fixture_scope = {"checkedAt": utc_now(), "userDataPath": user_data_value, "extensionsPath": extensions_value, "activeProcessIds": process_scope}

        if process_scope:
            raise CaptureError(f"Isolated Code fixture still has active processes: {process_scope}")

        if display_server is None or display_generation is None:
            raise CaptureError("Missing retained Xvfb server generation at cleanup")

        if display_generation.check_exit():
            raise CaptureError("Isolated Xvfb exited before normal fixture cleanup")

        display_outcome = signal_retained_process(display_server, display_generation, signal.SIGTERM)
        trace_command = command
        strace_command = [strace, *strace_arguments]
        trace_command_hash = hashlib.sha256(json.dumps(trace_command, separators=(",", ":")).encode("utf-8")).hexdigest()
        native = {
            "format": "hesperia-editor-linux-native-process-observation",
            "version": 1,
            "platform": "linux",
            "runId": config["runId"],
            "populationFingerprint": config["populationFingerprint"],
            "observerStartedAt": observer_started_at,
            "observedAt": utc_now(),
            "codeCliWrapper": code_wrapper_identity,
            "codeCli": code_cli_identity,
            "codeGui": {"pid": gui_generation.pid, "procStarttimeTicks": gui_generation.start_ticks},
            "fixtureProcessScope": fixture_scope,
            "displayServer": {
                "pid": display_generation.pid,
                "parentPid": display_generation.ppid,
                "procStarttimeTicks": display_generation.start_ticks,
                "pidfdAttachedAt": display_generation.attached_at,
                "pidfdReadyAt": display_generation.ready_at,
                "executablePath": display_generation.executions[-1]["executablePath"],
                "procArgv": display_generation.executions[-1]["argv"],
                "requestedSignal": "SIGTERM",
                "outcome": display_outcome,
            },
            "trace": {
                "format": "strace-ff-process-tree",
                "executablePath": strace,
                "version": version[0],
                "command": trace_command,
                "straceCommand": strace_command,
                "commandSha256": hashlib.sha256(json.dumps(trace_command, separators=(",", ":")).encode("utf-8")).hexdigest(),
                "straceCommandSha256": trace_command_hash,
                "tracer": {
                    "pid": supervisor_generation.pid,
                    "parentPid": supervisor_generation.ppid,
                    "procStarttimeTicks": supervisor_generation.start_ticks,
                    "pidfdAttachedAt": supervisor_generation.attached_at,
                    "pidfdReadyAt": supervisor_generation.ready_at,
                    "executablePath": supervisor_generation.executions[-1]["executablePath"],
                    "procArgv": supervisor_generation.executions[-1]["argv"],
                    "outcome": {"kind": "exit", "status": supervisor_status},
                },
                "cancelledSyscalls": trace_snapshot.get("cancelledSyscalls", []),
                "files": trace_files,
            },
            "events": native_events,
        }

        write_json(output / "native-process-observation.json", native)

        passed = True
        return 0
    except BaseException as error:
        failure = str(error)
        failure_exception_type = f"{type(error).__module__}.{type(error).__qualname__}"
        failure_traceback = traceback.format_exc()
        failure_errno = error.errno if isinstance(error, OSError) else None
        failure_filename = (
            os.fsdecode(error.filename) if isinstance(error, OSError) and error.filename is not None else None
        )
        failure_filename2 = (
            os.fsdecode(error.filename2) if isinstance(error, OSError) and error.filename2 is not None else None
        )

        print(f"Linux editor capture failed: {failure}", file=sys.stderr)

        workspace_result = workspace / "editor-result.json"

        if workspace_result.exists() and not (output / "editor-result.json").exists():
            shutil.copy2(workspace_result, output / "editor-result.json")

        cleanup_errors: list[dict[str, Any]] = []
        forced_pids: list[int] = []
        tracer_outcome: dict[str, Any] | None = None
        display_outcome = None

        try:
            release_raw_creator_abort(raw_creator_fixture)
        except BaseException as cleanup_error:
            cleanup_errors.append(
                {
                    "pid": raw_creator_fixture.helper_pid if raw_creator_fixture is not None else None,
                    "error": f"Could not release raw-creator abort gate: {cleanup_error}",
                }
            )

        cleanup_raw_creator_child(
            raw_creator_fixture,
            forced_pids,
            cleanup_errors,
            trace_directory,
            prefix,
            tid_groups,
        )

        for pid, attachment in list(pending_trace_generations.items()):
            try:
                if not pidfd_ready(attachment.pidfd):
                    try:
                        identity = read_proc_kernel_identity(pid, "pending traced process failure cleanup")

                        validate_retained_generation(
                            identity, pid, attachment.start_ticks, "pending traced process failure cleanup"
                        )
                    except BaseException as identity_error:
                        cleanup_errors.append(
                            {"pid": pid, "error": f"Could not recheck pending traced process before pidfd cleanup: {identity_error}"}
                        )

                    try:
                        signal.pidfd_send_signal(attachment.pidfd, signal.SIGKILL)

                        forced_pids.append(pid)
                    except ProcessLookupError:
                        if not pidfd_ready(attachment.pidfd):
                            raise

                    deadline = time.monotonic() + 5

                    while time.monotonic() < deadline and not pidfd_ready(attachment.pidfd):
                        time.sleep(PROCESS_POLL_SECONDS)

                if not pidfd_ready(attachment.pidfd):
                    cleanup_errors.append(
                        {"pid": pid, "procStarttimeTicks": attachment.start_ticks, "error": "Pending traced process pidfd was not ready after SIGKILL cleanup"}
                    )
            except BaseException as cleanup_error:
                cleanup_errors.append(
                    {"pid": pid, "procStarttimeTicks": attachment.start_ticks, "error": f"Pending traced process pidfd cleanup failed: {cleanup_error}"}
                )
            finally:
                pending_trace_generations.pop(pid, None)

                try:
                    os.close(attachment.pidfd)
                except OSError as cleanup_error:
                    cleanup_errors.append({"pid": pid, "error": f"Could not close pending traced process pidfd: {cleanup_error}"})

        for pid, attachment in list(pending_popen.items()):
            ready_before_cleanup = False
            requested_signal: str | None = None

            try:
                ready_before_cleanup = pidfd_ready(attachment.pidfd)

                if not ready_before_cleanup:
                    try:
                        signal.pidfd_send_signal(attachment.pidfd, signal.SIGKILL)

                        requested_signal = "SIGKILL"
                    except ProcessLookupError:
                        if not pidfd_ready(attachment.pidfd):
                            raise

                    deadline = time.monotonic() + 5

                    while time.monotonic() < deadline and not pidfd_ready(attachment.pidfd):
                        time.sleep(PROCESS_POLL_SECONDS)

                if pidfd_ready(attachment.pidfd):
                    wait_outcome = popen_wait_outcome(attachment.process)
                    stderr = capture_popen_stderr(attachment.process, attachment.stderr_path)

                    startup_diagnostics.append(
                        popen_outcome_detail(
                            attachment.role,
                            pid,
                            "failure cleanup",
                            ready_before_cleanup,
                            wait_outcome,
                            stderr,
                            requested_signal,
                        )
                    )
                else:
                    cleanup_errors.append(
                        {"pid": pid, "error": f"Retained {attachment.role} pidfd was not ready after SIGKILL cleanup"}
                    )
            except BaseException as cleanup_error:
                cleanup_errors.append({"pid": pid, "error": f"Popen pidfd cleanup failed: {cleanup_error}"})
            finally:
                pending_popen.pop(pid, None)

                try:
                    os.close(attachment.pidfd)
                except OSError as cleanup_error:
                    cleanup_errors.append({"pid": pid, "error": f"Could not close retained Popen pidfd: {cleanup_error}"})

        for generation in reversed(list(generations.values())):
            try:
                terminate_retained_generation(generation, forced_pids)
            except BaseException as cleanup_error:
                cleanup_errors.append(
                    {
                        "pid": generation.pid,
                        "procStarttimeTicks": generation.start_ticks,
                        "error": str(cleanup_error),
                    }
                )

        if supervisor is not None and supervisor_generation is not None:
            try:
                if not supervisor_generation.check_exit():
                    forced_pids.append(supervisor.pid)

                tracer_outcome = await_or_signal_retained_process(
                    supervisor, supervisor_generation, 5, signal.SIGKILL
                )
            except BaseException as cleanup_error:
                cleanup_errors.append({"pid": supervisor.pid, "error": str(cleanup_error)})

        if display_server is not None and display_generation is not None:
            try:
                if not display_generation.check_exit():
                    forced_pids.append(display_server.pid)

                display_outcome = signal_retained_process(display_server, display_generation, signal.SIGKILL)
            except BaseException as cleanup_error:
                cleanup_errors.append(
                    {
                        "pid": display_server.pid,
                        "procStarttimeTicks": display_generation.start_ticks,
                        "error": str(cleanup_error),
                    }
                )

        diagnostics: list[dict[str, Any]] = []
        diagnostic_errors: list[str] = list(startup_diagnostics)
        failure_fixture_scope = {
            "checkedAt": utc_now(),
            "userDataPath": str(user_data),
            "extensionsPath": str(extensions),
            "activeProcessIds": fixture_active_process_ids(user_data, extensions),
        }

        try:
            remember_tid_groups(tid_groups, generations)

            trace_snapshot = scan_trace(trace_directory, prefix, final=True)
            trace_files, trace_hashes = trace_files_manifest(trace_directory, prefix)

            try:
                code_wrapper_identity, code_cli_identity = code_launch_trace_identities(
                    trace_snapshot, args.code_launcher, args.code_executable, tid_groups
                )
            except BaseException as identity_error:
                diagnostic_errors.append(f"Code launcher ancestry: {identity_error}")

            host_start = owner_start(output, config["runId"], config["populationFingerprint"], "extension-host")
            server_start = owner_start(output, config["runId"], config["populationFingerprint"], "language-server")

            for pid, generation in sorted(generations.items()):
                generation.check_exit()

                try:
                    confirmed = confirm_traced_exit(generation, trace_snapshot, tid_groups)

                    if not confirmed:
                        raise CaptureError(f"Retained PID {pid} has no raw-closure readiness confirmation")

                    if control is not None and generation.pid == control["pid"] and "pidfdReadyAt" in control:
                        if (
                            control["runId"] != config["runId"]
                            or control["populationFingerprint"] != config["populationFingerprint"]
                            or generation.start_ticks != control["procStarttimeTicks"]
                            or generation.attached_at != control["pidfdAttachedAt"]
                            or control_path is None
                        ):
                            raise CaptureError("Retained kill target has no matching raw-closure readiness confirmation")

                        if control_path.exists():
                            raise CaptureError("Linux owner kill control already exists")

                        control["pidfdReadyAt"] = generation.ready_at

                        write_json(control_path, control)
                except BaseException as confirmation_error:
                    diagnostic_errors.append(f"Native process {pid} terminal readiness: {confirmation_error}")

            for pid, generation in sorted(generations.items()):
                try:
                    event = process_event(
                        generation,
                        trace_snapshot,
                        tid_groups,
                        trace_hashes,
                        generations,
                        args.code_executable,
                        gui_generation.pid if gui_generation is not None else None,
                    )

                    if host_start and event["pid"] == host_start["pid"]:
                        event["ownerRole"] = "extension-host"
                        event["ownerArgv"] = host_start["argv"]

                    if server_start and event["pid"] == server_start["pid"]:
                        event["ownerRole"] = "language-server"
                        event["ownerArgv"] = server_start["argv"]

                    diagnostics.append(event)
                except BaseException as event_error:
                    diagnostic_errors.append(f"PID {pid}: {event_error}")
        except BaseException as diagnostic_error:
            diagnostic_errors.append(str(diagnostic_error))

            trace_files = []
            trace_snapshot = {"cancelledSyscalls": []}

        trace_command = command if "command" in locals() else []
        strace_command = [strace, *strace_arguments] if "strace_arguments" in locals() else []

        write_json(
            output / "native-process-failure.json",
            {
                "format": "hesperia-editor-linux-native-process-failure",
                "version": 1,
                "platform": "linux",
                "runId": config["runId"],
                "populationFingerprint": config["populationFingerprint"],
                "observerStartedAt": observer_started_at,
                "observedAt": utc_now(),
                "failure": failure,
                "failureExceptionType": failure_exception_type,
                "failureTraceback": failure_traceback,
                "failureErrno": failure_errno,
                "failureFilename": failure_filename,
                "failureFilename2": failure_filename2,
                "codeCliWrapper": code_wrapper_identity,
                "codeCli": code_cli_identity,
                "forcedPids": forced_pids,
                "cleanupFailures": cleanup_errors,
                "diagnosticErrors": diagnostic_errors,
                "displayServer": (
                    {
                        "pid": display_generation.pid,
                        "parentPid": display_generation.ppid,
                        "procStarttimeTicks": display_generation.start_ticks,
                        "pidfdAttachedAt": display_generation.attached_at,
                        "pidfdReadyAt": display_generation.ready_at,
                        "executablePath": display_generation.executions[-1]["executablePath"],
                        "procArgv": display_generation.executions[-1]["argv"],
                        "outcome": display_outcome,
                    }
                    if display_generation is not None
                    else None
                ),
                "fixtureProcessScope": failure_fixture_scope,
                "trace": {
                    "format": "strace-ff-process-tree",
                    "executablePath": strace,
                    "version": version[0] if "version" in locals() and version else "",
                    "command": trace_command,
                    "straceCommand": strace_command,
                    "commandSha256": hashlib.sha256(json.dumps(trace_command, separators=(",", ":")).encode("utf-8")).hexdigest(),
                    "straceCommandSha256": hashlib.sha256(json.dumps(strace_command, separators=(",", ":")).encode("utf-8")).hexdigest(),
                    "tracer": (
                        {
                            "pid": supervisor_generation.pid,
                            "parentPid": supervisor_generation.ppid,
                            "procStarttimeTicks": supervisor_generation.start_ticks,
                            "pidfdAttachedAt": supervisor_generation.attached_at,
                            "pidfdReadyAt": supervisor_generation.ready_at,
                            "executablePath": supervisor_generation.executions[-1]["executablePath"],
                            "procArgv": supervisor_generation.executions[-1]["argv"],
                            "outcome": tracer_outcome,
                        }
                        if supervisor_generation is not None
                        else None
                    ),
                    "cancelledSyscalls": trace_snapshot.get("cancelledSyscalls", []),
                    "files": trace_files,
                },
                "events": diagnostics,
            },
        )

        if cleanup_errors:
            print(json.dumps({"cleanupFailures": cleanup_errors}, separators=(",", ":")), file=sys.stderr)

        return 1
    finally:
        if display_read_fd is not None:
            try:
                os.close(display_read_fd)
            except OSError:
                pass

        for generation in generations.values():
            try:
                os.close(generation.pidfd)
            except OSError:
                pass

        for attachment in pending_popen.values():
            try:
                os.close(attachment.pidfd)
            except OSError:
                pass

        for attachment in pending_trace_generations.values():
            try:
                os.close(attachment.pidfd)
            except OSError:
                pass

        if raw_creator_fixture is not None and raw_creator_fixture.child_pidfd is not None:
            try:
                os.close(raw_creator_fixture.child_pidfd)
            except OSError:
                pass

        if supervisor_generation is not None:
            try:
                os.close(supervisor_generation.pidfd)
            except OSError:
                pass

        if display_generation is not None:
            try:
                os.close(display_generation.pidfd)
            except OSError:
                pass

        try:
            retention = _retain_editor_logs(
                user_data,
                stdout_path,
                stderr_path,
                extension_path,
                primary_passed=passed,
                primary_failure=failure,
            )
        except BaseException as retention_error:
            retention = {"retentionPassed": False, "rawStreamErrors": [str(retention_error)]}

            try:
                print(
                    json.dumps(
                        {"editorLogRetentionFailure": str(retention_error)},
                        separators=(",", ":"),
                    ),
                    file=sys.stderr,
                )
            except BaseException:
                pass

        retention_failed_after_pass = passed and not retention["retentionPassed"]

        if retention_failed_after_pass:
            passed = False

        if passed:
            shutil.rmtree(temporary_root)
        else:
            print(f"Linux editor fixture retained at {temporary_root}", file=sys.stderr)

        if retention_failed_after_pass:
            raise CaptureError(
                "Editor stdout/stderr retention failed: "
                + "; ".join(retention["rawStreamErrors"])
            )


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except CaptureError as error:
        print(f"Linux editor capture failed: {error}", file=sys.stderr)

        raise SystemExit(1)
