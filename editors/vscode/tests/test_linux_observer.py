"""Focused filesystem controls for the Linux editor observer."""

from __future__ import annotations

import contextlib
from dataclasses import replace
import importlib.util
import io
import json
import os
import pathlib
import select
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from unittest import mock


OBSERVER_PATH = pathlib.Path(__file__).parents[1] / "test-linux.py"
OBSERVER_SPEC = importlib.util.spec_from_file_location("hesperia_linux_observer", OBSERVER_PATH)

if OBSERVER_SPEC is None or OBSERVER_SPEC.loader is None:
    raise RuntimeError(f"Could not load the Linux editor observer at {OBSERVER_PATH}")

observer = importlib.util.module_from_spec(OBSERVER_SPEC)
sys.modules[OBSERVER_SPEC.name] = observer

OBSERVER_SPEC.loader.exec_module(observer)


class NodeServiceProcHistoryTests(unittest.TestCase):
    def test_postexec_title_preserves_observed_arguments_and_binds_native_role(self) -> None:
        executable = "/usr/share/code/code"
        native_argv = [
            "/proc/self/exe",
            "--type=utility",
            "--utility-sub-type=node.mojom.NodeService",
            "--user-data-dir=/tmp/editor profile",
        ]
        title = (
            "/usr/share/code/code --type=utility --utility-sub-type=node.mojom.NodeService"
            " --user-data-dir=/tmp/editor profile"
        )
        completion_ns = 1_792_029_363_796_962_000
        transition = {
            "resolvedPath": executable,
            "completionNs": completion_ns,
            "argv": native_argv,
        }

        for observed_argv in ([executable, *native_argv[1:]], [title]):
            with self.subTest(observed_argv=observed_argv):
                generation = observer.Generation(41, 40, 1234, -1, observer.utc_at_ns(completion_ns))
                proc = {
                    "pid": 41,
                    "ppid": 40,
                    "tgid": 41,
                    "startTicks": 1234,
                    "executablePath": executable,
                    "argv": list(observed_argv),
                }

                generation.observe(proc, completion_ns + 1, completion_ns + 2)

                self.assertTrue(generation.qualify_after_exec(transition))

                self.assertTrue(observer.has_node_service_proc_history(generation, executable, transition))

                self.assertEqual(generation.executions[0]["argv"], observed_argv)

                self.assertEqual(generation.current_proc["argv"], observed_argv)

        controls = [
            ("changed title", [title + " --foreign"], native_argv, executable, completion_ns + 1),
            ("truncated title", [title[:-1]], native_argv, executable, completion_ns + 1),
            ("hybrid argv", [title, "--foreign"], native_argv, executable, completion_ns + 1),
            (
                "wrong raw role",
                [title.replace("--type=utility", "--type=renderer")],
                [argument.replace("--type=utility", "--type=renderer") for argument in native_argv],
                executable,
                completion_ns + 1,
            ),
            (
                "wrong raw subtype",
                [title.replace("node.mojom.NodeService", "foreign.Service")],
                [argument.replace("node.mojom.NodeService", "foreign.Service") for argument in native_argv],
                executable,
                completion_ns + 1,
            ),
            ("wrong executable", [title], native_argv, "/usr/share/foreign/code", completion_ns + 1),
            ("preexec sample", [title], native_argv, executable, completion_ns - 1),
            ("sample at exec", [title], native_argv, executable, completion_ns),
        ]

        for label, argv, raw_argv, image_path, observed_ns in controls:
            with self.subTest(control=label):
                generation = observer.Generation(41, 40, 1234, -1, observer.utc_at_ns(completion_ns))
                proc = {
                    "pid": 41,
                    "ppid": 40,
                    "tgid": 41,
                    "startTicks": 1234,
                    "executablePath": image_path,
                    "argv": argv,
                }

                generation.observe(proc, observed_ns, observed_ns + 1)

                self.assertFalse(observer.has_node_service_proc_history(
                    generation, executable, {**transition, "argv": raw_argv}
                ))


class RetainedGenerationTests(unittest.TestCase):
    def test_zombie_leader_invalidates_image_until_pidfd_is_ready(self) -> None:
        for exit_stage in ("before-sample", "after-complete-sample", "after-incomplete-argv"):
            with self.subTest(exit_stage=exit_stage):
                self.check_zombie_leader_invalidates_image_until_pidfd_is_ready(exit_stage)

    def check_zombie_leader_invalidates_image_until_pidfd_is_ready(self, exit_stage: str) -> None:
        worker_read_fd, worker_release_fd = os.pipe()
        child_script = r'''import ctypes, os, sys
libc = ctypes.CDLL(None)
argv_stage = sys.argv[2] == "after-incomplete-argv"
worker_fd = int(sys.argv[1])
if argv_stage:
    stat = open("/proc/self/stat").read()
    fields = stat[stat.rfind(")") + 1:].split()
    page_size = os.sysconf("SC_PAGE_SIZE")
    argv_page = int(fields[45]) // page_size * page_size
THREAD_START = ctypes.CFUNCTYPE(ctypes.c_void_p, ctypes.c_void_p)
def worker(_):
    buffer = ctypes.create_string_buffer(1)
    if argv_stage:
        libc.read(worker_fd, buffer, 1)
        if libc.mprotect(ctypes.c_void_p(argv_page), ctypes.c_size_t(page_size), 0):
            os._exit(1)
        sys.stdout.buffer.write(b"argv-empty\n")
        sys.stdout.buffer.flush()
        libc.read(worker_fd, buffer, 1)
        if libc.mprotect(ctypes.c_void_p(argv_page), ctypes.c_size_t(page_size), 3):
            os._exit(1)
        sys.stdout.buffer.write(b"argv-restored\n")
        sys.stdout.buffer.flush()
    libc.read(worker_fd, buffer, 1)
    return None
THREAD_START_CALLBACK = THREAD_START(worker)
thread = ctypes.c_ulong()
result = libc.pthread_create(ctypes.byref(thread), None, THREAD_START_CALLBACK, None)
if result:
    raise SystemExit(result)
sys.stdout.buffer.write(b"ready\n")
sys.stdout.buffer.flush()
sys.stdin.buffer.read(1)
libc.pthread_exit(None)
'''
        process: subprocess.Popen[bytes] | None = None
        pidfd: int | None = None
        child_read_fd_open = True
        argv_protection_requested = False
        argv_restored = False

        try:
            process = subprocess.Popen(
                [sys.executable, "-c", child_script, str(worker_read_fd), exit_stage],
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                pass_fds=(worker_read_fd,),
            )

            os.close(worker_read_fd)

            child_read_fd_open = False

            self.assertIsNotNone(process.stdout)

            self.assertTrue(select.select([process.stdout], [], [], 5)[0])

            self.assertEqual(process.stdout.readline(), b"ready\n")

            pid = process.pid
            pidfd = os.pidfd_open(pid, 0)

            def read_kernel_identity() -> dict[str, int | str]:
                stat = pathlib.Path(f"/proc/{pid}/stat").read_text(encoding="utf-8")
                fields = stat[stat.rfind(")") + 1 :].split()
                status = pathlib.Path(f"/proc/{pid}/status").read_text(encoding="utf-8")
                values = {}

                for line in status.splitlines():
                    key, separator, value = line.partition(":")

                    if separator:
                        values[key] = value.strip()

                return {
                    "pid": pid,
                    "state": fields[0],
                    "startTicks": int(fields[19]),
                    "tgid": int(values["Tgid"]),
                    "ppid": int(values["PPid"]),
                }

            deadline = time.monotonic() + 5

            while True:
                try:
                    identity = read_kernel_identity()
                    break
                except FileNotFoundError:
                    if time.monotonic() >= deadline:
                        raise

                    time.sleep(0.001)

            self.assertNotIn(identity["state"], {"Z", "X", "x"})

            self.assertEqual(identity["pid"], pid)

            self.assertEqual(identity["tgid"], pid)

            generation = observer.Generation(
                pid,
                int(identity["ppid"]),
                int(identity["startTicks"]),
                pidfd,
                observer.utc_now(),
            )

            observer.observe_retained_generation(generation)

            self.assertIsNotNone(generation.current_proc)

            transition = {
                "completionNs": int(generation.sample_started_ns) - 1,
                "resolvedPath": generation.current_proc["executablePath"],
            }

            self.assertTrue(generation.qualify_after_exec(transition))

            original_sample_proc = observer.sample_proc
            zombie_identities: list[dict[str, int | str]] = []

            def exit_leader() -> None:
                self.assertIsNotNone(process.stdin)

                process.stdin.write(b"x")

                process.stdin.flush()

                zombie_deadline = time.monotonic() + 5

                while True:
                    current = read_kernel_identity()

                    if current["state"] == "Z":
                        break

                    if time.monotonic() >= zombie_deadline:
                        self.fail(f"process leader did not become a zombie: {current!r}")

                    time.sleep(0.001)

                self.assertEqual(
                    {key: current[key] for key in ("pid", "tgid", "startTicks", "ppid")},
                    {key: identity[key] for key in ("pid", "tgid", "startTicks", "ppid")},
                )

                self.assertFalse(observer.pidfd_ready(pidfd))

                zombie_identities.append(current)

            def sample_at_transition(*args: object, **kwargs: object):
                nonlocal argv_protection_requested, argv_restored

                if exit_stage == "before-sample":
                    exit_leader()

                if exit_stage == "after-incomplete-argv":
                    argv_protection_requested = True

                    os.write(worker_release_fd, b"a")

                    self.assertTrue(select.select([process.stdout], [], [], 5)[0])

                    self.assertEqual(process.stdout.readline(), b"argv-empty\n")

                    self.assertEqual(pathlib.Path(f"/proc/{pid}/cmdline").read_bytes(), b"")

                try:
                    sampled = original_sample_proc(*args, **kwargs)
                except observer.IncompleteProcArgv:
                    if exit_stage == "after-incomplete-argv":
                        os.write(worker_release_fd, b"r")

                        self.assertTrue(select.select([process.stdout], [], [], 5)[0])

                        self.assertEqual(process.stdout.readline(), b"argv-restored\n")

                        argv_restored = True

                        exit_leader()

                    raise

                if exit_stage == "after-complete-sample":
                    exit_leader()

                return sampled

            with mock.patch.object(observer, "sample_proc", side_effect=sample_at_transition):
                observer.observe_retained_generation(generation)

            self.assertEqual(zombie_identities[0]["state"], "Z")

            self.assertFalse(generation.qualify_after_exec(transition))

            self.assertFalse(generation.check_exit())

            observer.observe_retained_generation(generation)

            self.assertFalse(generation.qualify_after_exec(transition))

            self.assertFalse(generation.check_exit())

            generation.start_ticks += 1
            with self.assertRaises(observer.CaptureError):
                observer.observe_retained_generation(generation)
            generation.start_ticks = int(identity["startTicks"])

            self.assertFalse(observer.pidfd_ready(pidfd))

            forced_pids: list[int] = []

            observer.terminate_retained_generation(generation, forced_pids)

            self.assertEqual(forced_pids, [pid])

            self.assertTrue(observer.pidfd_ready(pidfd))

            observer.observe_retained_generation(generation)

            self.assertTrue(generation.check_exit())

            self.assertIsNotNone(generation.ready_at)

            self.assertEqual(process.wait(timeout=5), -signal.SIGKILL)

            self.assertFalse(generation.qualify_after_exec(transition))
        finally:
            if argv_protection_requested and not argv_restored and process is not None and process.poll() is None:
                process.kill()

            if process is not None and process.stdin is not None and process.poll() is None:
                try:
                    process.stdin.write(b"x")

                    process.stdin.flush()
                except OSError:
                    pass

            try:
                os.write(worker_release_fd, b"x")
            except OSError:
                pass

            if child_read_fd_open:
                os.close(worker_read_fd)

            if process is not None and process.poll() is None:
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    process.kill()

                    process.wait(timeout=5)

            if process is not None:
                for stream in (process.stdin, process.stdout, process.stderr):
                    if stream is not None:
                        stream.close()

            if pidfd is not None:
                os.close(pidfd)

            os.close(worker_release_fd)

    def test_reversed_periodic_sample_discards_stale_image_and_recovers(self) -> None:
        pid = os.getpid()
        proc = observer.parse_proc(pid)
        pidfd = os.pidfd_open(pid, 0)

        self.addCleanup(os.close, pidfd)

        attached_ns = time.time_ns()
        generation = observer.Generation(
            pid,
            proc["ppid"],
            proc["startTicks"],
            pidfd,
            observer.utc_at_ns(attached_ns),
        )
        previous_started_ns = attached_ns + 10_000_000
        previous_finished_ns = previous_started_ns + 2_000_000
        with mock.patch.object(
            observer.time,
            "time_ns",
            side_effect=[previous_started_ns, previous_finished_ns],
        ):
            observer.observe_retained_generation(generation)

        previous_transition = {
            "completionNs": previous_started_ns - 1,
            "resolvedPath": proc["executablePath"],
        }

        self.assertTrue(generation.qualify_after_exec(previous_transition))

        reversed_started_ns = previous_finished_ns + 10_000_000
        reversed_finished_ns = reversed_started_ns - 1_464_301
        with mock.patch.object(
            observer.time,
            "time_ns",
            side_effect=[reversed_started_ns, reversed_finished_ns],
        ):
            observer.observe_retained_generation(generation)

        self.assertFalse(generation.qualify_after_exec(previous_transition))

        recovered_started_ns = reversed_started_ns + 2_000_000
        recovered_finished_ns = recovered_started_ns + 2_000_000
        recovered_transition = {
            "completionNs": recovered_started_ns - 1,
            "resolvedPath": proc["executablePath"],
        }

        self.assertFalse(generation.qualify_after_exec(recovered_transition))

        with mock.patch.object(
            observer.time,
            "time_ns",
            side_effect=[recovered_started_ns, recovered_finished_ns],
        ):
            observer.observe_retained_generation(generation)

        self.assertTrue(generation.qualify_after_exec(recovered_transition))

    def test_parent_change_during_retained_sample_discards_image_and_recovers(self) -> None:
        import ctypes

        self.assertTrue(hasattr(os, "pidfd_open"), "the Linux observer owner requires pidfd support")

        libc = ctypes.CDLL(None, use_errno=True)
        previous_subreaper = ctypes.c_int()

        self.assertEqual(libc.prctl(37, ctypes.byref(previous_subreaper), 0, 0, 0), 0)

        self.assertEqual(libc.prctl(36, 1, 0, 0, 0), 0)

        helper_script = r'''import os, sys
release_fd, child_gate_fd = map(int, sys.argv[1:])
child_pid = os.fork()
if child_pid == 0:
    os.close(release_fd)
    os.close(1)
    os.read(child_gate_fd, 1)
    os._exit(0)
os.close(child_gate_fd)
os.write(1, f"{child_pid}\n".encode())
os.read(release_fd, 1)
os._exit(0)
'''

        try:
            for release_bracket in ("before-sample", "after-sample"):
                with self.subTest(release_bracket=release_bracket):
                    process: subprocess.Popen[bytes] | None = None
                    helper_release_read: int | None = None
                    helper_release_write: int | None = None
                    child_gate_read: int | None = None
                    child_gate_write: int | None = None
                    cleanup_pidfd: int | None = None
                    generation: observer.Generation | None = None
                    child_pid: int | None = None
                    helper_released = False
                    parent_fds: list[int] = []

                    def release_helper_and_wait() -> None:
                        nonlocal helper_release_write, helper_released

                        if process is None:
                            raise AssertionError("fixture helper was not started")

                        if not helper_released:
                            self.assertIsNotNone(helper_release_write)

                            os.write(helper_release_write, b"x")

                            os.close(helper_release_write)

                            parent_fds.remove(helper_release_write)

                            helper_release_write = None
                            helper_released = True

                        self.assertEqual(process.wait(timeout=5), 0)

                    def wait_for_adoption() -> dict[str, int | str]:
                        self.assertIsNotNone(child_pid)

                        deadline = time.monotonic() + 5

                        while True:
                            identity = observer.parse_proc(child_pid)

                            if identity["ppid"] == os.getpid():
                                return identity

                            if time.monotonic() >= deadline:
                                self.fail(f"child did not adopt to the test subreaper: {identity!r}")

                            time.sleep(0.001)

                    try:
                        helper_release_read, helper_release_write = os.pipe()
                        child_gate_read, child_gate_write = os.pipe()

                        parent_fds.extend(
                            (helper_release_read, helper_release_write, child_gate_read, child_gate_write)
                        )

                        process = subprocess.Popen(
                            [
                                sys.executable,
                                "-c",
                                helper_script,
                                str(helper_release_read),
                                str(child_gate_read),
                            ],
                            stdin=subprocess.DEVNULL,
                            stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE,
                            pass_fds=(helper_release_read, child_gate_read),
                        )

                        for fd in (helper_release_read, child_gate_read):
                            os.close(fd)

                            parent_fds.remove(fd)

                        helper_release_read = None
                        child_gate_read = None

                        self.assertIsNotNone(process.stdout)

                        self.assertTrue(select.select([process.stdout], [], [], 5)[0])

                        child_pid = int(process.stdout.readline().strip())

                        self.assertGreater(child_pid, 0)

                        helper_pid = process.pid
                        cleanup_pidfd = os.pidfd_open(child_pid, 0)
                        initial_identity = observer.parse_proc(child_pid)

                        self.assertEqual(initial_identity["pid"], child_pid)

                        self.assertEqual(initial_identity["tgid"], child_pid)

                        self.assertGreater(initial_identity["startTicks"], 0)

                        self.assertEqual(initial_identity["ppid"], helper_pid)

                        self.assertFalse(observer.pidfd_ready(cleanup_pidfd))

                        generation = observer.open_generation(child_pid, {})

                        self.assertIsNotNone(generation, "the gated child was not admitted through the real pidfd path")

                        self.assertEqual(generation.ppid, helper_pid)

                        self.assertEqual(generation.start_ticks, initial_identity["startTicks"])

                        self.assertTrue(generation.current_image_complete)

                        self.assertIsNotNone(generation.current_proc)

                        self.assertIsNotNone(generation.sample_started_ns)

                        self.assertIsNotNone(generation.sample_finished_ns)

                        previous_executions = [dict(item) for item in generation.executions]
                        previous_parents = [dict(item) for item in generation.parents]
                        original_sample_proc = observer.sample_proc

                        def sample_across_adoption(*args: object, **kwargs: object):
                            if release_bracket == "before-sample":
                                release_helper_and_wait()

                                wait_for_adoption()

                                return original_sample_proc(*args, **kwargs)

                            genuine_sample = original_sample_proc(*args, **kwargs)

                            release_helper_and_wait()

                            wait_for_adoption()

                            return genuine_sample

                        with mock.patch.object(observer, "sample_proc", side_effect=sample_across_adoption):
                            observer.observe_retained_generation(generation)

                        adopted_identity = wait_for_adoption()

                        self.assertEqual(adopted_identity["pid"], child_pid)

                        self.assertEqual(adopted_identity["tgid"], child_pid)

                        self.assertEqual(adopted_identity["startTicks"], initial_identity["startTicks"])

                        self.assertFalse(observer.pidfd_ready(cleanup_pidfd))

                        self.assertFalse(generation.current_image_complete)

                        self.assertIsNone(generation.current_proc)

                        self.assertIsNone(generation.sample_started_ns)

                        self.assertIsNone(generation.sample_finished_ns)

                        self.assertEqual(generation.executions, previous_executions)

                        self.assertEqual(generation.parents, previous_parents)

                        observer.observe_retained_generation(generation)

                        self.assertFalse(observer.pidfd_ready(cleanup_pidfd))

                        self.assertTrue(generation.current_image_complete)

                        self.assertIsNotNone(generation.current_proc)

                        self.assertIsNotNone(generation.sample_started_ns)

                        self.assertIsNotNone(generation.sample_finished_ns)

                        self.assertLessEqual(generation.sample_started_ns, generation.sample_finished_ns)

                        self.assertEqual(generation.executions, previous_executions)

                        self.assertEqual(generation.parents[:-1], previous_parents)

                        self.assertEqual(generation.parents[-1]["pid"], os.getpid())

                        self.assertEqual(generation.current_proc["pid"], child_pid)

                        self.assertEqual(generation.current_proc["tgid"], child_pid)

                        self.assertEqual(generation.current_proc["startTicks"], initial_identity["startTicks"])
                    finally:
                        try:
                            if process is not None and not helper_released:
                                try:
                                    release_helper_and_wait()
                                except (AssertionError, OSError, subprocess.TimeoutExpired):
                                    if process.poll() is None:
                                        process.kill()

                                        process.wait(timeout=5)

                            if child_gate_write is not None:
                                try:
                                    os.write(child_gate_write, b"x")
                                except OSError:
                                    pass

                                try:
                                    os.close(child_gate_write)
                                except OSError:
                                    pass

                                if child_gate_write in parent_fds:
                                    parent_fds.remove(child_gate_write)

                                child_gate_write = None

                            if process is not None and process.poll() is None:
                                process.kill()

                                process.wait(timeout=5)

                            if child_pid is not None:
                                deadline = time.monotonic() + 5
                                cleanup_signal_sent = False

                                while True:
                                    try:
                                        reaped_pid, _ = os.waitpid(child_pid, os.WNOHANG)
                                    except ChildProcessError:
                                        break

                                    if reaped_pid == child_pid:
                                        break

                                    if time.monotonic() >= deadline:
                                        if cleanup_pidfd is None or cleanup_signal_sent:
                                            raise AssertionError("gated fixture child did not exit during bounded cleanup")

                                        signal.pidfd_send_signal(cleanup_pidfd, signal.SIGKILL)

                                        cleanup_signal_sent = True
                                        deadline = time.monotonic() + 5

                                    time.sleep(0.001)
                        finally:
                            if process is not None:
                                for stream in (process.stdin, process.stdout, process.stderr):
                                    if stream is not None:
                                        stream.close()

                            if generation is not None:
                                os.close(generation.pidfd)

                            if cleanup_pidfd is not None:
                                os.close(cleanup_pidfd)

                            for fd in parent_fds:
                                try:
                                    os.close(fd)
                                except OSError:
                                    pass
        finally:
            self.assertEqual(libc.prctl(36, previous_subreaper.value, 0, 0, 0), 0)

    def test_initial_incomplete_sample_exit_before_pidfd_does_not_admit_generation(self) -> None:
        import errno

        self.assertTrue(hasattr(os, "pidfd_open"), "the Linux observer owner requires pidfd support")

        child_script = r'''import sys
sys.stdout.buffer.write(b"ready\n")
sys.stdout.buffer.flush()
sys.stdin.buffer.read(1)
'''
        process: subprocess.Popen[bytes] | None = None
        cleanup_pidfd: int | None = None

        try:
            process = subprocess.Popen(
                [sys.executable, "-c", child_script],
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
            )

            self.assertIsNotNone(process.stdin)

            self.assertIsNotNone(process.stdout)

            self.assertTrue(select.select([process.stdout], [], [], 5)[0])

            self.assertEqual(process.stdout.readline(), b"ready\n")

            pid = process.pid
            cleanup_pidfd = os.pidfd_open(pid, 0)
            initial_proc = observer.parse_proc(pid)
            initial_identity = observer.read_proc_kernel_identity(pid, "incomplete attachment fixture setup")

            self.assertEqual(initial_proc["pid"], pid)

            self.assertEqual(initial_proc["tgid"], pid)

            self.assertGreater(initial_proc["startTicks"], 0)

            self.assertEqual(initial_identity["startTicks"], initial_proc["startTicks"])

            self.assertFalse(observer.pidfd_ready(cleanup_pidfd))

            cmdline_path = pathlib.Path("/proc") / str(pid) / "cmdline"
            exe_path = pathlib.Path("/proc") / str(pid) / "exe"
            original_read_bytes = pathlib.Path.read_bytes
            original_readlink = os.readlink
            original_pidfd_open = os.pidfd_open
            zombie_identities: list[dict[str, int | str]] = []
            cmdline_samples: list[bytes] = []
            exe_readlink_errnos: list[int | None] = []
            pidfd_open_errnos: list[int | None] = []
            reap_result: int | None = None

            def wait_for_cleanup_pidfd_ready() -> None:
                deadline = time.monotonic() + 5

                while not observer.pidfd_ready(cleanup_pidfd):
                    if time.monotonic() >= deadline:
                        self.fail("single-thread fixture pidfd did not become ready for its zombie")

                    time.sleep(0.001)

            def read_bytes(path: pathlib.Path) -> bytes:
                if path == cmdline_path:
                    self.assertIsNotNone(process.stdin)

                    process.stdin.write(b"x")

                    process.stdin.flush()

                    deadline = time.monotonic() + 5

                    while True:
                        identity = observer.read_proc_kernel_identity(
                            pid,
                            "incomplete attachment fixture zombie transition",
                            allow_zombie=True,
                        )

                        if identity["state"] == "Z":
                            zombie_identities.append(identity)

                            break

                        if time.monotonic() >= deadline:
                            self.fail(f"fixture child did not reach a real zombie state: {identity!r}")

                        time.sleep(0.001)

                    wait_for_cleanup_pidfd_ready()

                content = original_read_bytes(path)

                if path == cmdline_path:
                    cmdline_samples.append(content)

                return content

            def readlink(path: str | os.PathLike[str], *args: object, **kwargs: object) -> str:
                try:
                    return original_readlink(path, *args, **kwargs)
                except FileNotFoundError as error:
                    if pathlib.Path(path) == exe_path:
                        exe_readlink_errnos.append(error.errno)

                    raise

            def pidfd_open(target_pid: int, *args: object, **kwargs: object) -> int:
                nonlocal reap_result

                if target_pid == pid:
                    self.assertTrue(zombie_identities)

                    wait_for_cleanup_pidfd_ready()

                    self.assertIsNotNone(process)

                    reap_result = process.wait(timeout=5)

                try:
                    return original_pidfd_open(target_pid, *args, **kwargs)
                except ProcessLookupError as error:
                    if target_pid == pid:
                        pidfd_open_errnos.append(error.errno)

                    raise

            pending: dict[int, observer.PendingTraceGeneration] = {}
            with (
                mock.patch.object(pathlib.Path, "read_bytes", new=read_bytes),
                mock.patch.object(os, "readlink", side_effect=readlink),
                mock.patch.object(os, "pidfd_open", side_effect=pidfd_open),
            ):
                generation = observer.open_generation(pid, pending)

            self.assertIsNone(generation)

            self.assertFalse(pending)

            self.assertEqual(zombie_identities[0]["state"], "Z")

            self.assertEqual(zombie_identities[0]["pid"], pid)

            self.assertEqual(zombie_identities[0]["tgid"], pid)

            self.assertEqual(zombie_identities[0]["startTicks"], initial_proc["startTicks"])

            self.assertEqual(zombie_identities[0]["ppid"], initial_proc["ppid"])

            self.assertIn(b"", cmdline_samples)

            self.assertIn(errno.ENOENT, exe_readlink_errnos)

            self.assertIn(errno.ESRCH, pidfd_open_errnos)

            self.assertEqual(reap_result, 0)

            self.assertTrue(observer.pidfd_ready(cleanup_pidfd))

            self.assertEqual(process.wait(timeout=5), 0)
        finally:
            try:
                if process is not None and process.stdin is not None:
                    try:
                        process.stdin.write(b"x")

                        process.stdin.flush()
                    except OSError:
                        pass

                if process is not None:
                    try:
                        process.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        if cleanup_pidfd is not None:
                            try:
                                signal.pidfd_send_signal(cleanup_pidfd, signal.SIGKILL)
                            except ProcessLookupError:
                                pass
                        else:
                            process.kill()

                        process.wait(timeout=5)
            finally:
                try:
                    if process is not None:
                        for stream in (process.stdin, process.stdout, process.stderr):
                            if stream is not None:
                                try:
                                    stream.close()
                                except BrokenPipeError:
                                    pass
                finally:
                    if cleanup_pidfd is not None:
                        os.close(cleanup_pidfd)

    def test_raw_only_creator_reparenting_uses_real_pidfd_and_strace_evidence(self) -> None:
        self.check_raw_only_creator_reparenting("fork")

    def test_spawned_raw_only_creator_child_uses_real_pidfd_and_strace_evidence(self) -> None:
        self.check_raw_only_creator_reparenting("posix-spawn")

    def test_retained_creator_sampled_after_child_birth_proves_reparenting(self) -> None:
        self.check_raw_only_creator_reparenting("posix-spawn", retain_creator=True)

    def check_raw_only_creator_reparenting(self, creation: str, *, retain_creator: bool = False) -> None:
        import ctypes

        strace = shutil.which("strace")

        self.assertIsNotNone(strace, "the Linux observer owner requires the prepared strace runtime")

        self.assertTrue(hasattr(os, "pidfd_open"), "the Linux observer owner requires pidfd support")

        libc = ctypes.CDLL(None, use_errno=True)
        previous_subreaper = ctypes.c_int()

        self.assertEqual(libc.prctl(37, ctypes.byref(previous_subreaper), 0, 0, 0), 0)

        self.assertEqual(libc.prctl(36, 1, 0, 0, 0), 0)

        process: subprocess.Popen[bytes] | None = None
        root_pidfd: int | None = None
        child_pidfd: int | None = None
        helper_pidfd: int | None = None
        cleanup_pidfds: list[int] = []
        parent_fds: list[int] = []
        root_pid: int | None = None
        helper_pid: int | None = None
        child_pid: int | None = None
        root_gate_write: int | None = None
        child_gate_write: int | None = None
        helper_gate_write: int | None = None

        try:
            with tempfile.TemporaryDirectory(prefix="hesperia-raw-only-creator-") as temporary:
                directory = pathlib.Path(temporary)
                trace_directory = directory / "trace"

                trace_directory.mkdir()

                protocol_read, protocol_write = os.pipe()

                parent_fds.extend((protocol_read, protocol_write))

                root_gate_read, root_gate_write = os.pipe()

                parent_fds.extend((root_gate_read, root_gate_write))

                child_gate_read, child_gate_write = os.pipe()

                parent_fds.extend((child_gate_read, child_gate_write))

                helper_gate_read, helper_gate_write = os.pipe()

                parent_fds.extend((helper_gate_read, helper_gate_write))

                anchor_script = r'''import os, sys
protocol_fd, root_gate_fd, child_gate_fd, helper_gate_fd = map(int, sys.argv[1:5])
creation = sys.argv[5]
retain_creator = sys.argv[6] == "1"
os.write(protocol_fd, f"anchor {os.getpid()}\n".encode())
helper_pid = os.fork()
if helper_pid == 0:
    if creation == "posix-spawn":
        child_script = "import os,sys; protocol_fd,gate_fd=map(int,sys.argv[1:]); os.write(protocol_fd,f'child {os.getpid()}\\n'.encode()); os.read(gate_fd,1); os._exit(0)"
        child_pid = os.posix_spawn(sys.executable, [sys.executable, "-c", child_script, str(protocol_fd), str(child_gate_fd)], os.environ)
    else:
        child_pid = os.fork()
    if creation == "fork" and child_pid == 0:
        os.write(protocol_fd, f"child {os.getpid()}\n".encode())
        os.read(child_gate_fd, 1)
        os._exit(0)
    os.write(protocol_fd, f"helper {os.getpid()}\n".encode())
    if retain_creator or creation == "fork":
        os.read(helper_gate_fd, 1)
    os._exit(0)
os.read(root_gate_fd, 1)
os._exit(0)
'''
                launcher_script = r'''import os, sys
anchor = os.fork()
if anchor == 0:
    os.execv(sys.executable, [sys.executable, sys.argv[1], *sys.argv[2:]])
os.waitpid(anchor, 0)
'''
                launcher_path = directory / "launcher.py"
                anchor_path = directory / "anchor.py"

                launcher_path.write_text(launcher_script, encoding="utf-8")

                anchor_path.write_text(anchor_script, encoding="utf-8")

                trace_prefix = trace_directory / "native-process-trace"
                process = subprocess.Popen(
                    [
                        strace,
                        "-ff",
                        "-ttt",
                        "-v",
                        "-s",
                        "8192",
                        "-e",
                        "trace=%process",
                        "-o",
                        str(trace_prefix),
                        "--",
                        sys.executable,
                        str(launcher_path),
                        str(anchor_path),
                        str(protocol_write),
                        str(root_gate_read),
                        str(child_gate_read),
                        str(helper_gate_read),
                        creation,
                        "1" if retain_creator else "0",
                    ],
                    cwd=directory,
                    stdin=subprocess.DEVNULL,
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                    pass_fds=(protocol_write, root_gate_read, child_gate_read, helper_gate_read),
                    start_new_session=True,
                )

                for fd in (protocol_write, root_gate_read, child_gate_read, helper_gate_read):
                    os.close(fd)

                    parent_fds.remove(fd)

                protocol_buffer = b""
                identities: dict[str, int] = {}
                deadline = time.monotonic() + 5

                while not {"anchor", "helper", "child"} <= identities.keys():
                    remaining = deadline - time.monotonic()

                    if remaining <= 0:
                        self.fail(f"traced process tree did not publish identities: {identities!r}")

                    readable, _, _ = select.select([protocol_read], [], [], remaining)

                    if not readable:
                        self.fail(f"traced process tree did not publish identities: {identities!r}")

                    chunk = os.read(protocol_read, 256)

                    if not chunk:
                        self.fail(f"traced process tree closed its identity pipe: {identities!r}")

                    protocol_buffer += chunk

                    while b"\n" in protocol_buffer:
                        raw_line, protocol_buffer = protocol_buffer.split(b"\n", 1)
                        role, raw_pid = raw_line.decode("ascii").split(" ", 1)

                        self.assertIn(role, {"anchor", "helper", "child"})

                        self.assertNotIn(role, identities)

                        identities[role] = int(raw_pid)

                root_pid = identities["anchor"]
                helper_pid = identities["helper"]
                child_pid = identities["child"]

                self.assertEqual(len(set(identities.values())), 3)

                self.assertNotEqual(root_pid, process.pid)

                cleanup_pidfds.append(os.pidfd_open(root_pid, 0))

                cleanup_pidfds.append(os.pidfd_open(child_pid, 0))

                helper_generation = None
                pre_adoption_trace = None

                if retain_creator:
                    helper_generation = observer.open_generation(helper_pid, {})

                    self.assertIsNotNone(helper_generation, "the live creator was not retained")

                    helper_pidfd = helper_generation.pidfd

                    os.write(helper_gate_write, b"x")
                elif creation == "fork":
                    trace_deadline = time.monotonic() + 5

                    while time.monotonic() < trace_deadline:
                        candidate_trace = observer.scan_trace(trace_directory, "native-process-trace")

                        if candidate_trace["creations"].get(child_pid):
                            pre_adoption_trace = candidate_trace
                            break

                        time.sleep(0.001)

                    self.assertIsNotNone(pre_adoption_trace, "the live helper child birth was not traced")

                    self.assertNotIn(helper_pid, pre_adoption_trace["exits"])

                    os.write(helper_gate_write, b"x")

                helper_trace = trace_directory / f"native-process-trace.{helper_pid}"
                helper_terminal_ns: int | None = None
                adopted_identity: dict[str, int | str] | None = None
                adoption_deadline = time.monotonic() + 5

                while time.monotonic() < adoption_deadline:
                    if helper_trace.exists():
                        for raw_line in observer.raw_lines(helper_trace):
                            line = raw_line.decode("utf-8", errors="strict").rstrip("\r\n")

                            if observer.EXIT_RE.search(line) or observer.SIGNAL_RE.search(line):
                                helper_terminal_ns = observer.trace_time_ns(line)

                    try:
                        current = observer.parse_proc(child_pid)
                    except (FileNotFoundError, ProcessLookupError):
                        current = None

                    if helper_terminal_ns is not None and current is not None and current["ppid"] == os.getpid():
                        adopted_identity = current
                        break

                    time.sleep(0.001)

                self.assertIsNotNone(helper_terminal_ns, "raw trace did not record the helper terminal")

                self.assertIsNotNone(adopted_identity, "child did not reparent to the test subreaper")

                self.assertNotEqual(adopted_identity["ppid"], helper_pid)

                pending: dict[int, observer.PendingTraceGeneration] = {}
                root_generation = observer.open_generation(root_pid, pending)
                child_generation = observer.open_generation(child_pid, pending, pre_adoption_trace)

                if pre_adoption_trace is not None:
                    self.assertIsNone(child_generation, "an adopted child was admitted before raw creator closure")

                    attachment = pending[child_pid]
                    child_pidfd = attachment.pidfd
                    deferred_at = time.time_ns()
                    retry_trace = observer.scan_trace(trace_directory, "native-process-trace")
                    admitted: dict[int, observer.Generation] = {}

                    observer.retry_pending_trace_generation(child_pid, pending, admitted, pre_adoption_trace)

                    self.assertNotIn(child_pid, admitted, "a stale raw snapshot admitted the adopted child on retry")

                    self.assertIs(pending[child_pid], attachment)

                    observer.retry_pending_trace_generation(child_pid, pending, admitted, retry_trace)

                    child_generation = admitted.get(child_pid)

                    self.assertIsNotNone(child_generation, "the fresh post-closure parent sample was not admitted")

                    self.assertEqual(child_generation.pidfd, attachment.pidfd)

                    self.assertEqual(child_generation.start_ticks, attachment.start_ticks)

                    self.assertEqual(child_generation.attached_at, attachment.attached_at)

                    self.assertGreaterEqual(
                        observer.utc_time_ns(child_generation.parents[0]["observedAt"]), deferred_at
                    )

                self.assertIsNotNone(root_generation, "the retained anchor was not admitted")

                self.assertIsNotNone(child_generation, "the reparented child was not admitted")

                self.assertFalse(pending, "the retained fixture left pending PID generations")

                root_pidfd = root_generation.pidfd
                child_pidfd = child_generation.pidfd

                self.assertEqual(child_generation.ppid, os.getpid())

                self.assertEqual(child_generation.start_ticks, adopted_identity["startTicks"])

                first_parent_ns = observer.utc_time_ns(child_generation.parents[0]["observedAt"])

                self.assertGreater(first_parent_ns, helper_terminal_ns)

                generations = {root_pid: root_generation, child_pid: child_generation}

                if helper_generation is not None:
                    generations[helper_pid] = helper_generation

                    self.assertTrue(helper_generation.check_exit())

                os.write(child_gate_write, b"x")

                os.write(root_gate_write, b"x")

                for pidfd in (root_pidfd, child_pidfd):
                    readiness_deadline = time.monotonic() + 5

                    while not observer.pidfd_ready(pidfd):
                        if time.monotonic() >= readiness_deadline:
                            self.fail("a retained process pidfd did not become ready after its gate opened")

                        time.sleep(0.001)

                self.assertTrue(root_generation.check_exit())

                self.assertTrue(child_generation.check_exit())

                first_ready_at = {pid: generation.ready_at for pid, generation in generations.items()}

                self.assertEqual(process.wait(timeout=10), 0)

                try:
                    os.waitpid(child_pid, 0)
                except ChildProcessError:
                    pass

                try:
                    os.waitpid(helper_pid, os.WNOHANG)
                except ChildProcessError:
                    pass

                trace = observer.scan_trace(trace_directory, "native-process-trace", final=True)
                _, raw_files = observer.trace_files_manifest(trace_directory, "native-process-trace")

                for generation in generations.values():
                    self.assertTrue(observer.confirm_traced_exit(generation, trace, {}))

                    self.assertGreaterEqual(
                        observer.utc_time_ns(generation.ready_at),
                        observer.utc_time_ns(first_ready_at[generation.pid]),
                    )

                closed_pidfd = os.dup(child_generation.pidfd)
                os.close(closed_pidfd)

                with self.assertRaises(ValueError):
                    observer.confirm_traced_exit(replace(child_generation, pidfd=-1), trace, {})

                with self.assertRaisesRegex(observer.CaptureError, "readiness descriptor is invalid"):
                    observer.confirm_traced_exit(replace(child_generation, pidfd=closed_pidfd), trace, {})

                event = observer.process_event(
                    child_generation,
                    trace,
                    {},
                    raw_files,
                    generations,
                    os.path.realpath(sys.executable),
                    root_pid,
                )

                self.assertEqual(event["parentPid"], os.getpid())

                self.assertEqual(event["creator"]["parentPid"], helper_pid)

                if creation == "fork":
                    self.assertEqual(event["execEvents"], [])
                else:
                    self.assertEqual(len(event["execEvents"]), 1)

                    self.assertEqual(event["execEvents"][0]["resolvedPath"], os.path.realpath(sys.executable))

                if helper_generation is None:
                    self.assertNotIn(helper_pid, generations)

                    _, child_terminal_ns = observer.raw_process_group_closure(child_pid, trace, {})
                    confirmed_ready_at = child_generation.ready_at
                    child_generation.ready_at = observer.utc_at_ns(child_terminal_ns - 1)

                    try:
                        with self.assertRaisesRegex(observer.CaptureError, "pidfd and parent sample do not bind"):
                            observer.process_event(
                                child_generation, trace, {}, raw_files, generations,
                                os.path.realpath(sys.executable), root_pid,
                            )
                    finally:
                        child_generation.ready_at = confirmed_ready_at
                else:
                    birth = trace["creations"][child_pid][0]

                    self.assertGreater(
                        observer.utc_time_ns(helper_generation.parents[0]["observedAt"]), birth["startNs"]
                    )

                    original_attached_at = helper_generation.attached_at
                    original_parent_sample = helper_generation.parents[0]["observedAt"]
                    original_ready_at = helper_generation.ready_at
                    helper_birth_ns = trace["creations"][helper_pid][0]["startNs"]

                    for field, invalid_time in (
                        ("attached_at", helper_birth_ns),
                        ("parent_sample", helper_terminal_ns),
                        ("ready_at", helper_terminal_ns - 1),
                    ):
                        with self.subTest(invalid_creator_time=field):
                            helper_generation.attached_at = original_attached_at
                            helper_generation.parents[0]["observedAt"] = original_parent_sample
                            helper_generation.ready_at = original_ready_at

                            if field == "parent_sample":
                                helper_generation.parents[0]["observedAt"] = observer.utc_at_ns(invalid_time)
                            else:
                                setattr(helper_generation, field, observer.utc_at_ns(invalid_time))

                            with self.assertRaisesRegex(observer.CaptureError, "Raw creator group does not prove reparenting"):
                                observer.process_event(
                                    child_generation, trace, {}, raw_files, generations,
                                    os.path.realpath(sys.executable), root_pid,
                                )

                    helper_generation.attached_at = original_attached_at
                    helper_generation.parents[0]["observedAt"] = original_parent_sample
                    helper_generation.ready_at = original_ready_at
        finally:
            for fd in (child_gate_write, root_gate_write, helper_gate_write):
                if fd is not None and fd in parent_fds:
                    try:
                        os.write(fd, b"x")
                    except OSError:
                        pass

                    try:
                        os.close(fd)
                    except OSError:
                        pass

                    parent_fds.remove(fd)

            try:
                if process is not None and process.poll() is None:
                    for pidfd in (*cleanup_pidfds, child_pidfd, root_pidfd, helper_pidfd):
                        if pidfd is not None and not observer.pidfd_ready(pidfd):
                            try:
                                signal.pidfd_send_signal(pidfd, signal.SIGKILL)
                            except ProcessLookupError:
                                pass

                    readiness_deadline = time.monotonic() + 5

                    while any(not observer.pidfd_ready(pidfd) for pidfd in cleanup_pidfds):
                        if time.monotonic() >= readiness_deadline:
                            try:
                                os.killpg(process.pid, signal.SIGKILL)
                            except ProcessLookupError:
                                pass

                            break

                        time.sleep(0.001)

                    try:
                        process.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        try:
                            os.killpg(process.pid, signal.SIGKILL)
                        except ProcessLookupError:
                            pass

                        process.wait(timeout=5)

                if child_pid is not None:
                    try:
                        if cleanup_pidfds and all(observer.pidfd_ready(pidfd) for pidfd in cleanup_pidfds):
                            os.waitpid(child_pid, 0)
                    except ChildProcessError:
                        pass
                if helper_pid is not None:
                    try:
                        os.waitpid(helper_pid, os.WNOHANG)
                    except ChildProcessError:
                        pass
            finally:
                for pidfd in (*cleanup_pidfds, child_pidfd, root_pidfd, helper_pidfd):
                    if pidfd is not None:
                        try:
                            os.close(pidfd)
                        except OSError:
                            pass

                for fd in parent_fds:
                    try:
                        os.close(fd)
                    except OSError:
                        pass

                self.assertEqual(libc.prctl(36, previous_subreaper.value, 0, 0, 0), 0)


class TracedFilesTests(unittest.TestCase):
    def test_same_lexical_path_repeated_by_one_glob_is_one_pid(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            directory = pathlib.Path(temporary)
            path = directory / "native-process-trace.99"

            path.write_bytes(b"1790956887.385730 +++ killed by SIGKILL +++\n")

            original_glob = pathlib.Path.glob

            def repeat_real_target(path_directory: pathlib.Path, pattern: str):
                entries = list(original_glob(path_directory, pattern))

                if path_directory == directory and pattern == "native-process-trace.*":
                    return iter(entries + entries)

                return iter(entries)

            with mock.patch.object(pathlib.Path, "glob", repeat_real_target):
                result = observer.scan_trace(directory, "native-process-trace", final=True)

        self.assertEqual(len(result["files"]), 1)

        self.assertEqual(result["exits"][99]["outcome"], {"kind": "signal", "signal": "SIGKILL"})

    def test_distinct_spellings_for_one_pid_remain_ambiguous(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            directory = pathlib.Path(temporary)
            first = directory / "native-process-trace.99"
            second = directory / "native-process-trace.099"

            first.touch()

            second.touch()

            with self.assertRaisesRegex(observer.CaptureError, "Ambiguous strace output PID: 99"):
                observer.traced_files(directory, "native-process-trace")

    def test_invalid_suffix_and_nonpositive_pid_remain_rejected(self) -> None:
        for name, expected in (
            ("native-process-trace.nope", "Unexpected strace output name"),
            ("native-process-trace.0", "Ambiguous strace output PID: 0"),
        ):
            with self.subTest(name=name), tempfile.TemporaryDirectory() as temporary:
                directory = pathlib.Path(temporary)

                (directory / name).touch()

                with self.assertRaisesRegex(observer.CaptureError, expected):
                    observer.traced_files(directory, "native-process-trace")


class RawProcessCreationParsingTests(unittest.TestCase):
    def test_final_clone_flags_are_admitted_without_widening_image_inheritance(self) -> None:
        """Parser-format fixtures only; these do not prove native provenance or admission."""
        trace_lines = (
            "1791049502.153915 clone(child_stack=0x7d870af99ff0, flags=CLONE_VM|CLONE_VFORK|SIGCHLD) = 1499",
            "1791049502.153916 clone(child_stack=0x7d870af99ff0, flags=SIGCHLD) = 1500",
            "1791049502.153917 clone(child_stack=0x7d870af99ff0, flags=CLONE_PARENT|SIGCHLD) = 1501",
            "1791945357.564154 clone3({flags=CLONE_VM|CLONE_VFORK|CLONE_CLEAR_SIGHAND, exit_signal=SIGCHLD, stack=0x7f71f84f9000, stack_size=0x9000}, 88) = 32166",
            *(
                f"1791945357.565000 clone3({{flags=CLONE_VM|CLONE_VFORK|CLONE_CLEAR_SIGHAND|{flag}, exit_signal=SIGCHLD}}, 88) = {pid}"
                for pid, flag in enumerate(
                    ("CLONE_SIGHAND", "CLONE_PARENT", "CLONE_NEWPID", "CLONE_THREAD", "0x80000000"),
                    start=32167,
                )
            ),
        )
        with tempfile.TemporaryDirectory() as temporary:
            directory = pathlib.Path(temporary)

            (directory / "native-process-trace.1498").write_text(
                "\n".join(trace_lines) + "\n",
                encoding="utf-8",
            )

            trace = observer.scan_trace(directory, "native-process-trace", final=True)

        vm_vfork_edge = trace["creations"][1499][0]

        self.assertTrue(observer.raw_process_creation_is_supported(vm_vfork_edge))

        self.assertFalse(vm_vfork_edge["imageInheritanceSafe"])

        image_safe_edge = trace["creations"][1500][0]

        self.assertTrue(observer.raw_process_creation_is_supported(image_safe_edge))

        self.assertTrue(image_safe_edge["imageInheritanceSafe"])

        parent_changing_edge = trace["creations"][1501][0]

        self.assertFalse(observer.raw_process_creation_is_supported(parent_changing_edge))

        clear_sighand_edge = trace["creations"][32166][0]

        self.assertTrue(observer.raw_process_creation_is_supported(clear_sighand_edge))

        self.assertFalse(clear_sighand_edge["imageInheritanceSafe"])

        for pid in range(32167, 32172):
            with self.subTest(pid=pid):
                self.assertFalse(observer.raw_process_creation_is_supported(trace["creations"][pid][0]))


class EditorResultCopyTests(unittest.TestCase):
    def test_report_copy_does_not_depend_on_metadata_and_rejects_content_changes(self) -> None:
        payload = b'{"passed":true,"checks":["binary report bytes"]}\n'
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary)

            def report_paths(name: str) -> tuple[pathlib.Path, pathlib.Path]:
                case = root / name
                source = case / "workspace" / "editor-result.json"
                destination = case / "output" / "editor-result.json"

                source.parent.mkdir(parents=True)

                destination.parent.mkdir()

                source.write_bytes(payload)

                return source, destination

            with self.subTest(case="old copy2 exposes the metadata fault"):
                source, destination = report_paths("old-copy2")
                metadata_calls: list[tuple[str, str]] = []

                def deny_metadata(src, dst, **kwargs) -> None:
                    metadata_calls.append((str(src), str(dst)))

                    raise PermissionError(1, "injected report metadata denial", str(src), str(dst))

                with mock.patch.object(observer.shutil, "copystat", side_effect=deny_metadata):
                    with self.assertRaises(PermissionError) as raised:
                        observer.shutil.copy2(source, destination)

                self.assertEqual(raised.exception.errno, 1)

                self.assertTrue(metadata_calls)

                self.assertEqual(destination.read_bytes(), payload)

            with self.subTest(case="content copy survives metadata fault"):
                source, destination = report_paths("verified-copy")
                with mock.patch.object(
                    observer.shutil,
                    "copystat",
                    side_effect=PermissionError(1, "metadata must not be required"),
                ):
                    identity = observer._copy_editor_result(source, destination)

                self.assertEqual(destination.read_bytes(), payload)

                self.assertEqual(identity["sourceBefore"], identity["sourceAfter"])

                self.assertEqual(identity["sourceBefore"], identity["destinationIdentity"])

            with self.subTest(case="destination corruption is rejected"):
                source, destination = report_paths("corrupt-copy")
                copyfile = observer.shutil.copyfile

                def corrupt_destination(src, dst):
                    result = copyfile(src, dst)

                    pathlib.Path(dst).write_bytes(pathlib.Path(dst).read_bytes() + b"corrupt")

                    return result

                with mock.patch.object(observer.shutil, "copyfile", side_effect=corrupt_destination):
                    with self.assertRaisesRegex(observer.CaptureError, "does not match its source"):
                        observer._copy_editor_result(source, destination)

            with self.subTest(case="source drift during copy is rejected"):
                source, destination = report_paths("source-drift")
                copyfile = observer.shutil.copyfile

                def change_source(src, dst):
                    result = copyfile(src, dst)
                    with pathlib.Path(src).open("ab") as stream:
                        stream.write(b"changed")
                    return result

                with mock.patch.object(observer.shutil, "copyfile", side_effect=change_source):
                    with self.assertRaisesRegex(observer.CaptureError, "changed while copying"):
                        observer._copy_editor_result(source, destination)


class EditorLogRetentionTests(unittest.TestCase):
    def make_inputs(self):
        temporary = tempfile.TemporaryDirectory()
        root = pathlib.Path(temporary.name)
        user_data = root / "user-data"

        user_data.mkdir()

        extension_directory = root / "extension"

        extension_directory.mkdir()

        extension_path = extension_directory / "extension.cjs"

        extension_path.write_bytes(b"extension")

        stdout_path = root / "editor-stdout.log"
        stderr_path = root / "editor-stderr.log"

        stdout_path.write_bytes(b"stdout\x00with\r\nbytes\xff")

        stderr_path.write_bytes(b"stderr\x00with\r\nbytes\xfe")

        return temporary, user_data, stdout_path, stderr_path, extension_path

    def retention(
        self,
        user_data: pathlib.Path,
        stdout_path: pathlib.Path,
        stderr_path: pathlib.Path,
        extension_path: pathlib.Path,
        *,
        primary_passed: bool = True,
        primary_failure: str = "",
    ) -> dict[str, object]:
        return observer._retain_editor_logs(
            user_data,
            stdout_path,
            stderr_path,
            extension_path,
            primary_passed=primary_passed,
            primary_failure=primary_failure,
        )

    def evidence_directory(self, extension_path: pathlib.Path) -> pathlib.Path:
        return extension_path.parent / "editor-evidence" / "logs"

    def test_nonempty_binary_streams_are_content_verified_without_metadata_copy(self) -> None:
        temporary, user_data, stdout_path, stderr_path, extension_path = self.make_inputs()

        self.addCleanup(temporary.cleanup)

        with mock.patch.object(observer.shutil, "copystat", side_effect=PermissionError("metadata copy denied")):
            result = self.retention(user_data, stdout_path, stderr_path, extension_path)

        evidence = self.evidence_directory(extension_path)

        self.assertEqual(result["rawStreamErrors"], [])

        self.assertTrue(result["retentionPassed"])

        for source in (stdout_path, stderr_path):
            destination = evidence / source.name

            self.assertEqual(destination.read_bytes(), source.read_bytes())

            stream = result["streams"][source.name]

            self.assertTrue(stream["verified"])

            self.assertEqual(stream["sourceBefore"], stream["sourceAfter"])

            self.assertEqual(stream["sourceBefore"], stream["destinationIdentity"])

        receipt_path = evidence / "editor-log-retention.json"
        receipt = json.loads(receipt_path.read_text(encoding="utf-8"))

        self.assertEqual(receipt["retentionPassed"], result["retentionPassed"])

        self.assertEqual(receipt["streams"][stdout_path.name], result["streams"][stdout_path.name])

    def test_optional_log_tree_is_copied_before_raw_streams_overwrite_members(self) -> None:
        temporary, user_data, stdout_path, stderr_path, extension_path = self.make_inputs()

        self.addCleanup(temporary.cleanup)

        (user_data / "logs").mkdir()

        (user_data / "logs" / "renderer.log").write_bytes(b"optional VS Code log")

        (user_data / "logs" / stdout_path.name).write_bytes(b"old tree stdout")

        (user_data / "logs" / stderr_path.name).write_bytes(b"old tree stderr")

        result = self.retention(user_data, stdout_path, stderr_path, extension_path)

        evidence = self.evidence_directory(extension_path)

        self.assertIsNone(result["optionalLogTree"]["error"])

        self.assertTrue(result["optionalLogTree"]["attempted"])

        self.assertEqual((evidence / stdout_path.name).read_bytes(), stdout_path.read_bytes())

        self.assertEqual((evidence / stderr_path.name).read_bytes(), stderr_path.read_bytes())

        self.assertEqual((evidence / "renderer.log").read_bytes(), b"optional VS Code log")

    def test_optional_log_tree_error_does_not_skip_raw_streams(self) -> None:
        temporary, user_data, stdout_path, stderr_path, extension_path = self.make_inputs()

        self.addCleanup(temporary.cleanup)

        (user_data / "logs").mkdir()

        (user_data / "logs" / "renderer.log").write_bytes(b"optional VS Code log")

        with mock.patch.object(observer.shutil, "copytree", side_effect=PermissionError("optional tree denied")):
            result = self.retention(user_data, stdout_path, stderr_path, extension_path)

        evidence = self.evidence_directory(extension_path)

        self.assertEqual(result["optionalLogTree"]["error"], "optional tree denied")

        self.assertEqual(result["rawStreamErrors"], [])

        self.assertTrue(result["retentionPassed"])

        self.assertEqual((evidence / stdout_path.name).read_bytes(), stdout_path.read_bytes())

        self.assertEqual((evidence / stderr_path.name).read_bytes(), stderr_path.read_bytes())

    def test_first_stream_failure_does_not_skip_second_stream_and_fails_required_retention(self) -> None:
        temporary, user_data, stdout_path, stderr_path, extension_path = self.make_inputs()

        self.addCleanup(temporary.cleanup)

        copyfile = observer.shutil.copyfile

        def fail_stdout(source: pathlib.Path, destination: pathlib.Path) -> str:
            if pathlib.Path(source) == stdout_path:
                raise PermissionError("stdout copy denied")

            return copyfile(source, destination)

        with mock.patch.object(observer.shutil, "copyfile", side_effect=fail_stdout):
            result = self.retention(user_data, stdout_path, stderr_path, extension_path)

        evidence = self.evidence_directory(extension_path)

        self.assertFalse((evidence / stdout_path.name).exists())

        self.assertEqual((evidence / stderr_path.name).read_bytes(), stderr_path.read_bytes())

        self.assertFalse(result["retentionPassed"])

        self.assertEqual(len(result["rawStreamErrors"]), 1)

        self.assertIn("stdout copy denied", result["rawStreamErrors"][0])

    def test_destination_corruption_fails_content_verification(self) -> None:
        temporary, user_data, stdout_path, stderr_path, extension_path = self.make_inputs()

        self.addCleanup(temporary.cleanup)

        copyfile = observer.shutil.copyfile

        def corrupt_stdout(source: pathlib.Path, destination: pathlib.Path) -> str:
            result = copyfile(source, destination)

            if pathlib.Path(source) == stdout_path:
                pathlib.Path(destination).write_bytes(pathlib.Path(destination).read_bytes() + b"corrupt")

            return result

        with mock.patch.object(observer.shutil, "copyfile", side_effect=corrupt_stdout):
            result = self.retention(user_data, stdout_path, stderr_path, extension_path)

        stdout = result["streams"][stdout_path.name]

        self.assertFalse(stdout["verified"])

        self.assertIn("does not match", stdout["error"])

        self.assertFalse(result["retentionPassed"])

        self.assertTrue(result["rawStreamErrors"])

    def test_source_change_during_copy_fails_content_verification(self) -> None:
        temporary, user_data, stdout_path, stderr_path, extension_path = self.make_inputs()

        self.addCleanup(temporary.cleanup)

        copyfile = observer.shutil.copyfile

        def change_stdout(source: pathlib.Path, destination: pathlib.Path) -> str:
            result = copyfile(source, destination)

            if pathlib.Path(source) == stdout_path:
                with stdout_path.open("ab") as stream:
                    stream.write(b"changed")

            return result

        with mock.patch.object(observer.shutil, "copyfile", side_effect=change_stdout):
            result = self.retention(user_data, stdout_path, stderr_path, extension_path)

        stdout = result["streams"][stdout_path.name]

        self.assertFalse(stdout["verified"])

        self.assertNotEqual(stdout["sourceBefore"], stdout["sourceAfter"])

        self.assertFalse(result["retentionPassed"])

        self.assertTrue(result["rawStreamErrors"])

    def test_primary_failure_is_preserved_when_raw_retention_also_fails(self) -> None:
        temporary, user_data, stdout_path, stderr_path, extension_path = self.make_inputs()

        self.addCleanup(temporary.cleanup)

        copyfile = observer.shutil.copyfile

        def fail_stdout(source: pathlib.Path, destination: pathlib.Path) -> str:
            if pathlib.Path(source) == stdout_path:
                raise PermissionError("stdout copy denied")

            return copyfile(source, destination)

        with mock.patch.object(observer.shutil, "copyfile", side_effect=fail_stdout):
            result = self.retention(
                user_data,
                stdout_path,
                stderr_path,
                extension_path,
                primary_passed=False,
                primary_failure="original editor assertion failed",
            )

        self.assertFalse(result["primaryPassed"])

        self.assertEqual(result["primaryFailure"], "original editor assertion failed")

        self.assertFalse(result["retentionPassed"])

        self.assertTrue(result["rawStreamErrors"])

        self.assertIn("stdout copy denied", result["streams"][stdout_path.name]["error"])

        self.assertTrue((self.evidence_directory(extension_path) / stderr_path.name).is_file())

        receipt = json.loads(
            (self.evidence_directory(extension_path) / "editor-log-retention.json").read_text(encoding="utf-8")
        )

        self.assertEqual(receipt["primaryFailure"], "original editor assertion failed")

        self.assertFalse(receipt["retentionPassed"])

    def test_receipt_write_error_is_secondary_to_verified_streams(self) -> None:
        temporary, user_data, stdout_path, stderr_path, extension_path = self.make_inputs()

        self.addCleanup(temporary.cleanup)

        stderr = io.StringIO()
        with (
            mock.patch.object(observer, "write_json", side_effect=PermissionError("receipt denied")),
            contextlib.redirect_stderr(stderr),
        ):
            result = self.retention(user_data, stdout_path, stderr_path, extension_path)

        self.assertEqual(result["rawStreamErrors"], [])

        self.assertTrue(result["retentionPassed"])

        self.assertTrue(result["streams"][stdout_path.name]["verified"])

        self.assertTrue(result["streams"][stderr_path.name]["verified"])

        self.assertIn("editorLogRetentionReceiptFailure", stderr.getvalue())


if __name__ == "__main__":
    unittest.main()
