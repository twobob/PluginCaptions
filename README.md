# RuTranscribe WebGPU

Firefox extension providing real-time Russian-to-English closed captions for web videos and microphone input. Runs Whisper Base locally via WebGPU.

## Requirements

Firefox with WebGPU enabled:
1. Open `about:config`.
2. Set `dom.webgpu.enabled` to `true`.
3. On Windows, set `gfx.webgpu.force-enabled` to `true` if needed.
4. Restart Firefox.

## Installation

1. Build the extension:
   ```bash
   npm install
   npm run build
   ```
2. Open `about:debugging#/runtime/this-firefox`.
3. Click **Load Temporary Add-on...**.
4. Select `dist/manifest.json`.

## Usage

- **Video playback**: Play any video with Russian speech. Subtitles appear at the bottom of the player.
- **Pinned controls**: Use the top-right in-page HUD to toggle captions on/off, change size, or enable dual subtitles (Russian + English).
- **Studio**: Open `dashboard.html` from the toolbar icon to test microphone input or translate local audio files.

## Licence

MIT
