# RuTranscribe WebGPU

Firefox extension providing real-time Russian-to-English closed captions for web videos and microphone input. Runs Whisper Base locally via WebGPU. Audio never leaves your device (see [PRIVACY.md](PRIVACY.md)).

## Requirements

Firefox 142 or later.

WebGPU is needed for live captions and is on by default in current Firefox for Windows. Where it is unavailable the extension falls back to a CPU (WASM) backend that is too slow to follow live speech. To turn WebGPU on by hand:

1. Open `about:config`.
2. Set `dom.webgpu.enabled` to `true`.
3. On Windows, set `gfx.webgpu.force-enabled` to `true` if needed.
4. Restart Firefox.

The first time captions are needed the extension downloads its models from huggingface.co (about 290 MB). They are cached after that.

## Installation

1. Build the extension:
   ```bash
   npm ci
   npm run build
   ```
2. Open `about:debugging#/runtime/this-firefox`.
3. Click **Load Temporary Add-on...**.
4. Select `dist/manifest.json`.

## Usage

- **Video playback**: Play any video or stream with Russian speech. Subtitles appear at the bottom of the page a few seconds after each phrase. Background music and game sound are ignored when nobody is speaking.
- **Pinned controls**: On pages that are playing media, a small panel at the top right toggles captions on/off, changes size, or enables dual subtitles (Russian + English).
- **Studio**: Open the Studio from the toolbar popup to test microphone input or translate local audio files, and export the result as `.srt`.

## Limitations

- Captions follow whole phrases, so they trail the speech by a few seconds.
- The model is Whisper Base. Clear speech translates well; fast, slangy or mumbled speech over loud game sound comes out rough.
- Media that is muted is not captioned.
- Media served from another site without CORS headers cannot be captioned: the browser does not let extensions or pages read that audio.
- DRM-protected streams cannot be captured.
- When a `<video>` element itself is fullscreen (rather than the player around it), the browser shows nothing but the video, so captions are hidden.

## Development

```bash
npm test                # unit tests
npm run lint            # Mozilla add-on linter
npm run test:firefox    # end-to-end test in headless Firefox
npm run package         # build and write web-ext-artifacts/*.xpi
npm run try -- <url>    # watch a live stream in a test browser and print captions and timings
```

For architecture and build details, see [BUILDING.md](BUILDING.md). For publishing, see [RELEASING.md](RELEASING.md).

## Licence

MIT
