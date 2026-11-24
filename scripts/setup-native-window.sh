#!/usr/bin/env bash
# Create an isolated, self-consistent PyQt6/Qt WebEngine environment for the
# native ProcManager window.  The system Python and its PyQt6 packages are
# left untouched.
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SYSTEM_PYTHON="$(command -v python3)"
VENV="$APP_DIR/.venv-native"
REQUIREMENTS="$APP_DIR/requirements-native.txt"

if [[ ! -f "$REQUIREMENTS" ]]; then
  echo "Missing $REQUIREMENTS" >&2
  exit 1
fi

echo "Native Qt environment: $VENV"
if [[ ! -x "$VENV/bin/python" ]]; then
  "$SYSTEM_PYTHON" -m venv "$VENV"
fi

"$VENV/bin/python" -m pip install --upgrade pip
"$VENV/bin/python" -m pip install -r "$REQUIREMENTS"

"$VENV/bin/python" - <<'PY'
import PyQt6.QtCore as qt
import PyQt6.QtWebEngineWidgets  # noqa: F401
import psutil

print(f"PyQt6 {qt.PYQT_VERSION_STR} / Qt {qt.QT_VERSION_STR} / psutil {psutil.__version__}")
print("Native Qt environment is ready.")
PY

echo
echo "Launch with: $APP_DIR/.venv-native/bin/python $APP_DIR/run.py --desktop"
echo "Or just run: python3 $APP_DIR/run.py  (it will switch to this venv automatically)"
