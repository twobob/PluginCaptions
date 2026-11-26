# Releasing on addons.mozilla.org

## Before the first submission

1. **Choose the add-on ID.** `browser_specific_settings.gecko.id` in `manifest.json` is permanent once a version is signed. It currently uses a domain placeholder; change it to one you control (an email-style ID such as `rutranscribe@your-domain` or a GUID) before uploading.
2. **Add a LICENSE file.** `package.json` and the README say MIT, but the repository has no licence text yet.
3. **Test by hand in Firefox.** The automated tests cover capture, UI and captioning of a synthetic speech clip, and `npm run try -- <url>` prints what the extension makes of a live stream. Still check by eye: caption placement on the sites you care about, fullscreen video, and the Studio page with a microphone.

## Each release

1. Bump `version` in `manifest.json` and `package.json`.
2. Run the checks:
   ```bash
   npm ci
   npm test
   npm run package
   npm run lint
   npm run test:firefox
   npm run test:firefox -- --engine
   ```
3. Create the source archive that reviewers rebuild from:
   ```bash
   git archive --format=zip --output web-ext-artifacts/source.zip HEAD
   ```
4. At https://addons.mozilla.org/developers/ choose **Submit a New Add-on** (or **Upload New Version**), and upload `web-ext-artifacts/rutranscribe-webgpu-<version>.xpi`.
5. When asked whether the add-on uses minified or machine-generated code, answer **yes** and upload `source.zip`. This is required because the package is built with Vite and esbuild.
6. Paste the reviewer notes below, and link `PRIVACY.md` as the privacy policy.

## Notes for reviewers (paste into the submission form)

```
BUILD
Requirements: Node.js 20.19+ / 22.13+ / 24+, npm 10+. Any OS.
  npm ci
  npm run build
Output is in dist/. Full details are in BUILDING.md in the source archive.

WHAT THE ADD-ON DOES
Live captions for Russian speech in web audio/video, translated to English.
Speech detection (Silero VAD) and recognition (Whisper) run on the user's
device with ONNX Runtime Web (WebGPU encoder, WASM decoder, WASM fallback).
No audio or text leaves the device.

NETWORK ACCESS
One kind of request: model weights (onnx-community/whisper-base and
onnx-community/silero-vad, both pinned to fixed revisions) are downloaded
from huggingface.co on first use and cached. These are data files, not
code. All executable code, including the ONNX Runtime .wasm and .mjs files
in wasm/, is inside the package.

PERMISSIONS
<all_urls>: the content script must run wherever the user plays media, to
read that media's audio and draw captions on the page.
storage: user settings.

LINTER WARNINGS
Three warnings (2x DANGEROUS_EVAL, 1x UNSAFE_VAR_ASSIGNMENT) come from
unmodified onnxruntime-web code. The Function-constructor paths cannot run
under the extension CSP (no unsafe-eval). The dynamic import() loads
wasm/ort-wasm-simd-threaded.asyncify.mjs from the package itself.

THIRD-PARTY LIBRARIES
@huggingface/transformers 4.3.1 (npm), onnxruntime-web (npm, version pinned
in package-lock.json). wasm/* is copied unmodified from
node_modules/onnxruntime-web/dist/.

TESTING
Play any video with speech. Captions appear at the bottom of the page and a
small control panel appears at the top right. The toolbar popup has settings
and a link to a Studio page for microphone and file input.
```
