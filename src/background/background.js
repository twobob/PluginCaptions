import { whisperEngine } from "./whisper-engine.js";
import { MESSAGE_TYPES, DEFAULT_SETTINGS } from "../utils/constants.js";
const webExt = typeof browser !== "undefined" ? browser : chrome;
let currentSettings = { ...DEFAULT_SETTINGS };
async function loadSettings() {
  try {
    const data = await webExt.storage.local.get("settings");
    if (data && data.settings) {
      currentSettings = { ...DEFAULT_SETTINGS, ...data.settings };
    }
  } catch (err) {
    console.warn("[Background] Failed to load settings from storage:", err);
  }
}
async function saveSettings(newSettings) {
  currentSettings = { ...currentSettings, ...newSettings };
  try {
    await webExt.storage.local.set({ settings: currentSettings });
  } catch (err) {
    console.warn("[Background] Failed to save settings to storage:", err);
  }
}
async function broadcastToTabs(message) {
  try {
    const tabs = await webExt.tabs.query({});
    for (const tab of tabs) {
      if (tab.id) {
        webExt.tabs.sendMessage(tab.id, message).catch(() => {
        });
      }
    }
  } catch (err) {
    console.warn("[Background] Error broadcasting to tabs:", err);
  }
}
whisperEngine.onProgress = (progressData) => {
  webExt.runtime.sendMessage({
    type: MESSAGE_TYPES.ENGINE_STATUS_UPDATED,
    status: whisperEngine.getStatus()
  }).catch(() => {
  });
};
webExt.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || !message.type) return;
  switch (message.type) {
    case MESSAGE_TYPES.PING:
      sendResponse({ pong: true, timestamp: Date.now() });
      break;
    case MESSAGE_TYPES.GET_ENGINE_STATUS:
      sendResponse({
        status: whisperEngine.getStatus(),
        settings: currentSettings
      });
      break;
    case MESSAGE_TYPES.INIT_ENGINE:
      whisperEngine.init(currentSettings.preferWebGPU).then((res) => sendResponse({ success: true, ...res })).catch((err) => sendResponse({ success: false, error: err.message }));
      return true;
    // Keep channel open for async response
    case MESSAGE_TYPES.UPDATE_SETTINGS:
      saveSettings(message.settings).then(() => {
        broadcastToTabs({
          type: MESSAGE_TYPES.UPDATE_SETTINGS,
          settings: currentSettings
        });
        sendResponse({ success: true, settings: currentSettings });
      });
      return true;
    case MESSAGE_TYPES.TOGGLE_EXTENSION:
      currentSettings.enabled = message.enabled ?? !currentSettings.enabled;
      saveSettings(currentSettings).then(() => {
        broadcastToTabs({
          type: MESSAGE_TYPES.TOGGLE_EXTENSION,
          enabled: currentSettings.enabled
        });
        sendResponse({ success: true, enabled: currentSettings.enabled });
      });
      return true;
    case MESSAGE_TYPES.PROCESS_AUDIO_CHUNK:
      if (!currentSettings.enabled) {
        sendResponse({ success: false, error: "Extension is disabled" });
        return;
      }
      const audioArray = message.audio instanceof Float32Array ? message.audio : new Float32Array(message.audio);
      const options = {
        sourceLanguage: currentSettings.sourceLanguage,
        task: currentSettings.task,
        showDualSubtitles: currentSettings.showDualSubtitles,
        preferWebGPU: currentSettings.preferWebGPU
      };
      whisperEngine.queueAudio(audioArray, options).then((result) => {
        sendResponse({ success: true, result });
      }).catch((err) => {
        sendResponse({ success: false, error: err.message });
      });
      return true;
    // Asynchronous response
    case MESSAGE_TYPES.OPEN_DASHBOARD:
      webExt.tabs.create({ url: webExt.runtime.getURL("dashboard.html") });
      sendResponse({ success: true });
      break;
    default:
      console.warn("[Background] Unknown message type:", message.type);
  }
});
loadSettings().then(() => {
  console.log("[Background] RuTranscribe WebGPU Service worker active. Settings:", currentSettings);
  if (currentSettings.enabled) {
    whisperEngine.init(currentSettings.preferWebGPU).catch((err) => {
      console.warn("[Background] Warmup init deferred:", err);
    });
  }
});
