"""API and security tests for ProcManager.

Run with:  python3 -m unittest discover -s tests -v
"""

from __future__ import annotations

import json
import os
import subprocess
import time
import unittest
import urllib.error
import urllib.request

import psutil

from procmanager.server import ProcManagerApp


class ProcManagerApiTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.app = ProcManagerApp(port=0)
        cls.app.start()
        cls.base = cls.app.url.rstrip("/")
        cls.deadline = time.monotonic() + 10
        while time.monotonic() < cls.deadline:
            try:
                stats = cls.get_json("/api/stats")
                if stats.get("ts"):
                    break
            except Exception:
                pass
            time.sleep(0.2)

    @classmethod
    def tearDownClass(cls) -> None:
        cls.app.stop()

    # -- helpers -------------------------------------------------------

    @classmethod
    def request(cls, path: str, method: str = "GET", payload=None, token=None, headers=None):
        url = cls.base + path
        body = None
        request_headers = {"Accept": "application/json"}
        if headers:
            request_headers.update(headers)
        if payload is not None:
            body = json.dumps(payload).encode("utf-8")
            request_headers["Content-Type"] = "application/json"
        if token is not None:
            request_headers["X-PM-Token"] = token
        request = urllib.request.Request(url, data=body, headers=request_headers, method=method)
        return urllib.request.urlopen(request, timeout=8)

    @classmethod
    def get_json(cls, path: str):
        with cls.request(path) as response:
            return json.load(response)

    @classmethod
    def post_json(cls, path: str, payload, token=None):
        with cls.request(path, method="POST", payload=payload, token=token) as response:
            return json.load(response)

    def wait_for_process(self, pid: int, timeout: float = 6.0):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            data = self.get_json("/api/processes")
            for item in data.get("items", []):
                if item["pid"] == pid:
                    return item
            time.sleep(0.2)
        return None

    def spawn_sleep(self, seconds: int = 60) -> tuple[subprocess.Popen, dict]:
        process = subprocess.Popen(["sleep", str(seconds)])
        self.addCleanup(self._cleanup_process, process)
        item = self.wait_for_process(process.pid)
        self.assertIsNotNone(item, "sleep process did not appear in /api/processes")
        return process, item

    @staticmethod
    def _cleanup_process(process: subprocess.Popen) -> None:
        if process.poll() is not None:
            return
        try:
            process.kill()
            process.wait(timeout=3)
        except Exception:
            pass

    # -- system info ---------------------------------------------------

    def test_health(self) -> None:
        data = self.get_json("/api/health")
        self.assertTrue(data["ok"])
        self.assertEqual(data["app"], "ProcManager")
        self.assertEqual(data["pid"], os.getpid())

    def test_system_info_matches_system(self) -> None:
        data = self.get_json("/api/system")
        hardware = data["hardware"]
        self.assertEqual(hardware["cpu"]["threads"], psutil.cpu_count(logical=True))
        self.assertEqual(hardware["memory"]["total"], psutil.virtual_memory().total)
        self.assertEqual(data["host"]["hostname"], os.uname().nodename)
        self.assertTrue(hardware["cpu"]["model"])
        self.assertTrue(hardware["disks"])
        root = next(
            (part for disk in hardware["disks"] for part in disk["partitions"] if part["mount"] == "/"),
            None,
        )
        self.assertIsNotNone(root)
        self.assertAlmostEqual(root["total"], psutil.disk_usage("/").total, delta=1024)
        self.assertTrue(hardware["gpus"] is not None)
        self.assertIn("server_pid", data["runtime"])

    def test_stats_accuracy(self) -> None:
        data = self.get_json("/api/stats")
        self.assertGreater(data["ts"], 0)
        self.assertEqual(len(data["cpu"]["per_core"]), psutil.cpu_count(logical=True))
        self.assertEqual(data["memory"]["total"], psutil.virtual_memory().total)
        self.assertGreater(data["memory"]["available"], 0)
        self.assertGreater(data["counts"]["processes"], 10)
        self.assertGreater(len(data["disk"]["partitions"]), 0)
        self.assertTrue(any(part["mount"] == "/" for part in data["disk"]["partitions"]))
        self.assertTrue(data["network"]["interfaces"])
        battery = data.get("battery")
        if battery:
            self.assertGreaterEqual(battery["percent"], 0)
            self.assertLessEqual(battery["percent"], 100)

    def test_process_list_contains_self(self) -> None:
        data = self.get_json("/api/processes")
        items = data["items"]
        self.assertGreater(len(items), 10)
        me = next((item for item in items if item["pid"] == os.getpid()), None)
        self.assertIsNotNone(me)
        self.assertEqual(me["name"], psutil.Process().name())
        self.assertGreater(me["memory"], 0)
        self.assertTrue(me["cpu"] is None or 0 <= me["cpu"] <= 100)
        self.assertIn("kernel", me)
        self.assertEqual(data["total"], len(items))

    def test_history(self) -> None:
        data = self.get_json("/api/history?seconds=10")
        self.assertIn("points", data)
        if data["points"]:
            point = data["points"][-1]
            for key in ("t", "cpu", "mem", "disk_read", "disk_write", "net_recv", "net_sent"):
                self.assertIn(key, point)
            self.assertGreater(point["t"], 0)

    def test_users(self) -> None:
        data = self.get_json("/api/users")
        self.assertTrue(data["users"])
        current_user = psutil.Process().username()
        self.assertTrue(any(user["name"] == current_user for user in data["users"]))
        self.assertIn("sessions", data)
        self.assertIn("kernel", data)

    def test_process_details(self) -> None:
        data = self.get_json(f"/api/process/{os.getpid()}")
        self.assertEqual(data["pid"], os.getpid())
        self.assertGreater(data["memory"]["rss"], 0)
        self.assertTrue(data["cmdline"])
        self.assertIn("python", " ".join(data["cmdline"]).lower())
        self.assertIsNotNone(data["cpu_times"]["user"])
        self.assertIsNotNone(data["open_files_count"])
        self.assertIsInstance(data["connections"], list)

    def test_process_details_404(self) -> None:
        with self.assertRaises(urllib.error.HTTPError) as context:
            self.request("/api/process/99999999")
        self.assertEqual(context.exception.code, 404)
        body = json.load(context.exception)
        self.assertIn("error", body)

    # -- static UI / security -----------------------------------------

    def test_index_served_with_token_and_csp(self) -> None:
        with self.request("/") as response:
            html = response.read().decode("utf-8")
            headers = {key.lower(): value for key, value in response.headers.items()}
        self.assertNotIn("__PM_TOKEN__", html)
        self.assertIn('name="pm-token"', html)
        self.assertIn("default-src 'self'", headers.get("content-security-policy", ""))
        self.assertEqual(headers.get("x-frame-options"), "DENY")
        self.assertEqual(headers.get("cache-control"), "no-store, max-age=0")

    def test_static_assets(self) -> None:
        for path, content_type in (
            ("/app.js", "text/javascript"),
            ("/styles.css", "text/css"),
            ("/boot.js", "text/javascript"),
            ("/icon.svg", "image/svg+xml"),
        ):
            with self.request(path) as response:
                self.assertEqual(response.status, 200)
                self.assertIn(content_type, response.headers.get("Content-Type", ""))
                self.assertGreater(len(response.read()), 100)

    def test_unknown_static_is_404(self) -> None:
        for path in ("/does-not-exist", "/../etc/passwd"):
            with self.assertRaises(urllib.error.HTTPError) as context:
                self.request(path)
            self.assertEqual(context.exception.code, 404)

    def test_bad_host_rejected(self) -> None:
        with self.assertRaises(urllib.error.HTTPError) as context:
            self.request("/api/health", headers={"Host": "evil.example"})
        self.assertEqual(context.exception.code, 421)

    def test_action_requires_token(self) -> None:
        with self.assertRaises(urllib.error.HTTPError) as context:
            self.post_json("/api/process/1/action", {"action": "terminate"})
        self.assertEqual(context.exception.code, 401)
        self.assertTrue(psutil.Process(1).is_running())

    def test_wrong_token_rejected(self) -> None:
        with self.assertRaises(urllib.error.HTTPError) as context:
            self.post_json("/api/process/1/action", {"action": "terminate"}, token="nope")
        self.assertEqual(context.exception.code, 401)
        self.assertTrue(psutil.Process(1).is_running())

    def test_protected_processes(self) -> None:
        with self.assertRaises(urllib.error.HTTPError) as context:
            self.post_json("/api/process/1/action", {"action": "terminate"}, token=self.app.token)
        self.assertEqual(context.exception.code, 403)

        runtime = self.get_json("/api/system")["runtime"]
        with self.assertRaises(urllib.error.HTTPError) as context:
            self.post_json(
                f"/api/process/{runtime['server_pid']}/action",
                {"action": "terminate"},
                token=self.app.token,
            )
        self.assertEqual(context.exception.code, 403)

    def test_cross_site_origin_rejected(self) -> None:
        with self.assertRaises(urllib.error.HTTPError) as context:
            self.request(
                "/api/process/1/action",
                method="POST",
                payload={"action": "terminate"},
                token=self.app.token,
                headers={"Origin": "https://evil.example"},
            )
        self.assertEqual(context.exception.code, 403)

    # -- real process actions -----------------------------------------

    def test_terminate_real_process(self) -> None:
        process, item = self.spawn_sleep(30)
        result = self.post_json(
            f"/api/process/{process.pid}/action",
            {"action": "terminate", "create_time": item["create_time"]},
            token=self.app.token,
        )
        self.assertTrue(result["ok"])
        process.wait(timeout=6)
        self.assertIsNotNone(process.poll())

    def test_suspend_and_resume(self) -> None:
        process, item = self.spawn_sleep(30)
        process_handle = psutil.Process(process.pid)

        result = self.post_json(
            f"/api/process/{process.pid}/action",
            {"action": "suspend", "create_time": item["create_time"]},
            token=self.app.token,
        )
        self.assertTrue(result["ok"])
        deadline = time.monotonic() + 4
        while time.monotonic() < deadline and process_handle.status() != psutil.STATUS_STOPPED:
            time.sleep(0.05)
        self.assertEqual(process_handle.status(), psutil.STATUS_STOPPED)

        result = self.post_json(
            f"/api/process/{process.pid}/action",
            {"action": "resume", "create_time": item["create_time"]},
            token=self.app.token,
        )
        self.assertTrue(result["ok"])
        deadline = time.monotonic() + 4
        while time.monotonic() < deadline and process_handle.status() == psutil.STATUS_STOPPED:
            time.sleep(0.05)
        self.assertNotEqual(process_handle.status(), psutil.STATUS_STOPPED)

    def test_stale_create_time_rejected(self) -> None:
        process, _item = self.spawn_sleep(30)
        with self.assertRaises(urllib.error.HTTPError) as context:
            self.post_json(
                f"/api/process/{process.pid}/action",
                {"action": "terminate", "create_time": 1.0},
                token=self.app.token,
            )
        self.assertEqual(context.exception.code, 409)
        self.assertIsNone(process.poll())
        process.kill()
        process.wait(timeout=3)


if __name__ == "__main__":
    unittest.main(verbosity=2)
