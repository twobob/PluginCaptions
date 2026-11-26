export const DEFAULT_MODEL_ID = "onnx-community/whisper-base";
// Pinned commit of the model repository on huggingface.co. Pinning means every
// install downloads exactly the same weights, and a change upstream cannot
// alter what the extension runs without a new extension release.
export const DEFAULT_MODEL_REVISION = "27a07b4b52b3a4c5886134bb4320e93e1a4bbc7c";
// Speech detector (Silero VAD), also pinned.
export const VAD_MODEL_ID = "onnx-community/silero-vad";
export const VAD_MODEL_REVISION = "e71cae966052b992a7eca6b17738916ce0eca4ec";
export const TARGET_SAMPLE_RATE = 16e3;
// Largest audio batch a page may send in one stream message.
export const MAX_STREAM_BATCH_SAMPLES = TARGET_SAMPLE_RATE * 2;
// Bounds for one audio chunk accepted by the background engine (16 kHz mono).
export const MIN_CHUNK_SAMPLES = TARGET_SAMPLE_RATE * 0.2;
export const MAX_CHUNK_SAMPLES = TARGET_SAMPLE_RATE * 30;
export const MESSAGE_TYPES = {
  // Status and Init
  CHECK_WEBGPU: "CHECK_WEBGPU",
  GET_ENGINE_STATUS: "GET_ENGINE_STATUS",
  INIT_ENGINE: "INIT_ENGINE",
  ENGINE_STATUS_UPDATED: "ENGINE_STATUS_UPDATED",
  GET_ENGINE_DIAGNOSTICS: "GET_ENGINE_DIAGNOSTICS",
  BENCHMARK_ENGINE: "BENCHMARK_ENGINE",
  // Audio & Subtitles
  PROCESS_AUDIO_CHUNK: "PROCESS_AUDIO_CHUNK",
  STREAM_AUDIO: "STREAM_AUDIO",
  STREAM_STATE: "STREAM_STATE",
  SUBTITLE_GENERATED: "SUBTITLE_GENERATED",
  CLEAR_SUBTITLES: "CLEAR_SUBTITLES",
  // Controls
  TOGGLE_EXTENSION: "TOGGLE_EXTENSION",
  GET_EXTENSION_STATE: "GET_EXTENSION_STATE",
  UPDATE_SETTINGS: "UPDATE_SETTINGS",
  // Tab & Dashboard
  OPEN_DASHBOARD: "OPEN_DASHBOARD",
  MEDIA_ACTIVE: "MEDIA_ACTIVE",
  PING: "PING"
};
export const DEFAULT_SETTINGS = {
  enabled: true,
  sourceLanguage: "russian",
  targetLanguage: "english",
  task: "translate",
  // 'translate' (RU->EN) or 'transcribe' (RU->RU)
  showDualSubtitles: false,
  // Show original Russian alongside English translation
  fontSize: "medium",
  // 'small' (16px), 'medium' (20px), 'large' (26px), 'xlarge' (32px)
  theme: "dark-glass",
  // 'dark-glass', 'high-contrast-yellow', 'pure-white'
  chunkTargetSeconds: 5,
  // Once a caption segment is this long it ends at the next gap between words
  chunkMaxSeconds: 8,
  // Hard limit: a segment is split here even mid-sentence
  autoHideSeconds: 4.5,
  // Auto-hide captions after speech ends
  preferWebGPU: true,
  pinned: true
  // Pinned HUD shown on pages that are playing media
};
export const FONT_SIZES = {
  small: "16px",
  medium: "20px",
  large: "26px",
  xlarge: "32px"
};
export const THEMES = ["dark-glass", "high-contrast-yellow", "pure-white"];
const isBool = (v) => typeof v === "boolean";
const oneOf = (list) => (v) => typeof v === "string" && list.includes(v);
const inRange = (min, max) => (v) => typeof v === "number" && Number.isFinite(v) && v >= min && v <= max;
const SETTING_VALIDATORS = {
  enabled: isBool,
  sourceLanguage: (v) => typeof v === "string" && /^[a-z]{2,24}$/.test(v),
  targetLanguage: oneOf(["english"]),
  task: oneOf(["translate", "transcribe"]),
  showDualSubtitles: isBool,
  fontSize: oneOf(Object.keys(FONT_SIZES)),
  theme: oneOf(THEMES),
  chunkTargetSeconds: inRange(2, 15),
  chunkMaxSeconds: inRange(3, 25),
  autoHideSeconds: inRange(1, 60),
  preferWebGPU: isBool,
  pinned: isBool
};
/**
 * Returns a copy of `input` holding only known setting keys with valid values.
 * Anything unknown or out of range is dropped, so the result is always safe to
 * spread over existing settings and to write to storage.
 */
export function sanitizeSettings(input) {
  const clean = {};
  if (!input || typeof input !== "object") return clean;
  for (const key of Object.keys(SETTING_VALIDATORS)) {
    if (Object.prototype.hasOwnProperty.call(input, key) && SETTING_VALIDATORS[key](input[key])) {
      clean[key] = input[key];
    }
  }
  return clean;
}
