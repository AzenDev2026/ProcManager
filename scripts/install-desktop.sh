#!/usr/bin/env bash
# Install a ProcManager launcher in the desktop application menu.
# It prefers the native Qt window when .venv-native exists (or a compatible
# system PyQt6 is available) and falls back to a Chromium app window.
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SYSTEM_PYTHON="$(command -v python3)"
APPLICATIONS_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
mkdir -p "$APPLICATIONS_DIR"

ENTRY="$APPLICATIONS_DIR/procmanager.desktop"
cat > "$ENTRY" <<DESKTOP
[Desktop Entry]
Type=Application
Version=1.0
Name=ProcManager
GenericName=Process Manager
Comment=Monitor processes, performance and hardware
Exec=$SYSTEM_PYTHON "$APP_DIR/run.py" --desktop --no-browser
Path=$APP_DIR
Icon=$APP_DIR/assets/icon.svg
Terminal=false
Categories=System;Monitor;
Keywords=process;task;manager;monitor;memory;cpu;hardware;
StartupNotify=true
StartupWMClass=ProcManager
Actions=web;

[Desktop Action web]
Name=Open in browser
Exec=$SYSTEM_PYTHON "$APP_DIR/run.py" --web
DESKTOP

chmod 644 "$ENTRY"
if command -v update-desktop-database >/dev/null 2>&1; then
  update-desktop-database "$APPLICATIONS_DIR" >/dev/null 2>&1 || true
fi

if [[ "${1:-}" == "--desktop-shortcut" ]]; then
  DESKTOP_DIR="$(xdg-user-dir DESKTOP 2>/dev/null || printf '%s/Desktop' "$HOME")"
  mkdir -p "$DESKTOP_DIR"
  cp "$ENTRY" "$DESKTOP_DIR/ProcManager.desktop"
  chmod +x "$DESKTOP_DIR/ProcManager.desktop"
  echo "Added desktop shortcut: $DESKTOP_DIR/ProcManager.desktop"
fi

echo "Installed application launcher: $ENTRY"
echo "Launch ProcManager from the application menu."
