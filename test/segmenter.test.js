import test from "node:test";
import assert from "node:assert/strict";
import { FRAME_SAMPLES, SAMPLE_RATE, Segmenter } from "../src/background/segmenter.js";

const FRAME_SECONDS = FRAME_SAMPLES / SAMPLE_RATE;
const framesFor = (seconds) => Math.round(seconds / FRAME_SECONDS);

/** Feeds `seconds` of audio at one speech probability; returns completed segments. */
function feed(segmenter, seconds, probability, level = 0.1) {
  const out = [];
  for (let i = 0; i < framesFor(seconds); i++) {
    out.push(...segmenter.push(new Float32Array(FRAME_SAMPLES).fill(level), probability));
  }
  return out;
}
const seconds = (segment) => segment.length / SAMPLE_RATE;

test("music or noise alone never produces a segment", () => {
  const s = new Segmenter();
  assert.deepEqual(feed(s, 60, 0.05), []);
  assert.equal(s.flush(), null);
});

test("a short phrase is sent once the speaker has clearly stopped", () => {
  const s = new Segmenter();
  feed(s, 1, 0.02);
  assert.deepEqual(feed(s, 1.2, 0.95), []);
  // A brief pause does not end a short segment...
  assert.deepEqual(feed(s, 0.5, 0.02), []);
  // ...a long one does.
  const out = feed(s, 0.6, 0.02);
  assert.equal(out.length, 1);
  assert.ok(seconds(out[0]) > 1.4 && seconds(out[0]) < 2.2, `got ${seconds(out[0])}s`);
});

test("pauses between words do not chop speech into fragments", () => {
  const s = new Segmenter();
  const out = [];
  // Fast chat: 0.6 s bursts with 0.2 s gaps, for about 4 seconds.
  for (let i = 0; i < 5; i++) {
    out.push(...feed(s, 0.6, 0.9), ...feed(s, 0.2, 0.1));
  }
  assert.deepEqual(out, [], "nothing should be sent before a real pause or the target length");
  out.push(...feed(s, 0.5, 0.05));
  assert.equal(out.length, 1);
  assert.ok(seconds(out[0]) > 3.8, `expected one segment of about 4s, got ${seconds(out[0])}s`);
});

test("past the target length the first gap between words ends the segment", () => {
  const s = new Segmenter({ targetSeconds: 5, maxSeconds: 8 });
  const out = [...feed(s, 5.3, 0.9), ...feed(s, 0.2, 0.1)];
  assert.equal(out.length, 1);
  assert.ok(seconds(out[0]) > 5 && seconds(out[0]) < 5.8, `got ${seconds(out[0])}s`);
});

test("non-stop speech is split at the limit, at the quietest point, and nothing is lost", () => {
  const s = new Segmenter({ targetSeconds: 5, maxSeconds: 8 });
  const out = [];
  out.push(...feed(s, 6.5, 0.95, 0.2));
  // A quiet (but still voiced) moment that makes the best place to cut.
  out.push(...feed(s, 0.2, 0.9, 0.01));
  out.push(...feed(s, 1.5, 0.95, 0.2));
  assert.equal(out.length, 1);
  const first = seconds(out[0]);
  assert.ok(first > 6.4 && first < 6.9, `cut should land in the quiet moment, got ${first}s`);
  assert.ok(s.isActive, "the remainder continues as the next segment");
  const rest = s.flush();
  assert.ok(Math.abs(first + seconds(rest) - 8.2) < 0.15, "both parts together cover all the audio");
});

test("segments never exceed the limit", () => {
  const s = new Segmenter({ targetSeconds: 4, maxSeconds: 6 });
  const out = feed(s, 40, 0.95);
  assert.ok(out.length >= 6);
  for (const segment of out) assert.ok(seconds(segment) <= 6 + FRAME_SECONDS);
});

test("a click or cough shorter than a quarter second is dropped", () => {
  const s = new Segmenter();
  feed(s, 1, 0.02);
  feed(s, 0.1, 0.9);
  assert.deepEqual(feed(s, 2, 0.02), []);
  assert.equal(s.isActive, false);
});

test("a segment starts slightly before the first detected speech", () => {
  const s = new Segmenter();
  feed(s, 2, 0.02, 0);
  feed(s, 1, 0.95, 0.3);
  const [segment] = feed(s, 1.2, 0.02, 0);
  // Pre-roll frames are silent (level 0), speech frames are not.
  const leadingSilence = segment.findIndex((v) => v !== 0) / SAMPLE_RATE;
  assert.ok(leadingSilence > 0.2 && leadingSilence < 0.4, `got ${leadingSilence}s of pre-roll`);
});

test("the limit is always kept above the target", () => {
  const s = new Segmenter({ targetSeconds: 6, maxSeconds: 3 });
  assert.ok(s.maxFrames > s.targetFrames);
});
