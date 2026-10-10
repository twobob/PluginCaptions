export const DEFAULT_MODEL_ID = "onnx-community/whisper-base";
export const MESSAGE_TYPES = {
  // Status and Init
  CHECK_WEBGPU: "CHECK_WEBGPU",
  GET_ENGINE_STATUS: "GET_ENGINE_STATUS",
  INIT_ENGINE: "INIT_ENGINE",
  ENGINE_STATUS_UPDATED: "ENGINE_STATUS_UPDATED",
  // Audio & Subtitles
  PROCESS_AUDIO_CHUNK: "PROCESS_AUDIO_CHUNK",
  SUBTITLE_GENERATED: "SUBTITLE_GENERATED",
  CLEAR_SUBTITLES: "CLEAR_SUBTITLES",
  // Controls
  TOGGLE_EXTENSION: "TOGGLE_EXTENSION",
  GET_EXTENSION_STATE: "GET_EXTENSION_STATE",
  UPDATE_SETTINGS: "UPDATE_SETTINGS",
  // Tab & Dashboard
  OPEN_DASHBOARD: "OPEN_DASHBOARD",
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
  vadSensitivity: 0.015,
  // Energy threshold for RMS speech detection
  maxChunkSeconds: 3.5,
  // Audio chunk duration
  silenceThresholdMs: 450,
  // Silence duration to trigger chunk processing
  autoHideSeconds: 4.5,
  // Auto-hide captions after speech ends
  preferWebGPU: true,
  pinned: true
  // Pinned HUD active by default with disable button & live status output
};
export const FONT_SIZES = {
  small: "16px",
  medium: "20px",
  large: "26px",
  xlarge: "32px"
};
