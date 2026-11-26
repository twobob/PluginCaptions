# Building & Architecture

## Architecture

```
PluginCaptions/
├── dist/                        # Production-ready extension bundle (generated)
│   ├── manifest.json            # Firefox Manifest V3
│   ├── background.html          # Engine host (event page)
│   ├── popup.html               # Toolbar popup UI
│   ├── dashboard.html           # Live audio studio & test lab
│   ├── content.js               # Standalone IIFE content script
│   ├── wasm/                    # ONNX Runtime WebGPU/WASM binaries
│   ├── icons/                   # Extension icons (16, 32, 48, 128)
│   └── assets/                  # Minified scripts & styles
├── src/
│   ├── background/
│   │   ├── background.js        # Message bus & extension state manager
│   │   ├── stream-manager.js    # One audio stream per page frame
│   │   ├── speech-detector.js   # Silero VAD: tells speech from music
│   │   ├── segmenter.js         # Cuts speech into phrase-sized segments
│   │   └── whisper-engine.js    # Transformers.js Whisper pipeline & queue
│   ├── content/
│   │   ├── content.js           # Media event routing & lazy UI
│   │   ├── audio-processor.js   # Capture, 16 kHz resampling, gain
│   │   ├── caption-ui.js        # Shadow DOM draggable subtitle overlay
│   │   └── pinned-panel.js      # In-page control HUD
│   ├── popup/                   # Diagnostics, settings, WebGPU detector
│   ├── dashboard/               # Mic capture, file drop, waveform visualizer
│   └── utils/
│       ├── constants.js         # Defaults, message types, settings validation
│       └── webgpu-detector.js   # WebGPU device and adapter inspector
├── test/                        # Unit tests (node:test)
├── scripts/
│   ├── firefox-smoke.mjs        # End-to-end checks in Firefox
│   ├── firefox-try.mjs          # Live trial on a URL or clip, with timings
│   ├── make-fixture.mjs         # Builds speech-over-music test clips (Windows)
│   └── lib/firefox.mjs          # Drives a throwaway Firefox via Marionette
├── package.json
└── vite.config.js               # Multi-page build configuration
```

### How it fits together

1. The **content script** listens for media events in every frame. It does nothing visible until a page plays unmuted audio or video. Then it captures that element's audio and streams it, as 16 kHz mono in batches of about a third of a second, to the background page. It makes no decision about what is speech.
2. The **speech detector** (Silero VAD, a 2 MB neural model on the CPU) scores every 32 ms frame. It separates speech from music and game sound, which a loudness threshold cannot do.
3. The **segmenter** turns those scores into segments of a few seconds that end at a real pause: a short phrase is sent once the speaker stops, a long one is ended at the first gap after about 5 seconds, and non-stop speech is split at 8 seconds at the quietest point. Music on its own never becomes a segment.
4. The **Whisper engine** transcribes each segment and the caption is sent back to the frame the audio came from.

Other points worth knowing:

- The models load on first use, not at browser start. Firefox suspends the background page when it is idle and restarts it on the next message, so every handler waits for stored settings before answering.
- Captured audio is routed through one `AudioContext` per page, and that route is kept for the life of the page. Turning captions off only disconnects the analysis branch.
- Media that is muted, or that comes from another origin without CORS approval, is never captured. The browser gives Web Audio silence for such cross-origin media, so there is nothing to transcribe.

### Why the encoder is on the GPU and the decoder on the CPU

Whisper has a large encoder that runs once per segment and a small decoder that runs once per output token. In Firefox every read of a result back from the GPU waits for a device poll, so a decoder on WebGPU costs hundreds of milliseconds per token. Measured on the test clip (`npm run try -- --file ... --bench`), a 3.5 second segment took:

| Configuration | Time per segment |
| --- | --- |
| Encoder and decoder on WebGPU | about 6 s (about 430 ms per token) |
| Encoder on WebGPU, decoder on CPU (the default) | about 1 s |

For tuning on other hardware, a backend configuration stored under the `engineOverride` key of the extension's local storage replaces the default. `scripts/firefox-try.mjs --engine '<json>'` sets it for a trial run.

Without WebGPU everything runs on the CPU, which is too slow to follow live speech.

## Requirements

- Node.js 20.19+, 22.13+ or 24+ (the range `web-ext` supports), with npm 10+.
- Any OS. The release build was produced on Windows 11 with Node 24.14 and npm 10.9.

## Building

```bash
npm ci
npm run build
```

`npm ci` installs the exact dependency versions from `package-lock.json`. The build runs Vite, bundles the content script as a zero-dependency IIFE with esbuild, and copies the ONNX Runtime binaries, icons and manifest into `dist/`.

To produce the installable package:

```bash
npm run package
```

This writes `web-ext-artifacts/rutranscribe-webgpu-<version>.xpi`.

## Checks

```bash
npm test                # unit tests: settings, segmenter, audio stream, capture rules
npm run lint            # Mozilla's add-on linter (the same checks addons.mozilla.org runs)
npm run test:firefox    # loads dist/ into headless Firefox and tests capture and UI
```

These need Firefox installed (set `FIREFOX_BIN` if it is not in a standard location). They use a temporary profile and scale output volume to 1%.

### End-to-end and live trials

Headless Firefox has no WebGPU, so anything that runs the model opens a visible Firefox window on its own profile.

```bash
npm run fixtures                          # build test clips: Russian speech over music (Windows only)
npm run test:firefox -- --engine          # caption a clip end to end
npm run try -- --file .fixtures/speech-over-music.wav --reference .fixtures/transcript.txt --dual
npm run try -- https://www.twitch.tv/<channel> --seconds 120 --dual
```

`npm run try` prints every segment with its length, model time and text, then a summary: backend, segments dropped, speed relative to real time and, with `--reference`, the share of words recognised. The first run downloads the models (about 290 MB) into a profile kept in the system temp directory.

### Expected linter output

The linter reports no errors and three warnings, all inside unmodified third-party code:

| Warning | File | Source |
| --- | --- | --- |
| `DANGEROUS_EVAL` | `wasm/ort-wasm-simd-threaded.asyncify.mjs` | ONNX Runtime Web (Emscripten glue) |
| `DANGEROUS_EVAL` | `assets/background.js` | ONNX Runtime Web, bundled |
| `UNSAFE_VAR_ASSIGNMENT` | `assets/background.js` | ONNX Runtime Web's dynamic `import()` of its own `.mjs` |

The `Function` constructor paths cannot run: the extension's content security policy does not allow `unsafe-eval`. The dynamic import loads the `.mjs` file shipped in `wasm/` (the path is set to the extension's own URL in `whisper-engine.js`).

## Third-party code

| Package | Version | Licence | Shipped as |
| --- | --- | --- | --- |
| `@huggingface/transformers` | 4.3.1 | Apache-2.0 | bundled into `assets/background.js` |
| `onnxruntime-web` | version pinned by the above in `package-lock.json` | MIT | bundled, plus `wasm/*` copied unmodified from `node_modules/onnxruntime-web/dist/` |

The models are not part of the package. They are downloaded from huggingface.co at pinned revisions (see `src/utils/constants.js`):

| Model | Purpose | Licence |
| --- | --- | --- |
| `onnx-community/whisper-base` | speech recognition and translation | MIT |
| `onnx-community/silero-vad` | speech detection | MIT |
