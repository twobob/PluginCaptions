import { AutoModel, Tensor } from "@huggingface/transformers";
import { VAD_MODEL_ID, VAD_MODEL_REVISION } from "../utils/constants.js";
import { FRAME_SAMPLES, SAMPLE_RATE } from "./segmenter.js";
// Silero VAD expects each frame to be preceded by the tail of the previous
// one. Without that context it mistakes loud music for speech.
const CONTEXT_SAMPLES = 64;
const RETRY_COOLDOWN_MS = 3e4;
const SPEECH_THRESHOLD = 0.5;
/**
 * Neural speech detector (Silero VAD, about 2 MB, runs on the CPU). It tells
 * speech from music and noise, which a loudness threshold cannot do.
 */
export class SpeechDetector {
  constructor() {
    this.model = null;
    this.sampleRateTensor = null;
    this.loadPromise = null;
    this.lastFailureAt = 0;
  }
  get available() {
    return !!this.model;
  }
  /** Resolves to true when the model is ready. Never rejects. */
  load() {
    if (this.model) return Promise.resolve(true);
    if (this.loadPromise) return this.loadPromise;
    if (Date.now() - this.lastFailureAt < RETRY_COOLDOWN_MS) return Promise.resolve(false);
    this.loadPromise = (async () => {
      try {
        const model = await AutoModel.from_pretrained(VAD_MODEL_ID, {
          config: { model_type: "custom" },
          dtype: "fp32",
          device: "wasm",
          revision: VAD_MODEL_REVISION
        });
        this.sampleRateTensor = new Tensor("int64", BigInt64Array.from([BigInt(SAMPLE_RATE)]), []);
        this.model = model;
        return true;
      } catch (err) {
        console.warn("[SpeechDetector] Could not load the speech detector, using loudness instead:", err);
        this.lastFailureAt = Date.now();
        return false;
      } finally {
        this.loadPromise = null;
      }
    })();
    return this.loadPromise;
  }
  /** Per-stream memory. The detector is recurrent, so each stream needs its own. */
  createState() {
    return { recurrent: null, context: new Float32Array(CONTEXT_SAMPLES) };
  }
  /** Probability (0 to 1) that the frame of FRAME_SAMPLES samples contains speech. */
  async probability(state, frame) {
    if (!this.model) return loudnessGuess(frame);
    const input = new Float32Array(CONTEXT_SAMPLES + FRAME_SAMPLES);
    input.set(state.context, 0);
    input.set(frame, CONTEXT_SAMPLES);
    state.context = frame.slice(FRAME_SAMPLES - CONTEXT_SAMPLES);
    if (!state.recurrent) state.recurrent = new Tensor("float32", new Float32Array(2 * 128), [2, 1, 128]);
    const result = await this.model({
      input: new Tensor("float32", input, [1, input.length]),
      sr: this.sampleRateTensor,
      state: state.recurrent
    });
    state.recurrent = result.stateN;
    return result.output.data[0];
  }
  /** Seconds of speech found in a whole chunk of 16 kHz audio. */
  async speechSeconds(audio) {
    const state = this.createState();
    let speechFrames = 0;
    for (let offset = 0; offset + FRAME_SAMPLES <= audio.length; offset += FRAME_SAMPLES) {
      const p = await this.probability(state, audio.subarray(offset, offset + FRAME_SAMPLES));
      if (p >= SPEECH_THRESHOLD) speechFrames += 1;
    }
    return speechFrames * FRAME_SAMPLES / SAMPLE_RATE;
  }
}
/** Fallback when the model is unavailable: any clearly audible frame counts. */
function loudnessGuess(frame) {
  let sum = 0;
  for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i];
  return Math.sqrt(sum / frame.length) >= 0.02 ? 0.9 : 0.05;
}
