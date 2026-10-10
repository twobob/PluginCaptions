import { detectWebGPUSupport } from "../utils/webgpu-detector.js";
import { MESSAGE_TYPES, DEFAULT_SETTINGS } from "../utils/constants.js";
const webExt = typeof browser !== "undefined" ? browser : chrome;
const masterToggle = document.getElementById("masterToggle");
const statusPill = document.getElementById("statusPill");
const statusText = document.getElementById("statusText");
const gpuBadge = document.getElementById("gpuBadge");
const gpuDeviceName = document.getElementById("gpuDeviceName");
const backendType = document.getElementById("backendType");
const firefoxHelp = document.getElementById("firefoxHelp");
const fontSizeSelect = document.getElementById("fontSizeSelect");
const themeSelect = document.getElementById("themeSelect");
const dualSubtitlesToggle = document.getElementById("dualSubtitlesToggle");
const openStudioBtn = document.getElementById("openStudioBtn");
let currentSettings = { ...DEFAULT_SETTINGS };
async function initPopup() {
  const gpuCheck = await detectWebGPUSupport();
  updateGPUStatus(gpuCheck);
  try {
    const response = await webExt.runtime.sendMessage({ type: MESSAGE_TYPES.GET_ENGINE_STATUS });
    if (response) {
      if (response.settings) {
        currentSettings = { ...DEFAULT_SETTINGS, ...response.settings };
        applySettingsToUI(currentSettings);
      }
      if (response.status) {
        updateEngineStatusUI(response.status);
      }
    }
  } catch (err) {
    console.warn("[Popup] Background engine not ready:", err);
    statusPill.className = "status-pill checking";
    statusText.textContent = "Connecting...";
  }
  setupEventListeners();
  webExt.runtime.onMessage.addListener((message) => {
    if (message && message.type === MESSAGE_TYPES.ENGINE_STATUS_UPDATED && message.status) {
      updateEngineStatusUI(message.status);
    }
  });
}
function updateGPUStatus(gpuCheck) {
  if (gpuCheck.supported) {
    gpuBadge.textContent = "Hardware Active";
    gpuBadge.className = "gpu-badge active";
    const info = gpuCheck.gpuInfo || {};
    gpuDeviceName.textContent = info.description || info.vendor || "WebGPU Adapter Ready";
    backendType.textContent = "WebGPU (Direct Shaders)";
    firefoxHelp.classList.add("hidden");
  } else {
    gpuBadge.textContent = "Fallback: WASM";
    gpuBadge.className = "gpu-badge warning";
    gpuDeviceName.textContent = gpuCheck.error || "No WebGPU Device";
    backendType.textContent = "CPU (WASM SIMD)";
    if (gpuCheck.isFirefox) {
      firefoxHelp.classList.remove("hidden");
    }
  }
}
function updateEngineStatusUI(status) {
  if (status.isReady) {
    statusPill.className = "status-pill ready";
    statusText.textContent = `Ready (${(status.device || "WebGPU").toUpperCase()})`;
  } else if (status.isInitializing) {
    statusPill.className = "status-pill checking";
    statusText.textContent = status.progress ? `Loading ${status.progress}%` : "Loading Model...";
  } else {
    statusPill.className = "status-pill checking";
    statusText.textContent = "Standby";
  }
  if (status.gpuInfo) {
    gpuDeviceName.textContent = status.gpuInfo.description || status.gpuInfo.vendor || "Hardware Accelerated";
  }
}
function applySettingsToUI(settings) {
  masterToggle.checked = !!settings.enabled;
  fontSizeSelect.value = settings.fontSize || "medium";
  themeSelect.value = settings.theme || "dark-glass";
  dualSubtitlesToggle.checked = !!settings.showDualSubtitles;
}
function setupEventListeners() {
  masterToggle.addEventListener("change", () => {
    currentSettings.enabled = masterToggle.checked;
    webExt.runtime.sendMessage({
      type: MESSAGE_TYPES.TOGGLE_EXTENSION,
      enabled: currentSettings.enabled
    });
  });
  fontSizeSelect.addEventListener("change", () => {
    currentSettings.fontSize = fontSizeSelect.value;
    saveAndBroadcastSettings();
  });
  themeSelect.addEventListener("change", () => {
    currentSettings.theme = themeSelect.value;
    saveAndBroadcastSettings();
  });
  dualSubtitlesToggle.addEventListener("change", () => {
    currentSettings.showDualSubtitles = dualSubtitlesToggle.checked;
    saveAndBroadcastSettings();
  });
  openStudioBtn.addEventListener("click", () => {
    webExt.runtime.sendMessage({ type: MESSAGE_TYPES.OPEN_DASHBOARD });
    window.close();
  });
  const pinBtn = document.getElementById("pinBtn");
  pinBtn.textContent = currentSettings.pinned ? "\u{1F4CC} Unpin Mini Panel" : "\u{1F4CC} Pin Mini Panel to Page (stays open)";
  pinBtn.addEventListener("click", async () => {
    currentSettings.pinned = !currentSettings.pinned;
    await webExt.runtime.sendMessage({ type: MESSAGE_TYPES.UPDATE_SETTINGS, settings: currentSettings });
    window.close();
  });
}
function saveAndBroadcastSettings() {
  webExt.runtime.sendMessage({
    type: MESSAGE_TYPES.UPDATE_SETTINGS,
    settings: currentSettings
  });
}
document.addEventListener("DOMContentLoaded", initPopup);
