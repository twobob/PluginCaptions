# Building & Architecture

## Architecture

```
PluginCaptions/
├── dist/                      # Production-ready extension bundle
│   ├── manifest.json          # Firefox Manifest V3
│   ├── background.html        # Persistent WebGPU engine host
│   ├── popup.html             # Toolbar popup UI
│   ├── dashboard.html         # Live audio studio & test lab
│   ├── content.js             # Standalone IIFE content script
│   ├── wasm/                  # ONNX Runtime WebGPU/WASM binaries
│   ├── icons/                 # Extension icons (16, 32, 48, 128)
│   └── assets/                # Minified scripts & styles
├── src/
│   ├── background/
│   │   ├── background.js      # Message bus & extension state manager
│   │   └── whisper-engine.js  # Transformers.js WebGPU pipeline & queue
│   ├── content/
│   │   ├── content.js         # Media element hooks & event routing
│   │   ├── audio-processor.js # 16kHz resampling & RMS energy VAD
│   │   ├── caption-ui.js      # Shadow DOM draggable subtitle overlay
│   │   └── pinned-panel.js    # In-page control HUD
│   ├── popup/
│   │   ├── popup.html
│   │   ├── popup.css
│   │   └── popup.js           # Diagnostics, settings, and WebGPU detector
│   ├── dashboard/
│   │   ├── dashboard.html
│   │   ├── dashboard.css
│   │   └── dashboard.js       # Mic capture, file drop, waveform visualizer
│   └── utils/
│       ├── constants.js       # Shared defaults & message types
│       └── webgpu-detector.js # WebGPU device and adapter inspector
├── package.json
└── vite.config.js             # Multi-page build configuration
```

## Rebuilding

To compile changes into `dist/`:

```bash
npm install
npm run build
```

This runs Vite, bundles the content script as a zero-dependency IIFE, and copies all required ONNX WASM binaries and icons into `dist/`.
