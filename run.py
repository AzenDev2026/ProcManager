#!/usr/bin/env python3
"""ProcManager launcher.

Modes
-----
* default "auto": native PyQt6 window when the project-local `.venv-native`
  (or a compatible system Qt) is available; otherwise a Chromium app window
  (no tabs / address bar), otherwise the default browser.
* --desktop : native PyQt6 window (falls back if PyQt6 is incompatible)
* --app     : Chromium app window
* --web     : default browser

The project-local `.venv-native` is created by
`scripts/setup-native-window.sh`.  It keeps a known-good PyQt6/WebEngine set
isolated from the rest of the system, and run.py automatically re-execs into
it for native/auto modes.

Examples:
    ./run.py
    ./run.py --app --no-browser --port 8765
    ./run.py --web --no-browser --port 8765
"""

from __future__ import annotations

import argparse
import fcntl
import logging
import os
import shutil
import subprocess
import sys
import threading
import time
import webbrowser
from pathlib import Path

from procmanager import APP_NAME, __version__
from procmanager.server import ProcManagerApp

APP_DATA = Path(os.environ.get("XDG_DATA_HOME", str(Path.home() / ".local" / "share"))) / "ProcManager"
PROJECT_DIR = Path(__file__).resolve().parent
NATIVE_VENV_PYTHON = PROJECT_DIR / ".venv-native" / "bin" / "python"
NATIVE_VENV_DIR = PROJECT_DIR / ".venv-native"


def _graphical_session() -> bool:
    return bool(os.environ.get("DISPLAY") or os.environ.get("WAYLAND_DISPLAY"))


def _native_venv_python() -> Path | None:
    """Return the project-local venv Python unless we are already inside it."""
    candidate = NATIVE_VENV_PYTHON
    try:
        if not candidate.is_file() or not os.access(candidate, os.X_OK):
            return None
        if candidate.absolute() == Path(sys.executable).absolute():
            return None
        if Path(sys.prefix).absolute() == NATIVE_VENV_DIR.absolute():
            return None
    except OSError:
        return None
    return candidate


def _native_venv_works(python: Path) -> bool:
    """Cheap probe: the venv has the packages needed for a Qt window."""
    try:
        result = subprocess.run(
            [str(python), "-c", "import psutil, PyQt6.QtWebEngineWidgets"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=10,
        )
    except (OSError, subprocess.SubprocessError):
        return False
    return result.returncode == 0


def _maybe_reexec_native(args: argparse.Namespace) -> None:
    """Switch auto/--desktop launches into the isolated native Qt environment."""
    if args.web or args.app or os.geteuid() == 0 or not _graphical_session():
        return
    python = _native_venv_python()
    if python is None or not _native_venv_works(python):
        return
    print(f"Using isolated native Qt environment: {python}", flush=True)
    try:
        os.execv(
            str(python),
            [str(python), str(Path(__file__).resolve()), *sys.argv[1:]],
        )
    except OSError as error:
        print(f"Could not switch to the native Qt environment: {error}", file=sys.stderr)


def _pyqt_status() -> tuple[bool, str]:
    """Check that QtCore and QtWebEngine are importable *and compatible*.

    Mixing a system PyQt6 with a pip-installed PyQt6-WebEngine from a
    different Qt release causes Chromium to abort inside ICU/Mojo, so we
    compare the runtime versions instead of only trying to import.
    """
    if not _graphical_session():
        return False, "no graphical session detected"
    try:
        import PyQt6
        import PyQt6.QtCore as qt_core
        import PyQt6.QtWebEngineCore as web_engine
        import PyQt6.QtWebEngineWidgets  # noqa: F401
    except Exception as error:  # pragma: no cover - depends on host packages
        return False, f"PyQt6 WebEngine is not available ({error})"

    core_dir = os.path.dirname(os.path.abspath(qt_core.__file__))
    web_dir = os.path.dirname(os.path.abspath(web_engine.__file__))
    widgets_dir = os.path.dirname(os.path.abspath(PyQt6.QtWebEngineWidgets.__file__))
    if core_dir != web_dir or widgets_dir != web_dir:
        return (
            False,
            "PyQt6 and PyQt6-WebEngine are installed from different locations "
            "(%s vs %s); mixing system and pip Qt packages can crash Chromium. "
            "Use --app, or run scripts/setup-native-window.sh and let run.py "
            "use the isolated Qt environment." % (core_dir, web_dir),
        )
    # QtWebEngine does not expose QT_VERSION_STR through PyQt6, so this
    # location check is the most reliable cheap compatibility test.
    return True, "PyQt6 and QtWebEngine modules share one installation"



def _chromium_binary() -> str | None:
    for name in (
        "chromium",
        "chromium-browser",
        "google-chrome",
        "google-chrome-stable",
        "brave-browser",
        "microsoft-edge",
    ):
        found = shutil.which(name)
        if found:
            return found
    return None


class AppModeLock:
    """Single-instance guard for the Chromium app window."""

    def __init__(self) -> None:
        self.handle = None

    def acquire(self) -> bool:
        APP_DATA.mkdir(parents=True, exist_ok=True)
        handle = open(APP_DATA / "app.lock", "w", encoding="utf-8")
        try:
            fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            handle.close()
            return False
        handle.write(str(os.getpid()))
        handle.flush()
        self.handle = handle
        return True

    def release(self) -> None:
        if self.handle is not None:
            try:
                fcntl.flock(self.handle.fileno(), fcntl.LOCK_UN)
            finally:
                self.handle.close()
                self.handle = None


def _launch_chromium_app(url: str) -> subprocess.Popen | None:
    binary = _chromium_binary()
    if not binary:
        return None
    profile = APP_DATA / "chromium-profile"
    profile.mkdir(parents=True, exist_ok=True)
    arguments = [
        binary,
        f"--app={url}",
        f"--user-data-dir={profile}",
        "--class=ProcManager",
        "--window-size=1360,860",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-sync",
        "--disable-features=Translate,OptimizationHints,MediaRouter",
        "--password-store=basic",
    ]
    try:
        return subprocess.Popen(arguments)
    except OSError as error:
        print(f"Could not launch Chromium: {error}", file=sys.stderr)
        return None


def _make_app(port: int, debug: bool) -> ProcManagerApp:
    try:
        return ProcManagerApp(port=port, debug=debug)
    except OSError as error:
        if port == 0:
            raise
        print(f"Port {port} is unavailable ({error}); using a random free port.", flush=True)
        return ProcManagerApp(port=0, debug=debug)


def _print_banner(app: ProcManagerApp) -> None:
    print(f"{APP_NAME} {__version__}")
    print(f"Local UI: {app.url}")
    print("Data stays on this machine. Press Ctrl+C to quit.", flush=True)


def _run_app_window(app: ProcManagerApp) -> int:
    lock = AppModeLock()
    if not lock.acquire():
        print("ProcManager is already running in an app window.", file=sys.stderr)
        return 0
    try:
        process = _launch_chromium_app(app.url)
        if process is None:
            print("Chromium was not found; opening the default browser instead.", file=sys.stderr)
            webbrowser.open(app.url)
            try:
                while True:
                    time.sleep(3600)
            except KeyboardInterrupt:
                pass
            return 0

        print(f"App window: {_chromium_binary()} (close the window to quit)", flush=True)
        # Catch very early failures (e.g. a profile lock from a crashed run).
        time.sleep(1.0)
        if process.poll() is not None and process.returncode not in (0, None):
            print(
                f"Chromium exited with code {process.returncode}; opening the default browser instead.",
                file=sys.stderr,
            )
            webbrowser.open(app.url)
            try:
                while True:
                    time.sleep(3600)
            except KeyboardInterrupt:
                pass
            return 0
        try:
            process.wait()
        except KeyboardInterrupt:
            print("\nClosing ProcManager…", flush=True)
            if process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    process.kill()
        return 0
    finally:
        lock.release()


def main() -> int:
    parser = argparse.ArgumentParser(description="ProcManager - process and system monitor")
    parser.add_argument("--web", action="store_true", help="open in the default browser")
    parser.add_argument("--desktop", action="store_true", help="force the native PyQt6 window")
    parser.add_argument("--app", action="store_true", help="force a Chromium app window")
    parser.add_argument("--port", type=int, default=None, help="TCP port (default: 8766 for windows, 8765 for web)")
    parser.add_argument("--no-browser", action="store_true", help="do not open a browser automatically")
    parser.add_argument("--devtools", action="store_true", help="enable Chromium remote debugging (port 9222)")
    parser.add_argument("--debug", action="store_true", help="verbose server logging")
    parser.add_argument("--version", action="version", version=f"{APP_NAME} {__version__}")
    args = parser.parse_args()
    if args.debug:
        logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")

    # Prefer the project-local, self-consistent Qt environment.  The venv
    # Python symlink resolves to /usr/bin/python3, so compare the executable
    # paths without following the symlink.
    _maybe_reexec_native(args)

    pyqt_ok, pyqt_reason = _pyqt_status()
    chromium = _chromium_binary()

    if args.web:
        mode = "web"
    elif args.app:
        mode = "app" if chromium and _graphical_session() else "web"
        if mode == "web":
            print("Chromium app mode is unavailable (no browser or no graphical session); using the web UI.", file=sys.stderr)
    elif args.desktop:
        if pyqt_ok:
            mode = "pyqt"
        else:
            print(f"Native window unavailable: {pyqt_reason}", file=sys.stderr)
            mode = "app" if chromium and _graphical_session() else "web"
            print(f"Falling back to {'Chromium app window' if mode == 'app' else 'browser'} mode.", file=sys.stderr)
    else:
        if pyqt_ok and _graphical_session():
            mode = "pyqt"
        elif chromium and _graphical_session():
            mode = "app"
        else:
            mode = "web"

    if os.geteuid() == 0 and mode in {"pyqt", "app"}:
        # Chromium refuses to use its sandbox as root; keep the backend usable
        # by serving the UI for a normal browser instead.
        print("Running as root: starting browser mode. Open the printed URL in a non-root browser.", file=sys.stderr)
        mode = "web"
        args.no_browser = True

    if args.devtools:
        os.environ.setdefault("QTWEBENGINE_REMOTE_DEBUGGING", "9222")

    # A stable port keeps localStorage (theme/settings) attached to the same
    # origin across app-window launches.  Fall back to a random port if busy.
    default_port = 8766 if mode in {"pyqt", "app"} else 8765
    port = args.port if args.port is not None else default_port
    try:
        app = _make_app(port, args.debug)
        app.start()
    except Exception as error:
        print(f"Could not start ProcManager: {error}", file=sys.stderr)
        return 1

    _print_banner(app)
    try:
        if mode == "pyqt":
            print("Mode: native PyQt6 window", flush=True)
            try:
                from procmanager.desktop import run_desktop

                run_desktop(app.url)
            except Exception as error:  # pragma: no cover - host dependent
                print(f"Native window failed: {error}", file=sys.stderr)
                print("Falling back to the Chromium app window / browser.", file=sys.stderr)
                if chromium and _graphical_session():
                    _run_app_window(app)
                elif not args.no_browser:
                    webbrowser.open(app.url)
                    _wait_forever()
            return 0

        if mode == "app":
            print("Mode: Chromium app window", flush=True)
            return _run_app_window(app)

        print("Mode: browser", flush=True)
        if not args.no_browser:
            threading.Timer(0.6, lambda: webbrowser.open(app.url)).start()
        _wait_forever()
        return 0
    finally:
        app.stop()


def _wait_forever() -> None:
    try:
        while True:
            time.sleep(3600)
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    raise SystemExit(main())
