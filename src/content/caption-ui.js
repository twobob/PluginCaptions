import { FONT_SIZES } from "../utils/constants.js";
export class CaptionUI {
  constructor(options = {}) {
    this.settings = options.settings || {};
    this.hostElement = null;
    this.shadowRoot = null;
    this.container = null;
    this.primaryTextEl = null;
    this.secondaryTextEl = null;
    this.statusDotEl = null;
    this.badgeEl = null;
    this.autoHideTimer = null;
    this.isDragging = false;
    this.dragStartX = 0;
    this.dragStartY = 0;
    this.posX = null;
    this.posY = null;
    this.initDOM();
    this.setupFullscreenListener();
  }
  initDOM() {
    let existing = document.getElementById("rutranscribe-root");
    if (existing) existing.remove();
    this.hostElement = document.createElement("div");
    this.hostElement.id = "rutranscribe-root";
    this.hostElement.style.all = "initial";
    this.hostElement.style.position = "fixed";
    this.hostElement.style.zIndex = "2147483647";
    this.hostElement.style.left = "0";
    this.hostElement.style.top = "0";
    this.hostElement.style.width = "100vw";
    this.hostElement.style.height = "100vh";
    this.hostElement.style.pointerEvents = "none";
    this.shadowRoot = this.hostElement.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = `
      :host {
        all: initial;
        pointer-events: none;
      }
      .caption-box {
        position: fixed;
        bottom: 80px;
        left: 50%;
        transform: translateX(-50%);
        max-width: 85vw;
        min-width: 0;
        width: fit-content;
        display: inline-block;
        padding: 6px 14px 7px 14px;
        border-radius: 8px;
        background: rgba(10, 14, 23, 0.88);
        backdrop-filter: blur(10px);
        -webkit-backdrop-filter: blur(10px);
        box-shadow: 0 6px 20px rgba(0, 0, 0, 0.6), 0 0 0 1px rgba(255, 255, 255, 0.1);
        color: #ffffff;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
        text-align: center;
        pointer-events: auto;
        user-select: none;
        cursor: move;
        transition: opacity 0.2s ease, transform 0.1s ease;
        opacity: 0;
        visibility: hidden;
        z-index: 2147483647;
      }
      .caption-box.visible {
        opacity: 1;
        visibility: visible;
      }
      .caption-box.theme-high-contrast-yellow .primary-text {
        color: #ffe600;
        text-shadow: 0 2px 4px rgba(0, 0, 0, 0.9);
      }
      .caption-box.theme-pure-white .primary-text {
        color: #ffffff;
        text-shadow: 0 2px 4px rgba(0, 0, 0, 0.9);
      }
      /* Hover toolbar floats cleanly ABOVE the subtitle box so it never adds empty black space inside */
      .header-bar {
        position: absolute;
        bottom: calc(100% + 6px);
        left: 50%;
        transform: translateX(-50%);
        display: none;
        align-items: center;
        gap: 8px;
        padding: 3px 8px;
        border-radius: 8px;
        background: rgba(10, 14, 23, 0.94);
        border: 1px solid rgba(255, 255, 255, 0.12);
        box-shadow: 0 4px 14px rgba(0, 0, 0, 0.6);
        white-space: nowrap;
        font-size: 11px;
        color: #94a3b8;
        z-index: 2147483647;
      }
      .caption-box:hover .header-bar {
        display: flex;
      }
      .badge {
        display: inline-flex;
        align-items: center;
        gap: 5px;
        background: rgba(99, 102, 241, 0.25);
        color: #818cf8;
        padding: 2px 7px;
        border-radius: 6px;
        font-size: 10px;
        font-weight: 600;
        letter-spacing: 0.5px;
      }
      .status-dot {
        width: 6px;
        height: 6px;
        border-radius: 50%;
        background: #10b981;
        box-shadow: 0 0 8px #10b981;
        transition: background 0.3s ease;
      }
      .status-dot.active {
        background: #38ef7d;
        box-shadow: 0 0 12px #38ef7d;
        animation: pulse 1s infinite alternate;
      }
      @keyframes pulse {
        0% { opacity: 0.6; transform: scale(0.9); }
        100% { opacity: 1; transform: scale(1.15); }
      }
      .controls {
        display: flex;
        gap: 6px;
      }
      .btn-mini {
        background: rgba(255, 255, 255, 0.1);
        border: none;
        color: #cbd5e1;
        padding: 2px 6px;
        border-radius: 4px;
        cursor: pointer;
        font-size: 10px;
        transition: background 0.15s ease, color 0.15s ease;
      }
      .btn-mini:hover {
        background: rgba(255, 255, 255, 0.25);
        color: #ffffff;
      }
      .secondary-text {
        font-size: 13px;
        color: #94a3b8;
        font-style: italic;
        margin: 0 0 2px 0;
        line-height: 1.25;
        display: none;
      }
      .secondary-text.visible {
        display: block;
      }
      .primary-text {
        font-size: 20px;
        font-weight: 600;
        line-height: 1.25;
        margin: 0;
        padding: 0;
        letter-spacing: 0.2px;
        text-shadow: 0 2px 8px rgba(0, 0, 0, 0.9);
        word-wrap: break-word;
      }
    `;
    this.container = document.createElement("div");
    this.container.className = `caption-box theme-${this.settings.theme || "dark-glass"}`;
    const header = document.createElement("div");
    header.className = "header-bar";
    const badgeContainer = document.createElement("div");
    badgeContainer.className = "badge";
    this.statusDotEl = document.createElement("span");
    this.statusDotEl.className = "status-dot";
    this.badgeEl = document.createElement("span");
    this.badgeEl.textContent = "\u26A1 WebGPU RU\u2192EN";
    badgeContainer.appendChild(this.statusDotEl);
    badgeContainer.appendChild(this.badgeEl);
    const controls = document.createElement("div");
    controls.className = "controls";
    const fontSmaller = document.createElement("button");
    fontSmaller.className = "btn-mini";
    fontSmaller.textContent = "A-";
    fontSmaller.title = "Decrease Font Size";
    fontSmaller.onclick = (e) => {
      e.stopPropagation();
      this.cycleFontSize(-1);
    };
    const fontLarger = document.createElement("button");
    fontLarger.className = "btn-mini";
    fontLarger.textContent = "A+";
    fontLarger.title = "Increase Font Size";
    fontLarger.onclick = (e) => {
      e.stopPropagation();
      this.cycleFontSize(1);
    };
    const closeBtn = document.createElement("button");
    closeBtn.className = "btn-mini";
    closeBtn.textContent = "\u2715";
    closeBtn.title = "Hide Subtitles";
    closeBtn.onclick = (e) => {
      e.stopPropagation();
      this.hide();
    };
    controls.appendChild(fontSmaller);
    controls.appendChild(fontLarger);
    controls.appendChild(closeBtn);
    header.appendChild(badgeContainer);
    header.appendChild(controls);
    this.secondaryTextEl = document.createElement("div");
    this.secondaryTextEl.className = "secondary-text";
    this.primaryTextEl = document.createElement("div");
    this.primaryTextEl.className = "primary-text";
    this.container.appendChild(header);
    this.container.appendChild(this.secondaryTextEl);
    this.container.appendChild(this.primaryTextEl);
    this.shadowRoot.appendChild(style);
    this.shadowRoot.appendChild(this.container);
    document.documentElement.appendChild(this.hostElement);
    this.setupDragHandler();
    this.applySettings(this.settings);
  }
  setupDragHandler() {
    this.container.addEventListener("mousedown", (e) => {
      if (e.target.tagName === "BUTTON") return;
      this.isDragging = true;
      const rect = this.container.getBoundingClientRect();
      this.dragStartX = e.clientX - rect.left;
      this.dragStartY = e.clientY - rect.top;
      this.container.style.transition = "none";
      e.preventDefault();
    });
    window.addEventListener("mousemove", (e) => {
      if (!this.isDragging) return;
      let newX = e.clientX - this.dragStartX;
      let newY = e.clientY - this.dragStartY;
      newX = Math.max(10, Math.min(window.innerWidth - this.container.offsetWidth - 10, newX));
      newY = Math.max(10, Math.min(window.innerHeight - this.container.offsetHeight - 10, newY));
      this.posX = newX;
      this.posY = newY;
      this.container.style.left = `${newX}px`;
      this.container.style.top = `${newY}px`;
      this.container.style.bottom = "auto";
      this.container.style.transform = "none";
    });
    window.addEventListener("mouseup", () => {
      if (this.isDragging) {
        this.isDragging = false;
        this.container.style.transition = "opacity 0.25s ease, transform 0.1s ease";
      }
    });
  }
  setupFullscreenListener() {
    const handleFullscreen = () => {
      const fsElement = document.fullscreenElement || document.webkitFullscreenElement || document.mozFullScreenElement;
      if (fsElement && this.hostElement) {
        if (this.hostElement.parentNode !== fsElement) {
          fsElement.appendChild(this.hostElement);
        }
      } else if (this.hostElement && this.hostElement.parentNode !== document.documentElement) {
        document.documentElement.appendChild(this.hostElement);
      }
    };
    document.addEventListener("fullscreenchange", handleFullscreen);
    document.addEventListener("webkitfullscreenchange", handleFullscreen);
    document.addEventListener("mozfullscreenchange", handleFullscreen);
  }
  showSubtitle(englishText, russianText = "") {
    if (!englishText || !englishText.trim()) return;
    this.primaryTextEl.textContent = englishText;
    if (russianText && russianText.trim()) {
      this.secondaryTextEl.textContent = russianText;
      this.secondaryTextEl.classList.add("visible");
    } else {
      this.secondaryTextEl.classList.remove("visible");
    }
    this.container.classList.add("visible");
    this.statusDotEl.classList.add("active");
    setTimeout(() => {
      if (this.statusDotEl) this.statusDotEl.classList.remove("active");
    }, 600);
    if (this.autoHideTimer) clearTimeout(this.autoHideTimer);
    const hideDelay = (this.settings.autoHideSeconds || 4.5) * 1e3;
    this.autoHideTimer = setTimeout(() => {
      this.hide();
    }, hideDelay);
  }
  hide() {
    if (this.container) {
      this.container.classList.remove("visible");
    }
  }
  cycleFontSize(delta) {
    const order = ["small", "medium", "large", "xlarge"];
    let currentIdx = order.indexOf(this.settings.fontSize || "medium");
    let nextIdx = Math.max(0, Math.min(order.length - 1, currentIdx + delta));
    this.settings.fontSize = order[nextIdx];
    this.applySettings(this.settings);
  }
  applySettings(settings) {
    this.settings = { ...this.settings, ...settings };
    if (!this.container) return;
    const size = FONT_SIZES[this.settings.fontSize] || "20px";
    this.primaryTextEl.style.fontSize = size;
    this.container.className = `caption-box theme-${this.settings.theme || "dark-glass"} ${this.container.classList.contains("visible") ? "visible" : ""}`;
    if (this.settings.preferWebGPU) {
      this.badgeEl.textContent = "\u26A1 WebGPU RU\u2192EN";
    } else {
      this.badgeEl.textContent = "\u2699 WASM RU\u2192EN";
    }
  }
  destroy() {
    if (this.autoHideTimer) clearTimeout(this.autoHideTimer);
    if (this.hostElement && this.hostElement.parentNode) {
      this.hostElement.parentNode.removeChild(this.hostElement);
    }
  }
}
