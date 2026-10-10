import { pipeline, env } from "@huggingface/transformers";
import { detectWebGPUSupport } from "../utils/webgpu-detector.js";
import { DEFAULT_MODEL_ID } from "../utils/constants.js";
export class WhisperEngine {
  constructor() {
    this.modelId = DEFAULT_MODEL_ID;
    this.pipelineInstance = null;
    this.isInitializing = false;
    this.isReady = false;
    this.device = "unknown";
    this.gpuInfo = null;
    this.loadingProgress = 0;
    this.loadingStatus = "Uninitialized";
    this.processingQueue = [];
    this.isProcessing = false;
    this.onProgress = null;
    this.onSubtitle = null;
    this.setupEnvironment();
  }
  setupEnvironment() {
    env.allowLocalModels = false;
    env.useBrowserCache = true;
    const rt = (typeof browser !== "undefined" ? browser : chrome).runtime;
    env.backends.onnx.wasm.wasmPaths = rt.getURL("wasm/");
    env.backends.onnx.wasm.proxy = false;
    env.backends.onnx.wasm.numThreads = 1;
  }
  async init(preferWebGPU = true) {
    if (this.isReady) {
      return { success: true, device: this.device, gpuInfo: this.gpuInfo };
    }
    if (this.isInitializing) {
      return new Promise((resolve) => {
        const check = setInterval(() => {
          if (this.isReady || !this.isInitializing) {
            clearInterval(check);
            resolve({ success: this.isReady, device: this.device, gpuInfo: this.gpuInfo });
          }
        }, 200);
      });
    }
    this.isInitializing = true;
    this.loadingStatus = "Checking WebGPU Support...";
    try {
      const gpuCheck = await detectWebGPUSupport();
      let targetDevice = "wasm";
      let dtypeConfig = "fp32";
      if (preferWebGPU && gpuCheck.supported) {
        targetDevice = "webgpu";
        this.gpuInfo = gpuCheck.gpuInfo;
        dtypeConfig = {
          encoder_model: "fp32",
          decoder_model_merged: "q4"
        };
        console.log("[WhisperEngine] WebGPU initialized on:", this.gpuInfo);
      } else {
        console.warn("[WhisperEngine] WebGPU not available, falling back to WASM:", gpuCheck.error || gpuCheck.recommendation);
        targetDevice = "wasm";
        dtypeConfig = "fp32";
      }
      this.device = targetDevice;
      this.loadingStatus = `Loading ${this.modelId} on ${this.device.toUpperCase()}...`;
      this.pipelineInstance = await pipeline(
        "automatic-speech-recognition",
        this.modelId,
        {
          device: targetDevice,
          dtype: dtypeConfig,
          progress_callback: (progressData) => {
            if (progressData.status === "progress") {
              this.loadingProgress = Math.round(progressData.progress || 0);
              this.loadingStatus = `Downloading ${progressData.file || "model"}: ${this.loadingProgress}%`;
            } else if (progressData.status === "done") {
              this.loadingStatus = `Loaded ${progressData.file || "component"}`;
            } else if (progressData.status === "initiate") {
              this.loadingStatus = `Fetching ${progressData.file || "model files"}...`;
            }
            if (this.onProgress) {
              this.onProgress({
                status: this.loadingStatus,
                progress: this.loadingProgress,
                device: this.device
              });
            }
          }
        }
      );
      this.isReady = true;
      this.isInitializing = false;
      this.loadingStatus = `Ready (${this.device.toUpperCase()})`;
      this.loadingProgress = 100;
      console.log(`[WhisperEngine] Model pipeline ready on ${this.device.toUpperCase()}!`);
      return { success: true, device: this.device, gpuInfo: this.gpuInfo };
    } catch (err) {
      console.error("[WhisperEngine] Initialization error:", err);
      this.isInitializing = false;
      this.isReady = false;
      this.loadingStatus = `Error: ${err.message}`;
      if (this.device === "webgpu") {
        console.log("[WhisperEngine] Retrying pipeline initialization with WASM fallback...");
        this.device = "wasm";
        return this.init(false);
      }
      throw err;
    }
  }
  async queueAudio(audioFloat32Array, options = {}) {
    if (!this.isReady) {
      await this.init(options.preferWebGPU ?? true);
    }
    return new Promise((resolve, reject) => {
      if (this.processingQueue.length > 2) {
        const dropped = this.processingQueue.shift();
        dropped.reject(new Error("Dropped audio chunk to keep real-time synchronization"));
      }
      this.processingQueue.push({
        audio: audioFloat32Array,
        options,
        resolve,
        reject,
        queuedAt: Date.now()
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
    const startTime = performance.now();
    try {
      const sourceLanguage = item.options.sourceLanguage || "russian";
      const task = item.options.task || "translate";
      const showDual = item.options.showDualSubtitles || false;
      const translationResult = await this.pipelineInstance(item.audio, {
        language: sourceLanguage,
        task: "translate",
        return_timestamps: false,
        chunk_length_s: 30,
        stride_length_s: 5
      });
      let translatedText = (translationResult.text || "").trim();
      let originalRussianText = "";
      translatedText = this.cleanSubtitleText(translatedText);
      if (showDual && translatedText.length > 0) {
        try {
          const transcriptionResult = await this.pipelineInstance(item.audio, {
            language: sourceLanguage,
            task: "transcribe",
            return_timestamps: false
          });
          originalRussianText = this.cleanSubtitleText(transcriptionResult.text || "");
        } catch (e) {
          console.warn("[WhisperEngine] Dual transcription error:", e);
        }
      }
      const latencyMs = Math.round(performance.now() - startTime);
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
      item.reject(err);
    } finally {
      this.isProcessing = false;
      setTimeout(() => this.processNextInQueue(), 10);
    }
  }
  cleanSubtitleText(text) {
    if (!text) return "";
    let cleaned = text.trim();
    cleaned = cleaned.replace(/[\[(（][^\])）]{0,40}[\])）]/g, " ").replace(/[♪♫🎵🎶*]+/g, " ").replace(/\s+/g, " ").trim();
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
    return cleaned;
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
