# Privacy Policy

RuTranscribe WebGPU does not collect, store on a server, sell or share any personal data. There is no analytics, no telemetry, no account and no server operated by this extension.

## What happens to audio

Speech recognition runs entirely on your device. Audio from the page you are watching (or from your microphone, in the Studio page) is passed to a speech detector and a Whisper model running inside the browser, and is discarded once the caption has been produced. Audio, captions and transcripts never leave your computer.

## Network requests

The extension makes one kind of network request: downloading the files of its two models (Whisper for recognition, Silero VAD for speech detection) from `huggingface.co` (and the storage hosts it redirects to) the first time captions are needed. The files are then kept in the browser's cache and reused.

As with any download, Hugging Face receives your IP address and standard request headers. The request contains no audio, no captions and no information about the pages you visit. Hugging Face's own privacy policy applies to that download: https://huggingface.co/privacy

All executable code, including the ONNX Runtime WebAssembly binaries, ships inside the extension package. Only model weights are downloaded, and both models are pinned to fixed revisions.

## Data stored on your device

- Your settings (caption size, theme, on/off state and similar), in the browser's extension storage.
- The downloaded model files, in the browser's cache storage.

Removing the extension removes both.

## Permissions

- **Access your data for all websites**: needed to notice when a page plays audio or video, read that audio for on-device recognition, and draw the captions on the page. Page content is not read, changed or transmitted.
- **Storage**: saves your settings.
- **Microphone**: requested by the browser only if you press "Start Microphone" in the Studio page. Not used anywhere else.

## Contact

Questions and reports: https://github.com/twobob/PluginCaptions/issues
