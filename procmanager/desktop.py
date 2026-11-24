"""Native desktop window for ProcManager (PyQt6 + QtWebEngine).

The UI is exactly the same local web application served by the Python
backend.  This module is optional: ProcManager also runs in a browser.
"""

from __future__ import annotations

import sys
from pathlib import Path

from PyQt6.QtCore import QSize, Qt, QUrl
from PyQt6.QtGui import QColor, QIcon, QKeySequence, QShortcut
from PyQt6.QtWebEngineWidgets import QWebEngineView
from PyQt6.QtWidgets import QApplication, QMainWindow

ICON_PATH = Path(__file__).resolve().parent.parent / "assets" / "icon.svg"


def run_desktop(url: str) -> None:
    QApplication.setApplicationName("ProcManager")
    QApplication.setApplicationVersion("1.0.0")
    QApplication.setOrganizationName("ProcManager")
    QApplication.setDesktopFileName("procmanager")

    app = QApplication(sys.argv)
    app.setApplicationDisplayName("ProcManager")
    icon = QIcon(str(ICON_PATH))
    app.setWindowIcon(icon)

    window = QMainWindow()
    window.setWindowTitle("ProcManager")
    window.setWindowIcon(icon)
    window.setMinimumSize(QSize(980, 640))
    window.resize(QSize(1360, 860))

    view = QWebEngineView()
    view.setContextMenuPolicy(Qt.ContextMenuPolicy.NoContextMenu)
    view.page().setBackgroundColor(QColor("#1a1a1a"))
    view.setUrl(QUrl(url))
    window.setCentralWidget(view)

    screen = app.primaryScreen()
    if screen is not None:
        geometry = screen.availableGeometry()
        window.move(
            geometry.x() + max(0, (geometry.width() - window.width()) // 2),
            geometry.y() + max(0, (geometry.height() - window.height()) // 2),
        )

    QShortcut(QKeySequence("F5"), window, activated=view.reload)
    QShortcut(QKeySequence("Ctrl+Q"), window, activated=window.close)
    QShortcut(QKeySequence("F11"), window, activated=lambda: window.showNormal() if window.isFullScreen() else window.showFullScreen())

    window.show()
    app.exec()
