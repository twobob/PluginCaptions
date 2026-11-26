// End-to-end smoke test: loads the built extension into a throwaway headless
// Firefox profile and checks the behaviour that unit tests cannot reach.
//
//   node scripts/firefox-smoke.mjs            capture and UI checks only
//   node scripts/firefox-smoke.mjs --engine   also captions a real speech clip end to end
//                                             (downloads the models; needs the clips from
//                                             scripts/make-fixture.mjs and a visible window,
//                                             because headless Firefox has no WebGPU)
//
// Set FIREFOX_BIN to point at a specific Firefox binary. Output volume is
// scaled to 1% so the test tone is effectively silent.
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { installExtension, launchFirefox, openExtensionChannel, sleep, waitFor } from "./lib/firefox.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const extensionArg = process.argv.indexOf("--extension");
// Defaults to the unpacked build. Pass --extension <dir or .xpi> to test another one.
const DIST = extensionArg > 0 ? path.resolve(process.argv[extensionArg + 1]) : path.join(ROOT, "dist");
const WITH_ENGINE = process.argv.includes("--engine");
const SPEECH_CLIP = path.join(ROOT, ".fixtures", "speech-over-music.wav");
const ENGINE_TIMEOUT_MS = 6 * 60 * 1e3;

/** Mono 16-bit WAV: bursts of a 440 Hz tone separated by silence. */
function makeToneWav() {
  const rate = 44100;
  const seconds = 12;
  const samples = rate * seconds;
  const data = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) {
    const t = i / rate;
    const on = t % 2 < 1.2;
    const value = on ? 0.8 * Math.sin(2 * Math.PI * 440 * t) : 0;
    data.writeInt16LE(Math.round(value * 32767), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

function startServer() {
  const wav = makeToneWav();
  const page = (audioAttrs) => `<!doctype html><meta charset="utf-8"><title>smoke</title>
<audio id="a" loop ${audioAttrs}></audio>
<script>document.getElementById("a").volume = 0.3;</script>`;
  const server = http.createServer((req, res) => {
    const port = server.address().port;
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname === "/tone.wav") {
      res.writeHead(200, { "Content-Type": "audio/wav", "Content-Length": wav.length, "Accept-Ranges": "none" });
      res.end(wav);
    } else if (url.pathname === "/speech.wav" && fs.existsSync(SPEECH_CLIP)) {
      const clip = fs.readFileSync(SPEECH_CLIP);
      res.writeHead(200, { "Content-Type": "audio/wav", "Content-Length": clip.length, "Accept-Ranges": "none" });
      res.end(clip);
    } else if (url.pathname === "/speech.html") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(`<!doctype html><meta charset="utf-8"><title>speech</title><audio id="a" src="/speech.wav"></audio>`);
    } else if (url.pathname === "/same-origin.html") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(page(`src="/tone.wav"`));
    } else if (url.pathname === "/muted.html") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(page(`src="/tone.wav" muted`));
    } else if (url.pathname === "/cross-origin.html") {
      // Same server under a different host name is a different origin, and
      // the response carries no CORS headers.
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(page(`src="http://localhost:${port}/tone.wav"`));
    } else if (url.pathname === "/idle.html") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<!doctype html><title>idle</title><p>No media here.</p>");
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

const results = [];
function record(name, ok, detail = "") {
  results.push({ name, ok });
  console.log(`${ok ? "ok  " : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}

const UI_STATE = `
  const panel = document.getElementById("rutranscribe-pinned");
  const overlay = document.getElementById("rutranscribe-root");
  const q = (sel) => panel && panel.shadowRoot && panel.shadowRoot.querySelector(sel);
  const a = document.getElementById("a");
  return {
    panel: !!panel,
    overlay: !!overlay,
    status: q(".status-pill") ? q(".status-pill").textContent : null,
    latency: q(".latency-badge") ? q(".latency-badge").textContent : null,
    caption: overlay && overlay.shadowRoot ? overlay.shadowRoot.querySelector(".primary-text").textContent : null,
    paused: a ? a.paused : null,
    time: a ? a.currentTime : null
  };`;
const TAB_AUDIBLE = `return window.gBrowser.selectedTab.hasAttribute("soundplaying");`;

async function main() {
  if (!fs.existsSync(DIST)) {
    throw new Error(`${DIST} is missing. Run \`npm run build\` first.`);
  }
  const server = await startServer();
  const base = `http://127.0.0.1:${server.address().port}`;
  // Output volume is scaled to 1% so the test tone is effectively silent.
  const browser = await launchFirefox({
    headless: !WITH_ENGINE,
    // The end-to-end run keeps its profile so the models are downloaded once.
    profileDir: WITH_ENGINE ? path.join(os.tmpdir(), "rutranscribe-try-profile") : null,
    prefs: { "media.volume_scale": "0.01" }
  });
  const client = browser.client;
  try {
    console.log(`Firefox ${browser.version}, extension from ${DIST}`);
    const addon = await installExtension(client, DIST);
    record("extension installs as a temporary add-on", !!addon.id, addon.id);
    const { ask } = await openExtensionChannel(client, addon);
    // A reused profile may hold settings from an earlier run.
    await ask({ type: "UPDATE_SETTINGS", settings: { enabled: true, pinned: true, showDualSubtitles: false } });

    // 1. A page without media gets no injected UI at all.
    await client.send("WebDriver:Navigate", { url: `${base}/idle.html` });
    await sleep(1500);
    let ui = await client.content(UI_STATE);
    record("no UI is injected into a page without media", !ui.panel && !ui.overlay);

    // 2. Same-origin media: nothing until playback, then capture and HUD.
    await client.send("WebDriver:Navigate", { url: `${base}/same-origin.html` });
    await sleep(1e3);
    ui = await client.content(UI_STATE);
    record("no UI before media starts playing", !ui.panel && !ui.overlay);
    await client.content(`return document.getElementById("a").play().then(() => true);`);
    ui = await waitFor("pinned panel", async () => {
      const s = await client.content(UI_STATE);
      return s.panel ? s : null;
    }).catch(() => null);
    record("pinned panel appears once media is captured", !!ui, ui ? ui.status : "");
    await sleep(2500);
    record("captured media is still audible", await client.chrome(TAB_AUDIBLE));
    const t1 = (await client.content(UI_STATE)).time;
    await sleep(1e3);
    const t2 = (await client.content(UI_STATE)).time;
    record("playback keeps advancing while captured", t2 > t1, `${t1.toFixed(2)}s -> ${t2.toFixed(2)}s`);
    const received = await waitFor("audio to reach the background", async () => {
      const diag = await ask({ type: "GET_ENGINE_DIAGNOSTICS" });
      return diag.success && diag.streams.audioSeconds > 1 ? diag.streams : null;
    }, 2e4, 1e3).catch(() => null);
    record("page audio is streamed to the background", !!received, received ? `${received.audioSeconds.toFixed(1)}s` : "");
    const toneStats = received && (await ask({ type: "GET_ENGINE_DIAGNOSTICS" })).streams;
    record("a plain tone is not mistaken for speech", !!toneStats && toneStats.segments === 0, toneStats ? `${toneStats.detector} detector` : "");

    // 3. Pause and resume goes through the detach and re-attach path.
    await client.content(`document.getElementById("a").pause(); return true;`);
    await sleep(800);
    await client.content(`return document.getElementById("a").play().then(() => true);`);
    await sleep(2500);
    record("audible again after pause and resume", await client.chrome(TAB_AUDIBLE));

    // 4. Disabling captions must not silence the page.
    await client.content(`document.getElementById("rutranscribe-pinned").shadowRoot.querySelector(".btn-power").click(); return true;`);
    const disabled = await waitFor("disabled status", async () => {
      const s = await client.content(UI_STATE);
      return /disabled/i.test(s.status || "") ? s : null;
    }).catch(() => null);
    record("HUD button disables captions", !!disabled);
    await sleep(4500);
    record("media is still audible after disabling captions", await client.chrome(TAB_AUDIBLE));
    await client.content(`document.getElementById("rutranscribe-pinned").shadowRoot.querySelector(".btn-power").click(); return true;`);
    const enabled = await waitFor("enabled status", async () => {
      const s = await client.content(UI_STATE);
      return s.status && !/disabled/i.test(s.status) ? s : null;
    }).catch(() => null);
    record("HUD button enables captions again", !!enabled);

    // The page's own mute control must keep working on captured media. This
    // also proves the audibility probe can report silence.
    await client.content(`document.getElementById("a").muted = true; return true;`);
    const silenced = await waitFor("tab to go quiet", async () => !await client.chrome(TAB_AUDIBLE), 12e3, 500).catch(() => false);
    record("muting the element silences captured media", !!silenced);
    await client.content(`document.getElementById("a").muted = false; return true;`);
    const unmuted = await waitFor("tab to be audible", () => client.chrome(TAB_AUDIBLE), 12e3, 500).catch(() => false);
    record("unmuting restores sound", !!unmuted);

    // 5. Optional: real Russian speech over music, captioned end to end.
    if (WITH_ENGINE && !fs.existsSync(SPEECH_CLIP)) {
      console.log("skip  end-to-end captioning (run `node scripts/make-fixture.mjs` first)");
    } else if (WITH_ENGINE) {
      console.log("Captioning a speech clip (the first run downloads the models)...");
      await client.send("WebDriver:Navigate", { url: `${base}/speech.html` });
      await client.content(`return document.getElementById("a").play().then(() => true);`);
      const captioned = await waitFor("a caption", async () => {
        const state = await client.content(UI_STATE);
        return state.caption ? state : null;
      }, ENGINE_TIMEOUT_MS, 2e3).catch(() => null);
      record("speech over music produces a caption on the page", !!captioned, captioned ? JSON.stringify(captioned.caption) : "");
      const diag = await ask({ type: "GET_ENGINE_DIAGNOSTICS" });
      record("the neural speech detector is in use", diag.success && diag.streams.detector === "silero", diag.success ? diag.streams.detector : diag.error);
      // Segments that arrive while the model is still loading are dropped on purpose.
      record("no segment failed", diag.success && diag.stats.failed === 0 && diag.stats.processed > 0, diag.success ? `${diag.stats.processed} transcribed, ${diag.stats.dropped} dropped while loading` : "");
    }

    // 6. Muted media is left alone.
    await client.send("WebDriver:Navigate", { url: `${base}/muted.html` });
    await client.content(`return document.getElementById("a").play().then(() => true);`);
    await sleep(3e3);
    ui = await client.content(UI_STATE);
    record("muted media is not captured", !ui.panel && !ui.paused);

    // 7. Cross-origin media without CORS is left alone and stays audible.
    await client.send("WebDriver:Navigate", { url: `${base}/cross-origin.html` });
    await client.content(`return document.getElementById("a").play().then(() => true);`);
    await sleep(3500);
    ui = await client.content(UI_STATE);
    record("cross-origin media without CORS is not captured", !ui.panel && !ui.paused);
    record("cross-origin media stays audible", await client.chrome(TAB_AUDIBLE));
  } finally {
    await browser.close();
    server.close();
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length} of ${results.length} checks passed`);
  if (failed.length) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
