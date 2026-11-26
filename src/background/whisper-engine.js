import { pipeline, env } from "@huggingface/transformers";
import { detectWebGPUSupport } from "../utils/webgpu-detector.js";
import { DEFAULT_MODEL_ID, DEFAULT_MODEL_REVISION } from "../utils/constants.js";
// After a failed load (for example while offline) wait this long before trying
// again, so a stream of audio chunks does not hammer the model host.
const INIT_RETRY_COOLDOWN_MS = 15e3;
// This many inference errors in a row means the pipeline is broken (typically a
// lost GPU device). It is then discarded and rebuilt on the next chunk.
const MAX_CONSECUTIVE_FAILURES = 3;
const MAX_QUEUED_CHUNKS = 3;
const PROGRESS_NOTIFY_INTERVAL_MS = 250;
const RECENT_RESULTS_KEPT = 60;
// A chunk needs at least this much detected speech to be transcribed.
const MIN_SPEECH_SECONDS = 0.3;
// The same caption again within this window is treated as a hallucination
// loop (typical when the model is fed music) and not shown twice.
const REPEAT_WINDOW_MS = 2e4;
// In Firefox, decoding on WebGPU costs hundreds of milliseconds per token.
// Running the large encoder on the GPU and the small decoder on the CPU is
// about four times faster end to end (measured with scripts/firefox-try.mjs).
const HYBRID_DEVICE = { encoder_model: "webgpu", decoder_model_merged: "wasm" };
const HYBRID_DTYPE = { encoder_model: "fp32", decoder_model_merged: "fp32" };
export class WhisperEngine {
  constructor() {
    this.modelId = DEFAULT_MODEL_ID;
    this.modelRevision = DEFAULT_MODEL_REVISION;
    this.pipelineInstance = null;
    this.initPromise = null;
    this.isInitializing = false;
    this.isReady = false;
    this.device = "unknown";
    this.gpuInfo = null;
    this.loadingProgress = 0;
    this.loadingStatus = "Uninitialized";
    this.lastInitError = null;
    this.lastInitFailureAt = 0;
    this.webgpuDisabled = false;
    this.consecutiveFailures = 0;
    this.lastProgressNotifyAt = 0;
    this.processingQueue = [];
    this.isProcessing = false;
    // In-memory diagnostics for the Studio page and the test tools. Nothing
    // here is written to disk or sent anywhere.
    this.stats = { processed: 0, failed: 0, dropped: 0, filtered: 0, noSpeech: 0, audioSeconds: 0, latencyMs: 0 };
    // Optional SpeechDetector, set by the background script.
    this.detector = null;
    this.lastCaption = { text: "", at: 0 };
    this.recent = [];
    this.lastAudio = null;
    this.override = null;
    this.onProgress = null;
    this.onSubtitle = null;
    this.setupEnvironment();
  }
  setupEnvironment() {
    env.allowLocalModels = false;
    env.useBrowserCache = true;
    // The ONNX Runtime binaries ship inside the extension package. Nothing
    // executable is ever fetched from the network, only model weights.
    const rt = (typeof browser !== "undefined" ? browser : chrome).runtime;
    env.backends.onnx.wasm.wasmPaths = rt.getURL("wasm/");
    env.backends.onnx.wasm.proxy = false;
    env.backends.onnx.wasm.numThreads = 1;
  }
  notifyProgress(force = false) {
    if (!this.onProgress) return;
    const now = Date.now();
    if (!force && now - this.lastProgressNotifyAt < PROGRESS_NOTIFY_INTERVAL_MS) return;
    this.lastProgressNotifyAt = now;
    try {
      this.onProgress({
        status: this.loadingStatus,
        progress: this.loadingProgress,
        device: this.device
      });
    } catch (err) {
      console.warn("[WhisperEngine] Progress listener failed:", err);
    }
  }
  /**
   * Loads the model. Concurrent callers share one load, and every caller sees
   * the same outcome: the ready result, or the error that stopped the load.
   */
  init(preferWebGPU = true) {
    if (this.isReady) {
      return Promise.resolve({ success: true, device: this.device, gpuInfo: this.gpuInfo });
    }
    if (this.initPromise) return this.initPromise;
    if (this.lastInitError && Date.now() - this.lastInitFailureAt < INIT_RETRY_COOLDOWN_MS) {
      return Promise.reject(this.lastInitError);
    }
    this.initPromise = this.load(preferWebGPU).finally(() => {
      this.initPromise = null;
    });
    return this.initPromise;
  }
  async load(preferWebGPU) {
    this.isInitializing = true;
    this.loadingProgress = 0;
    this.loadingStatus = "Checking WebGPU Support...";
    this.notifyProgress(true);
    try {
      const gpuCheck = await detectWebGPUSupport();
      const useWebGPU = preferWebGPU && gpuCheck.supported && !this.webgpuDisabled;
      this.override = await this.readOverride();
      if (this.override) {
        await this.createPipeline("custom", this.override.device, this.override.dtype);
        this.gpuInfo = gpuCheck.gpuInfo;
      } else if (useWebGPU) {
        try {
          await this.createPipeline("webgpu", HYBRID_DEVICE, HYBRID_DTYPE);
          this.gpuInfo = gpuCheck.gpuInfo;
        } catch (err) {
          console.warn("[WhisperEngine] WebGPU pipeline failed, retrying on WASM:", err);
          this.webgpuDisabled = true;
          this.gpuInfo = null;
          await this.createPipeline("wasm", "wasm", "fp32");
        }
      } else {
        if (preferWebGPU && !gpuCheck.supported) {
          console.warn("[WhisperEngine] WebGPU not available, using WASM:", gpuCheck.error || gpuCheck.recommendation);
        }
        this.gpuInfo = null;
        await this.createPipeline("wasm", "wasm", "fp32");
      }
      this.isReady = true;
      this.lastInitError = null;
      this.consecutiveFailures = 0;
      this.loadingProgress = 100;
      this.loadingStatus = `Ready (${this.device.toUpperCase()})`;
      return { success: true, device: this.device, gpuInfo: this.gpuInfo };
    } catch (err) {
      console.error("[WhisperEngine] Initialization error:", err);
      this.isReady = false;
      this.pipelineInstance = null;
      this.lastInitError = err instanceof Error ? err : new Error(String(err));
      this.lastInitFailureAt = Date.now();
      this.loadingStatus = `Error: ${this.lastInitError.message}`;
      throw this.lastInitError;
    } finally {
      this.isInitializing = false;
      this.notifyProgress(true);
    }
  }
  /**
   * Developer knob for tuning: a backend configuration stored under the
   * `engineOverride` key replaces the built-in choice. Only the extension
   * itself can write that key.
   */
  async readOverride() {
    try {
      const api = typeof browser !== "undefined" ? browser : chrome;
      const { engineOverride } = await api.storage.local.get("engineOverride");
      if (engineOverride && engineOverride.device && engineOverride.dtype) return engineOverride;
    } catch (e) {
    }
    return null;
  }
  /** `label` is the backend name shown in the UI: "webgpu", "wasm" or "custom". */
  async createPipeline(label, device, dtype) {
    this.device = label;
    this.deviceDetail = device;
    // The speech detector loads alongside. It is optional: without it the
    // engine still works, it just cannot skip music.
    if (this.detector) this.detector.load();
    this.loadingStatus = `Loading ${this.modelId} on ${label.toUpperCase()}...`;
    this.notifyProgress(true);
    this.pipelineInstance = await pipeline(
      "automatic-speech-recognition",
      this.modelId,
      {
        device,
        dtype,
        revision: this.modelRevision,
        progress_callback: (progressData) => {
          if (progressData.status === "progress") {
            this.loadingProgress = Math.round(progressData.progress || 0);
            this.loadingStatus = `Downloading ${progressData.file || "model"}: ${this.loadingProgress}%`;
          } else if (progressData.status === "done") {
            this.loadingStatus = `Loaded ${progressData.file || "component"}`;
          } else if (progressData.status === "initiate") {
            this.loadingStatus = `Fetching ${progressData.file || "model files"}...`;
          }
          this.notifyProgress();
        }
      }
    );
  }
  /** Drops a broken pipeline so the next chunk rebuilds it from scratch. */
  async reset(disableWebGPU) {
    const broken = this.pipelineInstance;
    this.pipelineInstance = null;
    this.isReady = false;
    this.consecutiveFailures = 0;
    if (disableWebGPU) this.webgpuDisabled = true;
    this.loadingStatus = "Restarting engine...";
    this.notifyProgress(true);
    if (broken && typeof broken.dispose === "function") {
      try {
        await broken.dispose();
      } catch (err) {
        console.warn("[WhisperEngine] Error disposing pipeline:", err);
      }
    }
  }
  async queueAudio(audioFloat32Array, options = {}) {
    if (!this.isReady) {
      await this.init(options.preferWebGPU ?? true);
    }
    return new Promise((resolve, reject) => {
      if (this.processingQueue.length >= MAX_QUEUED_CHUNKS) {
        const dropped = this.processingQueue.shift();
        this.stats.dropped += 1;
        dropped.reject(new Error("Dropped audio chunk to keep real-time synchronization"));
      }
      this.processingQueue.push({
        audio: audioFloat32Array,
        options,
        resolve,
        reject,
        queuedAt: Date.now(),
        queuedPerf: performance.now()
      });
      this.processNextInQueue();
    });
  }
  async processNextInQueue() {
    if (this.isProcessing || this.processingQueue.length === 0) {
      return;
    }
    this.isProcessing = true;
    const item = this.processingQueue.shift();
    this.lastAudio = item.audio;
    const startTime = performance.now();
    let ranInference = false;
    try {
      if (!this.isReady || !this.pipelineInstance) {
        await this.init(item.options.preferWebGPU ?? true);
      }
      ranInference = true;
      const sourceLanguage = item.options.sourceLanguage || "russian";
      const showDual = item.options.showDualSubtitles || false;
      const seconds = item.audio.length / 16e3;
      // Chunks that were not cut by the speech detector (Studio microphone and
      // file input) are checked here, so music and noise are never transcribed.
      if (!item.options.speechChecked && this.detector && await this.detector.load()) {
        const speech = await this.detector.speechSeconds(item.audio);
        if (speech < MIN_SPEECH_SECONDS) {
          this.stats.noSpeech += 1;
          item.resolve({ text: "", russianText: "", latencyMs: Math.round(performance.now() - startTime), device: this.device, timestamp: Date.now(), skipped: "no-speech" });
          return;
        }
      }
      // Fast speech is about ten tokens a second. The cap stops a runaway
      // repetition loop from stalling the queue for many seconds.
      const maxNewTokens = Math.min(220, Math.ceil(seconds * 12) + 24);
      const translationResult = await this.pipelineInstance(item.audio, {
        language: sourceLanguage,
        task: "translate",
        return_timestamps: false,
        max_new_tokens: maxNewTokens
      });
      const rawText = (translationResult.text || "").trim();
      let originalRussianText = "";
      let translatedText = this.cleanSubtitleText(rawText);
      if (translatedText) {
        const key = translatedText.toLowerCase();
        const now = Date.now();
        if (key === this.lastCaption.text && now - this.lastCaption.at < REPEAT_WINDOW_MS) translatedText = "";
        this.lastCaption = { text: key, at: now };
      }
      if (showDual && translatedText.length > 0) {
        try {
          const transcriptionResult = await this.pipelineInstance(item.audio, {
            language: sourceLanguage,
            task: "transcribe",
            return_timestamps: false,
            max_new_tokens: maxNewTokens
          });
          originalRussianText = this.cleanSubtitleText(transcriptionResult.text || "");
        } catch (e) {
          console.warn("[WhisperEngine] Dual transcription error:", e);
        }
      }
      this.consecutiveFailures = 0;
      const latencyMs = Math.round(performance.now() - startTime);
      const audioSeconds = item.audio.length / 16e3;
      this.stats.processed += 1;
      this.stats.audioSeconds += audioSeconds;
      this.stats.latencyMs += latencyMs;
      if (!translatedText) this.stats.filtered += 1;
      this.recent.push({
        at: Date.now(),
        audioSeconds: Math.round(audioSeconds * 100) / 100,
        latencyMs,
        waitMs: Math.round(startTime - item.queuedPerf),
        rawText,
        text: translatedText,
        russianText: originalRussianText
      });
      if (this.recent.length > RECENT_RESULTS_KEPT) this.recent.shift();
      const result = {
        text: translatedText,
        russianText: originalRussianText,
        latencyMs,
        device: this.device,
        timestamp: Date.now()
      };
      item.resolve(result);
      if (this.onSubtitle && translatedText.length > 0) {
        this.onSubtitle(result);
      }
    } catch (err) {
      console.error("[WhisperEngine] Inference error:", err);
      this.stats.failed += 1;
      item.reject(err);
      if (ranInference) {
        this.consecutiveFailures += 1;
        if (this.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          await this.reset(this.device === "webgpu");
        }
      }
    } finally {
      this.isProcessing = false;
      setTimeout(() => this.processNextInQueue(), 10);
    }
  }
  cleanSubtitleText(text) {
    if (!text) return "";
    let cleaned = text.trim();
    cleaned = cleaned.replace(/[\[(（][^\])）]{0,40}[\])）]/g, " ").replace(/[♪♫🎵🎶*]+/g, " ").replace(/\s+/g, " ").trim();
    // A stuck model repeats one character or one short phrase. Collapse both.
    cleaned = cleaned.replace(/(\p{L})\1{4,}/giu, "$1$1$1").replace(/(\b[\p{L}\p{N}][\p{L}\p{N} ]{1,24}?)(?:[\s,.!?]+\1){3,}/giu, "$1").trim();
    if (!/[\p{L}\p{N}]/u.test(cleaned)) return "";
    const normalized = cleaned.toLowerCase().replace(/^[.,!?;:\s"'-]+|[.,!?;:\s"'-]+$/g, "").trim();
    const hallucinations = [
      "the end",
      "end",
      "fin",
      "\u043A\u043E\u043D\u0435\u0446",
      "\u043A\u043E\u043D\u0435\u0446 \u0444\u0438\u043B\u044C\u043C\u0430",
      "you",
      "thank you",
      "thanks",
      "thank you for watching",
      "thanks for watching",
      "subscribe",
      "please subscribe",
      "subscribe to our channel",
      "\u043F\u043E\u0434\u043F\u0438\u0441\u044B\u0432\u0430\u0439\u0442\u0435\u0441\u044C",
      "\u043F\u043E\u0434\u043F\u0438\u0441\u044B\u0432\u0430\u0439\u0442\u0435\u0441\u044C \u043D\u0430 \u043A\u0430\u043D\u0430\u043B",
      "subtitles by",
      "captioned by",
      "translated by",
      "\u0441\u0443\u0431\u0442\u0438\u0442\u0440\u044B",
      "\u043F\u0435\u0440\u0435\u0432\u043E\u0434",
      "to be continued",
      "\u043F\u0440\u043E\u0434\u043E\u043B\u0436\u0435\u043D\u0438\u0435 \u0441\u043B\u0435\u0434\u0443\u0435\u0442",
      "see you next time",
      "see you soon",
      "\u0434\u043E \u0432\u0441\u0442\u0440\u0435\u0447\u0438",
      "\u043F\u043E\u043A\u0430",
      "bye",
      "bye bye",
      "goodbye",
      "silence",
      "\u0442\u0438\u0448\u0438\u043D\u0430",
      "\u043C\u0443\u0437\u044B\u043A\u0430",
      "applause",
      "\u0430\u043F\u043B\u043E\u0434\u0438\u0441\u043C\u0435\u043D\u0442\u044B"
    ];
    if (hallucinations.includes(normalized)) {
      return "";
    }
    // Credits the model learned from subtitle files and recites over music.
    const creditPatterns = [
      /amara\.org/i,
      /dimatorzok/i,
      /^\s*(subtitles|captions|transcription|translation)\s+(by|made by|provided by)\b/i,
      /^\s*(\u0441\u0443\u0431\u0442\u0438\u0442\u0440\u044b|\u0440\u0435\u0434\u0430\u043a\u0442\u043e\u0440 \u0441\u0443\u0431\u0442\u0438\u0442\u0440\u043e\u0432|\u043a\u043e\u0440\u0440\u0435\u043a\u0442\u043e\u0440)\b/i,
      /^\s*(thanks|thank you)( so much)? for watching\b/i,
      /\u0441\u043f\u0430\u0441\u0438\u0431\u043e \u0437\u0430 \u043f\u0440\u043e\u0441\u043c\u043e\u0442\u0440/i
    ];
    if (cleaned.length < 80 && creditPatterns.some((re) => re.test(cleaned))) {
      return "";
    }
    return cleaned;
  }
  /** Times the last chunk with different output lengths to separate fixed cost from per-token cost. */
  async benchmark() {
    if (!this.isReady || !this.lastAudio) throw new Error("Nothing to benchmark yet");
    const out = { audioSeconds: this.lastAudio.length / 16e3, device: this.device, runs: [] };
    for (const maxNewTokens of [1, 1, 12, 12, 40, 40]) {
      const t0 = performance.now();
      const res = await this.pipelineInstance(this.lastAudio, {
        language: "russian",
        task: "translate",
        return_timestamps: false,
        max_new_tokens: maxNewTokens
      });
      out.runs.push({ maxNewTokens, ms: Math.round(performance.now() - t0), chars: (res.text || "").length });
    }
    return out;
  }
  getDiagnostics() {
    return { status: this.getStatus(), stats: { ...this.stats }, recent: this.recent.slice() };
  }
  getStatus() {
    return {
      isReady: this.isReady,
      isInitializing: this.isInitializing,
      device: this.device,
      model: this.modelId,
      status: this.loadingStatus,
      progress: this.loadingProgress,
      gpuInfo: this.gpuInfo,
      queueLength: this.processingQueue.length,
      isProcessing: this.isProcessing
    };
  }
}
export const whisperEngine = new WhisperEngine();
