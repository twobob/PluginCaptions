// Turns a stream of audio frames, each with a speech probability, into
// segments worth transcribing. Pure logic with no browser dependencies.
//
// Whisper pays a fixed cost per segment and translates better with a whole
// phrase in view, so the aim is segments of a few seconds that end at a real
// pause in the speech, never fragments and never music on its own.
export const FRAME_SAMPLES = 512;
export const SAMPLE_RATE = 16e3;
const FRAME_SECONDS = FRAME_SAMPLES / SAMPLE_RATE;
// A frame starts speech at this probability and keeps it going down to the
// lower one, so a segment is not broken by a brief dip.
const SPEECH_ON = 0.5;
const SPEECH_OFF = 0.35;
const PRE_ROLL_SECONDS = 0.3;
const TRAIL_SECONDS = 0.2;
// Below the minimum length a pause must be this long to end the segment
// (the speaker has really stopped). Above it, a shorter pause is enough.
const LONG_PAUSE_SECONDS = 0.8;
const MIN_SEGMENT_SECONDS = 2.5;
const PAUSE_SECONDS = 0.4;
// Past the target length the first small gap between words ends the segment.
const GAP_SECONDS = 0.16;
// A segment needs at least this much detected speech to be worth sending.
const MIN_SPEECH_SECONDS = 0.25;
// When the hard limit is hit mid-speech, look this far back for the best
// place to cut.
const CUT_SEARCH_SECONDS = 2.5;
const frames = (seconds) => Math.max(1, Math.round(seconds / FRAME_SECONDS));
export class Segmenter {
  constructor({ targetSeconds = 5, maxSeconds = 8 } = {}) {
    this.configure({ targetSeconds, maxSeconds });
    this.preRoll = [];
    this.reset();
  }
  configure({ targetSeconds, maxSeconds }) {
    if (Number.isFinite(targetSeconds)) this.targetFrames = frames(targetSeconds);
    if (Number.isFinite(maxSeconds)) this.maxFrames = frames(maxSeconds);
    // The limit must leave room beyond the target to find a gap.
    this.maxFrames = Math.max(this.maxFrames, this.targetFrames + frames(1));
  }
  reset() {
    this.active = false;
    this.inSpeech = false;
    this.frames = [];
    this.speech = [];
    this.energy = [];
    this.silenceRun = 0;
  }
  get isActive() {
    return this.active;
  }
  /**
   * Adds one frame of FRAME_SAMPLES samples with its speech probability.
   * Returns the segments completed by this frame (usually none, at most one).
   */
  push(frame, probability) {
    const isSpeech = probability >= (this.inSpeech ? SPEECH_OFF : SPEECH_ON);
    this.inSpeech = isSpeech;
    if (!this.active) {
      if (!isSpeech) {
        this.preRoll.push(frame);
        if (this.preRoll.length > frames(PRE_ROLL_SECONDS)) this.preRoll.shift();
        return [];
      }
      this.active = true;
      for (const earlier of this.preRoll) this.append(earlier, false);
      this.preRoll = [];
      this.append(frame, true);
      this.silenceRun = 0;
      return [];
    }
    this.append(frame, isSpeech);
    this.silenceRun = isSpeech ? 0 : this.silenceRun + 1;
    const length = this.frames.length;
    const pauseEnds = this.silenceRun >= frames(LONG_PAUSE_SECONDS) || length >= frames(MIN_SEGMENT_SECONDS) && this.silenceRun >= frames(PAUSE_SECONDS) || length >= this.targetFrames && this.silenceRun >= frames(GAP_SECONDS);
    if (pauseEnds) {
      const segment = this.take(length - Math.max(0, this.silenceRun - frames(TRAIL_SECONDS)));
      // What follows the cut is silence: keep it as pre-roll for the next segment.
      this.preRoll = this.frames.slice(-frames(PRE_ROLL_SECONDS));
      this.reset();
      return segment ? [segment] : [];
    }
    if (length >= this.maxFrames) {
      const cut = this.findCut();
      const segment = this.take(cut);
      // Speech continues: the rest becomes the start of the next segment.
      this.frames = this.frames.slice(cut);
      this.speech = this.speech.slice(cut);
      this.energy = this.energy.slice(cut);
      return segment ? [segment] : [];
    }
    return [];
  }
  /** Ends the stream: returns the segment in progress, if it holds speech. */
  flush() {
    if (!this.active) {
      this.preRoll = [];
      return null;
    }
    const segment = this.take(this.frames.length - Math.max(0, this.silenceRun - frames(TRAIL_SECONDS)));
    this.preRoll = [];
    this.reset();
    return segment;
  }
  append(frame, isSpeech) {
    let sum = 0;
    for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i];
    this.frames.push(frame);
    this.speech.push(isSpeech);
    this.energy.push(sum / frame.length);
  }
  /** Joins the first `count` frames into one segment, or null if they hold too little speech. */
  take(count) {
    let speechFrames = 0;
    for (let i = 0; i < count; i++) if (this.speech[i]) speechFrames += 1;
    if (speechFrames < frames(MIN_SPEECH_SECONDS)) return null;
    const out = new Float32Array(count * FRAME_SAMPLES);
    for (let i = 0; i < count; i++) out.set(this.frames[i], i * FRAME_SAMPLES);
    return out;
  }
  /**
   * Picks where to split a segment that hit the length limit while speech was
   * still going: a non-speech frame if there is one, otherwise the quietest
   * moment, searching the last couple of seconds.
   */
  findCut() {
    const length = this.frames.length;
    const from = Math.max(frames(MIN_SEGMENT_SECONDS), length - frames(CUT_SEARCH_SECONDS));
    const to = length - frames(TRAIL_SECONDS);
    let best = to;
    let bestScore = Infinity;
    for (let i = from; i <= to; i++) {
      // Smooth over three frames so one stray quiet sample does not win.
      const e = (this.energy[i - 1] + this.energy[i] + (this.energy[i + 1] ?? this.energy[i])) / 3;
      const score = (this.speech[i] ? 1 : 0) + e / (e + 1e-4);
      if (score < bestScore) {
        bestScore = score;
        best = i;
      }
    }
    return best;
  }
}
