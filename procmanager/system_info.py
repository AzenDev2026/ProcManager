"""Static system and hardware information for ProcManager.

Everything in this module is best-effort and read-only.  We prefer kernel
interfaces (/proc, /sys, /sys/class/dmi) and standard Linux tools (lscpu,
lsblk, lspci, nvidia-smi).  When a value cannot be read we return ``None``
instead of guessing, so the UI can display an honest "unavailable" state.
"""

from __future__ import annotations

import glob
import json
import os
import platform
import re
import socket
import subprocess
import time
from datetime import datetime
from pathlib import Path
from typing import Any

import psutil

from . import APP_NAME, __version__

DMI_DIR = Path("/sys/class/dmi/id")
PCI_VENDOR_NAMES = {
    "1002": "AMD",
    "1022": "AMD",
    "10de": "NVIDIA",
    "106b": "Apple",
    "1af4": "Red Hat",
    "8086": "Intel",
    "1b36": "Red Hat",
    "1414": "Microsoft",
}


# ---------------------------------------------------------------------------
# small helpers
# ---------------------------------------------------------------------------


def read_text(path: str | os.PathLike[str], default: str | None = None) -> str | None:
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as handle:
            value = handle.read().strip()
        return value or default
    except OSError:
        return default


def read_int(path: str | os.PathLike[str], default: int | None = None) -> int | None:
    value = read_text(path)
    if value is None:
        return default
    try:
        return int(value)
    except ValueError:
        return default


def _run(command: list[str], timeout: float = 4.0) -> str | None:
    """Run a read-only system tool, returning stdout or None."""
    try:
        result = subprocess.run(
            command,
            capture_output=True,
            text=True,
            timeout=timeout,
            env={**os.environ, "LC_ALL": "C", "LANG": "C"},
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    if result.returncode != 0:
        return None
    return result.stdout


def _parse_float(value: Any) -> float | None:
    if value is None:
        return None
    match = re.search(r"-?\d+(?:\.\d+)?", str(value))
    if not match:
        return None
    try:
        return float(match.group(0))
    except ValueError:
        return None


def _format_bytes(value: int | None) -> str | None:
    if value is None:
        return None
    units = ("B", "KiB", "MiB", "GiB", "TiB", "PiB")
    size = float(value)
    for unit in units:
        if size < 1024.0 or unit == units[-1]:
            if unit == "B":
                return f"{int(size)} {unit}"
            return f"{size:.1f} {unit}"
        size /= 1024.0
    return None


# ---------------------------------------------------------------------------
# CPU
# ---------------------------------------------------------------------------


def _lscpu_fields() -> dict[str, str]:
    fields: dict[str, str] = {}
    raw = _run(["lscpu", "--json"])
    if not raw:
        return fields
    try:
        payload = json.loads(raw)
    except (json.JSONDecodeError, TypeError):
        return fields
    for item in payload.get("lscpu", []):
        field = str(item.get("field", "")).rstrip(":").strip()
        data = str(item.get("data", "")).strip()
        if field:
            fields[field] = data
    return fields


def _cpu_info() -> dict[str, Any]:
    fields = _lscpu_fields()
    logical = psutil.cpu_count(logical=True)
    physical = psutil.cpu_count(logical=False)

    sockets = read_int_from(fields, "Socket(s)")
    cores_per_socket = read_int_from(fields, "Core(s) per socket")
    threads_per_core = read_int_from(fields, "Thread(s) per core")
    if physical is None and cores_per_socket and sockets:
        physical = cores_per_socket * sockets
    if logical is None:
        logical = read_int_from(fields, "CPU(s)")

    model = fields.get("Model name") or platform.processor() or "Unknown CPU"
    vendor = fields.get("Vendor ID") or "Unknown"
    cache = {
        "l1d": fields.get("L1d cache"),
        "l1i": fields.get("L1i cache"),
        "l2": fields.get("L2 cache"),
        "l3": fields.get("L3 cache"),
    }
    return {
        "model": model,
        "vendor": vendor,
        "vendor_id": fields.get("Vendor ID"),
        "architecture": fields.get("Architecture") or platform.machine(),
        "cores": physical,
        "threads": logical,
        "sockets": sockets,
        "cores_per_socket": cores_per_socket,
        "threads_per_core": threads_per_core,
        "max_mhz": _parse_float(fields.get("CPU max MHz")),
        "min_mhz": _parse_float(fields.get("CPU min MHz")),
        "cache": cache,
        "virtualization": fields.get("Virtualization"),
        "family": fields.get("CPU family"),
        "model_number": fields.get("Model"),
        "stepping": fields.get("Stepping"),
        "microcode": fields.get("Microcode version"),
        "numa_nodes": read_int_from(fields, "NUMA node(s)"),
        "governor": read_text("/sys/devices/system/cpu/cpu0/cpufreq/scaling_governor"),
        "address_sizes": fields.get("Address sizes"),
    }


def read_int_from(fields: dict[str, str], key: str) -> int | None:
    value = fields.get(key)
    if value is None:
        return None
    try:
        return int(value.split()[0])
    except (ValueError, IndexError):
        return None


# ---------------------------------------------------------------------------
# physical memory / DMI
# ---------------------------------------------------------------------------


def _dmidecode_memory_modules() -> list[dict[str, Any]]:
    """Parse DMI type 17 modules.  Requires root (dmidecode needs DMI access)."""
    raw = _run(["dmidecode", "-t", "memory"], timeout=6.0)
    if not raw:
        return []
    modules: list[dict[str, Any]] = []
    for block in raw.split("\n\n"):
        if "Memory Device" not in block:
            continue
        values: dict[str, str] = {}
        for line in block.splitlines():
            if ":" not in line:
                continue
            key, value = line.split(":", 1)
            values[key.strip()] = value.strip()
        size_text = values.get("Size", "")
        if not size_text or "No Module Installed" in size_text or "Unknown" in size_text:
            continue
        size_match = re.match(r"(\d+(?:\.\d+)?)\s*(GB|MB|KB|TB)", size_text, re.I)
        if not size_match:
            continue
        amount = float(size_match.group(1))
        unit = size_match.group(2).upper()
        multiplier = {"KB": 1024, "MB": 1024**2, "GB": 1024**3, "TB": 1024**4}[unit]
        size_bytes = int(amount * multiplier)
        speed = _parse_float(values.get("Speed"))
        configured = _parse_float(values.get("Configured Memory Speed"))
        modules.append(
            {
                "locator": values.get("Locator"),
                "bank": values.get("Bank Locator"),
                "size_bytes": size_bytes,
                "size_text": _format_bytes(size_bytes),
                "type": values.get("Type") if values.get("Type") not in (None, "Unknown") else None,
                "speed_mts": int(speed) if speed else None,
                "configured_speed_mts": int(configured) if configured else None,
                "manufacturer": values.get("Manufacturer")
                if values.get("Manufacturer") not in (None, "Unknown")
                else None,
                "part_number": values.get("Part Number")
                if values.get("Part Number") not in (None, "Unknown", "Not Specified")
                else None,
            }
        )
    return modules


def _memory_info() -> dict[str, Any]:
    virtual = psutil.virtual_memory()
    info: dict[str, Any] = {
        "total": virtual.total,
        "available": virtual.available,
        "dmi_available": False,
        "installed_bytes": None,
        "type": None,
        "speed_mts": None,
        "modules": [],
        "note": None,
    }

    modules: list[dict[str, Any]] = []
    if os.geteuid() == 0:
        modules = _dmidecode_memory_modules()

    if modules:
        info["dmi_available"] = True
        info["modules"] = modules
        info["installed_bytes"] = sum(module["size_bytes"] for module in modules)
        types = [module["type"] for module in modules if module.get("type")]
        speeds = [module["speed_mts"] for module in modules if module.get("speed_mts")]
        info["type"] = types[0] if types else None
        info["speed_mts"] = max(speeds) if speeds else None
    else:
        if os.geteuid() == 0:
            info["note"] = "Unable to read memory module details via DMI (dmidecode unavailable or data missing)."
        else:
            info["note"] = "Memory module type and speed require root access to DMI (dmidecode -t memory)."

    info["total_text"] = _format_bytes(info["total"])
    info["installed_text"] = _format_bytes(info.get("installed_bytes"))
    return info


# ---------------------------------------------------------------------------
# DMI / motherboard
# ---------------------------------------------------------------------------


def _dmi_info() -> dict[str, Any]:
    def dmi(name: str) -> str | None:
        value = read_text(DMI_DIR / name)
        if not value or value.lower() in {"none", "not specified", "unknown", "to be filled by o.e.m."}:
            return None
        return value

    vendor = dmi("sys_vendor")
    product = dmi("product_name")
    return {
        "vendor": vendor,
        "product": product,
        "product_version": dmi("product_version"),
        "family": dmi("product_family"),
        "board_vendor": dmi("board_vendor"),
        "board_name": dmi("board_name"),
        "board_version": dmi("board_version"),
        "bios_vendor": dmi("bios_vendor"),
        "bios_version": dmi("bios_version"),
        "bios_date": dmi("bios_date"),
        "chassis_type": read_text(DMI_DIR / "chassis_type"),
        "machine": " ".join(part for part in (vendor, product) if part) or None,
    }


# ---------------------------------------------------------------------------
# storage
# ---------------------------------------------------------------------------


def _lsblk_devices() -> list[dict[str, Any]]:
    raw = _run(
        [
            "lsblk",
            "--json",
            "-b",
            "-o",
            "NAME,MODEL,SIZE,ROTA,TYPE,SERIAL,TRAN,MOUNTPOINTS",
        ]
    )
    if not raw:
        return []
    try:
        payload = json.loads(raw)
    except (json.JSONDecodeError, TypeError):
        return []
    blockdevices = payload.get("blockdevices")
    if not isinstance(blockdevices, list):
        return []
    return blockdevices


def _disk_partition_usage(mountpoint: str) -> dict[str, Any] | None:
    if not mountpoint or mountpoint.startswith("["):
        return None
    try:
        usage = psutil.disk_usage(mountpoint)
    except OSError:
        return None
    return {
        "mount": mountpoint,
        "total": usage.total,
        "used": usage.used,
        "free": usage.free,
        "percent": round(usage.percent, 1),
    }


def _disks_info() -> list[dict[str, Any]]:
    devices = _lsblk_devices()
    partitions_by_device: dict[str, dict[str, Any]] = {}
    for partition in psutil.disk_partitions(all=False):
        partitions_by_device[partition.device] = {
            "mount": partition.mountpoint,
            "fstype": partition.fstype,
        }

    disks: list[dict[str, Any]] = []

    def visit(node: dict[str, Any], parent: dict[str, Any] | None = None) -> None:
        node_type = node.get("type")
        if node_type == "disk":
            name = str(node.get("name") or "")
            model = str(node.get("model") or "").strip() or None
            if name.startswith(("loop", "zram", "ram", "dm-", "md")):
                # Virtual block devices are not physical hardware.  Their
                # backing partitions are still collected below.
                for child in node.get("children") or []:
                    visit(child, node)
                return
            rota = bool(node.get("rota"))
            tran = node.get("tran")
            if tran == "nvme" or "nvme" in name:
                kind = "nvme"
            elif rota:
                kind = "hdd"
            else:
                kind = "ssd"
            disk: dict[str, Any] = {
                "name": name,
                "device": f"/dev/{name}",
                "model": model,
                "serial": (str(node.get("serial") or "").strip() or None),
                "size": int(node.get("size") or 0),
                "size_text": _format_bytes(int(node.get("size") or 0)),
                "rota": rota,
                "tran": tran,
                "kind": kind,
                "partitions": [],
            }
            for child in node.get("children") or []:
                if child.get("type") != "part":
                    # LUKS / LVM containers: collect mountpoints from nested
                    # children, but keep the owning physical disk the same.
                    for nested in child.get("children") or []:
                        if nested.get("type") == "part":
                            _add_partition(disk, nested)
                    continue
                _add_partition(disk, child)
            disk["partitions"].sort(key=lambda part: part.get("mount") or "")
            disks.append(disk)
        else:
            for child in node.get("children") or []:
                visit(child, parent)

    def _add_partition(disk: dict[str, Any], node: dict[str, Any]) -> None:
        name = str(node.get("name") or "")
        if not name:
            return
        mountpoints = node.get("mountpoints") or []
        if isinstance(mountpoints, str):
            mountpoints = [mountpoints]
        for mountpoint in mountpoints:
            if not mountpoint or mountpoint.startswith("["):
                continue
            usage = _disk_partition_usage(str(mountpoint))
            if usage is None:
                continue
            device = f"/dev/{name}"
            info = partitions_by_device.get(device, {})
            entry = {
                "name": name,
                "device": device,
                "fstype": info.get("fstype") or None,
                "size": int(node.get("size") or 0),
                "size_text": _format_bytes(int(node.get("size") or 0)),
                **usage,
            }
            # Do not duplicate the same partition if it is bind mounted twice.
            if any(existing.get("device") == device and existing.get("mount") == usage["mount"] for existing in disk["partitions"]):
                continue
            disk["partitions"].append(entry)

    for device in devices:
        visit(device)

    if not disks:
        # Fallback: show mounted filesystems even without lsblk metadata.
        for partition in psutil.disk_partitions(all=False):
            if partition.device in {"/dev/loop0"}:
                continue
            usage = _disk_partition_usage(partition.mountpoint)
            if not usage:
                continue
            disks.append(
                {
                    "name": Path(partition.device).name,
                    "device": partition.device,
                    "model": None,
                    "serial": None,
                    "size": usage["total"],
                    "size_text": _format_bytes(usage["total"]),
                    "rota": None,
                    "tran": None,
                    "kind": "unknown",
                    "partitions": [
                        {
                            "name": Path(partition.device).name,
                            "device": partition.device,
                            "fstype": partition.fstype,
                            "size": usage["total"],
                            "size_text": _format_bytes(usage["total"]),
                            **usage,
                        }
                    ],
                }
            )
    return disks


# ---------------------------------------------------------------------------
# GPUs
# ---------------------------------------------------------------------------


class GpuMonitor:
    """Static GPU discovery + lightweight dynamic sampling.

    * Intel (i915/xe): frequency via sysfs; global utilisation is not exposed
      by the driver, so it stays ``None`` on purpose.
    * NVIDIA: nvidia-smi utilisation/frequency/temperature/VRAM (polled at most
      every two seconds).
    * AMD (amdgpu): gpu_busy_percent / VRAM / hwmon temperature.
    """

    def __init__(self) -> None:
        self.gpus: list[dict[str, Any]] = self._discover()
        self._nvidia_indices: dict[int, int] = {}
        self._nvidia_last = 0.0
        self._nvidia_dynamic: dict[int, dict[str, Any]] = {}
        self._discover_nvidia()
        self._last_sample = 0.0
        self._last_result: list[dict[str, Any]] = [
            self._public_gpu(gpu) for gpu in self.gpus
        ]

    # -- discovery ---------------------------------------------------------

    def _discover(self) -> list[dict[str, Any]]:
        raw = _run(["lspci", "-nn"])
        if not raw:
            return []
        gpus: list[dict[str, Any]] = []
        pattern = re.compile(
            r"^\s*([0-9a-fA-F]{2,}(?::[0-9a-fA-F]{2})+\.[0-7])\s+.+?:\s+(.+)$"
        )
        for line in raw.splitlines():
            if not re.search(r"(VGA compatible controller|3D controller|Display controller)", line):
                continue
            match = pattern.match(line)
            if not match:
                continue
            slot, description = match.groups()
            ids = re.findall(r"\[([0-9a-fA-F]{4}):([0-9a-fA-F]{4})\]", description)
            vendor_id, device_id = (ids[-1] if ids else (None, None))
            name = re.sub(
                r"\s*\[[0-9a-fA-F]{4}:[0-9a-fA-F]{4}\](?:\s*\(rev [^)]+\))?\s*$",
                "",
                description,
            ).strip() or description.strip()
            sysdev = self._sysfs_pci_device(slot)
            driver = None
            if sysdev is not None:
                driver_link = sysdev / "driver"
                try:
                    driver = Path(os.path.realpath(driver_link)).name
                except OSError:
                    driver = None
            vendor = PCI_VENDOR_NAMES.get((vendor_id or "").lower())
            if vendor is None:
                vendor = name.split(" ")[0] if name else None
            gpu: dict[str, Any] = {
                "name": name,
                "vendor": vendor,
                "vendor_id": vendor_id,
                "device_id": device_id,
                "pci": self._full_slot(slot),
                "driver": driver,
                "driver_version": None,
                "integrated": vendor in {"Intel", "AMD", "Apple"},
                "freq_mhz": None,
                "freq_max_mhz": None,
                "freq_min_mhz": None,
                "utilization": None,
                "vram_total": None,
                "vram_used": None,
                "temp_c": None,
                "note": None,
                "_freq_path": None,
                "_freq_max_path": None,
                "_freq_min_path": None,
                "_busy_path": None,
                "_vram_total_path": None,
                "_vram_used_path": None,
                "_temp_path": None,
                "_freq_scale": None,
                "_nvidia_index": None,
            }
            self._read_static_gpu_metrics(gpu, sysdev)
            gpus.append(gpu)
        return gpus

    @staticmethod
    def _sysfs_pci_device(slot: str) -> Path | None:
        candidates = glob.glob(f"/sys/bus/pci/devices/*:{slot}")
        if not candidates:
            candidates = glob.glob("/sys/bus/pci/devices/*")
            candidates = [path for path in candidates if path.endswith(slot)]
        if not candidates:
            return None
        return Path(candidates[0])

    @staticmethod
    def _full_slot(slot: str) -> str:
        if slot.count(":") == 1:
            return f"0000:{slot}"
        return slot

    def _read_static_gpu_metrics(self, gpu: dict[str, Any], sysdev: Path | None) -> None:
        driver = gpu.get("driver")
        if sysdev is None:
            return
        if driver == "xe":
            # On xe, act_freq often reads 0 when the GT is clock-gated; the
            # requested clock (cur_freq) is the value exposed by the driver's
            # sysfs interface.  We label it as a requested frequency in the UI.
            freq_paths = sorted(
                glob.glob(str(sysdev / "tile*" / "gt*" / "freq0" / "cur_freq"))
            )
            if freq_paths:
                gpu["_freq_path"] = freq_paths[0]
                gpu["_freq_max_path"] = str(Path(freq_paths[0]).with_name("max_freq"))
                gpu["_freq_min_path"] = str(Path(freq_paths[0]).with_name("min_freq"))
                gpu["freq_max_mhz"] = read_int(gpu["_freq_max_path"])
                gpu["freq_min_mhz"] = read_int(gpu["_freq_min_path"])
        elif driver == "i915":
            card = self._drm_card_for(sysdev)
            if card is not None:
                gpu["_freq_path"] = str(card / "gt_cur_freq_mhz")
                gpu["_freq_max_path"] = str(card / "gt_max_freq_mhz")
                gpu["_freq_min_path"] = str(card / "gt_min_freq_mhz")
                gpu["freq_max_mhz"] = read_int(gpu["_freq_max_path"])
                gpu["freq_min_mhz"] = read_int(gpu["_freq_min_path"])
        elif driver == "amdgpu":
            if (sysdev / "gpu_busy_percent").exists():
                gpu["_busy_path"] = str(sysdev / "gpu_busy_percent")
            if (sysdev / "mem_info_vram_total").exists():
                gpu["_vram_total_path"] = str(sysdev / "mem_info_vram_total")
                gpu["_vram_used_path"] = str(sysdev / "mem_info_vram_used")
                gpu["vram_total"] = read_int(gpu["_vram_total_path"])
            temp_paths = glob.glob(str(sysdev / "hwmon" / "hwmon*" / "temp1_input"))
            if temp_paths:
                gpu["_temp_path"] = temp_paths[0]
            gpu["integrated"] = gpu["vram_total"] is None
            # amdgpu exposes the current shader clock through hwmon on most
            # cards; if it is missing we simply leave the frequency empty.
            freq_paths = glob.glob(str(sysdev / "hwmon" / "hwmon*" / "freq1_input"))
            if freq_paths:
                gpu["_freq_path"] = freq_paths[0]
                gpu["_freq_scale"] = 1_000_000  # Hz -> MHz
        else:
            card = self._drm_card_for(sysdev)
            if card is not None:
                gpu["_freq_path"] = str(card / "gt_cur_freq_mhz")
                gpu["_freq_max_path"] = str(card / "gt_max_freq_mhz")
                gpu["freq_max_mhz"] = read_int(str(card / "gt_max_freq_mhz"))

        module_version = read_text(f"/sys/module/{driver}/version") if driver else None
        if module_version:
            gpu["driver_version"] = module_version

        if gpu.get("utilization") is None:
            if gpu.get("_freq_path") and not gpu.get("_busy_path"):
                driver_label = f"The {driver}" if driver else "The current"
                gpu["note"] = (
                    f"{driver_label} driver does not expose a global GPU utilization percentage; "
                    "the requested GPU frequency is shown instead."
                )
            elif not gpu.get("_busy_path") and gpu.get("_nvidia_index") is None:
                gpu["note"] = "This GPU driver does not expose readable utilization data."

    @staticmethod
    def _drm_card_for(sysdev: Path) -> Path | None:
        try:
            target = sysdev.resolve()
        except OSError:
            return None
        for card in sorted(Path("/sys/class/drm").glob("card[0-9]*")):
            if not re.fullmatch(r"card\d+", card.name):
                continue
            try:
                if (card / "device").resolve() == target:
                    return card
            except OSError:
                continue
        return None

    def _discover_nvidia(self) -> None:
        raw = _run(
            [
                "nvidia-smi",
                "--query-gpu=index,pci.bus_id,name,driver_version,memory.total",
                "--format=csv,noheader,nounits",
            ],
            timeout=4.0,
        )
        if not raw:
            return
        for line in raw.splitlines():
            parts = [part.strip() for part in line.split(",")]
            if len(parts) < 5:
                continue
            try:
                index = int(parts[0])
                bus_id = parts[1]
                name = parts[2]
                driver_version = parts[3]
                memory_total_mib = _parse_float(parts[4])
            except ValueError:
                continue
            position: int | None = None
            for pos, gpu in enumerate(self.gpus):
                if gpu.get("_nvidia_index") is not None:
                    continue
                if (gpu.get("vendor_id") or "").lower() == "10de" and gpu.get("pci"):
                    if bus_id.endswith(gpu["pci"]):
                        position = pos
                        break
            if position is None:
                for pos, gpu in enumerate(self.gpus):
                    if (gpu.get("vendor_id") or "").lower() == "10de" and gpu.get("_nvidia_index") is None:
                        position = pos
                        break
            if position is None:
                continue
            gpu = self.gpus[position]
            gpu["name"] = name or gpu.get("name")
            gpu["driver_version"] = driver_version or gpu.get("driver_version")
            if memory_total_mib is not None:
                gpu["vram_total"] = int(memory_total_mib * 1024 * 1024)
            gpu["integrated"] = False
            gpu["_nvidia_index"] = index
            gpu["note"] = None
            self._nvidia_indices[index] = position

    # -- dynamic sampling --------------------------------------------------

    def sample(self, now: float | None = None) -> list[dict[str, Any]]:
        now = time.monotonic() if now is None else now
        if now - self._last_sample < 1.0:
            return self._last_result
        for gpu in self.gpus:
            if gpu.get("_freq_path"):
                freq = read_int(gpu["_freq_path"])
                if freq is not None and gpu.get("_freq_scale"):
                    freq = round(freq / gpu["_freq_scale"])
                gpu["freq_mhz"] = freq
            if gpu.get("_freq_max_path"):
                gpu["freq_max_mhz"] = read_int(gpu["_freq_max_path"])
            if gpu.get("_busy_path"):
                gpu["utilization"] = read_int(gpu["_busy_path"])
            if gpu.get("_vram_total_path"):
                gpu["vram_total"] = read_int(gpu["_vram_total_path"])
            if gpu.get("_vram_used_path"):
                gpu["vram_used"] = read_int(gpu["_vram_used_path"])
            if gpu.get("_temp_path"):
                temp = read_int(gpu["_temp_path"])
                gpu["temp_c"] = round(temp / 1000.0, 1) if temp is not None else None

        if self._nvidia_indices and now - self._nvidia_last >= 2.0:
            self._sample_nvidia(now)

        self._last_result = [self._public_gpu(gpu) for gpu in self.gpus]
        self._last_sample = now
        return self._last_result

    def _sample_nvidia(self, now: float) -> None:
        raw = _run(
            [
                "nvidia-smi",
                "--query-gpu=index,utilization.gpu,memory.used,temperature.gpu,clocks.current.graphics",
                "--format=csv,noheader,nounits",
            ],
            timeout=3.0,
        )
        self._nvidia_last = now
        if not raw:
            return
        for line in raw.splitlines():
            parts = [part.strip() for part in line.split(",")]
            if len(parts) < 5:
                continue
            try:
                index = int(parts[0])
            except ValueError:
                continue
            gpu_pos = self._nvidia_indices.get(index)
            if gpu_pos is None:
                continue
            gpu = self.gpus[gpu_pos]
            utilization = _parse_float(parts[1])
            memory_used_mib = _parse_float(parts[2])
            temperature = _parse_float(parts[3])
            clock = _parse_float(parts[4])
            if utilization is not None:
                gpu["utilization"] = round(utilization, 1)
            if memory_used_mib is not None:
                gpu["vram_used"] = int(memory_used_mib * 1024 * 1024)
            if temperature is not None:
                gpu["temp_c"] = round(temperature, 1)
            if clock is not None:
                gpu["freq_mhz"] = int(clock)
            if gpu.get("utilization") is None:
                gpu["note"] = "nvidia-smi did not return GPU utilization."
            elif not gpu.get("_temp_path"):
                gpu["note"] = None

    @staticmethod
    def _public_gpu(gpu: dict[str, Any]) -> dict[str, Any]:
        return {key: value for key, value in gpu.items() if not key.startswith("_")}

    @property
    def public(self) -> list[dict[str, Any]]:
        return [self._public_gpu(gpu) for gpu in self.gpus]


# ---------------------------------------------------------------------------
# networking / OS
# ---------------------------------------------------------------------------


def _network_info() -> list[dict[str, Any]]:
    interfaces: list[dict[str, Any]] = []
    stats = psutil.net_if_stats()
    for name, addresses in psutil.net_if_addrs().items():
        if name == "lo":
            continue
        iface_dir = Path("/sys/class/net") / name
        if (iface_dir / "wireless").exists() or (iface_dir / "phy80211").exists():
            kind = "wifi"
            kind_label = "Wi-Fi"
        elif (iface_dir / "device").exists():
            kind = "ethernet"
            kind_label = "Ethernet"
        else:
            kind = "virtual"
            kind_label = "Virtual network"
        link = stats.get(name)
        speed = read_int(iface_dir / "speed")
        operstate = read_text(iface_dir / "operstate")
        ipv4: list[str] = []
        ipv6: list[str] = []
        mac: str | None = None
        for address in addresses:
            if address.family == socket.AF_INET:
                ipv4.append(address.address)
            elif address.family == socket.AF_INET6:
                cleaned = address.address.split("%", 1)[0]
                if cleaned and cleaned != "::1" and not cleaned.lower().startswith("fe80:"):
                    ipv6.append(cleaned)
            elif address.family == psutil.AF_LINK:
                mac = address.address
        interfaces.append(
            {
                "name": name,
                "kind": kind,
                "type": kind_label,
                "mac": mac,
                "ipv4": ipv4,
                "ipv6": ipv6,
                "mtu": link.mtu if link else None,
                "speed_mbps": speed if speed and speed > 0 else None,
                "state": operstate or ("up" if link and link.isup else "down"),
                "is_up": bool(link.isup) if link else None,
            }
        )
    interfaces.sort(key=lambda item: (item["kind"] != "ethernet", item["name"]))
    return interfaces


def _os_info() -> dict[str, Any]:
    release: dict[str, str] = {}
    try:
        release = dict(platform.freedesktop_os_release())
    except (OSError, AttributeError):
        pass
    pretty = release.get("PRETTY_NAME") or release.get("NAME") or platform.system()
    boot_time = psutil.boot_time()
    return {
        "name": pretty,
        "id": release.get("ID"),
        "version_id": release.get("VERSION_ID"),
        "kernel": platform.release(),
        "architecture": platform.machine(),
        "hostname": socket.gethostname(),
        "boot_time": boot_time,
        "timezone": datetime.now().astimezone().tzname(),
        "locale": os.environ.get("LANG"),
        "session_type": os.environ.get("XDG_SESSION_TYPE"),
        "desktop": os.environ.get("XDG_CURRENT_DESKTOP") or os.environ.get("XDG_SESSION_DESKTOP"),
    }


def battery_state() -> dict[str, Any] | None:
    try:
        battery = psutil.sensors_battery()
    except (AttributeError, NotImplementedError, OSError):
        return None
    if battery is None:
        return None
    info: dict[str, Any] = {
        "percent": round(battery.percent, 1) if battery.percent is not None else None,
        "plugged": bool(battery.power_plugged),
        "secsleft": battery.secsleft,
        "power_w": None,
    }
    for power_dir in sorted(glob.glob("/sys/class/power_supply/BAT*")):
        power_now = read_int(Path(power_dir) / "power_now")
        if power_now:
            info["power_w"] = round(abs(power_now) / 1_000_000, 1)
            break
        current_now = read_int(Path(power_dir) / "current_now")
        voltage_now = read_int(Path(power_dir) / "voltage_now")
        if current_now and voltage_now:
            info["power_w"] = round(abs(current_now * voltage_now) / 1e12, 1)
            break
    return info


def collect_system_info(gpus: list[dict[str, Any]] | None = None) -> dict[str, Any]:
    """Collect the static information served by ``GET /api/system``."""
    return {
        "app": {
            "name": APP_NAME,
            "version": __version__,
            "generated_at": time.time(),
        },
        "host": _os_info(),
        "hardware": {
            "system": _dmi_info(),
            "cpu": _cpu_info(),
            "memory": _memory_info(),
            "disks": _disks_info(),
            "gpus": gpus if gpus is not None else GpuMonitor().public,
            "network": _network_info(),
            "battery": battery_state(),
        },
        "permissions": {
            "euid": os.geteuid(),
            "is_root": os.geteuid() == 0,
            "current_user": psutil.Process().username(),
        },
    }


def interface_rates(
    previous: dict[str, psutil._common.snetio] | None,
    current: dict[str, psutil._common.snetio],
    elapsed: float | None,
) -> dict[str, dict[str, float]]:
    """Helper kept here so the sampler and tests share the same arithmetic."""
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
