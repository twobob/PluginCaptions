import { AudioProcessor } from "./audio-processor.js";
import { CaptionUI } from "./caption-ui.js";
import { PinnedPanel } from "./pinned-panel.js";
import { MESSAGE_TYPES, DEFAULT_SETTINGS, sanitizeSettings } from "../utils/constants.js";
const webExt = typeof browser !== "undefined" ? browser : chrome;
const IS_TOP_FRAME = window.top === window;
const STATUS_READY = "Listening (Ready)";
const RETRY_ATTACH_INTERVAL_MS = 2e3;
const MEDIA_EVENTS = ["play", "playing", "pause", "ended", "emptied", "volumechange", "timeupdate"];
let captionUI = null;
let audioProcessor = null;
let pinnedPanel = null;
let isEnabled = true;
let isShutDown = false;
// True once any frame of this tab has captured media. The pinned panel and the
// caption overlay are only added to pages that actually use them.
let mediaActive = false;
let mediaActiveReported = false;
let lastRetryAt = 0;
let currentSettings = { ...DEFAULT_SETTINGS };
function isMediaElement(node) {
  return !!node && (node.nodeName === "VIDEO" || node.nodeName === "AUDIO");
}
function isContextInvalidated(err) {
  try {
    if (!webExt.runtime || !webExt.runtime.id) return true;
  } catch (e) {
    return true;
  }
  return /context invalidated/i.test(String(err && err.message));
}
function onSendError(err) {
  if (isContextInvalidated(err)) shutDown();
}
async function initContent() {
  try {
    const response = await webExt.runtime.sendMessage({ type: MESSAGE_TYPES.GET_ENGINE_STATUS });
    if (response && response.settings) {
      currentSettings = { ...DEFAULT_SETTINGS, ...sanitizeSettings(response.settings) };
      isEnabled = currentSettings.enabled;
    }
  } catch (e) {
    console.warn("[Content] Background script not yet reachable, using defaults");
  }
  audioProcessor = new AudioProcessor({ onAudio: sendAudio, onStop: sendStreamEnd });
  document.addEventListener("fullscreenchange", onFullscreenChange);
  // Media events do not bubble, but they can be caught on the way down. One
  // set of capturing listeners covers every media element in the document,
  // including ones added later, with no need to watch the DOM for changes.
  for (const type of MEDIA_EVENTS) {
    document.addEventListener(type, onMediaEvent, true);
  }
  webExt.runtime.onMessage.addListener(onRuntimeMessage);
  scanForPlayingMedia();
}
function onFullscreenChange() {
  if (pinnedPanel) pinnedPanel.reparent();
}
function ensureCaptionUI() {
  if (!captionUI) captionUI = new CaptionUI({ settings: currentSettings });
  return captionUI;
}
function syncPinnedPanel() {
  if (!IS_TOP_FRAME || isShutDown) return;
  if (currentSettings.pinned && mediaActive) {
    if (!pinnedPanel) {
      pinnedPanel = new PinnedPanel(currentSettings);
      pinnedPanel.mount();
      pinnedPanel.setStatus(isEnabled ? STATUS_READY : "Disabled", isEnabled ? "ready" : "off");
    } else {
      pinnedPanel.update(currentSettings);
    }
  } else if (pinnedPanel) {
    pinnedPanel.unmount();
    pinnedPanel = null;
  }
}
function markMediaActive() {
  mediaActive = true;
  syncPinnedPanel();
  if (mediaActiveReported) return;
  mediaActiveReported = true;
  // Lets the background start loading the model, and tells the top frame
  // about media that lives inside an embedded frame.
  webExt.runtime.sendMessage({ type: MESSAGE_TYPES.MEDIA_ACTIVE }).catch((err) => {
    mediaActiveReported = false;
    onSendError(err);
  });
}
// The page's audio goes to the background page as a continuous stream. The
// background finds the speech in it and sends captions back as messages.
function sendAudio(samples) {
  if (!isEnabled || isShutDown) return;
  webExt.runtime.sendMessage({
    type: MESSAGE_TYPES.STREAM_AUDIO,
    audio: Array.from(samples)
  }).catch(onSendError);
}
function sendStreamEnd() {
  if (isShutDown) return;
  webExt.runtime.sendMessage({ type: MESSAGE_TYPES.STREAM_AUDIO, end: true }).catch(onSendError);
}
async function tryAttach(element) {
  if (!isEnabled || isShutDown || !audioProcessor) return;
  if (element.paused || element.ended || element.muted) return;
  const attached = await audioProcessor.attachToMediaElement(element);
  if (attached) markMediaActive();
}
function onMediaEvent(event) {
  const element = event.target;
  if (!isMediaElement(element) || isShutDown || !audioProcessor) return;
  const isActive = audioProcessor.connectedElement === element;
  switch (event.type) {
    case "play":
    case "playing":
      tryAttach(element);
      break;
    case "pause":
    case "ended":
    case "emptied":
      if (isActive) audioProcessor.flushAndStop();
      break;
    case "volumechange":
      if (element.muted || element.volume === 0) {
        if (isActive) audioProcessor.flushAndStop();
      } else if (!isActive) {
        tryAttach(element);
      }
      break;
    case "timeupdate": {
      // Self-healing: if nothing is being captured while media plays (an
      // earlier attempt was refused, or metadata had not loaded), try again.
      if (audioProcessor.connectedElement) break;
      const now = Date.now();
      if (now - lastRetryAt < RETRY_ATTACH_INTERVAL_MS) break;
      lastRetryAt = now;
      tryAttach(element);
      break;
    }
  }
}
function scanForPlayingMedia() {
  if (!isEnabled || isShutDown) return;
  for (const element of document.querySelectorAll("video, audio")) {
    if (!element.paused && !element.ended && !element.muted) {
      tryAttach(element);
      break;
    }
  }
}
function applyEnabled(enabled) {
  isEnabled = enabled;
  currentSettings.enabled = enabled;
  if (!isEnabled) {
    audioProcessor.stopAnalysis();
    if (captionUI) captionUI.hide();
    if (pinnedPanel) {
      pinnedPanel.update(currentSettings);
      pinnedPanel.setStatus("Disabled", "off");
    }
  } else {
    scanForPlayingMedia();
    if (pinnedPanel) {
      pinnedPanel.update(currentSettings);
      pinnedPanel.setStatus(STATUS_READY, "ready");
    }
  }
}
function applyStreamState(message) {
  if (!pinnedPanel || !isEnabled) return;
  if (typeof message.latencyMs === "number") pinnedPanel.setLatency(message.latencyMs);
  if (message.state === "speech") pinnedPanel.setStatus("Voice detected...", "speech");
  else if (message.state === "busy") pinnedPanel.setStatus("Translating...", "busy");
  else pinnedPanel.setStatus(STATUS_READY, "ready");
}
function onRuntimeMessage(message) {
  if (!message || !message.type || isShutDown) return;
  switch (message.type) {
    case MESSAGE_TYPES.SUBTITLE_GENERATED:
      if (isEnabled && message.subtitle && message.subtitle.text) {
        ensureCaptionUI().showSubtitle(message.subtitle.text, message.subtitle.russianText);
      }
      break;
    case MESSAGE_TYPES.STREAM_STATE:
      applyStreamState(message);
      break;
    case MESSAGE_TYPES.MEDIA_ACTIVE:
      if (IS_TOP_FRAME) {
        mediaActive = true;
        syncPinnedPanel();
      }
      break;
    case MESSAGE_TYPES.TOGGLE_EXTENSION:
      applyEnabled(typeof message.enabled === "boolean" ? message.enabled : !isEnabled);
      syncPinnedPanel();
      break;
    case MESSAGE_TYPES.UPDATE_SETTINGS: {
      const wasEnabled = isEnabled;
      currentSettings = { ...currentSettings, ...sanitizeSettings(message.settings) };
      if (captionUI) captionUI.applySettings(currentSettings);
      if (currentSettings.enabled !== wasEnabled) applyEnabled(currentSettings.enabled);
      syncPinnedPanel();
      break;
    }
  }
}
/**
 * Runs when the extension was updated, reloaded or removed while this page
 * stayed open. The old script can no longer reach the background, so it stops
 * listening and removes its UI. Captured media keeps playing.
 */
function shutDown() {
  if (isShutDown) return;
  isShutDown = true;
  for (const type of MEDIA_EVENTS) {
    document.removeEventListener(type, onMediaEvent, true);
  }
  document.removeEventListener("fullscreenchange", onFullscreenChange);
  try {
    webExt.runtime.onMessage.removeListener(onRuntimeMessage);
  } catch (e) {
  }
  if (audioProcessor) audioProcessor.stopAnalysis();
  if (captionUI) {
    captionUI.destroy();
    captionUI = null;
  }
  if (pinnedPanel) {
    pinnedPanel.unmount();
    pinnedPanel = null;
  }
}
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initContent);
} else {
  initContent();
}
