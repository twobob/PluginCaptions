// Builds repeatable test audio with a known script: Russian speech from the
// Windows built-in voice, mixed over generated stereo music. Windows only
// (it uses System.Speech through PowerShell). Output goes to .fixtures/.
//
//   node scripts/make-fixture.mjs
//
// Files written:
//   speech.wav             the voice alone
//   music.wav              the music alone
//   speech-over-music.wav  voice about 8 dB above the music (a typical stream)
//   speech-loud-music.wav  voice about 2 dB above the music (a hard case)
//   transcript.txt         what was said
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, ".fixtures");
const RATE = 44100;

const SCRIPT = [
  "Всем привет, друзья, мы снова в эфире.",
  "Сегодня у нас очень интересная тема для разговора.",
  "Я вчера весь вечер читал ваши сообщения в чате.",
  "Многие спрашивали, когда будет следующий большой стрим.",
  "Отвечаю: в субботу вечером, примерно в восемь часов.",
  "Кстати, спасибо большое всем, кто подписался на канал.",
  "Давайте посмотрим, что нам пишут зрители прямо сейчас.",
  "Кто-то говорит, что музыка играет слишком громко.",
  "Хорошо, я сделаю её немного тише, одну минуту.",
  "А пока расскажу вам смешную историю про моего кота.",
  "Он сегодня утром уронил чашку с кофе прямо на клавиатуру.",
  "Пришлось срочно ехать в магазин и покупать новую.",
  "Ладно, давайте вернёмся к нашей игре и продолжим.",
  "Напишите в чат, откуда вы сегодня смотрите трансляцию."
];

function synthesizeSpeech(wavPath) {
  const textPath = path.join(OUT, "transcript.txt");
  fs.writeFileSync(textPath, SCRIPT.join("\n"), "utf8");
  const ps = `
    Add-Type -AssemblyName System.Speech
    $s = New-Object System.Speech.Synthesis.SpeechSynthesizer
    $s.SelectVoice('Microsoft Irina Desktop')
    $s.Rate = 3
    $fmt = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(${RATE}, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
    $s.SetOutputToWaveFile('${wavPath.replace(/'/g, "''")}', $fmt)
    $text = Get-Content -Raw -Encoding UTF8 '${textPath.replace(/'/g, "''")}'
    $s.Speak($text)
    $s.Dispose()
  `;
  const res = spawnSync("powershell.exe", ["-NoProfile", "-Command", ps], { encoding: "utf8" });
  if (res.status !== 0) throw new Error(`Speech synthesis failed: ${res.stderr || res.stdout}`);
}

function readMonoWav(file) {
  const buf = fs.readFileSync(file);
  let offset = 12;
  let rate = RATE;
  let channels = 1;
  while (offset + 8 <= buf.length) {
    const id = buf.toString("ascii", offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    if (id === "fmt ") {
      channels = buf.readUInt16LE(offset + 10);
      rate = buf.readUInt32LE(offset + 12);
    } else if (id === "data") {
      const count = Math.floor(Math.min(size, buf.length - offset - 8) / 2 / channels);
      const out = new Float32Array(count);
      for (let i = 0; i < count; i++) out[i] = buf.readInt16LE(offset + 8 + i * 2 * channels) / 32768;
      if (rate !== RATE) throw new Error(`Unexpected sample rate ${rate}`);
      return out;
    }
    offset += 8 + size + (size & 1);
  }
  throw new Error("No data chunk in WAV");
}

function writeStereoWav(file, left, right) {
  const n = left.length;
  const data = Buffer.alloc(n * 4);
  for (let i = 0; i < n; i++) {
    data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, left[i])) * 32767), i * 4);
    data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, right[i])) * 32767), i * 4 + 2);
  }
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(2, 22);
  header.writeUInt32LE(RATE, 24);
  header.writeUInt32LE(RATE * 4, 28);
  header.writeUInt16LE(4, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(data.length, 40);
  fs.writeFileSync(file, Buffer.concat([header, data]));
}

/** Deterministic pseudo-random numbers so the fixture is identical every time. */
function makeRandom(seed) {
  let x = seed >>> 0;
  return () => {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    return x / 4294967296;
  };
}

/** A simple lo-fi backing track: wide detuned pads, bass, kick and hi-hat. */
function synthesizeMusic(samples) {
  const left = new Float32Array(samples);
  const right = new Float32Array(samples);
  const rand = makeRandom(12345);
  const bpm = 92;
  const beat = 60 / bpm;
  const chords = [
    [220, 261.63, 329.63],
    [174.61, 220, 261.63],
    [261.63, 329.63, 392],
    [196, 246.94, 293.66]
  ];
  const saw = (phase) => 2 * (phase - Math.floor(phase + 0.5));
  for (let i = 0; i < samples; i++) {
    const t = i / RATE;
    const bar = Math.floor(t / (beat * 4));
    const chord = chords[bar % chords.length];
    const inBeat = t % beat / beat;
    let l = 0;
    let r = 0;
    for (const f of chord) {
      // Detune the two sides against each other: this is what makes it wide.
      l += 0.11 * saw(t * f * 0.997) + 0.07 * Math.sin(2 * Math.PI * f * 2 * t);
      r += 0.11 * saw(t * f * 1.003) + 0.07 * Math.sin(2 * Math.PI * f * 2.005 * t);
    }
    const tremolo = 0.8 + 0.2 * Math.sin(2 * Math.PI * 0.4 * t);
    l *= tremolo;
    r *= tremolo;
    // Melody note on every half beat, panned side to side.
    const step = Math.floor(t / (beat / 2));
    const note = chord[step % 3] * 2;
    const noteEnv = Math.exp(-6 * (t % (beat / 2)) / (beat / 2));
    const pan = step % 2 ? 0.8 : 0.2;
    const lead = 0.12 * noteEnv * Math.sin(2 * Math.PI * note * t);
    l += lead * (1 - pan);
    r += lead * pan;
    // Centre content: bass, kick, hi-hat.
    const bass = 0.2 * Math.sin(2 * Math.PI * chord[0] / 2 * t) * (0.6 + 0.4 * Math.exp(-4 * inBeat));
    const kick = 0.45 * Math.exp(-18 * inBeat) * Math.sin(2 * Math.PI * (50 + 80 * Math.exp(-30 * inBeat)) * (t % beat));
    const hatPhase = t % (beat / 2) / (beat / 2);
    const hat = 0.06 * Math.exp(-40 * hatPhase) * (rand() * 2 - 1);
    l += bass + kick + hat;
    r += bass + kick + hat;
    left[i] = l;
    right[i] = r;
  }
  return { left, right };
}

function rms(samples, from = 0, to = samples.length) {
  let sum = 0;
  for (let i = from; i < to; i++) sum += samples[i] * samples[i];
  return Math.sqrt(sum / Math.max(1, to - from));
}

/** RMS over the loudest half of 50 ms frames, so pauses do not count. */
function activeRms(samples) {
  const frame = Math.round(RATE * 0.05);
  const levels = [];
  for (let i = 0; i + frame <= samples.length; i += frame) levels.push(rms(samples, i, i + frame));
  levels.sort((a, b) => b - a);
  const top = levels.slice(0, Math.max(1, Math.floor(levels.length / 2)));
  return Math.sqrt(top.reduce((s, v) => s + v * v, 0) / top.length);
}

/** Mixes voice (or null) over music (or null); the music sits snrDb below the voice level. */
function mix(voice, music, snrDb, voiceLevel = 0.12) {
  const n = (voice || music.left).length;
  const voiceGain = voice ? voiceLevel / activeRms(voice) : 0;
  let musicGain = 0;
  if (music) {
    const musicMid = new Float32Array(n);
    for (let i = 0; i < n; i++) musicMid[i] = (music.left[i] + music.right[i]) / 2;
    musicGain = voiceLevel / Math.pow(10, snrDb / 20) / rms(musicMid);
  }
  const left = new Float32Array(n);
  const right = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const v = voice ? voice[i] * voiceGain : 0;
    left[i] = v + (music ? music.left[i] * musicGain : 0);
    right[i] = v + (music ? music.right[i] * musicGain : 0);
  }
  return { left, right };
}

fs.mkdirSync(OUT, { recursive: true });
const rawSpeech = path.join(OUT, "speech-raw.wav");
synthesizeSpeech(rawSpeech);
const voice = readMonoWav(rawSpeech);
fs.rmSync(rawSpeech);
// Two seconds of lead-in and five of tail, so there is music with no speech.
const lead = new Float32Array(RATE * 2);
const padded = new Float32Array(lead.length + voice.length + RATE * 5);
padded.set(voice, lead.length);
const music = synthesizeMusic(padded.length);

const clean = mix(padded, null, 0);
writeStereoWav(path.join(OUT, "speech.wav"), clean.left, clean.right);
const musicOnly = mix(null, music, 8);
writeStereoWav(path.join(OUT, "music.wav"), musicOnly.left, musicOnly.right);
const typical = mix(padded, music, 8);
writeStereoWav(path.join(OUT, "speech-over-music.wav"), typical.left, typical.right);
const hard = mix(padded, music, 2);
writeStereoWav(path.join(OUT, "speech-loud-music.wav"), hard.left, hard.right);
console.log(`Wrote ${(padded.length / RATE).toFixed(1)}s fixtures to ${OUT}`);
