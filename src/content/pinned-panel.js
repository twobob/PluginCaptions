import { MESSAGE_TYPES, FONT_SIZES } from "../utils/constants.js";
const webExt = typeof browser !== "undefined" ? browser : chrome;
const SIZE_ORDER = ["small", "medium", "large", "xlarge"];
export class PinnedPanel {
  constructor(settings) {
    this.settings = { ...settings };
    this.host = null;
    this.els = {};
    this.lastLatency = null;
    this.currentStatusText = "Listening (Ready)";
    this.currentStatusType = "ready";
    this.isCollapsed = false;
    this.isDragging = false;
    this.dragStartX = 0;
    this.dragStartY = 0;
  }
  mount() {
    if (this.host) return;
    this.host = document.createElement("div");
    this.host.id = "rutranscribe-pinned";
    this.host.style.cssText = "all:initial;position:fixed;top:14px;right:16px;z-index:2147483647;pointer-events:auto;";
    const root = this.host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = `
      :host {
        all: initial;
        pointer-events: auto;
      }
      .panel-card {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 6px 10px;
        border-radius: 12px;
        background: rgba(11, 15, 25, 0.92);
        backdrop-filter: blur(12px);
        -webkit-backdrop-filter: blur(12px);
        color: #f1f5f9;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
        font-size: 11px;
        font-weight: 600;
        box-shadow: 0 8px 24px rgba(0, 0, 0, 0.55), 0 0 0 1px rgba(255, 255, 255, 0.12);
        user-select: none;
        cursor: grab;
        transition: opacity 0.2s ease, transform 0.15s ease, background 0.2s ease;
      }
      .panel-card:active {
        cursor: grabbing;
      }
      .panel-card.collapsed .collapsible-item {
        display: none !important;
      }

      /* Logo / Drag handle */
      .brand-badge {
        display: inline-flex;
        align-items: center;
        gap: 5px;
        background: linear-gradient(135deg, #4f46e5, #06b6d4);
        color: #ffffff;
        padding: 3px 6px;
        border-radius: 6px;
        font-size: 10px;
        font-weight: 800;
        letter-spacing: 0.5px;
        box-shadow: 0 2px 6px rgba(79, 70, 229, 0.4);
      }

      /* Status Pill */
      .status-pill {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        background: rgba(255, 255, 255, 0.06);
        padding: 3px 8px;
        border-radius: 20px;
        font-size: 11px;
        font-weight: 500;
        color: #cbd5e1;
        border: 1px solid rgba(255, 255, 255, 0.08);
        transition: all 0.2s ease;
      }
      .status-dot {
        width: 7px;
        height: 7px;
        border-radius: 50%;
        background: #10b981;
        box-shadow: 0 0 8px #10b981;
        transition: all 0.2s ease;
      }
      .status-dot.speech {
        background: #38ef7d;
        box-shadow: 0 0 10px #38ef7d;
        animation: pulse-ring 0.8s infinite alternate;
      }
      .status-dot.busy {
        background: #fbbf24;
        box-shadow: 0 0 10px #fbbf24;
        animation: pulse-ring 0.6s infinite alternate;
      }
      .status-dot.off {
        background: #ef4444;
        box-shadow: 0 0 6px #ef4444;
      }
      @keyframes pulse-ring {
        0% { transform: scale(0.85); opacity: 0.7; }
        100% { transform: scale(1.25); opacity: 1; }
      }

      /* Action Buttons */
      .btn {
        all: unset;
        cursor: pointer;
        padding: 4px 8px;
        border-radius: 6px;
        background: rgba(255, 255, 255, 0.08);
        color: #e2e8f0;
        font-size: 11px;
        font-weight: 600;
        line-height: 1;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 4px;
        transition: background 0.15s ease, transform 0.1s ease, color 0.15s ease;
      }
      .btn:hover {
        background: rgba(255, 255, 255, 0.18);
        color: #ffffff;
      }
      .btn:active {
        transform: scale(0.96);
      }

      /* Dedicated Disable / Enable Button */
      .btn-power {
        font-weight: 700;
        padding: 4px 10px;
        border-radius: 6px;
      }
      .btn-power.enabled {
        background: rgba(239, 68, 68, 0.18);
        color: #f87171;
        border: 1px solid rgba(239, 68, 68, 0.35);
      }
      .btn-power.enabled:hover {
        background: rgba(239, 68, 68, 0.32);
        color: #ffffff;
      }
      .btn-power.disabled {
        background: rgba(16, 185, 129, 0.2);
        color: #34d399;
        border: 1px solid rgba(16, 185, 129, 0.4);
      }
      .btn-power.disabled:hover {
        background: rgba(16, 185, 129, 0.35);
        color: #ffffff;
      }

      .btn.active {
        background: #4f46e5;
        color: #ffffff;
        box-shadow: 0 2px 6px rgba(79, 70, 229, 0.35);
      }

      .latency-badge {
        font-size: 10px;
        font-weight: 600;
        color: #94a3b8;
        min-width: 38px;
        text-align: right;
      }
      .btn-icon {
        padding: 3px 6px;
        font-size: 11px;
        color: #94a3b8;
      }
      .btn-icon:hover {
        color: #ffffff;
      }
    `;
    const panel = document.createElement("div");
    panel.className = "panel-card";
    const badge = document.createElement("div");
    badge.className = "brand-badge";
    badge.textContent = "RU\u2794EN";
    badge.title = "RuTranscribe WebGPU HUD (Drag to reposition)";
    const statusPill = document.createElement("div");
    statusPill.className = "status-pill collapsible-item";
    const statusDot = document.createElement("span");
    statusDot.className = "status-dot";
    const statusLabel = document.createElement("span");
    statusLabel.textContent = this.currentStatusText;
    statusPill.appendChild(statusDot);
    statusPill.appendChild(statusLabel);
    const powerBtn = document.createElement("button");
    powerBtn.className = "btn btn-power";
    powerBtn.title = "Click to Disable or Enable live captions";
    powerBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      const nextEnabled = !this.settings.enabled;
      webExt.runtime.sendMessage({
        type: MESSAGE_TYPES.TOGGLE_EXTENSION,
        enabled: nextEnabled
      });
    });
    const dualBtn = this.createButton("RU+EN", "Toggle Dual Subtitles (Russian transcription + English translation)", () => {
      this.pushSettings({ showDualSubtitles: !this.settings.showDualSubtitles });
    });
    dualBtn.className = "btn collapsible-item";
    const smallerBtn = this.createButton("A\u2212", "Decrease subtitle font size", () => this.stepFontSize(-1));
    smallerBtn.className = "btn collapsible-item";
    const largerBtn = this.createButton("A+", "Increase subtitle font size", () => this.stepFontSize(1));
    largerBtn.className = "btn collapsible-item";
    const latencyEl = document.createElement("span");
    latencyEl.className = "latency-badge collapsible-item";
    latencyEl.title = "Whisper WebGPU inference latency";
    const collapseBtn = document.createElement("button");
    collapseBtn.className = "btn btn-icon";
    collapseBtn.textContent = "\u2014";
    collapseBtn.title = "Minimize HUD";
    collapseBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      this.toggleCollapse();
    });
    const closeBtn = document.createElement("button");
    closeBtn.className = "btn btn-icon";
    closeBtn.textContent = "\u2715";
    closeBtn.title = "Unpin HUD from page";
    closeBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      this.pushSettings({ pinned: false });
    });
    panel.append(
      badge,
      statusPill,
      powerBtn,
      dualBtn,
      smallerBtn,
      largerBtn,
      latencyEl,
      collapseBtn,
      closeBtn
    );
    root.append(style, panel);
    panel.addEventListener("click", (e) => e.stopPropagation());
    this.els = {
      panel,
      statusDot,
      statusLabel,
      powerBtn,
      dualBtn,
      smallerBtn,
      largerBtn,
      latencyEl,
      collapseBtn
    };
    this.setupDragHandler(panel);
    (document.fullscreenElement || document.documentElement).appendChild(this.host);
    this.render();
  }
  createButton(label, title, onClick) {
    const btn = document.createElement("button");
    btn.className = "btn";
    btn.textContent = label;
    btn.title = title;
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      onClick();
    });
    return btn;
  }
  setupDragHandler(panel) {
    panel.addEventListener("mousedown", (e) => {
      if (e.target.tagName === "BUTTON") return;
      this.isDragging = true;
      const rect = this.host.getBoundingClientRect();
      this.dragStartX = e.clientX - rect.left;
      this.dragStartY = e.clientY - rect.top;
      this.host.style.transition = "none";
      e.preventDefault();
    });
    window.addEventListener("mousemove", (e) => {
      if (!this.isDragging || !this.host) return;
      let newX = e.clientX - this.dragStartX;
      let newY = e.clientY - this.dragStartY;
      const maxX = window.innerWidth - this.host.offsetWidth - 8;
      const maxY = window.innerHeight - this.host.offsetHeight - 8;
      newX = Math.max(8, Math.min(maxX, newX));
      newY = Math.max(8, Math.min(maxY, newY));
      this.host.style.left = `${newX}px`;
      this.host.style.top = `${newY}px`;
      this.host.style.right = "auto";
    });
    window.addEventListener("mouseup", () => {
      if (this.isDragging) {
        this.isDragging = false;
        if (this.host) this.host.style.transition = "opacity 0.2s ease, transform 0.15s ease";
      }
    });
  }
  toggleCollapse() {
    this.isCollapsed = !this.isCollapsed;
    if (this.els.panel) {
      this.els.panel.classList.toggle("collapsed", this.isCollapsed);
    }
    if (this.els.collapseBtn) {
      this.els.collapseBtn.textContent = this.isCollapsed ? "\u25FB" : "\u2014";
      this.els.collapseBtn.title = this.isCollapsed ? "Expand HUD" : "Minimize HUD";
    }
  }
  stepFontSize(delta) {
    const i = SIZE_ORDER.indexOf(this.settings.fontSize || "medium");
    const next = SIZE_ORDER[Math.max(0, Math.min(SIZE_ORDER.length - 1, i + delta))];
    this.pushSettings({ fontSize: next });
  }
  pushSettings(partial) {
    webExt.runtime.sendMessage({
      type: MESSAGE_TYPES.UPDATE_SETTINGS,
      settings: { ...this.settings, ...partial }
    });
  }
  update(settings) {
    this.settings = { ...this.settings, ...settings };
    this.render();
  }
  setStatus(text, type = "ready") {
    this.currentStatusText = text;
    this.currentStatusType = type;
    if (!this.els.statusLabel || !this.els.statusDot) return;
    this.els.statusLabel.textContent = text;
    this.els.statusDot.className = `status-dot ${type}`;
  }
  setLatency(ms) {
    this.lastLatency = ms;
    if (this.els.latencyEl) {
      this.els.latencyEl.textContent = ms != null ? `\u26A1 ${ms}ms` : "";
    }
  }
  render() {
    if (!this.els.powerBtn) return;
    const isEnabled = !!this.settings.enabled;
    if (isEnabled) {
      this.els.powerBtn.textContent = "\u23F8 Disable";
      this.els.powerBtn.className = "btn btn-power enabled";
      this.els.powerBtn.title = "Click to Disable live captions";
      if (this.currentStatusType === "off") {
        this.setStatus("Listening (Ready)", "ready");
      }
    } else {
      this.els.powerBtn.textContent = "\u25B6 Enable";
      this.els.powerBtn.className = "btn btn-power disabled";
      this.els.powerBtn.title = "Click to Enable live captions";
      this.setStatus("Disabled", "off");
    }
    if (this.els.dualBtn) {
      this.els.dualBtn.classList.toggle("active", !!this.settings.showDualSubtitles);
    }
    if (this.els.smallerBtn) {
      this.els.smallerBtn.title = `Current size: ${FONT_SIZES[this.settings.fontSize] || "20px"}`;
    }
    this.setStatus(this.currentStatusText, this.currentStatusType);
    this.setLatency(this.lastLatency);
  }
  reparent() {
    if (!this.host) return;
    const target = document.fullscreenElement || document.documentElement;
    if (this.host.parentNode !== target) target.appendChild(this.host);
  }
  unmount() {
    if (this.host) this.host.remove();
    this.host = null;
    this.els = {};
  }
}
