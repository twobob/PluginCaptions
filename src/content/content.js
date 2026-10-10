import { AudioProcessor } from "./audio-processor.js";
import { CaptionUI } from "./caption-ui.js";
import { PinnedPanel } from "./pinned-panel.js";
import { MESSAGE_TYPES, DEFAULT_SETTINGS } from "../utils/constants.js";
const webExt = typeof browser !== "undefined" ? browser : chrome;
const IS_TOP_FRAME = window.top === window;
let captionUI = null;
let audioProcessor = null;
let pinnedPanel = null;
let isEnabled = true;
let currentSettings = { ...DEFAULT_SETTINGS };
async function initContent() {
  try {
    const response = await webExt.runtime.sendMessage({ type: MESSAGE_TYPES.GET_ENGINE_STATUS });
    if (response && response.settings) {
      currentSettings = { ...DEFAULT_SETTINGS, ...response.settings };
      isEnabled = currentSettings.enabled;
    }
  } catch (e) {
    console.warn("[Content] Background script not yet reachable, using defaults");
  }
  captionUI = new CaptionUI({ settings: currentSettings });
  audioProcessor = new AudioProcessor({
    vadSensitivity: currentSettings.vadSensitivity,
    maxChunkSeconds: currentSettings.maxChunkSeconds,
    silenceThresholdMs: currentSettings.silenceThresholdMs,
    onAudioChunkReady: handleAudioChunk,
    onStateChange: (state) => {
      if (!isEnabled || !pinnedPanel) return;
      if (state === "speech") {
        pinnedPanel.setStatus("\u{1F399}\uFE0F Voice detected...", "speech");
      } else {
        pinnedPanel.setStatus("Listening (Ready)", "ready");
      }
    }
  });
  syncPinnedPanel();
  document.addEventListener("fullscreenchange", () => pinnedPanel && pinnedPanel.reparent());
  scanAndHookMediaElements();
  setupMediaObserver();
  setupMessageListener();
  console.log("[Content] RuTranscribe WebGPU Content Script active.");
}
function syncPinnedPanel() {
  if (!IS_TOP_FRAME) return;
  if (currentSettings.pinned) {
    if (!pinnedPanel) {
      pinnedPanel = new PinnedPanel(currentSettings);
      pinnedPanel.mount();
    } else {
      pinnedPanel.update(currentSettings);
    }
  } else if (pinnedPanel) {
    pinnedPanel.unmount();
    pinnedPanel = null;
  }
}
async function handleAudioChunk(float32Chunk) {
  if (!isEnabled) return;
  try {
    if (pinnedPanel) pinnedPanel.setStatus("\u26A1 Translating (WebGPU)...", "busy");
    const response = await webExt.runtime.sendMessage({
      type: MESSAGE_TYPES.PROCESS_AUDIO_CHUNK,
      audio: Array.from(float32Chunk)
    });
    if (response && response.success && response.result) {
      if (pinnedPanel) {
        pinnedPanel.setLatency(response.result.latencyMs);
        pinnedPanel.setStatus("Listening (Ready)", "ready");
      }
      if (response.result.text) {
        captionUI.showSubtitle(response.result.text, response.result.russianText);
      }
    } else if (pinnedPanel) {
      pinnedPanel.setStatus("Listening (Ready)", "ready");
    }
  } catch (err) {
    console.warn("[Content] Error sending audio chunk to background:", err);
    if (pinnedPanel) pinnedPanel.setStatus("Listening (Ready)", "ready");
  }
}
function scanAndHookMediaElements() {
  const mediaElements = document.querySelectorAll("video, audio");
  mediaElements.forEach(hookMediaElement);
}
function attachIfPlaying(element) {
  if (isEnabled && !element.paused && !element.ended) {
    audioProcessor.attachToMediaElement(element);
  }
}
function hookMediaElement(element) {
  if (!element) return;
  if (element._rutranscribeHooked) {
    attachIfPlaying(element);
    return;
  }
  element._rutranscribeHooked = true;
  const tryHook = () => attachIfPlaying(element);
  element.addEventListener("play", tryHook);
  element.addEventListener("playing", tryHook);
  tryHook();
}
function setupMediaObserver() {
  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node.nodeType === Node.ELEMENT_NODE) {
          if (node.matches && (node.matches("video") || node.matches("audio"))) {
            hookMediaElement(node);
          } else if (node.querySelectorAll) {
            const nested = node.querySelectorAll("video, audio");
            nested.forEach(hookMediaElement);
          }
        }
      }
    }
  });
  observer.observe(document.documentElement || document.body, {
    childList: true,
    subtree: true
  });
}
function applyEnabled(enabled) {
  isEnabled = enabled;
  currentSettings.enabled = enabled;
  if (!isEnabled) {
    audioProcessor.detach();
    captionUI.hide();
    if (pinnedPanel) {
      pinnedPanel.update(currentSettings);
      pinnedPanel.setStatus("Disabled", "off");
    }
  } else {
    scanAndHookMediaElements();
    if (pinnedPanel) {
      pinnedPanel.update(currentSettings);
      pinnedPanel.setStatus("Listening (Ready)", "ready");
    }
  }
}
function setupMessageListener() {
  webExt.runtime.onMessage.addListener((message) => {
    if (!message || !message.type) return;
    switch (message.type) {
      case MESSAGE_TYPES.SUBTITLE_GENERATED:
        if (message.subtitle && message.subtitle.text) {
          captionUI.showSubtitle(message.subtitle.text, message.subtitle.russianText);
        }
        break;
      case MESSAGE_TYPES.TOGGLE_EXTENSION:
        applyEnabled(message.enabled ?? !isEnabled);
        syncPinnedPanel();
        break;
      case MESSAGE_TYPES.UPDATE_SETTINGS: {
        const wasEnabled = isEnabled;
        currentSettings = { ...currentSettings, ...message.settings };
        captionUI.applySettings(currentSettings);
        audioProcessor.updateSettings(currentSettings);
        if (currentSettings.enabled !== wasEnabled) applyEnabled(currentSettings.enabled);
        syncPinnedPanel();
        break;
      }
    }
  });
}
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initContent);
} else {
  initContent();
}
