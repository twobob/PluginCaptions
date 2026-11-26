import test from "node:test";
import assert from "node:assert/strict";
import { AudioProcessor, isCapturableMedia } from "../src/content/audio-processor.js";

const INPUT_RATE = 48e3;
const FRAME = 4096;
const BATCH = 5120;

function tone(amplitude) {
  const frame = new Float32Array(FRAME);
  for (let i = 0; i < FRAME; i++) frame[i] = amplitude * Math.sin(2 * Math.PI * 440 * i / INPUT_RATE);
  return frame;
}

function harness() {
  const batches = [];
  const processor = new AudioProcessor({ onAudio: (samples) => batches.push(samples) });
  const feed = (amplitude, frames) => {
    for (let i = 0; i < frames; i++) processor.processIncomingSamples(tone(amplitude), INPUT_RATE);
  };
  return { processor, batches, feed };
}
const peakOf = (samples) => samples.reduce((m, v) => Math.max(m, Math.abs(v)), 0);

test("audio is delivered as fixed-size 16 kHz batches with nothing lost", () => {
  const { batches, feed } = harness();
  feed(0.3, 30);
  const expected = Math.floor(30 * Math.round(FRAME / 3) / BATCH);
  assert.equal(batches.length, expected);
  for (const batch of batches) {
    assert.ok(batch instanceof Float32Array);
    assert.equal(batch.length, BATCH);
  }
});

test("quiet audio is raised towards a usable level, loud audio is left alone", () => {
  const quiet = harness();
  quiet.feed(0.01, 12);
  assert.ok(peakOf(quiet.batches[0]) > 0.25, "gain should be applied to a quiet player");
  assert.ok(peakOf(quiet.batches[0]) <= 0.5 + 1e-6);
  const loud = harness();
  loud.feed(0.9, 12);
  assert.ok(Math.abs(peakOf(loud.batches[0]) - 0.9) < 0.02, "audio above the target is not changed");
});

test("gain never pushes a sudden loud sound into clipping", () => {
  const { batches, feed } = harness();
  feed(0.01, 12);
  feed(0.8, 12);
  for (const batch of batches) assert.ok(peakOf(batch) <= 1);
});

test("digital silence stops being sent after a short tail and resumes with sound", () => {
  const { batches, feed } = harness();
  feed(0.3, 8);
  const before = batches.length;
  feed(0, 200);
  const tail = batches.length - before;
  assert.ok(tail >= 5 && tail <= 8, `expected about two seconds of silence to be sent, got ${tail} batches`);
  feed(0.3, 8);
  assert.ok(batches.length > before + tail, "sending resumes when sound returns");
});

test("resampling keeps duration and stays in range", () => {
  const processor = new AudioProcessor();
  const out = processor.resampleTo16k(tone(0.5), 44100);
  assert.equal(out.length, Math.round(FRAME / (44100 / 16e3)));
  assert.ok(out.every((v) => Number.isFinite(v) && Math.abs(v) <= 0.5 + 1e-6));
  const same = new Float32Array(160);
  assert.equal(processor.resampleTo16k(same, 16e3), same);
});

test("isCapturableMedia leaves cross-origin media without CORS alone", () => {
  const page = { href: "https://example.org/watch", origin: "https://example.org" };
  const el = (props) => ({ srcObject: null, currentSrc: "", src: "", crossOrigin: null, ...props });
  assert.equal(isCapturableMedia(el({ currentSrc: "https://example.org/a.mp4" }), page), true);
  assert.equal(isCapturableMedia(el({ currentSrc: "blob:https://example.org/1234" }), page), true);
  assert.equal(isCapturableMedia(el({ src: "/relative/a.mp4" }), page), true);
  assert.equal(isCapturableMedia(el({ srcObject: {} }), page), true);
  assert.equal(isCapturableMedia(el({}), page), true);
  assert.equal(isCapturableMedia(el({ currentSrc: "https://cdn.example.net/a.mp4" }), page), false);
  assert.equal(isCapturableMedia(el({ currentSrc: "https://cdn.example.net/a.mp4", crossOrigin: "anonymous" }), page), true);
});
