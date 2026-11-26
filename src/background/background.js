import { whisperEngine } from "./whisper-engine.js";
import { SpeechDetector } from "./speech-detector.js";
import { StreamManager } from "./stream-manager.js";
import {
  MESSAGE_TYPES,
  DEFAULT_SETTINGS,
  MIN_CHUNK_SAMPLES,
  MAX_CHUNK_SAMPLES,
  MAX_STREAM_BATCH_SAMPLES,
  sanitizeSettings
} from "../utils/constants.js";
const webExt = typeof browser !== "undefined" ? browser : chrome;
let currentSettings = { ...DEFAULT_SETTINGS };
async function loadSettings() {
  try {
    const data = await webExt.storage.local.get("settings");
    if (data && data.settings) {
      currentSettings = { ...DEFAULT_SETTINGS, ...sanitizeSettings(data.settings) };
    }
  } catch (err) {
    console.warn("[Background] Failed to load settings from storage:", err);
  }
}
// Firefox suspends this page when it is idle and restarts it on the next
// message. Every handler waits for this promise so a freshly woken page never
// answers with default settings in place of the stored ones.
const settingsReady = loadSettings();
async function saveSettings(newSettings) {
  currentSettings = { ...currentSettings, ...sanitizeSettings(newSettings) };
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
      if (tab.id != null) {
        webExt.tabs.sendMessage(tab.id, message).catch(() => {
        });
      }
    }
  } catch (err) {
    console.warn("[Background] Error broadcasting to tabs:", err);
  }
}
function sendToFrame(tabId, frameId, message) {
  webExt.tabs.sendMessage(tabId, message, { frameId }).catch(() => {
  });
}
function engineOptions() {
  return {
    sourceLanguage: currentSettings.sourceLanguage,
    task: currentSettings.task,
    showDualSubtitles: currentSettings.showDualSubtitles,
    preferWebGPU: currentSettings.preferWebGPU,
    chunkTargetSeconds: currentSettings.chunkTargetSeconds,
    chunkMaxSeconds: currentSettings.chunkMaxSeconds
  };
}
const speechDetector = new SpeechDetector();
whisperEngine.detector = speechDetector;
// Captions go back to the frame the audio came from. Status goes to the
// tab's top frame, where the pinned panel lives.
const streamManager = new StreamManager({
  engine: whisperEngine,
  detector: speechDetector,
  getOptions: engineOptions,
  onResult: (source, result) => {
    if (result.text) {
      sendToFrame(source.tabId, source.frameId, { type: MESSAGE_TYPES.SUBTITLE_GENERATED, subtitle: result });
    }
    sendToFrame(source.tabId, 0, { type: MESSAGE_TYPES.STREAM_STATE, state: "ready", latencyMs: result.latencyMs });
  },
  onState: (source, state) => {
    sendToFrame(source.tabId, 0, { type: MESSAGE_TYPES.STREAM_STATE, state });
  }
});
function warmUpEngine() {
  if (!currentSettings.enabled) return;
  whisperEngine.init(currentSettings.preferWebGPU).catch((err) => {
    console.warn("[Background] Engine warm-up failed:", err);
  });
}
function toAudioChunk(audio, minSamples, maxSamples) {
  if (!audio || typeof audio.length !== "number") {
    throw new Error("Audio chunk is missing or malformed");
  }
  if (audio.length < minSamples || audio.length > maxSamples) {
    throw new Error("Audio chunk length is out of range");
  }
  const chunk = audio instanceof Float32Array ? audio : new Float32Array(audio);
  for (let i = 0; i < chunk.length; i++) {
    if (!Number.isFinite(chunk[i])) {
      throw new Error("Audio chunk contains invalid samples");
    }
  }
  return chunk;
}
function isOwnPage(sender) {
  return !!sender && typeof sender.url === "string" && sender.url.startsWith(webExt.runtime.getURL(""));
}
whisperEngine.onProgress = () => {
  webExt.runtime.sendMessage({
    type: MESSAGE_TYPES.ENGINE_STATUS_UPDATED,
    status: whisperEngine.getStatus()
  }).catch(() => {
  });
};
const handlers = {
  [MESSAGE_TYPES.PING]: async () => ({ pong: true, timestamp: Date.now() }),
  [MESSAGE_TYPES.GET_ENGINE_STATUS]: async () => ({
    status: whisperEngine.getStatus(),
    settings: currentSettings
  }),
  // Recent transcripts are only handed to the extension's own pages, never
  // to a content script running inside a website.
  [MESSAGE_TYPES.GET_ENGINE_DIAGNOSTICS]: async (message, sender) => {
    if (!isOwnPage(sender)) return { success: false, error: "Not available to content scripts" };
    return { success: true, ...whisperEngine.getDiagnostics(), streams: streamManager.getStats() };
  },
  [MESSAGE_TYPES.BENCHMARK_ENGINE]: async (message, sender) => {
    if (!isOwnPage(sender)) return { success: false, error: "Not available to content scripts" };
    return { success: true, benchmark: await whisperEngine.benchmark() };
  },
  [MESSAGE_TYPES.INIT_ENGINE]: async () => {
    const res = await whisperEngine.init(currentSettings.preferWebGPU);
    return { ...res, success: true };
  },
  [MESSAGE_TYPES.UPDATE_SETTINGS]: async (message) => {
    await saveSettings(message.settings);
    if (!currentSettings.enabled) streamManager.endAll();
    streamManager.updateOptions();
    broadcastToTabs({
      type: MESSAGE_TYPES.UPDATE_SETTINGS,
      settings: currentSettings
    });
    return { success: true, settings: currentSettings };
  },
  [MESSAGE_TYPES.TOGGLE_EXTENSION]: async (message) => {
    const enabled = typeof message.enabled === "boolean" ? message.enabled : !currentSettings.enabled;
    await saveSettings({ enabled });
    if (!enabled) streamManager.endAll();
    broadcastToTabs({
      type: MESSAGE_TYPES.TOGGLE_EXTENSION,
      enabled: currentSettings.enabled
    });
    return { success: true, enabled: currentSettings.enabled };
  },
  // Continuous audio from a page. The answer is immediate; captions are sent
  // back later as SUBTITLE_GENERATED messages.
  [MESSAGE_TYPES.STREAM_AUDIO]: async (message, sender) => {
    if (!currentSettings.enabled) return { success: false, error: "Extension is disabled" };
    if (!sender || !sender.tab || sender.tab.id == null) return { success: false, error: "Streams must come from a tab" };
    const source = { tabId: sender.tab.id, frameId: sender.frameId || 0 };
    const audio = message.audio ? toAudioChunk(message.audio, 1, MAX_STREAM_BATCH_SAMPLES) : null;
    streamManager.handleAudio(`${source.tabId}:${source.frameId}`, source, audio, message.end === true);
    warmUpEngine();
    return { success: true };
  },
  // One pre-cut chunk, answered with its transcription (Studio page).
  [MESSAGE_TYPES.PROCESS_AUDIO_CHUNK]: async (message) => {
    if (!currentSettings.enabled) {
      return { success: false, error: "Extension is disabled" };
    }
    const audioArray = toAudioChunk(message.audio, MIN_CHUNK_SAMPLES, MAX_CHUNK_SAMPLES);
    const result = await whisperEngine.queueAudio(audioArray, engineOptions());
    return { success: true, result };
  },
  // A frame reports that it started capturing media. Start loading the model
  // now, and tell the tab's top frame so it can show the pinned panel.
  [MESSAGE_TYPES.MEDIA_ACTIVE]: async (message, sender) => {
    warmUpEngine();
    if (sender && sender.tab && sender.tab.id != null && sender.frameId) {
      sendToFrame(sender.tab.id, 0, { type: MESSAGE_TYPES.MEDIA_ACTIVE });
    }
    return { success: true };
  },
  [MESSAGE_TYPES.OPEN_DASHBOARD]: async () => {
    await webExt.tabs.create({ url: webExt.runtime.getURL("dashboard.html") });
    return { success: true };
  }
};
webExt.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message.type !== "string") return false;
  if (!Object.prototype.hasOwnProperty.call(handlers, message.type)) return false;
  const handler = handlers[message.type];
  settingsReady.then(() => handler(message, sender)).then(sendResponse, (err) => {
    sendResponse({ success: false, error: err && err.message ? err.message : String(err) });
  });
  return true;
});
