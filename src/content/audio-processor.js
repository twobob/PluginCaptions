const RESUME_TIMEOUT_MS = 1500;
const TARGET_SAMPLE_RATE = 16e3;
// Audio is sent to the background in batches of this many samples (0.32 s,
// ten frames of the speech detector).
const BATCH_SAMPLES = 5120;
// A batch whose loudest sample is below this is digital silence.
const SILENCE_PEAK = 1e-4;
// Keep sending this much silence so the background sees the speech end, then
// stop until sound returns.
const SILENCE_TAIL_SAMPLES = TARGET_SAMPLE_RATE * 2;
// Automatic gain: quiet players (low volume slider) are brought up to this
// peak level, by at most MAX_GAIN, so the speech detector hears them properly.
const TARGET_PEAK = 0.5;
const MAX_GAIN = 30;
const PEAK_DECAY = 0.98;
/**
 * True when the element's audio can be read by Web Audio. Media loaded from
 * another origin without CORS approval is "tainted": the browser hands Web
 * Audio pure silence for it. Capturing such an element would gain nothing and
 * would reroute its sound into that silence, so it must be left alone.
 */
export function isCapturableMedia(mediaElement, pageLocation = window.location) {
  if (mediaElement.srcObject) return true;
  const src = mediaElement.currentSrc || mediaElement.src;
  if (!src) return true;
  try {
    const url = new URL(src, pageLocation.href);
    if (url.protocol === "blob:" || url.protocol === "data:") return true;
    if (url.origin === pageLocation.origin) return true;
    return mediaElement.crossOrigin != null;
  } catch (e) {
    return false;
  }
}
/**
 * Captures the audio of a media element and delivers it as a continuous
 * 16 kHz mono stream. Deciding what is speech happens in the background page.
 */
export class AudioProcessor {
  constructor(options = {}) {
    this.targetSampleRate = TARGET_SAMPLE_RATE;
    // Called with a Float32Array of 16 kHz samples, about three times a second.
    this.onAudio = options.onAudio || null;
    // Called when capture stops (pause, mute, captions turned off).
    this.onStop = options.onStop || null;
    this.audioContext = null;
    // One entry per captured media element, kept for the life of the page.
    // Capturing an element reroutes its sound through our AudioContext, and
    // that cannot be undone, so the route to the speakers is never torn down.
    // Only the analysis branch below is connected and disconnected.
    this.sources = new WeakMap();
    this.activeEntry = null;
    this.filterNodes = null;
    this.processorNode = null;
    this.connectedElement = null;
    this.attachSerial = 0;
    this.resetStream();
  }
  resetStream() {
    this.batch = new Float32Array(BATCH_SAMPLES);
    this.batchFill = 0;
    this.silentSamples = 0;
    this.peakEstimate = 0;
  }
  ensureContext() {
    if (this.audioContext && this.audioContext.state !== "closed") return this.audioContext;
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return null;
    const ctx = new AudioCtx();
    // If the browser suspends the context (for example after a long pause)
    // the rerouted media would go silent, so always ask for it back.
    ctx.addEventListener("statechange", () => {
      if (ctx.state === "suspended") ctx.resume().catch(() => {
      });
    });
    this.audioContext = ctx;
    this.sources = new WeakMap();
    return ctx;
  }
  async ensureRunning(ctx) {
    if (ctx.state === "running") return true;
    try {
      await Promise.race([
        ctx.resume(),
        new Promise((resolve) => setTimeout(resolve, RESUME_TIMEOUT_MS))
      ]);
    } catch (e) {
    }
    return ctx.state === "running";
  }
  /**
   * Starts streaming the given element's audio. Resolves to true when it is
   * being captured. A false result leaves the element completely untouched.
   */
  async attachToMediaElement(mediaElement) {
    if (this.connectedElement === mediaElement && this.activeEntry && !this.isEntryStale(this.activeEntry, mediaElement)) {
      return true;
    }
    if (mediaElement.muted || mediaElement.volume === 0) return false;
    if (!isCapturableMedia(mediaElement)) return false;
    const serial = ++this.attachSerial;
    try {
      const ctx = this.ensureContext();
      if (!ctx) return false;
      // Never reroute an element into a context that is not running: the
      // page's audio would vanish. Try again on the next play event instead.
      if (!await this.ensureRunning(ctx)) return false;
      if (serial !== this.attachSerial) return false;
      if (mediaElement.paused || mediaElement.ended || mediaElement.muted) return false;
      const entry = this.getSourceEntry(ctx, mediaElement);
      if (!entry) return false;
      this.startAnalysis(ctx, entry, mediaElement);
      return true;
    } catch (err) {
      console.error("[AudioProcessor] Failed to attach to media element:", err);
      this.stopAnalysis();
      return false;
    }
  }
  isEntryStale(entry, mediaElement) {
    if (entry.kind === "element") return false;
    if (entry.kind === "stream" && mediaElement.srcObject !== entry.stream) return true;
    return !entry.track || entry.track.readyState === "ended";
  }
  getSourceEntry(ctx, mediaElement) {
    let entry = this.sources.get(mediaElement);
    if (entry && !this.isEntryStale(entry, mediaElement)) return entry;
    if (entry) {
      // The element moved on to new media and the old track ended. Rebuild the
      // node on the fresh track, reusing a capture stream we already hold.
      try {
        entry.node.disconnect();
      } catch (e) {
      }
      this.sources.delete(mediaElement);
      entry = entry.kind === "capture" ? this.buildStreamEntry(ctx, entry.stream, "capture", true) : null;
    }
    if (!entry) entry = this.createSourceEntry(ctx, mediaElement);
    if (entry) this.sources.set(mediaElement, entry);
    return entry;
  }
  buildStreamEntry(ctx, stream, kind, routeToSpeakers) {
    const track = stream.getAudioTracks().find((t) => t.readyState !== "ended");
    if (!track) return null;
    const node = typeof ctx.createMediaStreamTrackSource === "function" ? ctx.createMediaStreamTrackSource(track) : ctx.createMediaStreamSource(stream);
    if (routeToSpeakers) node.connect(ctx.destination);
    return { kind, node, stream, track };
  }
  createSourceEntry(ctx, mediaElement) {
    // Live streams (video calls, webcams): tap the stream itself. The element
    // keeps playing it exactly as before.
    const live = mediaElement.srcObject;
    if (live && typeof live.getAudioTracks === "function") {
      return this.buildStreamEntry(ctx, live, "stream", false);
    }
    // Wait for metadata so the element's tracks are known.
    if (mediaElement.readyState < 1) return null;
    // Standard route. The node follows the element across source changes
    // (next video in a playlist) and honours its volume and mute controls.
    try {
      const node = ctx.createMediaElementSource(mediaElement);
      node.connect(ctx.destination);
      return { kind: "element", node, stream: null, track: null };
    } catch (err) {
      console.warn("[AudioProcessor] createMediaElementSource unavailable, trying stream capture:", err);
    }
    // Fallback: capture the element's output as a stream. Firefox stops
    // playing a captured element on its own, so route it to the speakers.
    const capture = typeof mediaElement.captureStream === "function" ? "captureStream" : typeof mediaElement.mozCaptureStream === "function" ? "mozCaptureStream" : null;
    if (!capture) return null;
    let stream = null;
    try {
      stream = mediaElement[capture]();
    } catch (err) {
      console.warn("[AudioProcessor] Media element cannot be captured:", err);
      return null;
    }
    return this.buildStreamEntry(ctx, stream, "capture", capture === "mozCaptureStream");
  }
  startAnalysis(ctx, entry, mediaElement) {
    this.stopAnalysis();
    // Remove rumble below the voice range, and everything above 7 kHz so that
    // reducing the sample rate to 16 kHz does not fold cymbals and hiss down
    // into the speech band. Speech itself is left untouched.
    const highpass = ctx.createBiquadFilter();
    highpass.type = "highpass";
    highpass.frequency.value = 80;
    highpass.Q.value = 0.7;
    const lowpassA = ctx.createBiquadFilter();
    lowpassA.type = "lowpass";
    lowpassA.frequency.value = 7e3;
    lowpassA.Q.value = 0.54;
    const lowpassB = ctx.createBiquadFilter();
    lowpassB.type = "lowpass";
    lowpassB.frequency.value = 7e3;
    lowpassB.Q.value = 1.31;
    const bufferSize = 4096;
    const processor = ctx.createScriptProcessor(bufferSize, 2, 1);
    processor.onaudioprocess = (event) => {
      if (this.processorNode !== processor) return;
      if (mediaElement.paused || mediaElement.ended) return;
      const buf = event.inputBuffer;
      const L = buf.getChannelData(0);
      const R = buf.numberOfChannels > 1 ? buf.getChannelData(1) : L;
      const n = L.length;
      // The centre of the stereo image: a streamer's voice sits here, while
      // wide music and game sound partly cancel out.
      const mid = new Float32Array(n);
      for (let i = 0; i < n; i++) mid[i] = (L[i] + R[i]) * 0.5;
      this.processIncomingSamples(mid, buf.sampleRate);
    };
    entry.node.connect(highpass);
    highpass.connect(lowpassA);
    lowpassA.connect(lowpassB);
    lowpassB.connect(processor);
    // A ScriptProcessor only runs while connected to the destination. Its
    // output buffer is never written, so this adds silence, not sound.
    processor.connect(ctx.destination);
    this.filterNodes = [highpass, lowpassA, lowpassB];
    this.processorNode = processor;
    this.activeEntry = entry;
    this.connectedElement = mediaElement;
    console.log("[AudioProcessor] Capturing media element:", mediaElement.tagName);
  }
  /**
   * Stops streaming. The captured element keeps playing through the existing
   * route to the speakers; only the analysis branch goes.
   */
  stopAnalysis() {
    const wasActive = !!this.connectedElement;
    try {
      if (this.activeEntry && this.filterNodes) {
        // Disconnect from the filter only. A bare disconnect() would also cut
        // the element's route to the speakers.
        this.activeEntry.node.disconnect(this.filterNodes[0]);
      }
    } catch (e) {
    }
    try {
      if (this.processorNode) {
        this.processorNode.onaudioprocess = null;
        this.processorNode.disconnect();
      }
      if (this.filterNodes) this.filterNodes.forEach((n) => n.disconnect());
    } catch (e) {
      console.warn("[AudioProcessor] Error stopping analysis:", e);
    }
    this.processorNode = null;
    this.filterNodes = null;
    this.activeEntry = null;
    this.connectedElement = null;
    this.attachSerial++;
    this.resetStream();
    if (wasActive && this.onStop) this.onStop();
  }
  /** Sends whatever audio is still buffered, then stops. */
  flushAndStop() {
    if (this.connectedElement && this.batchFill > 0) this.emitBatch();
    this.stopAnalysis();
  }
  detach() {
    this.stopAnalysis();
  }
  processIncomingSamples(rawSamples, inputSampleRate) {
    const resampled = this.resampleTo16k(rawSamples, inputSampleRate);
    let offset = 0;
    while (offset < resampled.length) {
      const take = Math.min(resampled.length - offset, BATCH_SAMPLES - this.batchFill);
      this.batch.set(resampled.subarray(offset, offset + take), this.batchFill);
      this.batchFill += take;
      offset += take;
      if (this.batchFill === BATCH_SAMPLES) this.emitBatch();
    }
  }
  emitBatch() {
    const samples = this.batch.slice(0, this.batchFill);
    this.batchFill = 0;
    let peak = 0;
    for (let i = 0; i < samples.length; i++) {
      const a = Math.abs(samples[i]);
      if (a > peak) peak = a;
    }
    if (peak < SILENCE_PEAK) {
      this.silentSamples += samples.length;
      if (this.silentSamples > SILENCE_TAIL_SAMPLES) return;
    } else {
      this.silentSamples = 0;
    }
    this.peakEstimate = Math.max(peak, this.peakEstimate * PEAK_DECAY);
    const gain = this.peakEstimate > SILENCE_PEAK ? Math.min(MAX_GAIN, Math.max(1, TARGET_PEAK / this.peakEstimate)) : 1;
    if (gain !== 1) {
      for (let i = 0; i < samples.length; i++) samples[i] *= gain;
    }
    if (this.onAudio) this.onAudio(samples);
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
      const indexFloor = Math.min(Math.floor(originalIndex), inputData.length - 1);
      const indexCeil = Math.min(indexFloor + 1, inputData.length - 1);
      const fraction = originalIndex - indexFloor;
      result[i] = inputData[indexFloor] * (1 - fraction) + inputData[indexCeil] * fraction;
    }
    return result;
  }
}
