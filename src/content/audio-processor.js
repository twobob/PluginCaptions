export class AudioProcessor {
  constructor(options = {}) {
    this.targetSampleRate = 16e3;
    this.vadSensitivity = options.vadSensitivity ?? 0.015;
    this.maxChunkSeconds = options.maxChunkSeconds ?? 3.5;
    this.silenceThresholdMs = options.silenceThresholdMs ?? 450;
    this.onAudioChunkReady = options.onAudioChunkReady || null;
    this.onStateChange = options.onStateChange || null;
    this.audioContext = null;
    this.sourceNode = null;
    this.processorNode = null;
    this.connectedElement = null;
    this.isSpeaking = false;
    this.speechBuffer = [];
    this.preRollBuffer = [];
    this.lastSpeechTime = 0;
    this.maxSamples = this.targetSampleRate * this.maxChunkSeconds;
    this.preRollMaxSamples = Math.round(this.targetSampleRate * 0.3);
  }
  updateSettings(settings) {
    if (settings.vadSensitivity !== void 0) this.vadSensitivity = settings.vadSensitivity;
    if (settings.maxChunkSeconds !== void 0) {
      this.maxChunkSeconds = settings.maxChunkSeconds;
      this.maxSamples = this.targetSampleRate * this.maxChunkSeconds;
    }
    if (settings.silenceThresholdMs !== void 0) this.silenceThresholdMs = settings.silenceThresholdMs;
  }
  attachToMediaElement(mediaElement) {
    if (this.connectedElement === mediaElement && this.audioContext) {
      if (this.audioContext.state === "suspended") this.audioContext.resume().catch(() => {
      });
      return true;
    }
    this.detach();
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      this.audioContext = new AudioCtx();
      if (this.audioContext.state === "suspended") this.audioContext.resume().catch(() => {
      });
      let stream = null;
      let mustRouteToSpeakers = false;
      if (typeof mediaElement.captureStream === "function") {
        try {
          stream = mediaElement.captureStream();
        } catch (e) {
        }
      } else if (typeof mediaElement.mozCaptureStream === "function") {
        try {
          stream = mediaElement.mozCaptureStream();
          mustRouteToSpeakers = true;
        } catch (e) {
        }
      }
      if (stream && stream.getAudioTracks().length > 0) {
        this.sourceNode = this.audioContext.createMediaStreamSource(stream);
        if (mustRouteToSpeakers) this.sourceNode.connect(this.audioContext.destination);
      } else {
        try {
          this.sourceNode = this.audioContext.createMediaElementSource(mediaElement);
          this.sourceNode.connect(this.audioContext.destination);
        } catch (corsErr) {
          console.warn("[AudioProcessor] MediaElement cross-origin restriction:", corsErr);
          return false;
        }
      }
      const ctx = this.audioContext;
      const hp = ctx.createBiquadFilter();
      hp.type = "highpass";
      hp.frequency.value = 120;
      hp.Q.value = 0.7;
      const lp = ctx.createBiquadFilter();
      lp.type = "lowpass";
      lp.frequency.value = 4500;
      lp.Q.value = 0.7;
      const pk = ctx.createBiquadFilter();
      pk.type = "peaking";
      pk.frequency.value = 2e3;
      pk.Q.value = 1;
      pk.gain.value = 5;
      this.filterNodes = [hp, lp, pk];
      const bufferSize = 4096;
      this.processorNode = ctx.createScriptProcessor(bufferSize, 2, 1);
      this.processorNode.onaudioprocess = (event) => {
        if (!mediaElement || mediaElement.paused || mediaElement.ended) return;
        const buf = event.inputBuffer;
        const L = buf.getChannelData(0);
        const R = buf.numberOfChannels > 1 ? buf.getChannelData(1) : L;
        const n = L.length;
        const mid = new Float32Array(n);
        let midSq = 0, sideSq = 0;
        for (let i = 0; i < n; i++) {
          const m = (L[i] + R[i]) * 0.5;
          const s = (L[i] - R[i]) * 0.5;
          mid[i] = m;
          midSq += m * m;
          sideSq += s * s;
        }
        const centreRatio = midSq / (midSq + sideSq + 1e-12);
        this.processIncomingSamples(mid, buf.sampleRate, centreRatio);
      };
      this.sourceNode.connect(hp);
      hp.connect(lp);
      lp.connect(pk);
      pk.connect(this.processorNode);
      this.processorNode.connect(ctx.destination);
      this.connectedElement = mediaElement;
      console.log("[AudioProcessor] Successfully hooked media element:", mediaElement.tagName);
      return true;
    } catch (err) {
      console.error("[AudioProcessor] Failed to attach to media element:", err);
      this.detach();
      return false;
    }
  }
  processIncomingSamples(rawSamples, inputSampleRate, centreRatio = 1) {
    const resampled = this.resampleTo16k(rawSamples, inputSampleRate);
    if (!resampled || resampled.length === 0) return;
    let sumSquares = 0;
    for (let i = 0; i < resampled.length; i++) {
      sumSquares += resampled[i] * resampled[i];
    }
    const rms = Math.sqrt(sumSquares / resampled.length);
    const now = performance.now();
    if (this.noiseFloor === void 0) this.noiseFloor = rms;
    this.noiseFloor = rms < this.noiseFloor ? this.noiseFloor * 0.8 + rms * 0.2 : this.noiseFloor * 0.995 + rms * 5e-3;
    const threshold = Math.max(this.vadSensitivity, this.noiseFloor * 1.6);
    const centred = centreRatio >= 0.75;
    const isCurrentSliceSpeech = rms >= threshold && (centred || this.isSpeaking);
    if (isCurrentSliceSpeech) {
      if (!this.isSpeaking) {
        this.isSpeaking = true;
        this.speechBuffer = [...this.preRollBuffer];
        this.preRollBuffer = [];
        if (this.onStateChange) this.onStateChange("speech");
      }
      this.lastSpeechTime = now;
      for (let i = 0; i < resampled.length; i++) {
        this.speechBuffer.push(resampled[i]);
      }
    } else {
      if (this.isSpeaking) {
        for (let i = 0; i < resampled.length; i++) {
          this.speechBuffer.push(resampled[i]);
        }
        const silenceDuration = now - this.lastSpeechTime;
        if (silenceDuration > this.silenceThresholdMs) {
          this.flushSpeechBuffer();
        }
      } else {
        for (let i = 0; i < resampled.length; i++) {
          this.preRollBuffer.push(resampled[i]);
        }
        if (this.preRollBuffer.length > this.preRollMaxSamples) {
          this.preRollBuffer.splice(0, this.preRollBuffer.length - this.preRollMaxSamples);
        }
      }
    }
    if (this.speechBuffer.length >= this.maxSamples) {
      this.flushSpeechBuffer();
    }
  }
  flushSpeechBuffer() {
    if (this.speechBuffer.length < this.targetSampleRate * 0.4) {
      this.speechBuffer = [];
      this.isSpeaking = false;
      return;
    }
    const float32Chunk = new Float32Array(this.speechBuffer);
    this.speechBuffer = [];
    this.isSpeaking = false;
    if (this.onStateChange) this.onStateChange("idle");
    if (this.onAudioChunkReady) {
      this.onAudioChunkReady(float32Chunk);
    }
  }
  resampleTo16k(inputData, inputSampleRate) {
    if (inputSampleRate === this.targetSampleRate) {
      return inputData;
    }
    const ratio = inputSampleRate / this.targetSampleRate;
    const newLength = Math.round(inputData.length / ratio);
    const result = new Float32Array(newLength);
    for (let i = 0; i < newLength; i++) {
      const originalIndex = i * ratio;
      const indexFloor = Math.floor(originalIndex);
      const indexCeil = Math.min(indexFloor + 1, inputData.length - 1);
      const fraction = originalIndex - indexFloor;
      result[i] = inputData[indexFloor] * (1 - fraction) + inputData[indexCeil] * fraction;
    }
    return result;
  }
  detach() {
    try {
      if (this.processorNode) {
        this.processorNode.disconnect();
        this.processorNode = null;
      }
      if (this.filterNodes) {
        this.filterNodes.forEach((n) => n.disconnect());
        this.filterNodes = null;
      }
      if (this.sourceNode) {
        this.sourceNode.disconnect();
        this.sourceNode = null;
      }
      if (this.audioContext && this.audioContext.state !== "closed") {
        this.audioContext.close();
        this.audioContext = null;
      }
    } catch (e) {
      console.warn("[AudioProcessor] Error during detach:", e);
    }
    this.connectedElement = null;
    this.speechBuffer = [];
    this.preRollBuffer = [];
    this.isSpeaking = false;
  }
}
