"""Live sampling engine for ProcManager.

One background thread samples every second.  HTTP handlers only read the
latest published snapshot, so the UI latency does not depend on psutil's
sampling cost and all connected clients see the same numbers.

CPU percentages for processes are normalised by the number of logical CPUs,
matching Windows Task Manager's "process CPU" convention (percent of total
machine CPU).  Disk and network rates are bytes/second over the actual
sampling interval.
"""

from __future__ import annotations

import getpass
import logging
import os
import shlex
import threading
import time
from collections import deque
from typing import Any

import psutil

from .system_info import GpuMonitor, battery_state, collect_system_info

logger = logging.getLogger("procmanager.sampler")

SAMPLE_INTERVAL = 1.0
HISTORY_SECONDS = 300

ACTION_NAMES = {"terminate", "kill", "suspend", "resume"}


class ActionError(Exception):
    """An expected error while controlling a process."""

    def __init__(self, status: int, message: str) -> None:
        super().__init__(message)
        self.status = status
        self.message = message


class ProcessDetailsError(Exception):
    def __init__(self, status: int, message: str) -> None:
        super().__init__(message)
        self.status = status
        self.message = message


def _round(value: float | None, digits: int = 1) -> float | None:
    return None if value is None else round(value, digits)


def _safe(function: Any, default: Any = None) -> Any:
    try:
        return function()
    except (psutil.Error, OSError, ValueError):
        return default


class Sampler:
    def __init__(self, interval: float = SAMPLE_INTERVAL) -> None:
        self.interval = max(0.5, float(interval))
        self._sample_lock = threading.Lock()
        self._lock = threading.RLock()
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

        self._gpu = GpuMonitor()
        self.system_info = collect_system_info(gpus=self._gpu.public)

        self._cpu_count = psutil.cpu_count(logical=True) or 1
        self._physical_cpu_count = psutil.cpu_count(logical=False) or self._cpu_count
        self._boot_time = psutil.boot_time()
        self._current_user = _safe(lambda: psutil.Process().username(), getpass.getuser())
        self._is_root = os.geteuid() == 0

        self._prev_processes: dict[int, dict[str, Any]] = {}
        self._prev_disk: Any = None
        self._prev_net: dict[str, Any] | None = None
        self._prev_time: float | None = None

        self._history: deque[dict[str, Any]] = deque(maxlen=HISTORY_SECONDS)
        self._processes: list[dict[str, Any]] = []
        self._stats: dict[str, Any] = self._empty_stats()
        self._last_error: str | None = None
        self._last_sample_time = 0.0
        self._protected_pids = {1, 2, os.getpid()}

        # Prime the CPU counters so the first real sample has a baseline.
        psutil.cpu_percent(interval=None)
        psutil.cpu_percent(interval=None, percpu=True)

    # ------------------------------------------------------------------
    # lifecycle
    # ------------------------------------------------------------------

    def start(self) -> None:
        if self._thread is not None:
            return
        # Make sure the very first HTTP request can return real data.
        try:
            self.sample_now()
        except Exception:  # pragma: no cover - startup best effort
            logger.exception("initial sample failed")
        self._thread = threading.Thread(target=self._run, name="procmanager-sampler", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        thread = self._thread
        if thread is not None and thread.is_alive():
            thread.join(timeout=2.5)

    def _run(self) -> None:
        while not self._stop.is_set():
            started = time.monotonic()
            try:
                self.sample_now()
                self._last_error = None
            except Exception as error:
                self._last_error = str(error)
                logger.exception("sampling failed")
            elapsed = time.monotonic() - started
            self._stop.wait(max(0.05, self.interval - elapsed))

    def sample_now(self) -> dict[str, Any]:
        """Take a sample synchronously (used by the loop, tests and actions)."""
        with self._sample_lock:
            snapshot = self._collect()
            with self._lock:
                self._stats = snapshot["stats"]
                self._processes = snapshot["processes"]
                self._history.append(snapshot["history"])
                self._last_sample_time = snapshot["stats"]["ts"]
            return snapshot["stats"]

    # ------------------------------------------------------------------
    # public snapshots
    # ------------------------------------------------------------------

    def stats(self) -> dict[str, Any]:
        with self._lock:
            result = dict(self._stats)
            result["sampler"] = {
                "interval": self.interval,
                "error": self._last_error,
                "last_sample": self._last_sample_time,
            }
            return result

    def processes(self) -> dict[str, Any]:
        with self._lock:
            items = self._processes
            return {
                "ts": self._last_sample_time,
                "cpu_count": self._cpu_count,
                "physical_cpu_count": self._physical_cpu_count,
                "items": items,
                "total": len(items),
                "threads": sum(item.get("threads") or 0 for item in items),
                "kernel_threads": sum(1 for item in items if item.get("kernel")),
            }

    def history(self, seconds: int = 120) -> dict[str, Any]:
        seconds = max(1, min(int(seconds), HISTORY_SECONDS))
        with self._lock:
            points = list(self._history)[-seconds:]
        return {"interval": self.interval, "points": points}

    def users(self) -> dict[str, Any]:
        sessions: list[dict[str, Any]] = []
        try:
            for user in psutil.users():
                sessions.append(
                    {
                        "name": user.name,
                        "terminal": user.terminal,
                        "host": user.host,
                        "started": user.started,
                        "pid": user.pid,
                    }
                )
        except (psutil.Error, OSError):
            pass

        sessions_by_user: dict[str, list[dict[str, Any]]] = {}
        for session in sessions:
            sessions_by_user.setdefault(session["name"], []).append(session)

        users: dict[str, dict[str, Any]] = {}
        kernel = {"processes": 0, "threads": 0, "cpu": 0.0, "memory": 0}

        with self._lock:
            processes = list(self._processes)
            total_memory = self._stats.get("memory", {}).get("total") or 1

        for process in processes:
            if process.get("kernel"):
                kernel["processes"] += 1
                kernel["threads"] += process.get("threads") or 0
                kernel["cpu"] += process.get("cpu") or 0.0
                kernel["memory"] += process.get("memory") or 0
                continue
            name = process.get("username") or "unknown"
            group = users.setdefault(
                name,
                {
                    "name": name,
                    "processes": 0,
                    "threads": 0,
                    "cpu": 0.0,
                    "memory": 0,
                    "sessions": sessions_by_user.get(name, []),
                },
            )
            group["processes"] += 1
            group["threads"] += process.get("threads") or 0
            group["cpu"] += process.get("cpu") or 0.0
            group["memory"] += process.get("memory") or 0

        for name, session_list in sessions_by_user.items():
            if name not in users:
                users[name] = {
                    "name": name,
                    "processes": 0,
                    "threads": 0,
                    "cpu": 0.0,
                    "memory": 0,
                    "sessions": session_list,
                }

        result = []
        for user in users.values():
            user["cpu"] = round(user["cpu"], 1)
            user["memory_percent"] = round((user["memory"] / total_memory) * 100, 1) if total_memory else 0
            user["sessions"].sort(key=lambda session: session.get("started") or 0)
            result.append(user)
        result.sort(key=lambda user: (-user["cpu"], -user["memory"], user["name"]))
        kernel["cpu"] = round(kernel["cpu"], 1)
        kernel["memory_percent"] = round((kernel["memory"] / total_memory) * 100, 1) if total_memory else 0
        return {"users": result, "kernel": kernel, "sessions": sessions, "ts": self._last_sample_time}

    # ------------------------------------------------------------------
    # control
    # ------------------------------------------------------------------

    def process_details(self, pid: int) -> dict[str, Any]:
        try:
            process = psutil.Process(pid)
        except psutil.NoSuchProcess:
            raise ProcessDetailsError(404, "The process does not exist or has already exited.") from None
        except psutil.Error as error:
            raise ProcessDetailsError(400, f"Unable to read process: {error}") from error

        try:
            create_time = process.create_time()
            name = process.name()
            status = process.status()
        except psutil.NoSuchProcess:
            raise ProcessDetailsError(404, "The process does not exist or has already exited.") from None

        cpu_percent = None
        with self._lock:
            for item in self._processes:
                if item["pid"] == pid and item.get("create_time") == create_time:
                    cpu_percent = item.get("cpu")
                    break

        memory_info = _safe(process.memory_info)
        memory = None
        if memory_info is not None:
            memory = {
                "rss": memory_info.rss,
                "vms": memory_info.vms,
                "shared": getattr(memory_info, "shared", None),
            }

        io_counters = _safe(process.io_counters)
        io = None
        if io_counters is not None:
            io = {
                "read_bytes": io_counters.read_bytes,
                "write_bytes": io_counters.write_bytes,
                "read_count": io_counters.read_count,
                "write_count": io_counters.write_count,
            }

        parent_info = None
        try:
            parent = process.parent()
            if parent is not None:
                parent_info = {"pid": parent.pid, "name": _safe(parent.name)}
        except psutil.Error:
            parent_info = None

        uids = _safe(process.uids)
        gids = _safe(process.gids)
        ionice = _safe(process.ionice)
        open_files = _safe(process.open_files)
        connections = _safe(lambda: process.net_connections(kind="inet"))
        environ = _safe(process.environ)
        cmdline = _safe(process.cmdline, [])
        cpu_affinity = _safe(process.cpu_affinity)
        cpu_times = _safe(process.cpu_times)

        return {
            "pid": pid,
            "name": name,
            "status": status,
            "username": _safe(process.username),
            "create_time": create_time,
            "run_time": max(0.0, time.time() - create_time),
            "cpu": cpu_percent,
            "num_threads": _safe(process.num_threads),
            "nice": _safe(process.nice),
            "exe": _safe(process.exe),
            "cwd": _safe(process.cwd),
            "cmdline": cmdline or [],
            "cmdline_str": shlex.join(cmdline) if cmdline else "",
            "parent": parent_info,
            "children": [{"pid": child.pid, "name": _safe(child.name)} for child in _safe(process.children, [])],
            "memory": memory,
            "memory_percent": round(memory["rss"] / psutil.virtual_memory().total * 100, 2) if memory else None,
            "cpu_times": {
                "user": cpu_times.user if cpu_times is not None else None,
                "system": cpu_times.system if cpu_times is not None else None,
            },
            "io": io,
            "uids": {"real": uids.real, "effective": uids.effective} if uids else None,
            "gids": {"real": gids.real, "effective": gids.effective} if gids else None,
            "ionice": {"class": ionice.ioclass, "value": ionice.value} if ionice else None,
            "cpu_affinity": cpu_affinity,
            "terminal": _safe(process.terminal),
            "open_files_count": len(open_files) if open_files is not None else None,
            "connections_count": len(connections) if connections is not None else None,
            "connections": [
                {
                    "fd": connection.fd,
                    "family": str(connection.family),
                    "type": str(connection.type),
                    "laddr": f"{connection.laddr.ip}:{connection.laddr.port}" if connection.laddr else None,
                    "raddr": f"{connection.raddr.ip}:{connection.raddr.port}" if connection.raddr else None,
                    "status": connection.status,
                }
                for connection in (connections or [])[:20]
            ],
            "environment_count": len(environ) if environ is not None else None,
        }

    def perform_action(self, pid: int, action: str, expected_create_time: float | None = None) -> dict[str, Any]:
        if action not in ACTION_NAMES:
            raise ActionError(400, "Unsupported action.")
        if pid in self._protected_pids:
            raise ActionError(403, "This process is protected by the system or by ProcManager itself and cannot be ended.")
        if pid <= 2:
            raise ActionError(403, "This process is protected by the system and cannot be ended.")

        try:
            process = psutil.Process(pid)
            create_time = process.create_time()
            status = process.status()
        except psutil.NoSuchProcess:
            raise ActionError(404, "The process does not exist or has already exited.") from None
        except psutil.AccessDenied as error:
            raise ActionError(403, f"Permission denied: cannot access this process ({error}).") from error
        except psutil.Error as error:
            raise ActionError(400, f"Unable to control this process: {error}") from error

        if expected_create_time is not None:
            try:
                if abs(create_time - float(expected_create_time)) > 0.01:
                    raise ActionError(409, "This PID has been reused by another process; the action was cancelled.")
            except (TypeError, ValueError):
                raise ActionError(400, "Invalid process identifier.") from None

        if status == psutil.STATUS_ZOMBIE:
            raise ActionError(409, "The process has already exited and is waiting to be reaped (zombie processes cannot be ended).")

        if action == "suspend" and status == psutil.STATUS_STOPPED:
            raise ActionError(409, "The process is already suspended.")
        if action == "resume" and status != psutil.STATUS_STOPPED:
            raise ActionError(409, "The process is not currently suspended.")

        try:
            if action == "terminate":
                process.terminate()
            elif action == "kill":
                process.kill()
            elif action == "suspend":
                process.suspend()
            elif action == "resume":
                process.resume()
        except psutil.NoSuchProcess:
            raise ActionError(404, "The process exited before the action could be applied.") from None
        except psutil.AccessDenied as error:
            raise ActionError(
                403,
                "Permission denied: ending this system process requires root. Run ProcManager with sudo in a terminal and try again. "
                f"({error})",
            ) from error
        except psutil.Error as error:
            raise ActionError(400, f"Action failed: {error}") from error

        ended = False
        if action in {"terminate", "kill"}:
            deadline = time.monotonic() + 0.35
            while time.monotonic() < deadline:
                if not process.is_running():
                    ended = True
                    break
                current_status = _safe(process.status)
                if current_status == psutil.STATUS_ZOMBIE:
                    ended = True
                    break
                time.sleep(0.05)

        # Refresh the cache immediately so the UI reflects the action.
        try:
            self.sample_now()
        except Exception:
            logger.exception("post-action sample failed")

        return {
            "ok": True,
            "pid": pid,
            "action": action,
            "create_time": create_time,
            "ended": ended,
            "status": _safe(process.status, "unknown" if not ended else "terminated"),
        }

    # ------------------------------------------------------------------
    # sampling internals
    # ------------------------------------------------------------------

    def _collect(self) -> dict[str, Any]:
        now = time.monotonic()
        wall = time.time()
        elapsed = None if self._prev_time is None else max(0.0, now - self._prev_time)
        total_memory = psutil.virtual_memory().total

        per_core = psutil.cpu_percent(interval=None, percpu=True)
        per_core = [round(value, 1) for value in (per_core or [])]
        if per_core:
            overall_cpu = round(sum(per_core) / len(per_core), 1)
        else:
            overall_cpu = round(psutil.cpu_percent(interval=None), 1)

        try:
            frequency = psutil.cpu_freq()
            freq_mhz = round(frequency.current, 0) if frequency and frequency.current else None
        except (AttributeError, NotImplementedError, OSError):
            freq_mhz = None

        temperatures = _safe(psutil.sensors_temperatures, {}) or {}
        fan_rpm = None
        fans = _safe(getattr(psutil, "sensors_fans", lambda: {}), {}) or {}
        for sensor in fans.values():
            for fan in sensor:
                if fan.current:
                    fan_rpm = round(fan.current)
                    break
            if fan_rpm:
                break

        memory = psutil.virtual_memory()
        swap = psutil.swap_memory()
        memory_payload = {
            "total": memory.total,
            "used": memory.used,
            "in_use": max(0, memory.total - memory.available),
            "available": memory.available,
            "free": memory.free,
            "cached": getattr(memory, "cached", 0),
            "buffers": getattr(memory, "buffers", 0),
            "shared": getattr(memory, "shared", 0),
            "percent": round(memory.percent, 1),
            "swap_total": swap.total,
            "swap_used": swap.used,
            "swap_free": swap.free,
            "swap_percent": round(swap.percent, 1),
        }

        disk_read_bps = disk_write_bps = 0.0
        disk_read_iops = disk_write_iops = 0.0
        try:
            disk_counters = psutil.disk_io_counters()
        except (psutil.Error, OSError):
            disk_counters = None
        if self._prev_disk is not None and disk_counters is not None and elapsed:
            disk_read_bps = max(0.0, (disk_counters.read_bytes - self._prev_disk.read_bytes) / elapsed)
            disk_write_bps = max(0.0, (disk_counters.write_bytes - self._prev_disk.write_bytes) / elapsed)
            disk_read_iops = max(0.0, (disk_counters.read_count - self._prev_disk.read_count) / elapsed)
            disk_write_iops = max(0.0, (disk_counters.write_count - self._prev_disk.write_count) / elapsed)

        partitions: list[dict[str, Any]] = []
        for disk in self.system_info["hardware"]["disks"]:
            for partition in disk.get("partitions", []):
                entry = {
                    "disk": disk.get("name"),
                    "disk_model": disk.get("model"),
                    "disk_kind": disk.get("kind"),
                    "device": partition.get("device"),
                    "name": partition.get("name"),
                    "mount": partition.get("mount"),
                    "fstype": partition.get("fstype"),
                    "size": partition.get("size"),
                    "size_text": partition.get("size_text"),
                    "total": partition.get("total"),
                    "used": partition.get("used"),
                    "free": partition.get("free"),
                    "percent": partition.get("percent"),
                }
                if partition.get("mount"):
                    try:
                        usage = psutil.disk_usage(partition["mount"])
                        entry.update(
                            {
                                "total": usage.total,
                                "used": usage.used,
                                "free": usage.free,
                                "percent": round(usage.percent, 1),
                            }
                        )
                    except OSError:
                        pass
                if entry.get("total"):
                    partitions.append(entry)
        partitions.sort(key=lambda item: item.get("mount") != "/")

        net_counters: dict[str, Any] = {}
        try:
            net_counters = psutil.net_io_counters(pernic=True)
        except (psutil.Error, OSError):
            pass
        net_rates = self._network_rates(self._prev_net, net_counters, elapsed)
        address_map = _safe(psutil.net_if_addrs, {}) or {}
        stats_map = _safe(psutil.net_if_stats, {}) or {}
        static_network = {item["name"]: item for item in self.system_info["hardware"]["network"]}
        interfaces: list[dict[str, Any]] = []
        total_recv = total_sent = 0.0
        for name, counters in net_counters.items():
            if name == "lo":
                continue
            static = static_network.get(name, {})
            rate = net_rates.get(name, {"recv_bps": 0.0, "sent_bps": 0.0})
            total_recv += rate["recv_bps"]
            total_sent += rate["sent_bps"]
            ipv4: list[str] = []
            ipv6: list[str] = []
            mac = static.get("mac")
            for address in address_map.get(name, []):
                if address.family == 2:  # socket.AF_INET
                    ipv4.append(address.address)
                elif address.family == 10:  # socket.AF_INET6
                    cleaned = address.address.split("%", 1)[0]
                    if cleaned and cleaned != "::1" and not cleaned.lower().startswith("fe80:"):
                        ipv6.append(cleaned)
                elif address.family == getattr(psutil, "AF_LINK", 17):
                    mac = address.address
            link = stats_map.get(name)
            interfaces.append(
                {
                    "name": name,
                    "type": static.get("type", "Network"),
                    "kind": static.get("kind", "virtual"),
                    "mac": mac,
                    "ipv4": ipv4,
                    "ipv6": ipv6,
                    "mtu": link.mtu if link else static.get("mtu"),
                    "speed_mbps": static.get("speed_mbps"),
                    "state": static.get("state") or ("up" if link and link.isup else "down"),
                    "is_up": bool(link.isup) if link else static.get("is_up"),
                    "recv_bps": round(rate["recv_bps"]),
                    "sent_bps": round(rate["sent_bps"]),
                    "recv_total": counters.bytes_recv,
                    "sent_total": counters.bytes_sent,
                }
            )
        interfaces.sort(key=lambda item: (item["kind"] != "wifi", item["name"]))

        gpu = self._gpu.sample(now)
        gpu_temp = None
        for adapter in gpu:
            if adapter.get("temp_c") is not None:
                gpu_temp = adapter["temp_c"]
                break

        battery = battery_state()

        processes, prev_processes = self._collect_processes(elapsed, total_memory, now)
        threads = sum(item.get("threads") or 0 for item in processes)
        running = sum(1 for item in processes if item.get("status") == psutil.STATUS_RUNNING)

        cpu_temp = _pick_cpu_temperature(temperatures)
        stats = {
            "ts": wall,
            "uptime": max(0.0, wall - self._boot_time),
            "cpu": {
                "percent": overall_cpu,
                "per_core": per_core,
                "freq_mhz": freq_mhz,
                "freq_max_mhz": self.system_info["hardware"]["cpu"].get("max_mhz"),
                "temp_c": cpu_temp,
                "load": [round(value, 2) for value in os.getloadavg()],
            },
            "memory": memory_payload,
            "disk": {
                "read_bps": round(disk_read_bps),
                "write_bps": round(disk_write_bps),
                "read_iops": round(disk_read_iops, 1),
                "write_iops": round(disk_write_iops, 1),
                "partitions": partitions,
            },
            "network": {
                "recv_bps": round(total_recv),
                "sent_bps": round(total_sent),
                "interfaces": interfaces,
            },
            "gpu": gpu,
            "battery": battery,
            "sensors": {"cpu_temp_c": cpu_temp, "fan_rpm": fan_rpm, "gpu_temp_c": gpu_temp},
            "counts": {
                "processes": len(processes),
                "threads": threads,
                "running": running,
                "kernel_threads": sum(1 for item in processes if item.get("kernel")),
            },
        }

        history = {
            "t": round(wall, 3),
            "cpu": overall_cpu,
            "mem": memory_payload["percent"],
            "disk_read": round(disk_read_bps),
            "disk_write": round(disk_write_bps),
            "net_recv": round(total_recv),
            "net_sent": round(total_sent),
            "gpu_freq": (gpu[0].get("freq_mhz") if gpu else None),
            "gpu_util": (gpu[0].get("utilization") if gpu else None),
        }

        self._prev_disk = disk_counters
        self._prev_net = net_counters
        self._prev_time = now
        self._prev_processes = prev_processes
        return {"stats": stats, "processes": processes, "history": history}

    def _collect_processes(
        self, elapsed: float | None, total_memory: int, now: float
    ) -> tuple[list[dict[str, Any]], dict[int, dict[str, Any]]]:
        attributes = [
            "pid",
            "ppid",
            "name",
            "username",
            "status",
            "cpu_times",
            "memory_info",
            "num_threads",
            "create_time",
            "nice",
        ]
        items: list[dict[str, Any]] = []
        previous: dict[int, dict[str, Any]] = {}
        try:
            iterator = psutil.process_iter(attrs=attributes, ad_value=None)
        except (psutil.Error, OSError):
            return items, previous

        for process in iterator:
            info = process.info
            pid = info.get("pid")
            if pid is None:
                continue
            create_time = info.get("create_time")
            cpu_times = info.get("cpu_times")
            memory_info = info.get("memory_info")
            username = info.get("username")
            kernel = pid == 2 or info.get("ppid") == 2

            cpu_total = None
            if cpu_times is not None:
                cpu_total = cpu_times.user + cpu_times.system
            memory_rss = memory_info.rss if memory_info is not None else None
            memory_vms = memory_info.vms if memory_info is not None else None

            old = self._prev_processes.get(pid)
            cpu_percent: float | None = 0.0
            if cpu_total is not None and old is not None and elapsed and elapsed > 0:
                old_create_time = old.get("create_time")
                old_cpu_total = old.get("cpu_total")
                same_process = (
                    old_create_time is None
                    or create_time is None
                    or abs(old_create_time - create_time) < 0.01
                )
                if old_cpu_total is not None and same_process:
                    cpu_percent = max(0.0, (cpu_total - old_cpu_total) / elapsed / self._cpu_count * 100.0)
                    cpu_percent = round(min(100.0, cpu_percent), 1)
                else:
                    cpu_percent = 0.0
            elif cpu_total is None:
                cpu_percent = None

            io_read_bytes = io_write_bytes = None
            io_read_bps = io_write_bps = None
            can_read_io = self._is_root or (username is not None and username == self._current_user)
            if can_read_io and not kernel:
                io_counters = _safe(process.io_counters)
                if io_counters is not None:
                    io_read_bytes = io_counters.read_bytes
                    io_write_bytes = io_counters.write_bytes
                    same_process = (
                        old is not None
                        and (
                            old.get("create_time") is None
                            or create_time is None
                            or abs((old.get("create_time") or 0) - (create_time or 0)) < 0.01
                        )
                    )
                    if (
                        same_process
                        and elapsed
                        and elapsed > 0
                        and old.get("read_bytes") is not None
                        and old.get("write_bytes") is not None
                    ):
                        io_read_bps = max(0.0, (io_read_bytes - old["read_bytes"]) / elapsed)
                        io_write_bps = max(0.0, (io_write_bytes - old["write_bytes"]) / elapsed)
                    else:
                        io_read_bps = 0.0
                        io_write_bps = 0.0

            item = {
                "pid": pid,
                "ppid": info.get("ppid"),
                "name": info.get("name") or "?",
                "username": username,
                "status": info.get("status") or "unknown",
                "cpu": cpu_percent,
                "memory": memory_rss,
                "memory_percent": round(memory_rss / total_memory * 100, 2)
                if memory_rss is not None and total_memory
                else None,
                "virtual": memory_vms,
                "threads": info.get("num_threads"),
                "create_time": create_time,
                "nice": info.get("nice"),
                "kernel": kernel,
                "io_read_bytes": io_read_bytes,
                "io_write_bytes": io_write_bytes,
                "io_read_bps": round(io_read_bps) if io_read_bps is not None else None,
                "io_write_bps": round(io_write_bps) if io_write_bps is not None else None,
            }
            items.append(item)
            previous[pid] = {
                "create_time": create_time,
                "cpu_total": cpu_total,
                "read_bytes": io_read_bytes,
                "write_bytes": io_write_bytes,
            }

        items.sort(key=lambda item: (-(item.get("cpu") or 0), -(item.get("memory") or 0), item["pid"]))
        return items, previous

    @staticmethod
    def _network_rates(
        previous: dict[str, Any] | None,
        current: dict[str, Any],
        elapsed: float | None,
    ) -> dict[str, dict[str, float]]:
        rates: dict[str, dict[str, float]] = {}
        if previous is None or elapsed is None or elapsed <= 0:
            for name in current:
                rates[name] = {"recv_bps": 0.0, "sent_bps": 0.0}
            return rates
        for name, counters in current.items():
            before = previous.get(name)
            if before is None:
                rates[name] = {"recv_bps": 0.0, "sent_bps": 0.0}
                continue
            rates[name] = {
                "recv_bps": max(0.0, (counters.bytes_recv - before.bytes_recv) / elapsed),
                "sent_bps": max(0.0, (counters.bytes_sent - before.bytes_sent) / elapsed),
            }
        return rates

    def _empty_stats(self) -> dict[str, Any]:
        return {
            "ts": 0.0,
            "uptime": 0.0,
            "cpu": {"percent": 0.0, "per_core": [], "freq_mhz": None, "freq_max_mhz": None, "temp_c": None, "load": [0, 0, 0]},
            "memory": {
                "total": 0,
                "used": 0,
                "in_use": 0,
                "available": 0,
                "free": 0,
                "cached": 0,
                "buffers": 0,
                "shared": 0,
                "percent": 0.0,
                "swap_total": 0,
                "swap_used": 0,
                "swap_free": 0,
                "swap_percent": 0.0,
            },
            "disk": {"read_bps": 0, "write_bps": 0, "read_iops": 0, "write_iops": 0, "partitions": []},
            "network": {"recv_bps": 0, "sent_bps": 0, "interfaces": []},
            "gpu": [],
            "battery": None,
            "sensors": {"cpu_temp_c": None, "fan_rpm": None, "gpu_temp_c": None},
            "counts": {"processes": 0, "threads": 0, "running": 0, "kernel_threads": 0},
        }


def _pick_cpu_temperature(sensors: dict[str, list[Any]]) -> float | None:
    for group in ("coretemp", "k10temp", "zenpower"):
        entries = sensors.get(group)
        if not entries:
            continue
        for entry in entries:
            label = (getattr(entry, "label", "") or "").lower()
            if label in {"package id 0", "tctl", "tdie", "package"}:
                return round(entry.current, 1)
        first = entries[0]
        if getattr(first, "current", None) is not None:
            return round(first.current, 1)
    for group in ("acpitz", "dell_smm"):
        entries = sensors.get(group)
        if entries:
            for entry in entries:
                if getattr(entry, "current", None) is not None:
                    return round(entry.current, 1)
    return None
