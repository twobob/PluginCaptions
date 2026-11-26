// Live trial: loads the built extension into a throwaway Firefox profile, opens
// a page that plays media (a Twitch stream, a video site) and prints what the
// extension produces: every chunk it transcribed, the caption, and timings.
//
//   node scripts/firefox-try.mjs <url> [options]
//   node scripts/firefox-try.mjs --file clip.wav [options]
//
//   --file PATH       play a local audio file instead of opening a URL
//   --reference PATH  text of what is said, to score the Russian transcription
//   --seconds N       how long to watch (default 90)
//   --headed          show the browser window (default: headless)
//   --dual            also show the Russian transcription for each chunk
//   --set key=value   override a setting, repeatable (e.g. --set maxChunkSeconds=6)
//   --extension PATH  unpacked directory or .xpi (default: dist/)
//   --volume X        output volume scale, 0 to 1 (default 0.01, near silent)
//   --json FILE       also write the full result log as JSON
//   --engine JSON     backend override, e.g. '{"device":"wasm","dtype":"q8"}'
//   --bench           time the model at the end (fixed cost vs per-token cost)
//
// The browser profile is kept in the system temp directory between runs so the
// model is only downloaded once. It holds nothing but that cache.
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { installExtension, launchFirefox, openExtensionChannel, sleep, waitFor } from "./lib/firefox.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
function option(name, fallback) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : fallback;
}
function options(name) {
  const out = [];
  argv.forEach((arg, i) => {
    if (arg === name) out.push(argv[i + 1]);
  });
  return out;
}
let url = argv.find((a) => /^https?:\/\//.test(a));
const filePath = option("--file", null);
const referencePath = option("--reference", null);
let seconds = Number(option("--seconds", "90"));
const headed = argv.includes("--headed");
const extensionPath = path.resolve(option("--extension", path.join(ROOT, "dist")));
const jsonPath = option("--json", null);
const settings = {};
if (argv.includes("--dual")) settings.showDualSubtitles = true;
for (const pair of options("--set")) {
  const [key, raw] = pair.split("=");
  settings[key] = raw === "true" ? true : raw === "false" ? false : Number.isNaN(Number(raw)) ? raw : Number(raw);
}

const PAGE_STATE = `
  const panel = document.getElementById("rutranscribe-pinned");
  const q = (sel) => panel && panel.shadowRoot && panel.shadowRoot.querySelector(sel);
  const media = [...document.querySelectorAll("video, audio")].map((m) => ({
    tag: m.tagName, paused: m.paused, muted: m.muted, volume: m.volume,
    ready: m.readyState, time: Math.round(m.currentTime * 10) / 10,
    src: (m.currentSrc || "").slice(0, 40), stream: !!m.srcObject
  }));
  return { panel: !!panel, status: q(".status-pill") ? q(".status-pill").textContent : null, media };`;

// Gets playback going on players that wait for a click (age gates, muted
// autoplay). Uses the site's own buttons where they exist.
const START_PLAYBACK = `
  const click = (sel) => { const el = document.querySelector(sel); if (el) el.click(); return !!el; };
  click('[data-a-target="content-classification-gate-overlay-start-watching-button"]');
  click('[data-a-target="player-overlay-mature-accept"]');
  for (const m of document.querySelectorAll("video, audio")) {
    if (m.muted && !click('[data-a-target="player-mute-unmute-button"]')) m.muted = false;
    if (m.paused) m.play().catch(() => {});
  }
  return true;`;

/** Serves one audio file on a local page and returns its URL and duration. */
function serveFile(file) {
  const data = fs.readFileSync(file);
  const byteRate = data.readUInt32LE(28);
  const duration = (data.length - 44) / byteRate;
  const server = http.createServer((req, res) => {
    if (req.url.startsWith("/clip")) {
      res.writeHead(200, { "Content-Type": "audio/wav", "Content-Length": data.length, "Accept-Ranges": "none" });
      res.end(data);
    } else {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(`<!doctype html><meta charset="utf-8"><title>clip</title><audio id="a" src="/clip.wav" autoplay></audio>`);
    }
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => {
    resolve({ server, duration, url: `http://127.0.0.1:${server.address().port}/` });
  }));
}

function words(text) {
  return text.toLowerCase().replace(/ё/g, "е").replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter(Boolean);
}

/** Share of the reference words that appear in the output (order ignored). */
function wordRecall(reference, output) {
  const pool = new Map();
  for (const w of words(output)) pool.set(w, (pool.get(w) || 0) + 1);
  const ref = words(reference);
  let hit = 0;
  for (const w of ref) {
    const left = pool.get(w) || 0;
    if (left > 0) {
      hit += 1;
      pool.set(w, left - 1);
    }
  }
  return { hit, total: ref.length };
}

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

async function main() {
  let served = null;
  if (filePath) {
    served = await serveFile(path.resolve(filePath));
    url = served.url;
    if (!argv.includes("--seconds")) seconds = Math.ceil(served.duration + 14);
  }
  if (!url) {
    console.error("Usage: node scripts/firefox-try.mjs <url | --file clip.wav> [--seconds N] [--headed] [--dual] [--set key=value]");
    process.exit(2);
  }
  const browser = await launchFirefox({
    headless: !headed,
    profileDir: path.join(os.tmpdir(), "rutranscribe-try-profile"),
    prefs: { "media.volume_scale": String(option("--volume", "0.01")) }
  });
  const client = browser.client;
  const log = [];
  try {
    const addon = await installExtension(client, extensionPath);
    console.log(`Firefox ${browser.version}${headed ? "" : " (headless)"}, extension ${addon.id}`);
    const { ask, setStorage } = await openExtensionChannel(client, addon);
    const engineOverride = option("--engine", null);
    await setStorage("engineOverride", engineOverride ? JSON.parse(engineOverride) : null);
    if (engineOverride) console.log(`Engine override: ${engineOverride}`);
    if (Object.keys(settings).length) {
      const res = await ask({ type: "UPDATE_SETTINGS", settings });
      console.log("Settings applied:", JSON.stringify(settings), res.success ? "" : JSON.stringify(res));
    }

    console.log(`Opening ${url}`);
    await client.send("WebDriver:Navigate", { url }).catch((err) => console.log(`Navigation: ${err.message}`));
    const started = Date.now();
    const stamp = () => `[${((Date.now() - started) / 1e3).toFixed(0).padStart(3)}s]`;
    await waitFor("captured media", async () => {
      await client.content(START_PLAYBACK).catch(() => {
      });
      const state = await client.content(PAGE_STATE).catch(() => null);
      return state && state.panel ? state : null;
    }, 45e3, 1500).catch(() => null);
    const first = await client.content(PAGE_STATE);
    console.log(`${stamp()} media: ${JSON.stringify(first.media)}`);
    console.log(`${stamp()} panel: ${first.panel ? first.status : "not shown (nothing captured)"}`);

    let seen = 0;
    let lastStatus = "";
    const deadline = Date.now() + seconds * 1e3;
    while (Date.now() < deadline) {
      await sleep(4e3);
      const diag = await ask({ type: "GET_ENGINE_DIAGNOSTICS" });
      if (!diag.success) {
        console.log(`${stamp()} diagnostics unavailable: ${diag.error}`);
        continue;
      }
      if (diag.status.status !== lastStatus && !diag.status.isReady) {
        lastStatus = diag.status.status;
        console.log(`${stamp()} engine: ${lastStatus}`);
      }
      const fresh = diag.recent.filter((r) => r.at > seen);
      for (const r of fresh) {
        seen = r.at;
        log.push(r);
        const head = `${stamp()} ${r.audioSeconds.toFixed(1)}s audio, ${String(r.latencyMs).padStart(4)}ms (+${r.waitMs}ms queued)`;
        if (r.text) {
          console.log(`${head}  EN: ${r.text}`);
          if (r.russianText) console.log(`${" ".repeat(head.length)}  RU: ${r.russianText}`);
        } else {
          console.log(`${head}  (filtered) raw: ${JSON.stringify(r.rawText)}`);
        }
      }
    }

    const diag = await ask({ type: "GET_ENGINE_DIAGNOSTICS" });
    const page = await client.content(PAGE_STATE).catch(() => null);
    console.log("\n--- Summary ---");
    if (diag.success) {
      const { stats, status } = diag;
      const lat = log.map((r) => r.latencyMs);
      const len = log.map((r) => r.audioSeconds);
      console.log(`Backend: ${status.device}${status.gpuInfo ? ` (${status.gpuInfo.description || status.gpuInfo.vendor})` : ""}, model ${status.model}`);
      console.log(`Chunks: ${stats.processed} transcribed, ${stats.filtered} filtered as noise or hallucination, ${stats.dropped} dropped (engine too slow), ${stats.failed} failed, ${stats.noSpeech || 0} skipped as no speech`);
      console.log(`Chunk length: median ${median(len).toFixed(1)}s, max ${Math.max(0, ...len).toFixed(1)}s`);
      console.log(`Latency: median ${median(lat)}ms, max ${Math.max(0, ...lat)}ms`);
      if (stats.audioSeconds > 0) {
        console.log(`Speed: ${(stats.latencyMs / 1e3 / stats.audioSeconds).toFixed(2)}x real time (below 1 keeps up)`);
        console.log(`Speech sent for transcription: ${stats.audioSeconds.toFixed(0)}s of ${seconds}s watched`);
      }
    }
    if (diag.success && diag.streams) {
      const st = diag.streams;
      console.log(`Stream: ${st.audioSeconds.toFixed(0)}s of audio received, ${st.segments} speech segments (${st.segmentSeconds.toFixed(0)}s) found by the ${st.detector} detector, ${st.discardedSeconds.toFixed(0)}s discarded as backlog`);
    }
    if (page) console.log(`Final media state: ${JSON.stringify(page.media)}`);
    if (argv.includes("--bench")) {
      await client.send("WebDriver:SetTimeouts", { script: 18e4 });
      const bench = await ask({ type: "BENCHMARK_ENGINE" });
      if (bench.success) {
        const runs = bench.benchmark.runs;
        const best = (n) => Math.min(...runs.filter((r) => r.maxNewTokens === n).map((r) => r.ms));
        console.log(`Benchmark on a ${bench.benchmark.audioSeconds.toFixed(1)}s chunk: ${runs.map((r) => `${r.maxNewTokens}tok=${r.ms}ms`).join(", ")}`);
        console.log(`  fixed cost about ${best(1)}ms, about ${Math.round((best(40) - best(12)) / 28)}ms per extra token`);
      } else {
        console.log(`Benchmark failed: ${bench.error}`);
      }
    }
    if (referencePath) {
      const reference = fs.readFileSync(referencePath, "utf8");
      const russian = log.map((r) => r.russianText).join(" ");
      const { hit, total } = wordRecall(reference, russian);
      console.log(`Russian words recognised: ${hit} of ${total} (${Math.round(100 * hit / total)}%)${russian ? "" : "  [needs --dual]"}`);
    }
    if (jsonPath) {
      fs.writeFileSync(jsonPath, JSON.stringify({ url, settings, diag, log }, null, 2));
      console.log(`Full log written to ${jsonPath}`);
    }
  } finally {
    await browser.close();
    if (served) served.server.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
