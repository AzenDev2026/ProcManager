"use strict";

(() => {
  /* ======================================================================
     Constants / tiny helpers
     ====================================================================== */

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));
  const TOKEN = $('meta[name="pm-token"]')?.content || "";
  const APP_VERSION = $('meta[name="pm-version"]')?.content || "1.0.0";
  const SETTINGS_KEY = "procmanager.settings.v1";
  const MAX_HISTORY = 120;
  const CHART_WINDOW = 60;
  const TEXT_SORTS = new Set(["name", "status", "user"]);

  const DEFAULT_SETTINGS = {
    theme: "dark",
    refreshMs: 1000,
    confirmKill: true,
    showKernel: false,
    sidebarCollapsed: false,
  };

  const VIEW_META = {
    processes: {
      title: "Processes",
      subtitle: "Monitor and manage processes on this computer",
    },
    performance: {
      title: "Performance",
      subtitle: "Real-time CPU, memory, disk, network and GPU activity",
    },
    hardware: {
      title: "Hardware",
      subtitle: "Device model and hardware component information (read-only)",
    },
    users: {
      title: "Users",
      subtitle: "Signed-in sessions and per-user process resources",
    },
    details: {
      title: "Details",
      subtitle: "Complete process list and cumulative I/O data",
    },
    settings: {
      title: "Settings",
      subtitle: "Appearance, refresh rate and process action preferences",
    },
  };

  const STATUS_MAP = {
    running: { label: "Running", cls: "status-running" },
    sleeping: { label: "Sleeping", cls: "status-sleeping" },
    "disk-sleep": { label: "Disk sleep", cls: "status-disk-sleep" },
    "tracing-stop": { label: "Traced stop", cls: "status-stopped" },
    stopped: { label: "Suspended", cls: "status-stopped" },
    zombie: { label: "Zombie", cls: "status-zombie" },
    dead: { label: "Exited", cls: "status-zombie" },
    idle: { label: "Idle", cls: "status-idle" },
    waking: { label: "Waking", cls: "status-waking" },
    "wake-kill": { label: "Wake-kill", cls: "status-waking" },
    parked: { label: "Parked", cls: "status-stopped" },
    locked: { label: "Locked", cls: "status-stopped" },
    waiting: { label: "Waiting", cls: "status-sleeping" },
    suspended: { label: "Suspended", cls: "status-stopped" },
    unknown: { label: "Unknown", cls: "" },
  };

  const CHASSIS_TYPES = {
    "3": "Desktop",
    "4": "Low-profile desktop",
    "5": "Pizza box",
    "6": "Mini tower",
    "7": "Tower",
    "8": "Portable",
    "9": "Laptop",
    "10": "Notebook",
    "11": "Handheld",
    "12": "Docking station",
    "13": "All-in-one",
    "14": "Subnotebook",
    "15": "Space-saving",
    "16": "Lunch box",
    "17": "Main server chassis",
    "23": "Rack-mounted server",
    "30": "Tablet",
  };

  const state = {
    system: null,
    stats: null,
    processes: [],
    history: [],
    users: null,
    settings: loadSettings(),
    view: "processes",
    resource: "cpu",
    search: "",
    sort: {
      processes: { key: "cpu", dir: "desc" },
      details: { key: "cpu", dir: "desc" },
    },
    selected: null,
    contextPid: null,
    drawerPid: null,
    drawerCreateTime: null,
    drawerDetails: null,
    pendingEnd: null,
    actionBusy: false,
    refreshing: false,
    booted: false,
    failures: 0,
    lastStatsApplied: 0,
    lastHardwareRender: 0,
    lastUsersFetch: 0,
    loadingUsers: false,
    coreHistory: [],
    coreCount: -1,
  };

  const charts = {};
  let pollTimer = null;
  let pollGeneration = 0;
  let suppressHash = false;
  let toastCounter = 0;
  let resizeTimer = null;

  /* ======================================================================
     Settings
     ====================================================================== */

  function loadSettings() {
    try {
      const raw = localStorage.getItem(SETTINGS_KEY);
      const parsed = raw ? JSON.parse(raw) : {};
      const settings = { ...DEFAULT_SETTINGS, ...parsed };
      if (!["dark", "light"].includes(settings.theme)) settings.theme = "dark";
      if (![1000, 2000, 5000].includes(Number(settings.refreshMs))) settings.refreshMs = 1000;
      settings.confirmKill = Boolean(settings.confirmKill);
      settings.showKernel = Boolean(settings.showKernel);
      settings.sidebarCollapsed = Boolean(settings.sidebarCollapsed);
      return settings;
    } catch {
      return { ...DEFAULT_SETTINGS };
    }
  }

  function saveSettings() {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(state.settings));
    } catch {
      /* ignore quota / private mode */
    }
  }

  function applyTheme(theme, redraw = true) {
    if (!["dark", "light"].includes(theme)) theme = "dark";
    state.settings.theme = theme;
    document.documentElement.dataset.theme = theme;
    const themeMeta = $('meta[name="color-scheme"]');
    if (themeMeta) themeMeta.content = theme;
    const icon = theme === "dark" ? "sun" : "moon";
    const title = theme === "dark" ? "Switch to light theme" : "Switch to dark theme";
    const btn = $("#theme-btn");
    if (btn) {
      btn.title = title;
      btn.setAttribute("aria-label", title);
      btn.querySelector("use")?.setAttribute("href", `#i-${icon}`);
    }
    $$("#theme-choice button").forEach((button) => {
      button.classList.toggle("active", button.dataset.themeChoice === theme);
    });
    if (redraw) {
      requestAnimationFrame(() => {
        renderSummary();
        drawResourceSparks();
        Object.values(charts).forEach((chart) => chart.draw());
      });
    }
  }

  function applySidebar(collapsed, persist = true) {
    state.settings.sidebarCollapsed = Boolean(collapsed);
    if (collapsed) document.documentElement.dataset.sidebar = "collapsed";
    else delete document.documentElement.dataset.sidebar;
    const checkbox = $("#setting-sidebar");
    if (checkbox) checkbox.checked = Boolean(collapsed);
    if (persist) saveSettings();
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      Object.values(charts).forEach((chart) => chart.resize());
    }, 230);
  }

  function applyRefreshInterval(ms, persist = true) {
    state.settings.refreshMs = ms;
    $$("#interval-choice button").forEach((button) => {
      button.classList.toggle("active", Number(button.dataset.interval) === ms);
    });
    if (persist) {
      saveSettings();
      startPolling();
    }
  }

  function applyKernelSetting() {
    const checkbox = $("#setting-kernel");
    if (checkbox) checkbox.checked = state.settings.showKernel;
    renderProcessTable();
    renderDetailsTable();
    renderKernelChip();
  }

  function syncSettingsUI() {
    applyTheme(state.settings.theme, false);
    applySidebar(state.settings.sidebarCollapsed, false);
    applyRefreshInterval(state.settings.refreshMs, false);
    const confirm = $("#setting-confirm");
    if (confirm) confirm.checked = state.settings.confirmKill;
    const kernel = $("#setting-kernel");
    if (kernel) kernel.checked = state.settings.showKernel;
    $("#about-version") && ($("#about-version").textContent = APP_VERSION);
    $("#sidebar-version") && ($("#sidebar-version").textContent = APP_VERSION);
  }

  /* ======================================================================
     Formatting
     ====================================================================== */

  function esc(value) {
    return String(value ?? "").replace(/[&<>"']/g, (character) => {
      switch (character) {
        case "&": return "&amp;";
        case "<": return "&lt;";
        case ">": return "&gt;";
        case '"': return "&quot;";
        case "'": return "&#39;";
        default: return character;
      }
    });
  }

  function isNum(value) {
    return value !== null && value !== undefined && Number.isFinite(Number(value));
  }

  function plural(count, singular, pluralForm = null) {
    const number = Number(count);
    const form = pluralForm || (/(s|x|z|ch|sh)$/i.test(singular) ? `${singular}es` : `${singular}s`);
    return `${count} ${number === 1 ? singular : form}`;
  }

  function fmtBytes(value, fallback = "—") {
    if (!isNum(value)) return fallback;
    let amount = Math.max(0, Number(value));
    const units = ["B", "KB", "MB", "GB", "TB", "PB"];
    let index = 0;
    while (amount >= 1024 && index < units.length - 1) {
      amount /= 1024;
      index += 1;
    }
    if (index === 0) return `${Math.round(amount)} B`;
    const decimals = amount >= 100 ? 0 : amount >= 10 ? 1 : 2;
    let text = amount.toFixed(decimals);
    text = text.replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
    return `${text} ${units[index]}`;
  }

  function fmtRate(value, fallback = "—") {
    if (!isNum(value)) return fallback;
    return `${fmtBytes(value)}/s`;
  }

  function fmtPct(value, fallback = "—") {
    if (!isNum(value)) return fallback;
    const amount = Math.max(0, Number(value));
    if (amount > 0 && amount < 10) {
      return `${amount.toFixed(1).replace(/\.0$/, "")}%`;
    }
    return `${Math.round(amount)}%`;
  }

  function fmtPctExact(value, fallback = "—") {
    if (!isNum(value)) return fallback;
    return `${Number(value).toFixed(1)}%`;
  }

  function fmtMHz(value, fallback = "—") {
    if (!isNum(value)) return fallback;
    const mhz = Number(value);
    if (mhz >= 1000) return `${(mhz / 1000).toFixed(2)} GHz`;
    return `${Math.round(mhz)} MHz`;
  }

  function fmtDuration(seconds, fallback = "—") {
    if (!isNum(seconds)) return fallback;
    let total = Math.max(0, Math.round(Number(seconds)));
    const days = Math.floor(total / 86400);
    total -= days * 86400;
    const hours = Math.floor(total / 3600);
    total -= hours * 3600;
    const minutes = Math.floor(total / 60);
    const secs = total - minutes * 60;
    if (days > 0) return `${days}d ${hours}h`;
    if (hours > 0) return `${hours}h ${minutes}m`;
    if (minutes > 0) return `${minutes}m ${secs}s`;
    return `${secs}s`;
  }

  function fmtClock(epochSeconds, withSeconds = true) {
    if (!isNum(epochSeconds)) return "—";
    const date = new Date(Number(epochSeconds) * 1000);
    return date.toLocaleTimeString("en-AU", {
      hour12: false,
      hour: "2-digit",
      minute: "2-digit",
      ...(withSeconds ? { second: "2-digit" } : {}),
    });
  }

  function fmtDateTime(epochSeconds) {
    if (!isNum(epochSeconds)) return "—";
    return new Date(Number(epochSeconds) * 1000).toLocaleString("en-AU", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });
  }

  function fmtShortDate(epochSeconds) {
    if (!isNum(epochSeconds)) return "—";
    return new Date(Number(epochSeconds) * 1000).toLocaleString("en-AU", {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
  }

  function fmtBatteryTime(value) {
    if (!isNum(value)) return "—";
    const seconds = Number(value);
    if (seconds === -2) return "Plugged in";
    if (seconds < 0) return "Calculating";
    return fmtDuration(seconds);
  }

  function fmtDurationShort(seconds) {
    return fmtDuration(seconds);
  }

  function byteTitle(value) {
    if (!isNum(value)) return "Unavailable";
    return `${Number(value).toLocaleString("en-AU")} bytes`;
  }

  function statusInfo(status) {
    return STATUS_MAP[status] || { label: status || "Unknown", cls: "" };
  }

  function initials(name) {
    const cleaned = String(name || "?")
      .replace(/^\[|\]$/g, "")
      .replace(/[^A-Za-z0-9\u4e00-\u9fa5]+/g, " ")
      .trim();
    const parts = cleaned.split(/\s+/).filter(Boolean);
    if (!parts.length) return "?";
    if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
    return parts[0].slice(0, 2).toUpperCase();
  }

  function hueFor(name) {
    let hue = 0;
    const text = String(name || "");
    for (let index = 0; index < text.length; index += 1) {
      hue = (hue * 31 + text.charCodeAt(index)) % 360;
    }
    return hue;
  }

  function tileStyle(name, kernel = false) {
    if (kernel) return "--tile-bg:#4a4a4a";
    return `--tile-bg:hsl(${hueFor(name)} 41% 37%)`;
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /* ======================================================================
     API
     ====================================================================== */

  async function apiGet(path, timeout = 6000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const response = await fetch(path, {
        signal: controller.signal,
        headers: { Accept: "application/json" },
        cache: "no-store",
      });
      const text = await response.text();
      let payload;
      try {
        payload = JSON.parse(text);
      } catch {
        throw new Error(`Invalid data returned by the local service (HTTP ${response.status})`);
      }
      if (!response.ok) {
        throw new Error(payload?.error || `Request failed (HTTP ${response.status})`);
      }
      return payload;
    } catch (error) {
      if (error.name === "AbortError") throw new Error("Request timed out. The local service may be busy.");
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  async function apiAction(pid, action, createTime) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 6000);
    try {
      const response = await fetch(`/api/process/${pid}/action`, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "Content-Type": "application/json",
          "X-PM-Token": TOKEN,
        },
        body: JSON.stringify({
          action,
          ...(createTime ? { create_time: createTime } : {}),
        }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload?.error || `Action failed (HTTP ${response.status})`);
      return payload;
    } catch (error) {
      if (error.name === "AbortError") throw new Error("The action request timed out.");
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  /* ======================================================================
     Toasts / clipboard
     ====================================================================== */

  function toast(type, title, detail = "", timeout = 4600) {
    const container = $("#toasts");
    if (!container) return;
    const id = `toast-${++toastCounter}`;
    const iconName = type === "success" ? "check" : type === "warning" ? "alert" : type === "error" ? "alert" : "info";
    const element = document.createElement("div");
    element.className = `toast ${type}`;
    element.id = id;
    element.innerHTML = `
      <span class="toast-icon"><svg class="ic"><use href="#i-${iconName}"></use></svg></span>
      <div class="toast-content">
        <div class="toast-title">${esc(title)}</div>
        ${detail ? `<div class="toast-detail">${esc(detail)}</div>` : ""}
      </div>
      <button class="toast-close" type="button" title="Close" aria-label="Close">
        <svg class="ic"><use href="#i-close"></use></svg>
      </button>`;
    const remove = () => {
      if (!element.isConnected) return;
      element.classList.add("leaving");
      setTimeout(() => element.remove(), 180);
    };
    element.querySelector(".toast-close").addEventListener("click", remove);
    container.appendChild(element);
    const toasts = $$(".toast", container);
    while (toasts.length > 4) toasts.shift()?.remove();
    setTimeout(remove, timeout);
  }

  async function copyText(text, label = "Copied to clipboard") {
    if (!text) {
      toast("warning", "Nothing to copy");
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      toast("success", label);
    } catch {
      const area = document.createElement("textarea");
      area.value = text;
      area.style.position = "fixed";
      area.style.opacity = "0";
      document.body.appendChild(area);
      area.select();
      const ok = document.execCommand("copy");
      area.remove();
      if (ok) toast("success", label);
      else toast("error", "Copy failed", "The browser denied clipboard access.");
    }
  }

  /* ======================================================================
     Chart primitives
     ====================================================================== */

  function cssColor(variable, fallback = "#4cc2ff") {
    const value = getComputedStyle(document.documentElement).getPropertyValue(variable).trim();
    return value || fallback;
  }

  function niceMax(value) {
    if (!isNum(value) || value <= 0) return 1;
    const exponent = Math.floor(Math.log10(value));
    const fraction = value / 10 ** exponent;
    let nice;
    if (fraction <= 1) nice = 1;
    else if (fraction <= 2) nice = 2;
    else if (fraction <= 2.5) nice = 2.5;
    else if (fraction <= 5) nice = 5;
    else nice = 10;
    return nice * 10 ** exponent;
  }

  function axisLabel(kind, value) {
    if (!isNum(value)) return "";
    if (kind === "percent") return `${Math.round(value)}%`;
    if (kind === "mhz") {
      return value >= 1000 ? `${(value / 1000).toFixed(2)} GHz` : `${Math.round(value)} MHz`;
    }
    const units = ["B/s", "KB/s", "MB/s", "GB/s", "TB/s"];
    let amount = Math.max(0, value);
    let index = 0;
    while (amount >= 1024 && index < units.length - 1) {
      amount /= 1024;
      index += 1;
    }
    let text;
    if (index === 0) text = Math.round(amount).toString();
    else if (amount >= 100) text = amount.toFixed(0);
    else if (amount >= 10) text = amount.toFixed(1);
    else text = amount.toFixed(2).replace(/\.?0+$/, "");
    return `${text} ${units[index]}`;
  }

  function tooltipValue(kind, value) {
    if (!isNum(value)) return "—";
    if (kind === "percent") return fmtPctExact(value);
    if (kind === "mhz") return fmtMHz(value);
    return fmtRate(value);
  }

  function smoothPath(ctx, points) {
    if (!points.length) return;
    ctx.moveTo(points[0].x, points[0].y);
    if (points.length === 1) return;
    if (points.length === 2) {
      ctx.lineTo(points[1].x, points[1].y);
      return;
    }
    for (let index = 1; index < points.length - 1; index += 1) {
      const current = points[index];
      const next = points[index + 1];
      const midX = (current.x + next.x) / 2;
      const midY = (current.y + next.y) / 2;
      ctx.quadraticCurveTo(current.x, current.y, midX, midY);
    }
    const last = points[points.length - 1];
    ctx.lineTo(last.x, last.y);
  }

  class LineChart {
    constructor(canvas, options = {}) {
      this.canvas = canvas;
      this.wrap = canvas.parentElement;
      this.ctx = canvas.getContext("2d");
      this.tooltip = this.wrap?.querySelector(".chart-tooltip") || null;
      this.options = {
        kind: "percent",
        series: [],
        fixedMax: null,
        ...options,
      };
      this.points = [];
      this.hoverT = null;
      this.geometry = null;
      this.observer = new ResizeObserver(() => this.resize());
      if (this.wrap) this.observer.observe(this.wrap);
      canvas.addEventListener("mousemove", (event) => this.handleMove(event));
      canvas.addEventListener("mouseleave", () => this.handleLeave());
      this.resize();
    }

    setOptions(options) {
      this.options = { ...this.options, ...options };
      this.draw();
    }

    setPoints(points) {
      this.points = Array.isArray(points) ? points : [];
      this.draw();
    }

    resize() {
      if (!this.wrap) return;
      const rect = this.wrap.getBoundingClientRect();
      if (rect.width < 8 || rect.height < 8) return;
      const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
      const width = Math.max(1, Math.round(rect.width * dpr));
      const height = Math.max(1, Math.round(rect.height * dpr));
      if (this.canvas.width !== width || this.canvas.height !== height) {
        this.canvas.width = width;
        this.canvas.height = height;
      }
      this.dpr = dpr;
      this.cssWidth = rect.width;
      this.cssHeight = rect.height;
      this.draw();
    }

    draw() {
      const ctx = this.ctx;
      if (!ctx || !this.cssWidth || !this.cssHeight) return;
      const width = this.cssWidth;
      const height = this.cssHeight;
      const dpr = this.dpr || 1;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, height);

      const margin = { left: this.options.kind === "bytes" ? 67 : 52, right: 12, top: 12, bottom: 22 };
      const plotWidth = Math.max(1, width - margin.left - margin.right);
      const plotHeight = Math.max(1, height - margin.top - margin.bottom);
      const series = (this.options.series || []).map((definition) => ({
        ...definition,
        color: definition.color?.startsWith("--") ? cssColor(definition.color) : definition.color,
      }));

      let yMax;
      if (this.options.kind === "percent") yMax = 100;
      else if (isNum(this.options.fixedMax) && Number(this.options.fixedMax) > 0) yMax = Number(this.options.fixedMax);
      else {
        let max = 0;
        for (const definition of series) {
          for (const point of this.points) {
            const value = Number(point[definition.key]);
            if (Number.isFinite(value) && value > max) max = value;
          }
        }
        if (this.options.kind === "bytes") max = Math.max(max * 1.14, 1024);
        else max = Math.max(max * 1.12, 1);
        yMax = niceMax(max);
      }

      const gridColor = cssColor("--chart-grid", "rgba(255,255,255,.06)");
      const axisColor = cssColor("--chart-axis", "rgba(255,255,255,.4)");
      const textColor = cssColor("--text-3", "#969696");
      ctx.lineWidth = 1;
      ctx.strokeStyle = gridColor;
      ctx.fillStyle = textColor;
      ctx.font = "9px 'Segoe UI', 'Noto Sans', sans-serif";
      ctx.textBaseline = "middle";

      const tickCount = 4;
      for (let tick = 0; tick <= tickCount; tick += 1) {
        const ratio = tick / tickCount;
        const y = margin.top + plotHeight - ratio * plotHeight;
        ctx.beginPath();
        ctx.setLineDash([3, 5]);
        ctx.moveTo(margin.left, y);
        ctx.lineTo(margin.left + plotWidth, y);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.textAlign = "right";
        ctx.fillText(axisLabel(this.options.kind, yMax * ratio), margin.left - 8, y);
      }

      const points = this.points.filter((point) => isNum(point.t)).slice(-CHART_WINDOW);
      if (points.length === 0) {
        ctx.fillStyle = textColor;
        ctx.textAlign = "center";
        ctx.font = "10.5px 'Segoe UI', 'Noto Sans', sans-serif";
        ctx.fillText("Collecting data…", margin.left + plotWidth / 2, margin.top + plotHeight / 2);
        this.geometry = null;
        this.hideTooltip();
        return;
      }

      const firstT = Number(points[0].t);
      const lastT = Number(points[points.length - 1].t);
      const span = Math.max(1, lastT - firstT);
      const xFor = (t) => margin.left + ((Number(t) - firstT) / span) * plotWidth;
      const yFor = (v) => margin.top + plotHeight - Math.min(1, Math.max(0, Number(v) / yMax)) * plotHeight;
      this.geometry = { margin, plotWidth, plotHeight, firstT, lastT, xFor, yFor, points };

      const verticalLines = 3;
      for (let index = 0; index <= verticalLines; index += 1) {
        const ratio = index / verticalLines;
        const x = margin.left + ratio * plotWidth;
        ctx.strokeStyle = gridColor;
        ctx.beginPath();
        ctx.setLineDash([2, 6]);
        ctx.moveTo(x, margin.top);
        ctx.lineTo(x, margin.top + plotHeight);
        ctx.stroke();
        ctx.setLineDash([]);
        const timestamp = firstT + span * ratio;
        ctx.fillStyle = textColor;
        ctx.textAlign = ratio === 0 ? "left" : ratio === 1 ? "right" : "center";
        ctx.fillText(fmtClock(timestamp), x, height - 9);
      }

      for (const definition of series) {
        const coords = [];
        for (const point of points) {
          const value = Number(point[definition.key]);
          if (!Number.isFinite(value)) {
            if (coords.length > 1) this.drawSeries(ctx, coords, definition.color, margin, plotHeight);
            coords.length = 0;
            continue;
          }
          coords.push({ x: xFor(point.t), y: yFor(value) });
        }
        if (coords.length > 1) this.drawSeries(ctx, coords, definition.color, margin, plotHeight);
        else if (coords.length === 1) {
          ctx.fillStyle = definition.color;
          ctx.beginPath();
          ctx.arc(coords[0].x, coords[0].y, 2.5, 0, Math.PI * 2);
          ctx.fill();
        }
      }

      if (this.hoverT !== null) {
        this.drawHover(ctx, series);
      } else {
        this.hideTooltip();
      }
    }

    drawSeries(ctx, coords, color, margin, plotHeight) {
      const area = new Path2D();
      const linePath = new Path2D();
      // Build the smooth line in a Path2D so it can be stroked and filled separately.
      smoothPath(linePath, coords);
      area.addPath(linePath);
      const last = coords[coords.length - 1];
      const first = coords[0];
      area.lineTo(last.x, margin.top + plotHeight);
      area.lineTo(first.x, margin.top + plotHeight);
      area.closePath();
      ctx.save();
      const gradient = ctx.createLinearGradient(0, margin.top, 0, margin.top + plotHeight);
      gradient.addColorStop(0, color);
      gradient.addColorStop(1, color);
      ctx.globalAlpha = 0.12;
      ctx.fillStyle = gradient;
      ctx.fill(area);
      ctx.globalAlpha = 1;
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.lineJoin = "round";
      ctx.lineCap = "round";
      ctx.stroke(linePath);
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(last.x, last.y, 3, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 0.18;
      ctx.beginPath();
      ctx.arc(last.x, last.y, 7, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.restore();
    }

    drawHover(ctx, series) {
      if (!this.geometry) return;
      const { margin, plotHeight, firstT, lastT, xFor, points } = this.geometry;
      const target = Number(this.hoverT);
      let nearest = points[0];
      let nearestDistance = Infinity;
      for (const point of points) {
        const distance = Math.abs(Number(point.t) - target);
        if (distance < nearestDistance) {
          nearestDistance = distance;
          nearest = point;
        }
      }
      const x = xFor(nearest.t);
      ctx.save();
      ctx.strokeStyle = cssColor("--text-4", "#888");
      ctx.lineWidth = 1;
      ctx.setLineDash([2, 4]);
      ctx.beginPath();
      ctx.moveTo(x, margin.top);
      ctx.lineTo(x, margin.top + plotHeight);
      ctx.stroke();
      ctx.setLineDash([]);
      for (const definition of series) {
        const value = Number(nearest[definition.key]);
        if (!Number.isFinite(value)) continue;
        const y = this.geometry.yFor(value);
        ctx.fillStyle = definition.color;
        ctx.beginPath();
        ctx.arc(x, y, 3.2, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 0.2;
        ctx.beginPath();
        ctx.arc(x, y, 7, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 1;
      }
      ctx.restore();

      if (this.tooltip) {
        const rows = series
          .map((definition) => {
            const value = Number(nearest[definition.key]);
            return `<div class="tt-row"><span><i class="tt-dot" style="background:${definition.color}"></i>${esc(definition.label)}</span><span>${esc(tooltipValue(this.options.kind, value))}</span></div>`;
          })
          .join("");
        this.tooltip.innerHTML = `<div class="tt-time">${esc(fmtClock(nearest.t))}</div>${rows}`;
        this.tooltip.hidden = false;
        const wrapWidth = this.cssWidth;
        const tooltipWidth = this.tooltip.offsetWidth || 130;
        const left = Math.min(Math.max(x + 12, 8), wrapWidth - tooltipWidth - 8);
        this.tooltip.style.left = `${left}px`;
        this.tooltip.style.top = "10px";
      }
    }

    handleMove(event) {
      if (!this.geometry) return;
      const rect = this.canvas.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const { margin, plotWidth, firstT, lastT } = this.geometry;
      if (x < margin.left || x > margin.left + plotWidth) {
        this.hoverT = null;
        this.draw();
        return;
      }
      const ratio = (x - margin.left) / plotWidth;
      this.hoverT = firstT + ratio * (lastT - firstT);
      this.draw();
    }

    handleLeave() {
      this.hoverT = null;
      this.hideTooltip();
      this.draw();
    }

    hideTooltip() {
      if (this.tooltip) this.tooltip.hidden = true;
    }
  }

  function drawSpark(canvas, values, colorName, { fixedMax = null, fill = true, lineWidth = 1.6 } = {}) {
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    if (rect.width < 4 || rect.height < 4) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    const width = Math.round(rect.width * dpr);
    const height = Math.round(rect.height * dpr);
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, rect.width, rect.height);
    const clean = values.filter((value) => isNum(value)).map(Number);
    if (clean.length < 2) return;
    const color = cssColor(colorName);
    let max = fixedMax;
    if (!isNum(max)) {
      max = Math.max(...clean, 1) * 1.12;
    }
    max = Math.max(Number(max), 0.001);
    const pad = 2;
    const usableWidth = rect.width - pad * 2;
    const usableHeight = rect.height - pad * 2;
    const coords = clean.map((value, index) => ({
      x: pad + (index / (clean.length - 1)) * usableWidth,
      y: pad + usableHeight - Math.min(1, Math.max(0, value / max)) * usableHeight,
    }));
    const line = new Path2D();
    smoothPath(line, coords);
    if (fill) {
      const area = new Path2D();
      area.addPath(line);
      area.lineTo(coords[coords.length - 1].x, rect.height);
      area.lineTo(coords[0].x, rect.height);
      area.closePath();
      const gradient = ctx.createLinearGradient(0, 0, 0, rect.height);
      gradient.addColorStop(0, color);
      gradient.addColorStop(1, color);
      ctx.globalAlpha = 0.16;
      ctx.fillStyle = gradient;
      ctx.fill(area);
      ctx.globalAlpha = 1;
    }
    ctx.strokeStyle = color;
    ctx.lineWidth = lineWidth;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.stroke(line);
    ctx.fillStyle = color;
    const last = coords[coords.length - 1];
    ctx.beginPath();
    ctx.arc(last.x, last.y, 2, 0, Math.PI * 2);
    ctx.fill();
  }

  /* ======================================================================
     Data application
     ====================================================================== */

  function applySystem(system) {
    state.system = system;
    const host = system.host || {};
    const hardware = system.hardware || {};
    const gpu = hardware.gpus?.[0] || null;

    $("#sidebar-host").textContent = host.hostname || "This device";
    $("#sidebar-os").textContent = host.name || "Linux";
    $("#sidebar-version").textContent = APP_VERSION;
    $("#about-version").textContent = APP_VERSION;

    if (!gpu) {
      $("#sum-card-gpu").hidden = true;
      $("#res-item-gpu").hidden = true;
      $("#perf-panel-gpu").hidden = true;
      if (state.resource === "gpu") state.resource = "cpu";
    }

    setupGpuChart();
    renderHardware();
  }

  function applyStats(stats) {
    state.stats = stats;
    state.lastStatsApplied = Date.now();
    updateSidebarStatus(true);
    updateLastUpdated(stats.ts);
    appendHistory(stats);
    if (state.view === "processes") {
      renderSummary();
      drawSummarySparks();
      drawResourceSparks();
    }
    if (state.view === "performance") {
      renderPerformance();
      updateCharts();
    }
    if (state.view === "hardware" && Date.now() - state.lastHardwareRender > 2500) {
      renderHardware();
    }
    updateDrawerLive();
  }

  function applyProcesses(payload) {
    state.processes = Array.isArray(payload.items) ? payload.items : [];
    if (state.selected) {
      const current = findProcess(state.selected.pid, state.selected.createTime);
      if (!current) state.selected = null;
    }
    updateSelectionUI();
    if (state.view === "processes") renderProcessTable();
    if (state.view === "details") renderDetailsTable();
    updateDrawerLive();
  }

  function appendHistory(stats) {
    if (!stats || !isNum(stats.ts)) return;
    const t = Math.round(Number(stats.ts) * 1000) / 1000;
    const existing = state.history.findIndex((point) => Math.abs(Number(point.t) - t) < 0.002);
    const gpu = stats.gpu?.[0];
    const point = {
      t,
      cpu: stats.cpu?.percent ?? null,
      mem: stats.memory?.percent ?? null,
      disk_read: stats.disk?.read_bps ?? null,
      disk_write: stats.disk?.write_bps ?? null,
      net_recv: stats.network?.recv_bps ?? null,
      net_sent: stats.network?.sent_bps ?? null,
      gpu_freq: gpu?.freq_mhz ?? null,
      gpu_util: gpu?.utilization ?? null,
    };
    if (existing >= 0) state.history[existing] = point;
    else state.history.push(point);
    state.history = state.history
      .filter((item) => isNum(item.t))
      .sort((a, b) => Number(a.t) - Number(b.t))
      .slice(-MAX_HISTORY);

    const perCore = stats.cpu?.per_core || [];
    if (perCore.length !== state.coreCount) {
      state.coreCount = perCore.length;
      state.coreHistory = perCore.map(() => []);
    }
    perCore.forEach((value, index) => {
      if (!state.coreHistory[index]) state.coreHistory[index] = [];
      state.coreHistory[index].push(value);
      if (state.coreHistory[index].length > CHART_WINDOW) {
        state.coreHistory[index].splice(0, state.coreHistory[index].length - CHART_WINDOW);
      }
    });
  }

  function mergeHistory(points) {
    if (!Array.isArray(points)) return;
    const map = new Map(state.history.map((point) => [Number(point.t), point]));
    for (const point of points) {
      if (isNum(point.t)) map.set(Number(point.t), point);
    }
    state.history = Array.from(map.values())
      .sort((a, b) => Number(a.t) - Number(b.t))
      .slice(-MAX_HISTORY);
  }

  function historyWindow() {
    return state.history.slice(-CHART_WINDOW);
  }

  function updateSidebarStatus(online = true) {
    const dot = $("#sidebar-live-dot");
    const status = $("#sidebar-status");
    if (!dot || !status) return;
    if (online) {
      dot.style.background = "";
      dot.style.boxShadow = "";
      status.textContent = `Live · ${state.settings.refreshMs / 1000}s refresh`;
    } else {
      dot.style.background = "var(--danger)";
      dot.style.boxShadow = "0 0 0 3px var(--danger-bg)";
      status.textContent = "Local service disconnected";
    }
  }

  function updateLastUpdated(ts) {
    const text = isNum(ts) && Number(ts) > 0 ? `Last updated ${fmtClock(ts)}` : "Waiting for data";
    const processText = $("#last-updated");
    const detailsText = $("#details-last-updated");
    if (processText) processText.textContent = text;
    if (detailsText) detailsText.textContent = text;
  }

  function primaryGpu() {
    return state.stats?.gpu?.[0] || state.system?.hardware?.gpus?.[0] || null;
  }

  function gpuUsesUtilization() {
    const gpu = primaryGpu();
    return gpu ? gpu.utilization !== null && gpu.utilization !== undefined : false;
  }

  /* ======================================================================
     Summary cards
     ====================================================================== */

  function renderSummary() {
    const stats = state.stats;
    if (!stats) return;
    const cpu = stats.cpu || {};
    const memory = stats.memory || {};
    const disk = stats.disk || {};
    const network = stats.network || {};
    const gpu = stats.gpu?.[0];
    const rootPartition =
      (disk.partitions || []).find((partition) => partition.mount === "/") ||
      (disk.partitions || [])[0];

    $("#sum-cpu").textContent = fmtPct(cpu.percent);
    const cpuSub = [plural(cpu.per_core?.length ?? 0, "core"), fmtMHz(cpu.freq_mhz)].filter(Boolean);
    $("#sum-cpu-sub").textContent = cpuSub.join(" · ");

    $("#sum-memory").textContent = fmtPct(memory.percent);
    $("#sum-memory-sub").textContent = `${fmtBytes(memory.in_use)} / ${fmtBytes(memory.total)}`;

    $("#sum-disk").textContent = rootPartition ? fmtPct(rootPartition.percent) : "—";
    $("#sum-disk-sub").textContent = rootPartition
      ? `${fmtBytes(rootPartition.used)} / ${fmtBytes(rootPartition.total)}`
      : "System disk not found";

    $("#sum-network").textContent = fmtRate(network.recv_bps);
    $("#sum-network").classList.add("small");
    $("#sum-network-sub").textContent = `Upload ${fmtRate(network.sent_bps)}`;

    const gpuCard = $("#sum-card-gpu");
    if (gpu) {
      gpuCard.hidden = false;
      if (gpu.utilization !== null && gpu.utilization !== undefined) {
        $("#sum-gpu").textContent = fmtPct(gpu.utilization);
        $("#sum-gpu").classList.remove("small");
        $("#sum-gpu-sub").textContent = `${fmtMHz(gpu.freq_mhz)} · ${shortGpuName(gpu.name)}`;
      } else if (isNum(gpu.freq_mhz)) {
        $("#sum-gpu").textContent = fmtMHz(gpu.freq_mhz);
        $("#sum-gpu").classList.add("small");
        $("#sum-gpu-sub").textContent = `Max ${fmtMHz(gpu.freq_max_mhz)}`;
      } else {
        $("#sum-gpu").textContent = "—";
        $("#sum-gpu").classList.remove("small");
        $("#sum-gpu-sub").textContent = shortGpuName(gpu.name);
      }
    } else {
      gpuCard.hidden = true;
    }

    const diskIO = (disk.read_bps || 0) + (disk.write_bps || 0);
    $("#sum-card-gpu").title = gpu ? `${gpu.name}${gpu.note ? `\n${gpu.note}` : ""}` : "";
    $("#sum-disk").parentElement.title =
      `Disk activity: read ${fmtRate(disk.read_bps)} · write ${fmtRate(disk.write_bps)}\n` +
      `Total IOPS: read ${disk.read_iops ?? "—"} · write ${disk.write_iops ?? "—"}`;
    const memoryCard = $("#sum-memory").parentElement;
    memoryCard.title =
      `In use: ${fmtBytes(memory.in_use)} (${fmtPctExact(memory.percent)})\n` +
      `Available: ${fmtBytes(memory.available)}\nCached: ${fmtBytes(memory.cached)}`;
    const cpuCard = $("#sum-cpu").parentElement;
    cpuCard.title = `Current frequency: ${fmtMHz(cpu.freq_mhz)}\nTemperature: ${isNum(cpu.temp_c) ? `${cpu.temp_c.toFixed(1)} °C` : "—"}\nLoad average: ${(cpu.load || []).join(" / ")}`;
    $("#sum-network").parentElement.title =
      `Download: ${fmtRate(network.recv_bps)}\nUpload: ${fmtRate(network.sent_bps)}`;
  }

  function shortGpuName(name) {
    return String(name || "GPU").replace(/^Intel Corporation\s+/i, "").replace(/^NVIDIA Corporation\s+/i, "");
  }

  function drawSummarySparks() {
    const points = historyWindow();
    const gpu = primaryGpu();
    drawSpark($("#spark-cpu"), points.map((point) => point.cpu), "--accent", { fixedMax: 100 });
    drawSpark($("#spark-memory"), points.map((point) => point.mem), "--purple", { fixedMax: 100 });
    drawSpark(
      $("#spark-disk"),
      points.map((point) => (point.disk_read || 0) + (point.disk_write || 0)),
      "--teal",
    );
    drawSpark($("#spark-network"), points.map((point) => point.net_recv), "--green");
    if (!gpu) return;
    if (gpuUsesUtilization()) {
      drawSpark($("#spark-gpu"), points.map((point) => point.gpu_util), "--amber", { fixedMax: 100 });
    } else {
      drawSpark($("#spark-gpu"), points.map((point) => point.gpu_freq), "--amber", {
        fixedMax: gpu.freq_max_mhz || null,
      });
    }
  }

  /* ======================================================================
     Processes table
     ====================================================================== */

  function findProcess(pid, createTime = null) {
    return state.processes.find((process) => {
      if (process.pid !== pid) return false;
      if (createTime === null || createTime === undefined) return true;
      if (process.create_time === null || process.create_time === undefined) return true;
      return Math.abs(Number(process.create_time) - Number(createTime)) < 0.02;
    });
  }

  function visibleProcesses() {
    let list = state.processes;
    if (!state.settings.showKernel) list = list.filter((process) => !process.kernel);
    if (state.search.trim()) {
      const query = state.search.trim().toLowerCase();
      list = list.filter((process) => {
        const haystack = `${process.name || ""} ${process.pid} ${process.username || ""} ${statusInfo(process.status).label}`.toLowerCase();
        return haystack.includes(query);
      });
    }
    return list;
  }

  function processSortValue(process, key) {
    switch (key) {
      case "name": return String(process.name || "").toLowerCase();
      case "status": return statusInfo(process.status).label;
      case "user": return String(process.username || "").toLowerCase();
      case "cpu": return isNum(process.cpu) ? Number(process.cpu) : -1;
      case "memory": return isNum(process.memory) ? Number(process.memory) : -1;
      case "disk": return (process.io_read_bps || 0) + (process.io_write_bps || 0);
      case "pid": return process.pid;
      case "virtual": return isNum(process.virtual) ? Number(process.virtual) : -1;
      case "threads": return isNum(process.threads) ? Number(process.threads) : -1;
      case "disk_read": return isNum(process.io_read_bytes) ? Number(process.io_read_bytes) : -1;
      case "disk_write": return isNum(process.io_write_bytes) ? Number(process.io_write_bytes) : -1;
      case "created": return isNum(process.create_time) ? Number(process.create_time) : 0;
      default: return 0;
    }
  }

  function sortProcesses(list, sort) {
    const direction = sort.dir === "asc" ? 1 : -1;
    return [...list].sort((a, b) => {
      const av = processSortValue(a, sort.key);
      const bv = processSortValue(b, sort.key);
      let result;
      if (typeof av === "string" || typeof bv === "string") {
        result = String(av).localeCompare(String(bv), "en-AU", { numeric: true });
      } else {
        result = Number(av) - Number(bv);
      }
      if (result !== 0) return result * direction;
      return a.pid - b.pid;
    });
  }

  function heatClass(value, thresholds) {
    if (!isNum(value)) return "";
    for (let index = thresholds.length - 1; index >= 0; index -= 1) {
      if (Number(value) >= thresholds[index]) return `heat-${index + 1}`;
    }
    return "";
  }

  function nameCell(process, { showPid = true } = {}) {
    return `<div class="proc-name-cell">
      <span class="app-tile" style="${tileStyle(process.name, process.kernel)}">${esc(initials(process.name))}</span>
      <span class="proc-label">
        <span class="proc-name" title="${esc(process.name)}${process.kernel ? " (kernel thread)" : ""}">${esc(process.name)}</span>
        ${showPid ? `<span class="proc-pid">${process.pid}</span>` : ""}
      </span>
    </div>`;
  }

  function statusCell(process) {
    const status = statusInfo(process.status);
    return `<span class="status-wrap ${status.cls}"><span class="status-dot"></span>${esc(status.label)}</span>`;
  }

  function processRow(process) {
    const selected =
      state.selected &&
      state.selected.pid === process.pid &&
      (state.selected.createTime === null ||
        process.create_time === null ||
        Math.abs(Number(state.selected.createTime) - Number(process.create_time)) < 0.02);
    const cpuHeat = heatClass(process.cpu, [2, 8, 20, 45, 70]);
    const memHeat = heatClass(process.memory_percent, [0.5, 1.5, 3, 6, 12]);
    const totalDisk = (process.io_read_bps || 0) + (process.io_write_bps || 0);
    const diskKnown = process.io_read_bps !== null || process.io_write_bps !== null;
    const diskTitle = diskKnown
      ? `Read ${fmtRate(process.io_read_bps)} · write ${fmtRate(process.io_write_bps)}`
      : "I/O data for this process requires higher privileges";
    return `<tr data-pid="${process.pid}" data-ct="${process.create_time ?? ""}" class="${selected ? "selected" : ""}">
      <td class="col-name" title="${esc(process.name)} · PID ${process.pid}">${nameCell(process)}</td>
      <td class="col-status">${statusCell(process)}</td>
      <td class="col-cpu num ${cpuHeat}" title="${isNum(process.cpu) ? fmtPctExact(process.cpu) : "Permission denied"}">${isNum(process.cpu) ? fmtPct(process.cpu) : "—"}</td>
      <td class="col-memory num ${memHeat}" title="${byteTitle(process.memory)}${isNum(process.memory_percent) ? ` · ${process.memory_percent.toFixed(2)}%` : ""}">${fmtBytes(process.memory)}</td>
      <td class="col-disk num" title="${diskTitle}"><span class="disk-rate ${totalDisk === 0 ? "zero" : ""}">${diskKnown ? fmtRate(totalDisk) : "—"}</span></td>
      <td class="col-user" title="${esc(process.username || "—")}">${esc(process.username || "—")}</td>
    </tr>`;
  }

  function emptyRow(colspan, title, detail = "", iconName = "info") {
    return `<tr class="empty-row"><td colspan="${colspan}">
      <div class="empty-cell">
        <svg class="ic"><use href="#i-${iconName}"></use></svg>
        <div><div class="empty-title">${esc(title)}</div>${detail ? `<div>${esc(detail)}</div>` : ""}</div>
      </div>
    </td></tr>`;
  }

  function renderProcessTable() {
    const tbody = $("#process-tbody");
    if (!tbody) return;
    if (!state.processes.length) {
      tbody.innerHTML = emptyRow(6, "Reading processes…", "The local service will take its first sample within a second.", "clock");
      return;
    }
    const list = sortProcesses(visibleProcesses(), state.sort.processes);
    if (state.selected) {
      const stillVisible = list.some(
        (process) =>
          process.pid === state.selected.pid &&
          (state.selected.createTime === null ||
            process.create_time === null ||
            Math.abs(Number(process.create_time) - Number(state.selected.createTime)) < 0.02),
      );
      if (!stillVisible) state.selected = null;
    }
    if (!list.length) {
      tbody.innerHTML = state.search.trim()
        ? emptyRow(6, "No matching processes", `No processes match “${state.search.trim()}”.`, "search")
        : emptyRow(6, "No processes to show", "Kernel threads may be hidden. Enable them in Settings.", "eye");
    } else {
      tbody.innerHTML = list.map(processRow).join("");
    }
    const totalThreads = list.reduce((sum, process) => sum + (process.threads || 0), 0);
    const countLabel = $("#proc-count-label");
    if (countLabel) {
      if (state.search.trim()) countLabel.textContent = `${list.length} / ${state.processes.length} processes`;
      else countLabel.textContent = `${plural(list.length, "process")} · ${plural(totalThreads, "thread")}`;
    }
    const footer = $("#proc-footer-count");
    if (footer) {
      const hiddenKernel = state.processes.filter((process) => process.kernel).length;
      footer.textContent = `${plural(state.processes.length, "process")} · ${plural(state.processes.reduce((sum, process) => sum + (process.threads || 0), 0), "thread")}`;
    }
    renderKernelChip();
    updateSortHeaders("processes");
    updateSelectionUI();
  }

  function renderDetailsTable() {
    const tbody = $("#details-tbody");
    if (!tbody) return;
    if (!state.processes.length) {
      tbody.innerHTML = emptyRow(11, "Reading processes…", "", "clock");
      return;
    }
    const list = sortProcesses(visibleProcesses(), state.sort.details);
    if (!list.length) {
      tbody.innerHTML = state.search.trim()
        ? emptyRow(11, "No matching processes", `No processes match “${state.search.trim()}”.`, "search")
        : emptyRow(11, "No processes to show", "", "eye");
    } else {
      tbody.innerHTML = list
        .map((process) => {
          const selected =
            state.selected &&
            state.selected.pid === process.pid &&
            (state.selected.createTime === null ||
              process.create_time === null ||
              Math.abs(Number(state.selected.createTime) - Number(process.create_time)) < 0.02);
          const cpuHeat = heatClass(process.cpu, [2, 8, 20, 45, 70]);
          const memHeat = heatClass(process.memory_percent, [0.5, 1.5, 3, 6, 12]);
          return `<tr data-pid="${process.pid}" data-ct="${process.create_time ?? ""}" class="${selected ? "selected" : ""}">
            <td class="col-name">${nameCell(process, { showPid: false })}</td>
            <td class="col-pid num">${process.pid}</td>
            <td class="col-status">${statusCell(process)}</td>
            <td class="col-user" title="${esc(process.username || "—")}">${esc(process.username || "—")}</td>
            <td class="col-cpu num ${cpuHeat}">${isNum(process.cpu) ? fmtPct(process.cpu) : "—"}</td>
            <td class="col-memory num ${memHeat}" title="${byteTitle(process.memory)}">${fmtBytes(process.memory)}</td>
            <td class="col-vmem num" title="${byteTitle(process.virtual)}">${fmtBytes(process.virtual)}</td>
            <td class="col-threads num">${process.threads ?? "—"}</td>
            <td class="col-io num" title="${byteTitle(process.io_read_bytes)}">${fmtBytes(process.io_read_bytes)}</td>
            <td class="col-io num" title="${byteTitle(process.io_write_bytes)}">${fmtBytes(process.io_write_bytes)}</td>
            <td class="col-created" title="${fmtDateTime(process.create_time)}">${fmtShortDate(process.create_time)}</td>
          </tr>`;
        })
        .join("");
    }
    const label = $("#details-count-label");
    if (label) label.textContent = state.search.trim() ? `${list.length} / ${state.processes.length} processes` : plural(list.length, "process");
    const footer = $("#details-footer-count");
    if (footer) footer.textContent = `Showing ${plural(list.length, "process")} · cumulative I/O is read-only`;
    updateSortHeaders("details");
    updateSelectionUI();
  }

  function renderKernelChip() {
    const chip = $("#kernel-toggle");
    const text = $("#kernel-chip-text");
    if (!chip || !text) return;
    const kernelCount = state.processes.filter((process) => process.kernel).length;
    if (!kernelCount) {
      chip.hidden = true;
      return;
    }
    chip.hidden = false;
    text.textContent = state.settings.showKernel
      ? `Showing ${plural(kernelCount, "kernel thread")}`
      : `${plural(kernelCount, "kernel thread")} hidden`;
    chip.title = state.settings.showKernel ? "Click to hide kernel threads" : "Click to show kernel threads";
  }

  function updateSortHeaders(tableKey) {
    const table = tableKey === "processes" ? $("#process-table") : $("#details-table");
    if (!table) return;
    const sort = state.sort[tableKey];
    $$(".th-sort", table).forEach((button) => {
      const header = button.closest("th");
      if (!header) return;
      const active = button.dataset.sort === sort.key;
      header.classList.toggle("sorted", active);
      header.classList.toggle("dir-asc", active && sort.dir === "asc");
      header.classList.toggle("dir-desc", active && sort.dir === "desc");
      header.setAttribute("aria-sort", active ? (sort.dir === "asc" ? "ascending" : "descending") : "none");
    });
  }

  function bindSortHeaders() {
    $$(".data-table .th-sort").forEach((button) => {
      button.addEventListener("click", () => {
        const tableKey = button.closest("table")?.id === "details-table" ? "details" : "processes";
        const key = button.dataset.sort;
        const sort = state.sort[tableKey];
        if (sort.key === key) {
          sort.dir = sort.dir === "asc" ? "desc" : "asc";
        } else {
          sort.key = key;
          sort.dir = TEXT_SORTS.has(key) ? "asc" : "desc";
        }
        if (tableKey === "processes") renderProcessTable();
        else renderDetailsTable();
      });
    });
  }

  function updateSelectionUI() {
    const process = state.selected ? findProcess(state.selected.pid, state.selected.createTime) : null;
    if (!process) state.selected = null;
    const selectedName = process ? process.name : "";
    const selectionLabel = $("#selection-label");
    if (selectionLabel) {
      selectionLabel.hidden = !process;
      selectionLabel.textContent = process ? `Selected ${selectedName} · PID ${process.pid}` : "";
    }
    const protectedReason = process ? protectionReason(process) : null;
    const endButton = $("#btn-end");
    const suspendButton = $("#btn-suspend");
    const canAct = Boolean(process) && !protectedReason && !state.actionBusy;
    if (endButton) {
      endButton.disabled = !canAct;
      endButton.title = protectedReason || (process ? "End the selected process" : "Select a process first");
    }
    if (suspendButton) {
      const isStopped = process?.status === "stopped";
      suspendButton.disabled = !canAct;
      suspendButton.title = protectedReason || (process ? (isStopped ? "Resume the selected process" : "Suspend the selected process") : "Select a process first");
      const label = $("#btn-suspend-label");
      if (label) label.textContent = isStopped ? "Resume" : "Suspend";
      const use = suspendButton.querySelector("use");
      use?.setAttribute("href", isStopped ? "#i-play" : "#i-pause");
    }
    renderTableSelection();
  }

  function renderTableSelection() {
    for (const tableId of ["#process-table", "#details-table"]) {
      const table = $(tableId);
      if (!table) continue;
      $$("tbody tr[data-pid]", table).forEach((row) => {
        const pid = Number(row.dataset.pid);
        const ct = row.dataset.ct ? Number(row.dataset.ct) : null;
        const selected =
          state.selected &&
          state.selected.pid === pid &&
          (state.selected.createTime === null ||
            ct === null ||
            Math.abs(Number(state.selected.createTime) - Number(ct)) < 0.02);
        row.classList.toggle("selected", Boolean(selected));
      });
    }
  }

  function selectProcess(pid, createTime) {
    state.selected = { pid: Number(pid), createTime: createTime === null || createTime === undefined || createTime === "" ? null : Number(createTime) };
    updateSelectionUI();
  }

  function clearSelection() {
    state.selected = null;
    updateSelectionUI();
  }

  /* ======================================================================
     Performance page
     ====================================================================== */

  function setupGpuChart() {
    if (!charts.gpu) return;
    const gpu = primaryGpu();
    if (!gpu) return;
    if (gpuUsesUtilization()) {
      charts.gpu.setOptions({
        kind: "percent",
        fixedMax: 100,
        series: [{ key: "gpu_util", label: "GPU utilization", color: "--amber" }],
      });
      $("#gpu-chart-caption").textContent = "Up to 60 seconds · GPU utilization";
    } else {
      charts.gpu.setOptions({
        kind: "mhz",
        fixedMax: gpu.freq_max_mhz || null,
        series: [{ key: "gpu_freq", label: "GPU requested frequency", color: "--amber" }],
      });
      $("#gpu-chart-caption").textContent = "Up to 60 seconds · GPU requested frequency";
    }
  }

  function initCharts() {
    if (charts.cpu) return;
    charts.cpu = new LineChart($("#chart-cpu"), {
      kind: "percent",
      fixedMax: 100,
      series: [{ key: "cpu", label: "CPU", color: "--accent" }],
    });
    charts.memory = new LineChart($("#chart-memory"), {
      kind: "percent",
      fixedMax: 100,
      series: [{ key: "mem", label: "Memory", color: "--purple" }],
    });
    charts.disk = new LineChart($("#chart-disk"), {
      kind: "bytes",
      series: [
        { key: "disk_read", label: "Read", color: "--accent" },
        { key: "disk_write", label: "Write", color: "--orange" },
      ],
    });
    charts.network = new LineChart($("#chart-network"), {
      kind: "bytes",
      series: [
        { key: "net_recv", label: "Download", color: "--green" },
        { key: "net_sent", label: "Upload", color: "--purple" },
      ],
    });
    charts.gpu = new LineChart($("#chart-gpu"), {
      kind: "mhz",
      series: [{ key: "gpu_freq", label: "GPU", color: "--amber" }],
    });
    setupGpuChart();
  }

  function updateCharts() {
    if (!charts.cpu) return;
    const points = historyWindow();
    charts.cpu.setPoints(points);
    charts.memory.setPoints(points);
    charts.disk.setPoints(points);
    charts.network.setPoints(points);
    if (charts.gpu) {
      setupGpuChart();
      charts.gpu.setPoints(points);
    }
  }

  function renderPerformance() {
    if (!state.stats) return;
    const stats = state.stats;
    const hist = historyWindow();
    renderPerformanceResourceList();
    renderCpuPanel();
    renderMemoryPanel();
    renderDiskPanel();
    renderNetworkPanel();
    renderGpuPanel();
    drawResourceSparks();
    drawCoreSparks();
    updateCharts();
  }

  function renderPerformanceResourceList() {
    const stats = state.stats;
    if (!stats) return;
    const cpu = stats.cpu || {};
    const mem = stats.memory || {};
    const disk = stats.disk || {};
    const net = stats.network || {};
    const gpu = stats.gpu?.[0];
    $("#res-cpu-value").textContent = fmtPct(cpu.percent);
    $("#res-cpu-sub").textContent = `${fmtMHz(cpu.freq_mhz)} · ${plural(cpu.per_core?.length ?? 0, "core")}`;
    $("#res-memory-value").textContent = fmtPct(mem.percent);
    $("#res-memory-sub").textContent = `${fmtBytes(mem.in_use)} / ${fmtBytes(mem.total)}`;
    const root = (disk.partitions || []).find((part) => part.mount === "/") || (disk.partitions || [])[0];
    $("#res-disk-value").textContent = root ? fmtPct(root.percent) : fmtRate((disk.read_bps || 0) + (disk.write_bps || 0));
    $("#res-disk-sub").textContent = `R ${fmtRate(disk.read_bps)} · W ${fmtRate(disk.write_bps)}`;
    $("#res-network-value").textContent = fmtRate(net.recv_bps);
    $("#res-network-sub").textContent = `Upload ${fmtRate(net.sent_bps)}`;
    if (gpu) {
      if (gpu.utilization !== null && gpu.utilization !== undefined) {
        $("#res-gpu-value").textContent = fmtPct(gpu.utilization);
      } else {
        $("#res-gpu-value").textContent = fmtMHz(gpu.freq_mhz);
      }
      $("#res-gpu-sub").textContent = gpu.utilization !== null && gpu.utilization !== undefined
        ? `${fmtMHz(gpu.freq_mhz)} · ${shortGpuName(gpu.name)}`
        : `Requested · max ${fmtMHz(gpu.freq_max_mhz)}`;
    }
  }

  function drawResourceSparks() {
    const points = historyWindow();
    drawSpark($("#res-spark-cpu"), points.map((point) => point.cpu), "--accent", { fixedMax: 100 });
    drawSpark($("#res-spark-memory"), points.map((point) => point.mem), "--purple", { fixedMax: 100 });
    drawSpark(
      $("#res-spark-disk"),
      points.map((point) => (point.disk_read || 0) + (point.disk_write || 0)),
      "--teal",
    );
    drawSpark($("#res-spark-network"), points.map((point) => point.net_recv), "--green");
    if (primaryGpu()) {
      if (gpuUsesUtilization()) {
        drawSpark($("#res-spark-gpu"), points.map((point) => point.gpu_util), "--amber", { fixedMax: 100 });
      } else {
        drawSpark($("#res-spark-gpu"), points.map((point) => point.gpu_freq), "--amber", {
          fixedMax: primaryGpu()?.freq_max_mhz || null,
        });
      }
    }
  }

  function statItems(items) {
    return items
      .map(
        ([label, value, mono]) =>
          `<div class="stat-item"><div class="stat-label">${esc(label)}</div><div class="stat-value${mono ? " mono" : ""}">${value === null || value === undefined || value === "" ? "—" : esc(value)}</div></div>`,
      )
      .join("");
  }

  function renderCpuPanel() {
    const stats = state.stats;
    if (!stats) return;
    const cpu = stats.cpu || {};
    const hardwareCpu = state.system?.hardware?.cpu || {};
    $("#perf-cpu-name").textContent = hardwareCpu.model || "Unknown processor";
    $("#perf-cpu-big").textContent = fmtPct(cpu.percent);
    $("#perf-cpu-big-sub").textContent = `${fmtMHz(cpu.freq_mhz)} · load ${(cpu.load || [])[0] ?? "—"} · ${isNum(cpu.temp_c) ? `${cpu.temp_c.toFixed(1)}°C` : "temp —"}`;
    $("#perf-cpu-stats").innerHTML = statItems([
      ["Logical processors", `${cpu.per_core?.length ?? 0}`],
      ["Physical cores", `${hardwareCpu.cores ?? "—"}`],
      ["Current frequency", fmtMHz(cpu.freq_mhz)],
      ["Max frequency", fmtMHz(cpu.freq_max_mhz || hardwareCpu.max_mhz)],
      ["Temperature", isNum(cpu.temp_c) ? `${cpu.temp_c.toFixed(1)} °C` : "—"],
      ["1-minute load", (cpu.load || [])[0] ?? "—"],
      ["Processes", stats.counts?.processes ?? "—"],
      ["Threads", stats.counts?.threads ?? "—"],
    ]);
    $("#perf-cpu-hw").innerHTML = [
      `<span><strong>Model</strong> ${esc(hardwareCpu.model || "—")}</span>`,
      `<span><strong>L2 cache</strong> ${esc(hardwareCpu.cache?.l2 || "—")}</span>`,
      `<span><strong>L3 cache</strong> ${esc(hardwareCpu.cache?.l3 || "—")}</span>`,
      `<span><strong>Power policy</strong> ${esc(hardwareCpu.governor || "—")}</span>`,
      `<span><strong>Virtualization</strong> ${esc(hardwareCpu.virtualization || "—")}</span>`,
    ].join("");
    $("#perf-cpu-cores-label").textContent = plural(cpu.per_core?.length ?? 0, "logical processor");
    renderCoreGrid();
  }

  function renderCoreGrid() {
    const perCore = state.stats?.cpu?.per_core || [];
    const grid = $("#core-grid");
    if (!grid) return;
    if (!perCore.length) {
      grid.innerHTML = `<div class="view-note">Waiting for processor samples…</div>`;
      return;
    }
    if (grid.dataset.cores !== String(perCore.length)) {
      grid.dataset.cores = String(perCore.length);
      grid.innerHTML = perCore
        .map(
          (_, index) => `<div class="core-card">
            <div class="core-top"><span>Core ${index}</span><b id="core-value-${index}">—</b></div>
            <canvas class="core-canvas" id="core-canvas-${index}" aria-hidden="true"></canvas>
          </div>`,
        )
        .join("");
    }
    perCore.forEach((value, index) => {
      const target = $(`#core-value-${index}`);
      if (target) target.textContent = fmtPct(value);
    });
    drawCoreSparks();
  }

  function drawCoreSparks() {
    if (state.view !== "performance" || state.resource !== "cpu") return;
    const perCore = state.stats?.cpu?.per_core || [];
    perCore.forEach((_, index) => {
      drawSpark($(`#core-canvas-${index}`), state.coreHistory[index] || [], "--accent", {
        fixedMax: 100,
        lineWidth: 1.4,
      });
    });
  }

  function renderMemoryPanel() {
    const mem = state.stats?.memory;
    if (!mem) return;
    const hardware = state.system?.hardware?.memory || {};
    $("#perf-memory-big").textContent = fmtPct(mem.percent);
    $("#perf-memory-big-sub").textContent = `${fmtBytes(mem.in_use)} / ${fmtBytes(mem.total)}`;
    $("#perf-memory-subtitle").textContent = `${fmtBytes(mem.total)} physical · ${fmtBytes(mem.available)} available`;
    const usedPercent = mem.total ? (mem.in_use / mem.total) * 100 : 0;
    const availablePercent = mem.total ? (mem.available / mem.total) * 100 : 0;
    const swapPercent = mem.swap_total ? (mem.swap_used / mem.swap_total) * 100 : 0;
    $("#memory-bars").innerHTML = `
      <div>
        <div class="mem-bar-head"><span>Physical memory</span><span>In use ${fmtPct(mem.percent)} · available ${fmtBytes(mem.available)}</span></div>
        <div class="mem-bar"><span class="mem-seg used" style="width:${Math.min(100, usedPercent).toFixed(2)}%"></span></div>
      </div>
      <div>
        <div class="mem-bar-head"><span>Swap</span><span>${fmtBytes(mem.swap_used)} / ${fmtBytes(mem.swap_total)} (${fmtPct(mem.swap_percent)})</span></div>
        <div class="mem-bar"><span class="mem-seg swap" style="width:${Math.min(100, swapPercent).toFixed(2)}%"></span></div>
      </div>`;
    $("#perf-memory-stats").innerHTML = statItems([
      ["In use", fmtBytes(mem.in_use)],
      ["Available", fmtBytes(mem.available)],
      ["Cached", fmtBytes(mem.cached)],
      ["Buffers", fmtBytes(mem.buffers)],
      ["Shared memory", fmtBytes(mem.shared)],
      ["Swap used", `${fmtBytes(mem.swap_used)} / ${fmtBytes(mem.swap_total)}`],
      ["Swap usage", fmtPct(mem.swap_percent)],
      ["Installed", fmtBytes(hardware.installed_bytes || mem.total)],
    ]);
    $("#perf-memory-hw").innerHTML = [
      `<span><strong>Type</strong> ${esc(hardware.type || "— (root required to read DMI)")}</span>`,
      `<span><strong>Speed</strong> ${hardware.speed_mts ? `${hardware.speed_mts} MT/s` : "—"}</span>`,
      `<span><strong>Modules</strong> ${hardware.modules?.length ? plural(hardware.modules.length, "module") : "—"}</span>`,
      `<span><strong>Available</strong> ${fmtBytes(mem.available)}</span>`,
    ].join("");
  }

  function renderDiskPanel() {
    const disk = state.stats?.disk;
    if (!disk) return;
    const hardware = state.system?.hardware?.disks || [];
    const root = (disk.partitions || []).find((partition) => partition.mount === "/") || (disk.partitions || [])[0];
    const totalRate = (disk.read_bps || 0) + (disk.write_bps || 0);
    $("#perf-disk-big").textContent = fmtRate(totalRate);
    $("#perf-disk-big-sub").textContent = root
      ? `System disk ${fmtPct(root.percent)} · ${fmtBytes(root.used)} / ${fmtBytes(root.total)}`
      : "No usable partition found";
    $("#perf-disk-subtitle").textContent = hardware[0]?.model || "Storage activity and capacity";
    $("#perf-disk-stats").innerHTML = statItems([
      ["Read throughput", fmtRate(disk.read_bps)],
      ["Write throughput", fmtRate(disk.write_bps)],
      ["Read IOPS", disk.read_iops ?? "—"],
      ["Write IOPS", disk.write_iops ?? "—"],
      ["System disk usage", root ? fmtPct(root.percent) : "—"],
      ["System disk free", root ? fmtBytes(root.free) : "—"],
      ["Partitions", (disk.partitions || []).length],
      ["Disk model", hardware[0]?.model || "—"],
    ]);
    $("#disk-partitions").innerHTML = (disk.partitions || [])
      .map((partition) => {
        const usageClass = partition.percent >= 90 ? "high" : partition.percent >= 75 ? "warn" : "";
        return `<div class="partition-row">
          <div class="part-head"><strong>${esc(partition.mount)}</strong><span class="part-meta">${esc(partition.device || "")} · ${esc(partition.fstype || "")} · ${fmtPct(partition.percent)}</span></div>
          <div class="usage-bar ${usageClass}"><span style="width:${Math.min(100, partition.percent || 0)}%"></span></div>
          <div class="part-space">${fmtBytes(partition.used)} / ${fmtBytes(partition.total)}</div>
        </div>`;
      })
      .join("") || `<div class="view-note">No mounted partitions were found.</div>`;
    $("#perf-disk-hw").innerHTML = hardware.length
      ? hardware
          .map(
            (item) =>
              `<span><strong>${esc(item.model || item.name)}</strong> ${esc(item.kind === "nvme" ? "NVMe SSD" : item.rota ? "HDD" : "SSD")} · ${fmtBytes(item.size)}${item.serial ? ` · SN ${esc(item.serial)}` : ""}</span>`,
          )
          .join("")
      : `<span>No physical disk information available</span>`;
  }

  function renderNetworkPanel() {
    const network = state.stats?.network;
    if (!network) return;
    const interfaces = network.interfaces || [];
    const active = interfaces.filter((iface) => iface.is_up);
    const primary = active[0] || interfaces[0];
    $("#perf-network-big").textContent = fmtRate(network.recv_bps);
    $("#perf-network-big-sub").textContent = `Upload ${fmtRate(network.sent_bps)} · ${plural(interfaces.length, "interface")}`;
    $("#perf-network-subtitle").textContent = primary
      ? `${primary.name} · ${primary.type} · ${primary.state === "up" ? "connected" : primary.state}`
      : "No network interfaces detected";
    $("#perf-network-stats").innerHTML = statItems([
      ["Download", fmtRate(network.recv_bps)],
      ["Upload", fmtRate(network.sent_bps)],
      ["Interfaces", interfaces.length],
      ["Active interfaces", active.length],
      ["Primary interface", primary?.name || "—"],
      ["IPv4", primary?.ipv4?.[0] || "—"],
      ["Link speed", primary?.speed_mbps ? `${primary.speed_mbps} Mbps` : "—"],
      ["MAC", primary?.mac || "—"],
    ]);
    $("#network-adapters").innerHTML = interfaces
      .map(
        (iface) => `<div class="adapter-row">
          <span class="adapter-icon"><svg class="ic"><use href="#i-network"></use></svg></span>
          <div class="adapter-main">
            <div class="adapter-name">${esc(iface.name)} <span class="chip">${esc(iface.type)}</span> <span class="status-wrap ${iface.is_up ? "status-running" : "status-sleeping"}"><span class="status-dot"></span>${iface.is_up ? "Connected" : "Disconnected"}</span></div>
            <div class="adapter-sub">${esc(iface.ipv4?.join(" · ") || "No IPv4")} · ${esc(iface.mac || "No MAC")} · MTU ${iface.mtu ?? "—"}</div>
          </div>
          <div class="adapter-rate">↓ ${fmtRate(iface.recv_bps)}<small>↑ ${fmtRate(iface.sent_bps)}</small></div>
        </div>`,
      )
      .join("") || `<div class="view-note">No non-loopback network interfaces detected.</div>`;
  }

  function renderGpuPanel() {
    const gpu = primaryGpu();
    const panel = $("#perf-panel-gpu");
    if (!gpu) {
      if (panel) panel.hidden = true;
      return;
    }
    if (panel) panel.hidden = false;
    $("#perf-gpu-subtitle").textContent = shortGpuName(gpu.name) || "Graphics processor";
    if (gpu.utilization !== null && gpu.utilization !== undefined) {
      $("#perf-gpu-big").textContent = fmtPct(gpu.utilization);
      $("#perf-gpu-big-sub").textContent = `${fmtMHz(gpu.freq_mhz)} · ${gpu.vendor || ""}`;
    } else {
      $("#perf-gpu-big").textContent = fmtMHz(gpu.freq_mhz);
      $("#perf-gpu-big-sub").textContent = `Requested · max ${fmtMHz(gpu.freq_max_mhz)}`;
    }
    $("#perf-gpu-stats").innerHTML = statItems([
      ["Model", shortGpuName(gpu.name)],
      ["Driver", gpu.driver || "—"],
      ["Driver version", gpu.driver_version || "—"],
      ["PCI address", gpu.pci || "—"],
      ["Current frequency", fmtMHz(gpu.freq_mhz)],
      ["Max frequency", fmtMHz(gpu.freq_max_mhz)],
      ["VRAM", gpu.vram_total ? `${fmtBytes(gpu.vram_used)} / ${fmtBytes(gpu.vram_total)}` : gpu.integrated ? "Shared system memory" : "—"],
      ["Temperature", isNum(gpu.temp_c) ? `${gpu.temp_c.toFixed(1)} °C` : "—"],
    ]);
    const note = $("#perf-gpu-note");
    if (note) {
      if (gpu.note) {
        note.hidden = false;
        note.innerHTML = `<svg class="ic"><use href="#i-info"></use></svg>${esc(gpu.note)}`;
      } else if (gpu.utilization === null || gpu.utilization === undefined) {
        note.hidden = false;
        note.innerHTML = `<svg class="ic"><use href="#i-info"></use></svg>This GPU driver does not expose readable utilization; frequency data is shown instead.`;
      } else {
        note.hidden = true;
      }
    }
  }

  function selectResource(resource) {
    if (resource === "gpu" && !primaryGpu()) resource = "cpu";
    state.resource = resource;
    $$(".resource-item").forEach((item) => {
      const active = item.dataset.resource === resource;
      item.classList.toggle("active", active);
      item.setAttribute("aria-selected", String(active));
    });
    $$(".perf-panel").forEach((panel) => panel.classList.toggle("active", panel.dataset.resourcePanel === resource));
    requestAnimationFrame(() => {
      const chart = charts[resource];
      if (chart) {
        chart.resize();
        chart.draw();
      }
      if (resource === "cpu") drawCoreSparks();
      renderPerformance();
    });
  }

  /* ======================================================================
     Hardware
     ====================================================================== */

  function hwRow(label, value, mono = false) {
    return `<div class="hw-row"><span class="hw-label">${esc(label)}</span><span class="hw-value${mono ? " mono" : ""}">${value === null || value === undefined || value === "" ? '<span class="muted">—</span>' : value}</span></div>`;
  }

  function hwRowEsc(label, value, mono = false) {
    const safe = value === null || value === undefined || value === "" ? null : esc(value);
    return hwRow(label, safe, mono);
  }

  function renderHardware() {
    if (!state.system) return;
    state.lastHardwareRender = Date.now();
    const host = state.system.host || {};
    const hardware = state.system.hardware || {};
    const machine = hardware.system || {};
    const cpu = hardware.cpu || {};
    const memory = hardware.memory || {};
    const disks = hardware.disks || [];
    const gpus = hardware.gpus || [];
    const network = hardware.network || [];
    const stats = state.stats;
    const battery = stats?.battery || hardware.battery;

    const machineName = [machine.vendor, machine.product].filter(Boolean).join(" ") || host.hostname || "Unknown device";
    $("#hw-machine").textContent = machineName;
    $("#hw-machine-sub").textContent = `${host.hostname || ""} · ${host.name || "Linux"}`;
    $("#hw-badges").innerHTML = [
      host.name,
      host.kernel ? `Kernel ${host.kernel}` : null,
      host.architecture,
      host.desktop,
      host.session_type ? host.session_type.toUpperCase() : null,
    ]
      .filter(Boolean)
      .map((text) => `<span class="badge">${esc(text)}</span>`)
      .join("");

    $("#hw-cpu").innerHTML = [
      hwRowEsc("Model", cpu.model),
      hwRowEsc("Vendor", cpu.vendor),
      hwRow("Cores / threads", `${cpu.cores ?? "—"} / ${cpu.threads ?? "—"}`),
      hwRow("Frequency range", `${fmtMHz(cpu.min_mhz)} – ${fmtMHz(cpu.max_mhz)}`),
      hwRow("L2 / L3 cache", `${esc(cpu.cache?.l2 || "—")} / ${esc(cpu.cache?.l3 || "—")}`),
      hwRowEsc("Architecture", cpu.architecture),
      hwRowEsc("Virtualization", cpu.virtualization),
      hwRowEsc("Power policy", cpu.governor),
    ].join("");

    let memoryModules = "";
    if (memory.dmi_available && memory.modules?.length) {
      memoryModules = memory.modules
        .map(
          (module) =>
            `<div class="hw-block">
              <div class="hw-block-title">${esc(module.locator || "Module")} <span>${esc(module.type || "—")} · ${module.speed_mts ? `${module.speed_mts} MT/s` : "speed —"}</span></div>
              <div class="hw-block-sub">${fmtBytes(module.size_bytes)}${module.manufacturer ? ` · ${esc(module.manufacturer)}` : ""}${module.part_number ? ` · ${esc(module.part_number)}` : ""}</div>
            </div>`,
        )
        .join("");
    }
    $("#hw-memory").innerHTML = [
      hwRow("Total capacity", `${fmtBytes(memory.total)}${memory.installed_bytes ? ` (${fmtBytes(memory.installed_bytes)} installed)` : ""}`),
      hwRow("Current usage", stats ? `${fmtPct(stats.memory.percent)} · ${fmtBytes(stats.memory.in_use)}` : "—"),
      hwRow("Type", memory.type ? esc(memory.type) : '<span class="muted">Root required to read DMI</span>'),
      hwRow("Speed", memory.speed_mts ? `${memory.speed_mts} MT/s` : '<span class="muted">Root required to read DMI</span>'),
      hwRow("Modules", memory.dmi_available ? plural(memory.modules.length, "module") : '<span class="muted">—</span>'),
      memoryModules,
      !memory.dmi_available && memory.note ? `<div class="hw-note"><svg class="ic"><use href="#i-info"></use></svg>${esc(memory.note)}</div>` : "",
    ].join("");

    $("#hw-storage").innerHTML = disks.length
      ? disks
          .map((disk) => {
            const kind = disk.kind === "nvme" ? "NVMe SSD" : disk.rota ? "HDD" : disk.kind === "ssd" ? "SSD" : "Disk";
            const partitionHtml = (disk.partitions || [])
              .map((partition) => {
                const usageClass = partition.percent >= 90 ? "high" : partition.percent >= 75 ? "warn" : "";
                return `<div class="hw-block-sub" style="margin-top:9px"><strong>${esc(partition.mount)}</strong> · ${esc(partition.fstype || "")} · ${fmtBytes(partition.used)} / ${fmtBytes(partition.total)} (${fmtPct(partition.percent)})</div>
                  <div class="usage-bar ${usageClass}"><span style="width:${Math.min(100, partition.percent || 0)}%"></span></div>`;
              })
              .join("");
            return `<div class="hw-block">
              <div class="hw-block-title">${esc(disk.model || disk.name)} <span>${kind} · ${fmtBytes(disk.size)}</span></div>
              <div class="hw-block-sub">${esc(disk.device || "")}${disk.serial ? ` · SN ${esc(disk.serial)}` : ""}${disk.tran ? ` · ${esc(disk.tran)}` : ""}</div>
              ${partitionHtml}
            </div>`;
          })
          .join("")
      : hwRow("Disk", '<span class="muted">No physical disk detected</span>');

    $("#hw-gpu").innerHTML = gpus.length
      ? gpus
          .map((gpu) => {
            const live = stats?.gpu?.find((item) => item.pci === gpu.pci) || gpu;
            return `<div class="hw-block">
              <div class="hw-block-title">${esc(shortGpuName(gpu.name))} <span>${esc(gpu.vendor || "")}${gpu.integrated ? " · Integrated" : ""}</span></div>
              <div class="hw-block-sub">${gpu.driver ? `Driver ${esc(gpu.driver)}` : "Driver —"}${gpu.driver_version ? ` ${esc(gpu.driver_version)}` : ""} · ${esc(gpu.pci || "")}</div>
              <div class="hw-bar-note"><span>Requested ${fmtMHz(live.freq_mhz)} / max ${fmtMHz(live.freq_max_mhz || gpu.freq_max_mhz)}</span><span>${live.utilization !== null && live.utilization !== undefined ? `Utilization ${fmtPct(live.utilization)}` : "Utilization unavailable"}</span></div>
              ${live.note ? `<div class="hw-note"><svg class="ic"><use href="#i-info"></use></svg>${esc(live.note)}</div>` : ""}
            </div>`;
          })
          .join("")
      : hwRow("Graphics", '<span class="muted">No GPU detected</span>');

    $("#hw-board").innerHTML = [
      hwRowEsc("Device model", machine.machine),
      hwRowEsc("Motherboard", [machine.board_vendor, machine.board_name].filter(Boolean).join(" ")),
      hwRowEsc("BIOS", [machine.bios_vendor, machine.bios_version].filter(Boolean).join(" ")),
      hwRowEsc("BIOS date", machine.bios_date),
      hwRowEsc("Chassis type", CHASSIS_TYPES[machine.chassis_type] || machine.chassis_type),
      hwRowEsc("Product version", machine.product_version),
      hwRowEsc("Product family", machine.family),
    ].join("");

    $("#hw-network").innerHTML = network.length
      ? network
          .map(
            (iface) => `<div class="hw-block">
              <div class="hw-block-title">${esc(iface.name)} <span>${esc(iface.type)} · ${esc(iface.state || "")}</span></div>
              <div class="hw-block-sub">IPv4 ${esc(iface.ipv4?.join(" · ") || "—")}${iface.ipv6?.length ? ` · IPv6 ${esc(iface.ipv6[0])}` : ""}</div>
              <div class="hw-bar-note"><span>MAC ${esc(iface.mac || "—")}</span><span>MTU ${iface.mtu ?? "—"}${iface.speed_mbps ? ` · ${iface.speed_mbps} Mbps` : ""}</span></div>
            </div>`,
          )
          .join("")
      : hwRow("Adapters", '<span class="muted">No network adapters detected</span>');

    const batteryCard = $("#hw-battery-card");
    if (battery) {
      batteryCard.hidden = false;
      const plugged = battery.plugged;
      $("#hw-battery").innerHTML = [
        hwRow("Charge", `${fmtPct(battery.percent)}`),
        hwRow("Status", plugged ? "Plugged in" : "On battery"),
        hwRow("Estimated runtime", plugged ? (battery.secsleft === -2 ? "Plugged in" : "Charging") : fmtBatteryTime(battery.secsleft)),
        hwRow("Power", isNum(battery.power_w) ? `${battery.power_w.toFixed(1)} W` : "—"),
      ].join("");
    } else {
      batteryCard.hidden = true;
    }

    $("#hw-system").innerHTML = [
      hwRowEsc("Operating system", host.name),
      hwRowEsc("Kernel", host.kernel, true),
      hwRowEsc("Architecture", host.architecture),
      hwRowEsc("Desktop", host.desktop),
      hwRowEsc("Session type", host.session_type),
      hwRowEsc("Hostname", host.hostname),
      hwRow("Boot time", esc(fmtDateTime(host.boot_time))),
      hwRow("Uptime", stats ? fmtDuration(stats.uptime) : "—"),
      hwRowEsc("Time zone", host.timezone),
      hwRowEsc("Locale", host.locale),
      hwRow("ProcManager", `v${APP_VERSION}`),
    ].join("");

    const gpuCard = $("#hw-gpu")?.closest(".hw-card");
    if (gpuCard) gpuCard.hidden = !gpus.length;
    const networkCard = $("#hw-network")?.closest(".hw-card");
    if (networkCard) networkCard.hidden = !network.length;
  }

  function buildHardwareText() {
    if (!state.system) return "";
    const host = state.system.host || {};
    const hw = state.system.hardware || {};
    const cpu = hw.cpu || {};
    const mem = hw.memory || {};
    const lines = [
      "ProcManager hardware information",
      `Device: ${[hw.system?.vendor, hw.system?.product].filter(Boolean).join(" ")}`,
      `System: ${host.name} · kernel ${host.kernel} · ${host.architecture}`,
      `Hostname: ${host.hostname}`,
      `CPU: ${cpu.model} (${cpu.cores} cores / ${cpu.threads} threads, max ${fmtMHz(cpu.max_mhz)})`,
      `Memory: ${fmtBytes(mem.total)}${mem.installed_bytes ? ` (${fmtBytes(mem.installed_bytes)} installed)` : ""}${mem.type ? ` · ${mem.type}` : ""}${mem.speed_mts ? ` · ${mem.speed_mts} MT/s` : ""}`,
    ];
    for (const disk of hw.disks || []) {
      lines.push(`Storage: ${disk.model || disk.name} · ${fmtBytes(disk.size)}${disk.serial ? ` · SN ${disk.serial}` : ""}`);
      for (const partition of disk.partitions || []) {
        lines.push(`  Partition ${partition.mount}: ${fmtBytes(partition.used)} / ${fmtBytes(partition.total)} (${fmtPct(partition.percent)})`);
      }
    }
    for (const gpu of hw.gpus || []) {
      lines.push(`GPU: ${gpu.name}${gpu.driver ? ` · driver ${gpu.driver}` : ""}${gpu.pci ? ` · ${gpu.pci}` : ""}`);
    }
    const board = hw.system || {};
    lines.push(`Motherboard: ${[board.board_vendor, board.board_name].filter(Boolean).join(" ")} · BIOS ${[board.bios_vendor, board.bios_version].filter(Boolean).join(" ")}`);
    for (const iface of hw.network || []) {
      lines.push(`Network: ${iface.name} · ${iface.type} · IPv4 ${iface.ipv4?.join(", ") || "—"} · MAC ${iface.mac || "—"}`);
    }
    const battery = state.stats?.battery || hw.battery;
    if (battery) lines.push(`Battery: ${fmtPct(battery.percent)} · ${battery.plugged ? "Plugged in" : "On battery"}${isNum(battery.power_w) ? ` · ${battery.power_w.toFixed(1)} W` : ""}`);
    return lines.join("\n");
  }

  /* ======================================================================
     Users page
     ====================================================================== */

  function renderUsers() {
    const container = $("#users-grid");
    const overview = $("#users-overview");
    if (!container || !overview) return;
    if (!state.users) {
      overview.innerHTML = "";
      container.innerHTML = `<div class="card user-card"><div class="drawer-loading"><span class="spinner"></span>Reading user sessions…</div></div>`;
      $("#users-kernel").hidden = true;
      return;
    }
    const users = state.users.users || [];
    const sessions = state.users.sessions || [];
    const loggedIn = users.filter((user) => user.sessions?.length);
    const service = users.filter((user) => !user.sessions?.length);
    const userProcesses = users.reduce((sum, user) => sum + (user.processes || 0), 0);

    overview.innerHTML = [
      ["users", "Signed-in sessions", sessions.length, `${plural(loggedIn.length, "signed-in user")}`],
      ["users", "User accounts", users.length, "Includes system service accounts"],
      ["process", "User processes", userProcesses, `${plural(state.users.kernel?.processes || 0, "kernel thread")}`],
    ]
      .map(
        ([icon, label, value, sub]) => `<div class="overview-card">
          <span class="overview-icon"><svg class="ic"><use href="#i-${icon}"></use></svg></span>
          <span class="overview-text"><span class="overview-label">${esc(label)}</span><span class="overview-value">${esc(value)}</span><span class="overview-sub">${esc(sub)}</span></span>
        </div>`,
      )
      .join("");

    const sorted = [...loggedIn, ...service];
    container.innerHTML = sorted
      .map((user) => {
        const isService = !user.sessions?.length;
        const hue = hueFor(user.name);
        const avatarStyle = isService
          ? ""
          : `style="background:linear-gradient(145deg,hsl(${hue} 52% 44%),hsl(${(hue + 42) % 360} 58% 40%))"`;
        const sessionHtml = user.sessions?.length
          ? `<div class="user-sessions">${user.sessions
              .map(
                (session) => `<div class="session-row">
                  <svg class="ic"><use href="#i-terminal"></use></svg>
                  <span>${esc(session.terminal || "Session")}</span>
                  <span class="muted">${esc(session.host || "")}</span>
                  <span class="session-time" title="${esc(fmtDateTime(session.started))}">${esc(fmtClock(session.started, false))} signed in</span>
                </div>`,
              )
              .join("")}</div>`
          : `<div class="service-note">System account · no interactive session</div>`;
        return `<div class="card user-card">
          <div class="user-head">
            <span class="user-avatar ${isService ? "service" : ""}" ${avatarStyle}>${esc(initials(user.name))}</span>
            <div class="user-id">
              <div class="user-name">${esc(user.name)} <span class="badge">${isService ? "System account" : "Signed in"}</span></div>
              <div class="user-sub">${plural(user.processes, "process")} · ${plural(user.threads, "thread")}</div>
            </div>
          </div>
          <div class="user-metrics">
            <div class="user-metric"><div class="user-metric-label">CPU</div><div class="user-metric-value">${fmtPct(user.cpu)}</div></div>
            <div class="user-metric"><div class="user-metric-label" title="Sum of RSS for this user’s processes; shared pages may be counted more than once">Memory RSS</div><div class="user-metric-value">${fmtBytes(user.memory)}</div></div>
            <div class="user-metric"><div class="user-metric-label">RSS share</div><div class="user-metric-value">${fmtPct(user.memory_percent)}</div></div>
          </div>
          ${sessionHtml}
        </div>`;
      })
      .join("");

    const kernel = state.users.kernel;
    const kernelEl = $("#users-kernel");
    if (kernel && kernel.processes) {
      kernelEl.hidden = false;
      kernelEl.innerHTML = `<div class="kernel-summary-main">
          <span class="kc-icon"><svg class="ic"><use href="#i-chip"></use></svg></span>
          <div><h3>Kernel threads</h3><p>Kernel threads not associated with a user session</p></div>
        </div>
        <div class="kernel-metrics">
          <div class="kernel-metric"><span>Threads</span><b>${kernel.processes}</b></div>
          <div class="kernel-metric"><span>CPU</span><b>${fmtPct(kernel.cpu)}</b></div>
          <div class="kernel-metric"><span>Memory</span><b>${fmtBytes(kernel.memory)}</b></div>
        </div>`;
    } else {
      kernelEl.hidden = true;
    }
  }

  async function loadUsers(force = false) {
    if (state.loadingUsers) return;
    if (!force && Date.now() - state.lastUsersFetch < 3000) return;
    state.loadingUsers = true;
    try {
      const data = await apiGet("/api/users");
      state.users = data;
      state.lastUsersFetch = Date.now();
      if (state.view === "users") renderUsers();
    } catch (error) {
      if (state.view === "users") {
        $("#users-grid").innerHTML = `<div class="card user-card"><div class="view-note"><svg class="ic"><use href="#i-alert"></use></svg>Unable to read user sessions: ${esc(error.message)}</div></div>`;
      }
    } finally {
      state.loadingUsers = false;
    }
  }

  /* ======================================================================
     Drawer
     ====================================================================== */

  function protectionReason(process) {
    if (!process) return null;
    if (process.pid === 1) return "System init process (PID 1) is protected";
    if (process.pid === 2) return "Kernel thread daemon (PID 2) is protected";
    const serverPid = state.system?.runtime?.server_pid;
    if (serverPid && process.pid === serverPid) return "ProcManager backend service is protected";
    return null;
  }

  function openDrawer(pid, createTime = null) {
    const process = findProcess(pid, createTime);
    if (!process) return;
    state.drawerPid = process.pid;
    state.drawerCreateTime = process.create_time;
    state.drawerDetails = null;
    $("#drawer-name").textContent = process.name;
    $("#drawer-sub").textContent = `PID ${process.pid} · ${process.username || "—"}`;
    const tile = $("#drawer-tile");
    tile.textContent = initials(process.name);
    tile.setAttribute("style", tileStyle(process.name, process.kernel));
    $("#drawer").classList.add("open");
    $("#drawer").setAttribute("aria-hidden", "false");
    $("#drawer-scrim").classList.add("open");
    $("#drawer-body").innerHTML = `<div class="drawer-loading"><span class="spinner"></span>Reading process details…</div>`;
    updateDrawerActions();
    loadDrawerDetails();
  }

  function closeDrawer() {
    state.drawerPid = null;
    state.drawerCreateTime = null;
    state.drawerDetails = null;
    $("#drawer").classList.remove("open");
    $("#drawer").setAttribute("aria-hidden", "true");
    $("#drawer-scrim").classList.remove("open");
  }

  function updateDrawerActions() {
    if (!state.drawerPid) return;
    const process = findProcess(state.drawerPid, state.drawerCreateTime);
    const protectedReason = process ? protectionReason(process) : "Process exited";
    const disabled = !process || Boolean(protectedReason) || state.actionBusy;
    $("#drawer-end").disabled = disabled;
    $("#drawer-end").title = protectedReason || "End this process";
    $("#drawer-suspend").disabled = disabled;
    const isStopped = process?.status === "stopped";
    $("#drawer-suspend-label").textContent = isStopped ? "Resume" : "Suspend";
    $("#drawer-suspend").querySelector("use")?.setAttribute("href", isStopped ? "#i-play" : "#i-pause");
    $("#drawer-suspend").title = protectedReason || (isStopped ? "Resume this process" : "Suspend this process");
    $("#drawer-copy-pid").disabled = !process;
  }

  async function loadDrawerDetails() {
    const pid = state.drawerPid;
    if (!pid) return;
    const body = $("#drawer-body");
    body.innerHTML = `<div class="drawer-loading"><span class="spinner"></span>Reading process details…</div>`;
    try {
      const details = await apiGet(`/api/process/${pid}`);
      if (state.drawerPid !== pid) return;
      state.drawerDetails = details;
      renderDrawer();
    } catch (error) {
      if (state.drawerPid !== pid) return;
      body.innerHTML = `<div class="view-note"><svg class="ic"><use href="#i-alert"></use></svg>${esc(error.message)}</div>`;
    }
  }

  function drawerProp(label, value, { mono = false, full = false } = {}) {
    return `<div class="detail-prop${full ? " full" : ""}"><div class="dp-label">${esc(label)}</div><div class="dp-value${mono ? " mono" : ""}">${value === null || value === undefined || value === "" ? '<span class="muted">—</span>' : value}</div></div>`;
  }

  function renderDrawer() {
    const details = state.drawerDetails;
    if (!details) return;
    const process = findProcess(details.pid, details.create_time) || details;
    const io = details.io || {};
    const mem = details.memory || {};
    const cpuTimes = details.cpu_times || {};
    const sections = [];

    sections.push(`<div class="detail-section">
      <div class="detail-live">
        <div>CPU<b id="drawer-live-cpu">${fmtPct(process.cpu)}</b></div>
        <div>Memory<b id="drawer-live-memory">${fmtBytes(process.memory ?? mem.rss)}</b></div>
        <div>Threads<b id="drawer-live-threads">${process.threads ?? details.num_threads ?? "—"}</b></div>
        <div>Status<b id="drawer-live-status">${esc(statusInfo(process.status).label)}</b></div>
      </div>
    </div>`);

    sections.push(`<div class="detail-section">
      <h3>Basic</h3>
      <div class="detail-grid">
        ${drawerProp("PID", details.pid)}
        ${drawerProp("Parent", details.parent ? `${esc(details.parent.name || "?")} · ${details.parent.pid}` : "—")}
        ${drawerProp("User", esc(details.username || "—"))}
        ${drawerProp("Status", esc(statusInfo(details.status).label))}
        ${drawerProp("Priority (nice)", details.nice ?? "—")}
        ${drawerProp("Terminal", esc(details.terminal || "—"))}
        ${drawerProp("Started", esc(fmtDateTime(details.create_time)))}
        ${drawerProp("Uptime", esc(fmtDuration(details.run_time)))}
        ${drawerProp("Children", details.children?.length ?? 0)}
        ${drawerProp("UID / GID", details.uids ? `${details.uids.real} / ${details.gids?.real ?? "—"}` : "—")}
      </div>
    </div>`);

    sections.push(`<div class="detail-section">
      <h3>Resources</h3>
      <div class="detail-grid">
        ${drawerProp("Resident memory", `${fmtBytes(mem.rss)}${isNum(details.memory_percent) ? ` (${details.memory_percent.toFixed(2)}%)` : ""}`)}
        ${drawerProp("Virtual memory", fmtBytes(mem.vms))}
        ${drawerProp("CPU time (user)", fmtDuration(cpuTimes.user))}
        ${drawerProp("CPU time (system)", fmtDuration(cpuTimes.system))}
        ${drawerProp("Total read", fmtBytes(io.read_bytes))}
        ${drawerProp("Total written", fmtBytes(io.write_bytes))}
        ${drawerProp("Open files", details.open_files_count === null ? "Unavailable" : details.open_files_count)}
        ${drawerProp("Connections", details.connections_count === null ? "Unavailable" : details.connections_count)}
        ${drawerProp("Environment variables", details.environment_count === null ? "Unavailable" : details.environment_count)}
        ${drawerProp("CPU affinity", details.cpu_affinity?.length ? plural(details.cpu_affinity.length, "processor") : "—")}
      </div>
    </div>`);

    const pathRows = [];
    pathRows.push(`<div class="detail-section"><h3>Paths</h3>
      <div class="detail-path-label">Executable</div>
      <div class="detail-code-wrap"><div class="detail-code${details.exe ? "" : " empty"}">${esc(details.exe || "Unavailable (may require higher privileges)")}</div><button class="copy-btn" type="button" data-copy="exe" title="Copy executable path"><svg class="ic"><use href="#i-copy"></use></svg></button></div>`);
    if (details.cwd) {
      pathRows.push(`<div class="detail-path-label">Working directory</div><div class="detail-code-wrap"><div class="detail-code">${esc(details.cwd)}</div><button class="copy-btn" type="button" data-copy="cwd" title="Copy working directory"><svg class="ic"><use href="#i-copy"></use></svg></button></div>`);
    }
    pathRows.push(`<div class="detail-path-label">Command line</div><div class="detail-code-wrap"><div class="detail-code${details.cmdline_str ? "" : " empty"}">${esc(details.cmdline_str || "(no command line information)")}</div><button class="copy-btn" type="button" data-copy="cmdline" title="Copy command line"><svg class="ic"><use href="#i-copy"></use></svg></button></div></div>`);
    sections.push(pathRows.join(""));

    if (details.connections?.length) {
      sections.push(`<div class="detail-section"><h3>Network connections (up to 20)</h3>
        <div class="connection-list">${details.connections
          .map(
            (connection) => `<div class="connection-row"><span class="proto">${connection.type?.includes("STREAM") ? "TCP" : "UDP"}</span><span>${esc(connection.laddr || "—")}</span><span>→</span><span>${esc(connection.raddr || "—")}</span><span class="conn-status">${esc(connection.status || "")}</span></div>`,
          )
          .join("")}</div></div>`);
    }

    $("#drawer-body").innerHTML = sections.join("");
    updateDrawerLive();
  }

  function updateDrawerLive() {
    if (!state.drawerPid) return;
    const process = findProcess(state.drawerPid, state.drawerCreateTime);
    const sub = $("#drawer-sub");
    if (!process) {
      if (sub) sub.textContent = `PID ${state.drawerPid} · exited`;
      $("#drawer-end").disabled = true;
      $("#drawer-suspend").disabled = true;
      return;
    }
    if (sub) sub.textContent = `PID ${process.pid} · ${process.username || "—"}`;
    const cpu = $("#drawer-live-cpu");
    if (cpu) cpu.textContent = fmtPct(process.cpu);
    const memory = $("#drawer-live-memory");
    if (memory) memory.textContent = fmtBytes(process.memory);
    const threads = $("#drawer-live-threads");
    if (threads) threads.textContent = process.threads ?? "—";
    const status = $("#drawer-live-status");
    if (status) status.textContent = statusInfo(process.status).label;
    updateDrawerActions();
  }

  function drawerEndpoint() {
    return state.drawerDetails?.pid ? state.drawerDetails.pid : state.drawerPid;
  }

  /* ======================================================================
     Context menu
     ====================================================================== */

  function hideContextMenu() {
    const menu = $("#context-menu");
    if (!menu || menu.hidden) return;
    menu.hidden = true;
    menu.innerHTML = "";
    state.contextPid = null;
  }

  function showContextMenu(pid, x, y) {
    const process = findProcess(pid);
    if (!process) return;
    state.contextPid = pid;
    const reason = protectionReason(process);
    const isStopped = process.status === "stopped";
    const menu = $("#context-menu");
    menu.innerHTML = `
      <button class="cm-item" type="button" data-action="details"><svg class="ic"><use href="#i-details"></use></svg>View details<span class="cm-hint">Enter</span></button>
      <div class="cm-sep"></div>
      <button class="cm-item danger" type="button" data-action="end" ${reason ? "disabled" : ""}><svg class="ic"><use href="#i-stop"></use></svg>End task${reason ? `<span class="cm-hint">Protected</span>` : ""}</button>
      <button class="cm-item danger" type="button" data-action="force" ${reason ? "disabled" : ""}><svg class="ic"><use href="#i-alert"></use></svg>Force end</button>
      <button class="cm-item" type="button" data-action="${isStopped ? "resume" : "suspend"}" ${reason ? "disabled" : ""}><svg class="ic"><use href="#i-${isStopped ? "play" : "pause"}"></use></svg>${isStopped ? "Resume process" : "Suspend process"}</button>
      <div class="cm-sep"></div>
      <button class="cm-item" type="button" data-action="copy-pid"><svg class="ic"><use href="#i-copy"></use></svg>Copy PID</button>
      <button class="cm-item" type="button" data-action="copy-name"><svg class="ic"><use href="#i-copy"></use></svg>Copy process name</button>`;
    menu.hidden = false;
    menu.style.left = "0px";
    menu.style.top = "0px";
    const rect = menu.getBoundingClientRect();
    const left = Math.min(Math.max(8, x), window.innerWidth - rect.width - 8);
    const top = Math.min(Math.max(8, y), window.innerHeight - rect.height - 8);
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
    menu.querySelectorAll(".cm-item").forEach((item) => {
      item.addEventListener("click", () => {
        const action = item.dataset.action;
        hideContextMenu();
        handleMenuAction(process, action);
      });
    });
  }

  function handleMenuAction(process, action) {
    switch (action) {
      case "details": openDrawer(process.pid, process.create_time); break;
      case "end": requestEnd(process, false); break;
      case "force": requestEnd(process, true); break;
      case "suspend": performAction(process.pid, "suspend", process.create_time); break;
      case "resume": performAction(process.pid, "resume", process.create_time); break;
      case "copy-pid": copyText(String(process.pid), "PID copied"); break;
      case "copy-name": copyText(process.name, "Process name copied"); break;
      default: break;
    }
  }

  /* ======================================================================
     Process actions
     ====================================================================== */

  function requestEnd(process, force = false) {
    if (!process) return;
    const reason = protectionReason(process);
    if (reason) {
      toast("warning", "Unable to end this process", reason);
      return;
    }
    if (force || state.settings.confirmKill) {
      showEndDialog(process, force);
    } else {
      performAction(process.pid, "terminate", process.create_time);
    }
  }

  function showEndDialog(process, force) {
    state.pendingEnd = { pid: process.pid, createTime: process.create_time, force, name: process.name };
    $("#end-title").textContent = force ? "Force end process?" : "End process?";
    $("#end-text").textContent = `“${process.name}” (PID ${process.pid}) will be ended. Unsaved data may be lost.`;
    const warning = $("#end-warning");
    if (force) {
      warning.hidden = false;
      warning.textContent = "Force end terminates the process immediately and may cause data loss or file corruption. Use it only when a normal end does not work.";
    } else {
      warning.hidden = false;
      warning.textContent = "Ending a system process may fail because of permissions. ProcManager and critical system processes are protected.";
    }
    const dialog = $("#end-dialog");
    if (!dialog.open) dialog.showModal();
    setTimeout(() => (force ? $("#end-force") : $("#end-confirm")).focus(), 30);
  }

  async function performAction(pid, action, createTime) {
    if (state.actionBusy) return;
    state.actionBusy = true;
    updateSelectionUI();
    updateDrawerActions();
    try {
      const result = await apiAction(pid, action, createTime);
      const name = findProcess(pid, createTime)?.name || `PID ${pid}`;
      let message;
      if (action === "terminate") message = result.ended ? `Ended “${name}”` : `Sent an end request to “${name}”`;
      else if (action === "kill") message = result.ended ? `Force-ended “${name}”` : `Sent a force-end request to “${name}”`;
      else if (action === "suspend") message = `Suspended “${name}”`;
      else message = `Resumed “${name}”`;
      toast("success", message, result.ended === false && (action === "terminate" || action === "kill") ? "If the process does not respond, use “Force end”." : "");
      if (action === "terminate" || action === "kill") {
        clearSelection();
        if (state.drawerPid === pid) closeDrawer();
      }
      setTimeout(() => refreshLive(true), 120);
      if (state.drawerPid === pid) setTimeout(loadDrawerDetails, 260);
    } catch (error) {
      toast("error", "Action failed", error.message);
    } finally {
      state.actionBusy = false;
      updateSelectionUI();
      updateDrawerActions();
    }
  }

  /* ======================================================================
     Modal bindings
     ====================================================================== */

  function bindDialog() {
    const dialog = $("#end-dialog");
    $("#end-cancel").addEventListener("click", () => dialog.close());
    $("#end-confirm").addEventListener("click", () => {
      const pending = state.pendingEnd;
      dialog.close();
      state.pendingEnd = null;
      if (pending) performAction(pending.pid, "terminate", pending.createTime);
    });
    $("#end-force").addEventListener("click", () => {
      const pending = state.pendingEnd;
      dialog.close();
      state.pendingEnd = null;
      if (pending) performAction(pending.pid, "kill", pending.createTime);
    });
    dialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      state.pendingEnd = null;
      dialog.close();
    });
    dialog.addEventListener("close", () => {
      state.pendingEnd = null;
    });
  }

  /* ======================================================================
     Table interactions
     ====================================================================== */

  function bindTableInteractions(tableSelector, viewKey) {
    const table = $(tableSelector);
    if (!table) return;
    table.addEventListener("click", (event) => {
      const row = event.target.closest("tr[data-pid]");
      if (!row) return;
      selectProcess(row.dataset.pid, row.dataset.ct || null);
    });
    table.addEventListener("dblclick", (event) => {
      const row = event.target.closest("tr[data-pid]");
      if (!row) return;
      selectProcess(row.dataset.pid, row.dataset.ct || null);
      openDrawer(Number(row.dataset.pid), row.dataset.ct ? Number(row.dataset.ct) : null);
    });
    table.addEventListener("contextmenu", (event) => {
      const row = event.target.closest("tr[data-pid]");
      if (!row) return;
      event.preventDefault();
      selectProcess(row.dataset.pid, row.dataset.ct || null);
      showContextMenu(Number(row.dataset.pid), event.clientX, event.clientY);
    });
  }

  function bindRowAreas() {
    for (const scrollId of ["#process-scroll", "#details-scroll"]) {
      const area = $(scrollId);
      if (!area) continue;
      area.addEventListener("click", (event) => {
        if (!event.target.closest("tr[data-pid]")) {
          clearSelection();
          hideContextMenu();
        }
      });
    }
  }

  /* ======================================================================
     Navigation
     ====================================================================== */

  function navigate(view, { updateHash = true } = {}) {
    if (!VIEW_META[view]) view = "processes";
    const previous = state.view;
    if (previous !== view) {
      closeDrawer();
      hideContextMenu();
    }
    state.view = view;
    $$(".view").forEach((section) => section.classList.toggle("active", section.dataset.view === view));
    $$(".nav-item").forEach((item) => item.classList.toggle("active", item.dataset.view === view));
    $("#page-title").textContent = VIEW_META[view].title;
    $("#page-subtitle").textContent = VIEW_META[view].subtitle;
    const showSearch = view === "processes" || view === "details";
    $("#search-wrap").hidden = !showSearch;
    if (!showSearch) resetSearch(false);
    else $("#search-input").placeholder = view === "details" ? "Search processes (name, PID or user)" : "Search processes (name, PID or user)";

    if (view === "processes") {
      renderSummary();
      renderProcessTable();
      drawSummarySparks();
      drawResourceSparks();
    } else if (view === "performance") {
      initCharts();
      renderPerformance();
      requestAnimationFrame(() => {
        Object.values(charts).forEach((chart) => chart.resize());
      });
      loadHistory();
    } else if (view === "hardware") {
      renderHardware();
    } else if (view === "users") {
      renderUsers();
      loadUsers(true);
    } else if (view === "details") {
      renderDetailsTable();
    } else if (view === "settings") {
      syncSettingsUI();
    }
    const scrollContainer = $(`#view-${view}`);
    if (scrollContainer && previous !== view) scrollContainer.scrollTop = 0;

    if (updateHash && location.hash !== `#/${view}`) {
      suppressHash = true;
      location.hash = `#/${view}`;
    }
  }

  function parseHash() {
    const match = /^#\/([a-z]+)/i.exec(location.hash || "");
    return match && VIEW_META[match[1]] ? match[1] : "processes";
  }

  function resetSearch(rerender = true) {
    state.search = "";
    const input = $("#search-input");
    if (input) input.value = "";
    const clear = $("#search-clear");
    if (clear) clear.hidden = true;
    if (rerender) {
      if (state.view === "processes") renderProcessTable();
      if (state.view === "details") renderDetailsTable();
    }
  }

  /* ======================================================================
     Polling / data refresh
     ====================================================================== */

  async function refreshLive(manual = false) {
    if (state.refreshing) return;
    state.refreshing = true;
    const refreshButton = $("#refresh-btn");
    if (manual) refreshButton.classList.add("spinning");
    let failed = null;
    const [statsResult, processResult] = await Promise.allSettled([
      apiGet("/api/stats", 5000),
      apiGet("/api/processes", 6000),
    ]);
    if (statsResult.status === "fulfilled") {
      applyStats(statsResult.value);
    } else {
      failed = statsResult.reason;
    }
    if (processResult.status === "fulfilled") {
      applyProcesses(processResult.value);
    } else {
      failed = failed || processResult.reason;
    }
    if (failed) {
      state.failures += 1;
      updateSidebarStatus(false);
      const banner = $("#connection-banner");
      banner.hidden = false;
      $("#connection-text").textContent = `Cannot reach the local service: ${failed.message} (retrying)`;
    } else {
      if (state.failures > 0) {
        toast("success", "Connection restored", "Live data is refreshing again.");
      }
      state.failures = 0;
      $("#connection-banner").hidden = true;
    }
    if (state.view === "users" && Date.now() - state.lastUsersFetch > 3500) {
      loadUsers();
    }
    if (state.view === "hardware" && state.stats && Date.now() - state.lastHardwareRender > 3000) {
      renderHardware();
    }
    state.refreshing = false;
    if (manual) refreshButton.classList.remove("spinning");
  }

  function startPolling() {
    pollGeneration += 1;
    const generation = pollGeneration;
    if (pollTimer) clearTimeout(pollTimer);
    const tick = async () => {
      if (generation !== pollGeneration) return;
      if (!document.hidden) await refreshLive(false);
      if (generation !== pollGeneration) return;
      pollTimer = setTimeout(tick, Math.max(500, state.settings.refreshMs));
    };
    pollTimer = setTimeout(tick, Math.max(500, state.settings.refreshMs));
  }

  async function loadHistory() {
    try {
      const data = await apiGet("/api/history?seconds=60", 5000);
      mergeHistory(data.points || []);
      if (state.view === "performance") {
        renderPerformance();
        updateCharts();
      }
      drawSummarySparks();
    } catch {
      /* history is non-critical */
    }
  }

  /* ======================================================================
     UI bindings
     ====================================================================== */

  function bindNavigation() {
    $$(".nav-item").forEach((item) => {
      item.addEventListener("click", () => navigate(item.dataset.view));
    });
    $$(".summary-card").forEach((card) => {
      card.addEventListener("click", () => {
        state.resource = card.dataset.resource;
        navigate("performance");
        selectResource(state.resource);
      });
    });
    $$(".resource-item").forEach((item) => {
      item.addEventListener("click", () => selectResource(item.dataset.resource));
    });
    window.addEventListener("hashchange", () => {
      if (suppressHash) {
        suppressHash = false;
        return;
      }
      navigate(parseHash(), { updateHash: false });
    });
  }

  function bindTopbar() {
    $("#refresh-btn").addEventListener("click", () => refreshLive(true));
    $("#theme-btn").addEventListener("click", () => {
      applyTheme(state.settings.theme === "dark" ? "light" : "dark");
      saveSettings();
    });
    $("#search-input").addEventListener("input", (event) => {
      state.search = event.target.value;
      $("#search-clear").hidden = !state.search;
      if (state.view === "processes") renderProcessTable();
      if (state.view === "details") renderDetailsTable();
    });
    $("#search-clear").addEventListener("click", () => {
      resetSearch();
      $("#search-input").focus();
    });
    $("#search-input").addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        resetSearch();
        event.target.blur();
      }
      if (event.key === "Enter") {
        const rows = $$("tbody tr[data-pid]", state.view === "details" ? $("#details-table") : $("#process-table"));
        if (rows.length) {
          const pid = Number(rows[0].dataset.pid);
          selectProcess(pid, rows[0].dataset.ct || null);
          openDrawer(pid, rows[0].dataset.ct ? Number(rows[0].dataset.ct) : null);
        }
      }
    });
    const themeChoice = $("#theme-choice");
    themeChoice?.addEventListener("click", (event) => {
      const button = event.target.closest("button[data-theme-choice]");
      if (!button) return;
      applyTheme(button.dataset.themeChoice);
      saveSettings();
    });
    const intervalChoice = $("#interval-choice");
    intervalChoice?.addEventListener("click", (event) => {
      const button = event.target.closest("button[data-interval]");
      if (!button) return;
      const ms = Number(button.dataset.interval);
      applyRefreshInterval(ms);
      updateSidebarStatus(true);
      toast("info", `Refresh interval set to ${plural(ms / 1000, "second")}`);
    });
    $("#setting-confirm").addEventListener("change", (event) => {
      state.settings.confirmKill = event.target.checked;
      saveSettings();
    });
    $("#setting-kernel").addEventListener("change", (event) => {
      state.settings.showKernel = event.target.checked;
      saveSettings();
      applyKernelSetting();
    });
    $("#setting-sidebar").addEventListener("change", (event) => {
      applySidebar(event.target.checked);
    });
    $("#reset-settings").addEventListener("click", () => {
      state.settings = { ...DEFAULT_SETTINGS };
      saveSettings();
      applyTheme("dark");
      applySidebar(false);
      applyRefreshInterval(1000);
      $("#setting-confirm").checked = true;
      $("#setting-kernel").checked = false;
      applyKernelSetting();
      toast("success", "Default settings restored");
    });
    $("#sidebar-toggle").addEventListener("click", () => applySidebar(!state.settings.sidebarCollapsed));
    $("#kernel-toggle").addEventListener("click", () => {
      state.settings.showKernel = !state.settings.showKernel;
      saveSettings();
      applyKernelSetting();
    });
    $("#btn-end").addEventListener("click", () => {
      const process = state.selected ? findProcess(state.selected.pid, state.selected.createTime) : null;
      if (process) requestEnd(process, false);
    });
    $("#btn-suspend").addEventListener("click", () => {
      const process = state.selected ? findProcess(state.selected.pid, state.selected.createTime) : null;
      if (!process) return;
      const action = process.status === "stopped" ? "resume" : "suspend";
      performAction(process.pid, action, process.create_time);
    });
    $("#copy-hardware").addEventListener("click", () => copyText(buildHardwareText(), "Hardware information copied"));
  }

  function bindDrawer() {
    $("#drawer-close").addEventListener("click", closeDrawer);
    $("#drawer-scrim").addEventListener("click", closeDrawer);
    $("#drawer-refresh").addEventListener("click", loadDrawerDetails);
    $("#drawer-copy-pid").addEventListener("click", () => {
      if (state.drawerPid) copyText(String(state.drawerPid), "PID copied");
    });
    $("#drawer-end").addEventListener("click", () => {
      const process = state.drawerPid ? findProcess(state.drawerPid, state.drawerCreateTime) : null;
      if (process) requestEnd(process, false);
    });
    $("#drawer-suspend").addEventListener("click", () => {
      const process = state.drawerPid ? findProcess(state.drawerPid, state.drawerCreateTime) : null;
      if (!process) return;
      performAction(process.pid, process.status === "stopped" ? "resume" : "suspend", process.create_time);
    });
    $("#drawer-body").addEventListener("click", (event) => {
      const button = event.target.closest("[data-copy]");
      if (!button) return;
      const field = button.dataset.copy;
      const value = state.drawerDetails?.[field] ?? (field === "cmdline" ? state.drawerDetails?.cmdline_str : null);
      if (value) copyText(String(value), "Copied");
    });
  }

  function bindContextMenu() {
    document.addEventListener("click", (event) => {
      if (!event.target.closest("#context-menu")) hideContextMenu();
    });
    document.addEventListener("scroll", hideContextMenu, true);
    window.addEventListener("blur", hideContextMenu);
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") hideContextMenu();
    });
  }

  function bindGlobalKeys() {
    document.addEventListener("keydown", (event) => {
      const target = event.target;
      const typing = target instanceof HTMLElement && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable);

      if (event.key === "Escape") {
        if (state.drawerPid) {
          closeDrawer();
          return;
        }
        if (typing) {
          target.blur();
          return;
        }
        hideContextMenu();
        return;
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "f") {
        const searchWrap = $("#search-wrap");
        if (!searchWrap.hidden) {
          event.preventDefault();
          $("#search-input").focus();
          $("#search-input").select();
        }
        return;
      }
      if (event.key === "F5") {
        event.preventDefault();
        refreshLive(true);
        return;
      }
      if ((event.ctrlKey || event.metaKey) && /^[1-6]$/.test(event.key)) {
        const order = ["processes", "performance", "hardware", "users", "details", "settings"];
        const view = order[Number(event.key) - 1];
        if (view) {
          event.preventDefault();
          navigate(view);
        }
        return;
      }
      if (typing || state.actionBusy) return;
      if (event.key === "Delete") {
        const process = state.selected ? findProcess(state.selected.pid, state.selected.createTime) : null;
        if (process) {
          event.preventDefault();
          requestEnd(process, false);
        }
      } else if (event.key === "Enter") {
        const process = state.drawerPid
          ? findProcess(state.drawerPid, state.drawerCreateTime)
          : state.selected
            ? findProcess(state.selected.pid, state.selected.createTime)
            : null;
        if (process) {
          event.preventDefault();
          openDrawer(process.pid, process.create_time);
        }
      }
    });
  }

  function bindVisibility() {
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden && state.booted) {
        refreshLive(true);
        if (state.view === "performance") loadHistory();
      }
    });
  }

  function bindStaticEvents() {
    bindNavigation();
    bindTopbar();
    bindDrawer();
    bindContextMenu();
    bindGlobalKeys();
    bindVisibility();
    bindDialog();
    bindSortHeaders();
    bindTableInteractions("#process-table", "processes");
    bindTableInteractions("#details-table", "details");
    bindRowAreas();
    window.addEventListener("resize", () => {
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => Object.values(charts).forEach((chart) => chart.resize()), 120);
    });
  }

  /* ======================================================================
     Boot
     ====================================================================== */

  function setBootText(text) {
    const element = $("#boot-text");
    if (element) element.textContent = text;
  }

  function hideBootOverlay() {
    const overlay = $("#boot-overlay");
    if (!overlay) return;
    overlay.classList.add("hidden");
    setTimeout(() => overlay.remove(), 350);
  }

  async function bootstrap() {
    syncSettingsUI();
    initCharts();
    setBootText("Connecting to the local monitoring service…");
    let attempt = 0;
    while (true) {
      attempt += 1;
      try {
        const results = await Promise.allSettled([
          apiGet("/api/system", 8000),
          apiGet("/api/stats", 8000),
          apiGet("/api/processes", 8000),
          apiGet("/api/history?seconds=60", 8000),
        ]);
        const [systemResult, statsResult, processesResult, historyResult] = results;
        if (systemResult.status !== "fulfilled") throw systemResult.reason;
        if (statsResult.status !== "fulfilled") throw statsResult.reason;
        if (processesResult.status !== "fulfilled") throw processesResult.reason;

        applySystem(systemResult.value);
        if (historyResult.status === "fulfilled") mergeHistory(historyResult.value.points || []);
        applyStats(statsResult.value);
        applyProcesses(processesResult.value);
        state.history = state.history.slice(-MAX_HISTORY);

        const initialView = parseHash();
        navigate(initialView, { updateHash: !location.hash });
        state.booted = true;
        updateSidebarStatus(true);
        hideBootOverlay();
        startPolling();
        return;
      } catch (error) {
        setBootText(attempt < 5 ? "Waiting for the local service…" : `Cannot reach the local service: ${error.message}`);
        updateSidebarStatus(false);
        await sleep(attempt < 5 ? 900 : 2200);
      }
    }
  }

  function init() {
    if (!TOKEN) {
      setBootText("This page is missing its local access token. Reload the page or restart ProcManager.");
      return;
    }
    syncSettingsUI();
    applyTheme(state.settings.theme, false);
    applySidebar(state.settings.sidebarCollapsed, false);
    bindStaticEvents();
    bootstrap();
  }

  init();
})();
