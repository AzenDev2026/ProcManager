"""Local HTTP server and JSON API for ProcManager.

Security model
--------------
* Binds to loopback only.
* Validates the Host header (DNS-rebinding defence).
* Mutating requests require a random per-run token injected into the page.
* Cross-site POSTs are rejected by Origin / Sec-Fetch-Site checks.
* Only an explicit allow-list of static files is served.

The server is intentionally dependency-free (stdlib + psutil).
"""

from __future__ import annotations

import hmac
import json
import logging
import os
import secrets
import threading
import time
import urllib.parse
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

from . import APP_NAME, __version__
from .sampler import ActionError, ProcessDetailsError, Sampler

logger = logging.getLogger("procmanager.server")

WEB_DIR = Path(__file__).resolve().with_name("web")
PROJECT_DIR = Path(__file__).resolve().parent.parent
ICON_PATH = PROJECT_DIR / "assets" / "icon.svg"

MAX_POST_BODY = 8 * 1024


class ProcManagerApp:
    """Owns the sampler and the HTTP server; convenient for desktop mode."""

    def __init__(self, port: int = 0, interval: float = 1.0, debug: bool = False) -> None:
        self.sampler = Sampler(interval=interval)
        self.system_info = self.sampler.system_info
        self.token = secrets.token_urlsafe(24)
        self.debug = debug
        self.server = ProcManagerHTTPServer(self, ("127.0.0.1", port))
        self.thread: threading.Thread | None = None
        self.started_at = time.time()

    @property
    def port(self) -> int:
        return int(self.server.server_address[1])

    @property
    def url(self) -> str:
        return f"http://127.0.0.1:{self.port}/"

    def start(self) -> None:
        if self.thread is not None:
            return
        self.sampler.start()
        self.thread = threading.Thread(
            target=self.server.serve_forever,
            kwargs={"poll_interval": 0.25},
            name="procmanager-http",
            daemon=True,
        )
        self.thread.start()

    def stop(self) -> None:
        if self.thread is not None:
            self.server.shutdown()
            self.thread.join(timeout=3.0)
            self.thread = None
        self.server.server_close()
        self.sampler.stop()


class ProcManagerHTTPServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, app: ProcManagerApp, address: tuple[str, int]) -> None:
        self.app = app
        self.debug = app.debug
        super().__init__(address, ProcManagerRequestHandler)
        port = self.server_address[1]
        self.allowed_hosts = {
            f"127.0.0.1:{port}",
            f"localhost:{port}",
            f"[::1]:{port}",
        }
        self.allowed_origins = {
            f"http://127.0.0.1:{port}",
            f"http://localhost:{port}",
            f"http://[::1]:{port}",
        }


class ProcManagerRequestHandler(BaseHTTPRequestHandler):
    server_version = f"ProcManager/{__version__}"
    sys_version = ""
    protocol_version = "HTTP/1.1"

    server: ProcManagerHTTPServer

    # ------------------------------------------------------------------
    # plumbing
    # ------------------------------------------------------------------

    def log_message(self, format: str, *args: Any) -> None:  # noqa: A002
        if self.server.debug:
            logger.info("%s - %s", self.address_string(), format % args)

    def _security_headers(self) -> None:
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Cross-Origin-Resource-Policy", "same-origin")
        self.send_header("Cache-Control", "no-store, max-age=0")

    def _check_host(self) -> bool:
        host = (self.headers.get("Host") or "").strip().lower()
        if host in self.server.allowed_hosts:
            return True
        self._send_json(
            {"error": "Invalid Host header. ProcManager only accepts local requests."},
            421,
        )
        return False

    def _send_bytes(
        self,
        body: bytes,
        content_type: str,
        status: int = 200,
        extra_headers: dict[str, str] | None = None,
    ) -> None:
        try:
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            self._security_headers()
            for key, value in (extra_headers or {}).items():
                self.send_header(key, value)
            self.end_headers()
            if self.command != "HEAD":
                self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            if self.server.debug:
                logger.debug("client disconnected before response finished")

    def _send_json(self, payload: Any, status: int = 200) -> None:
        body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        self._send_bytes(body, "application/json; charset=utf-8", status)

    def _send_error_json(self, status: int, message: str) -> None:
        self._send_json({"error": message, "status": status}, status)

    def _allowed_origin(self) -> bool:
        origin = (self.headers.get("Origin") or "").rstrip("/")
        if origin and origin not in self.server.allowed_origins:
            return False
        fetch_site = self.headers.get("Sec-Fetch-Site")
        if fetch_site and fetch_site not in {"same-origin", "none"}:
            return False
        return True

    # ------------------------------------------------------------------
    # HTTP methods
    # ------------------------------------------------------------------

    def do_GET(self) -> None:  # noqa: N802
        if not self._check_host():
            return
        parsed = urllib.parse.urlsplit(self.path)
        path = parsed.path
        try:
            if path.startswith("/api/"):
                self._handle_api_get(path, urllib.parse.parse_qs(parsed.query))
            else:
                self._serve_static(path)
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception:
            logger.exception("unhandled GET error for %s", self.path)
            self._send_error_json(500, "Internal server error.")

    def do_HEAD(self) -> None:  # noqa: N802
        self.do_GET()

    def do_POST(self) -> None:  # noqa: N802
        if not self._check_host():
            return
        parsed = urllib.parse.urlsplit(self.path)
        try:
            if parsed.path.startswith("/api/"):
                self._handle_api_post(parsed.path)
            else:
                self._send_error_json(404, "API endpoint not found.")
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception:
            logger.exception("unhandled POST error for %s", self.path)
            self._send_error_json(500, "Internal server error.")

    # ------------------------------------------------------------------
    # static files
    # ------------------------------------------------------------------

    def _serve_static(self, path: str) -> None:
        if path in {"/", "/index.html"}:
            self._serve_index()
            return
        if path in {"/favicon.svg", "/icon.svg"}:
            self._serve_asset(ICON_PATH, "image/svg+xml")
            return
        if path == "/app.js":
            self._serve_asset(WEB_DIR / "app.js", "text/javascript; charset=utf-8")
            return
        if path == "/boot.js":
            self._serve_asset(WEB_DIR / "boot.js", "text/javascript; charset=utf-8")
            return
        if path == "/styles.css":
            self._serve_asset(WEB_DIR / "styles.css", "text/css; charset=utf-8")
            return
        if path == "/favicon.ico":
            self._send_bytes(b"", "image/x-icon", HTTPStatus.NO_CONTENT)
            return
        self._send_bytes(
            "404 Not Found".encode(),
            "text/plain; charset=utf-8",
            HTTPStatus.NOT_FOUND,
        )

    def _serve_index(self) -> None:
        index_path = WEB_DIR / "index.html"
        try:
            html = index_path.read_text(encoding="utf-8")
        except OSError:
            self._send_error_json(500, "UI files are missing.")
            return
        html = html.replace("__PM_TOKEN__", self.server.app.token).replace(
            "__PM_VERSION__", __version__
        )
        csp = (
            "default-src 'self'; "
            "script-src 'self'; "
            "style-src 'self' 'unsafe-inline'; "
            "img-src 'self' data:; "
            "connect-src 'self'; "
            "font-src 'self'; "
            "base-uri 'none'; "
            "form-action 'none'; "
            "frame-ancestors 'none'"
        )
        self._send_bytes(
            html.encode("utf-8"),
            "text/html; charset=utf-8",
            extra_headers={"Content-Security-Policy": csp},
        )

    def _serve_asset(self, path: Path, content_type: str) -> None:
        try:
            body = path.read_bytes()
        except OSError:
            self._send_error_json(404, "Resource not found.")
            return
        self._send_bytes(body, content_type)

    # ------------------------------------------------------------------
    # API
    # ------------------------------------------------------------------

    def _handle_api_get(self, path: str, query: dict[str, list[str]]) -> None:
        sampler = self.server.app.sampler
        if path == "/api/health":
            self._send_json(
                {
                    "ok": True,
                    "app": APP_NAME,
                    "version": __version__,
                    "pid": os.getpid(),
                    "uptime": round(time.time() - self.server.app.started_at, 1),
                }
            )
            return
        if path == "/api/system":
            payload = dict(self.server.app.system_info)
            payload["runtime"] = {
                "port": self.server.app.port,
                "server_pid": os.getpid(),
                "started_at": self.server.app.started_at,
                "sampling_interval": sampler.interval,
            }
            self._send_json(payload)
            return
        if path == "/api/stats":
            self._send_json(sampler.stats())
            return
        if path == "/api/processes":
            self._send_json(sampler.processes())
            return
        if path == "/api/users":
            self._send_json(sampler.users())
            return
        if path == "/api/history":
            try:
                seconds = int((query.get("seconds") or ["120"])[0])
            except (TypeError, ValueError):
                seconds = 120
            self._send_json(sampler.history(seconds))
            return
        if path.startswith("/api/process/"):
            tail = path[len("/api/process/") :]
            if not tail.isdigit():
                self._send_error_json(404, "Process not found.")
                return
            try:
                self._send_json(sampler.process_details(int(tail)))
            except ProcessDetailsError as error:
                self._send_error_json(error.status, error.message)
            return
        self._send_error_json(404, "API endpoint not found.")

    def _handle_api_post(self, path: str) -> None:
        if not self._allowed_origin():
            self._send_error_json(403, "Cross-site request rejected.")
            return
        token = self.headers.get("X-PM-Token") or ""
        if not hmac.compare_digest(token, self.server.app.token):
            self._send_error_json(401, "Missing or invalid action token. Reload the page and try again.")
            return
        content_type = (self.headers.get("Content-Type") or "").split(";", 1)[0].strip().lower()
        if content_type != "application/json":
            self._send_error_json(415, "Content-Type must be application/json.")
            return
        try:
            length = int(self.headers.get("Content-Length") or "0")
        except ValueError:
            length = 0
        if length <= 0 or length > MAX_POST_BODY:
            self._send_error_json(400, "Invalid request body.")
            return
        try:
            payload = json.loads(self.rfile.read(length).decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            self._send_error_json(400, "Invalid JSON body.")
            return
        if not isinstance(payload, dict):
            self._send_error_json(400, "Invalid request body.")
            return

        prefix = "/api/process/"
        if path.startswith(prefix) and path.endswith("/action"):
            pid_text = path[len(prefix) : -len("/action")].strip("/")
            if not pid_text.isdigit():
                self._send_error_json(404, "Process not found.")
                return
            action = payload.get("action")
            expected_create_time = payload.get("create_time")
            try:
                result = self.server.app.sampler.perform_action(
                    int(pid_text),
                    str(action or ""),
                    float(expected_create_time) if expected_create_time is not None else None,
                )
            except ActionError as error:
                self._send_error_json(error.status, error.message)
                return
            except (TypeError, ValueError):
                self._send_error_json(400, "Invalid process parameter.")
                return
            self._send_json(result)
            return
        self._send_error_json(404, "API endpoint not found.")
