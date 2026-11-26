import { FRAME_SAMPLES, SAMPLE_RATE, Segmenter } from "./segmenter.js";
// If the speech detector falls this far behind (the model is still loading,
// or the machine is overloaded) the oldest audio is discarded.
const MAX_BACKLOG_SAMPLES = SAMPLE_RATE * 12;
// A stream that stops sending without saying so is closed after this long.
const IDLE_TIMEOUT_MS = 2500;
/**
 * Receives continuous audio from pages, one stream per frame of a tab, finds
 * the speech in it and hands finished segments to the transcription engine.
 */
export class StreamManager {
  constructor({ engine, detector, getOptions, onResult, onState }) {
    this.engine = engine;
    this.detector = detector;
    this.getOptions = getOptions;
    this.onResult = onResult;
    this.onState = onState;
    this.streams = new Map();
    this.stats = { audioSeconds: 0, segments: 0, segmentSeconds: 0, discardedSeconds: 0 };
  }
  getStats() {
    return { ...this.stats, openStreams: this.streams.size, detector: this.detector.available ? "silero" : "loudness" };
  }
  /** Adds audio (16 kHz mono Float32Array) to a stream; `end` closes it. */
  handleAudio(key, source, audio, end = false) {
    let stream = this.streams.get(key);
    if (!stream) {
      if (!audio || audio.length === 0) return;
      const options = this.getOptions();
      stream = {
        key,
        source,
        pending: new Float32Array(0),
        segmenter: new Segmenter({ targetSeconds: options.chunkTargetSeconds, maxSeconds: options.chunkMaxSeconds }),
        detectorState: this.detector.createState(),
        draining: false,
        ended: false,
        idleTimer: null
      };
      this.streams.set(key, stream);
    }
    if (audio && audio.length) {
      this.stats.audioSeconds += audio.length / SAMPLE_RATE;
      let pending = new Float32Array(stream.pending.length + audio.length);
      pending.set(stream.pending, 0);
      pending.set(audio, stream.pending.length);
      if (pending.length > MAX_BACKLOG_SAMPLES) {
        this.stats.discardedSeconds += (pending.length - MAX_BACKLOG_SAMPLES) / SAMPLE_RATE;
        pending = pending.slice(pending.length - MAX_BACKLOG_SAMPLES);
      }
      stream.pending = pending;
    }
    if (end) stream.ended = true;
    clearTimeout(stream.idleTimer);
    stream.idleTimer = setTimeout(() => {
      stream.ended = true;
      this.drain(stream);
    }, IDLE_TIMEOUT_MS);
    this.drain(stream);
  }
  /** Closes every stream, sending any speech collected so far. */
  endAll() {
    for (const stream of this.streams.values()) {
      stream.ended = true;
      this.drain(stream);
    }
  }
  updateOptions() {
    const options = this.getOptions();
    for (const stream of this.streams.values()) {
      stream.segmenter.configure({ targetSeconds: options.chunkTargetSeconds, maxSeconds: options.chunkMaxSeconds });
    }
  }
  async drain(stream) {
    if (stream.draining) return;
    stream.draining = true;
    try {
      await this.detector.load();
      for (; ; ) {
        if (stream.pending.length < FRAME_SAMPLES) break;
        const frame = stream.pending.slice(0, FRAME_SAMPLES);
        stream.pending = stream.pending.subarray(FRAME_SAMPLES);
        const probability = await this.detector.probability(stream.detectorState, frame);
        const wasActive = stream.segmenter.isActive;
        const segments = stream.segmenter.push(frame, probability);
        if (!wasActive && stream.segmenter.isActive) this.onState(stream.source, "speech");
        for (const segment of segments) this.transcribe(stream, segment);
        if (wasActive && !stream.segmenter.isActive && segments.length === 0) this.onState(stream.source, "ready");
      }
      if (stream.ended && stream.pending.length < FRAME_SAMPLES) {
        const last = stream.segmenter.flush();
        if (last) this.transcribe(stream, last);
        clearTimeout(stream.idleTimer);
        this.streams.delete(stream.key);
      }
    } catch (err) {
      console.error("[StreamManager] Stream processing failed:", err);
      stream.pending = new Float32Array(0);
    } finally {
      stream.draining = false;
    }
  }
  transcribe(stream, segment) {
    this.stats.segments += 1;
    this.stats.segmentSeconds += segment.length / SAMPLE_RATE;
    this.onState(stream.source, "busy");
    this.engine.queueAudio(segment, { ...this.getOptions(), speechChecked: true }).then(
      (result) => this.onResult(stream.source, result),
      (err) => {
        console.warn("[StreamManager] Segment was not transcribed:", err && err.message);
        this.onState(stream.source, "ready");
      }
    );
  }
}
