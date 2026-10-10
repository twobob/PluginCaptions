import { detectWebGPUSupport } from "../utils/webgpu-detector.js";
import { MESSAGE_TYPES } from "../utils/constants.js";
const webExt = typeof browser !== "undefined" ? browser : chrome;
let isMicActive = false;
let audioContext = null;
let mediaStream = null;
let analyser = null;
let animFrameId = null;
let transcriptSegments = [];
const deviceBadge = document.getElementById("deviceBadge");
const adapterName = document.getElementById("adapterName");
const btnMicMode = document.getElementById("btnMicMode");
const btnFileMode = document.getElementById("btnFileMode");
const fileDropSection = document.getElementById("fileDropSection");
const dropZone = document.getElementById("dropZone");
const fileInput = document.getElementById("fileInput");
const btnToggleMic = document.getElementById("btnToggleMic");
const btnClear = document.getElementById("btnClear");
const btnExportSRT = document.getElementById("btnExportSRT");
const btnExportTXT = document.getElementById("btnExportTXT");
const liveDot = document.getElementById("liveDot");
const liveStatusText = document.getElementById("liveStatusText");
const stageBox = document.getElementById("stageBox");
const stageSecondary = document.getElementById("stageSecondary");
const stagePrimary = document.getElementById("stagePrimary");
const transcriptFeed = document.getElementById("transcriptFeed");
const entryCount = document.getElementById("entryCount");
const canvas = document.getElementById("audioVisualizer");
const canvasCtx = canvas.getContext("2d");
async function initDashboard() {
  resizeCanvas();
  window.addEventListener("resize", resizeCanvas);
  const gpuCheck = await detectWebGPUSupport();
  if (gpuCheck.supported) {
    deviceBadge.textContent = "WebGPU Active \u26A1";
    deviceBadge.style.color = "#38ef7d";
    adapterName.textContent = gpuCheck.gpuInfo?.description || gpuCheck.gpuInfo?.vendor || "WebGPU Device";
  } else {
    deviceBadge.textContent = "WASM Fallback \u2699";
    deviceBadge.style.color = "#fbbf24";
    adapterName.textContent = gpuCheck.error || "CPU Mode";
  }
  try {
    webExt.runtime.sendMessage({ type: MESSAGE_TYPES.INIT_ENGINE });
  } catch (e) {
  }
  setupEvents();
  drawIdleVisualizer();
}
function resizeCanvas() {
  canvas.width = canvas.parentElement.clientWidth - 40;
  canvas.height = 70;
}
function setupEvents() {
  btnMicMode.addEventListener("click", () => {
    btnMicMode.classList.add("active");
    btnFileMode.classList.remove("active");
    fileDropSection.classList.add("hidden");
  });
  btnFileMode.addEventListener("click", () => {
    btnFileMode.classList.add("active");
    btnMicMode.classList.remove("active");
    fileDropSection.classList.remove("hidden");
    if (isMicActive) stopMicrophone();
  });
  btnToggleMic.addEventListener("click", () => {
    if (isMicActive) {
      stopMicrophone();
    } else {
      startMicrophone();
    }
  });
  btnClear.addEventListener("click", () => {
    transcriptSegments = [];
    renderFeed();
    stagePrimary.textContent = "Speak Russian into your mic or play a video \u2014 English subtitles will appear here in real-time.";
    stageSecondary.textContent = "\u0417\u0434\u0435\u0441\u044C \u043F\u043E\u044F\u0432\u0438\u0442\u0441\u044F \u043E\u0440\u0438\u0433\u0438\u043D\u0430\u043B\u044C\u043D\u044B\u0439 \u0440\u0443\u0441\u0441\u043A\u0438\u0439 \u0442\u0435\u043A\u0441\u0442...";
  });
  btnExportSRT.addEventListener("click", exportSRT);
  btnExportTXT.addEventListener("click", exportTXT);
  fileInput.addEventListener("change", (e) => {
    if (e.target.files && e.target.files[0]) {
      handleAudioFile(e.target.files[0]);
    }
  });
  dropZone.addEventListener("dragover", (e) => {
    e.preventDefault();
    dropZone.style.borderColor = "#38ef7d";
  });
  dropZone.addEventListener("dragleave", () => {
    dropZone.style.borderColor = "rgba(255, 255, 255, 0.15)";
  });
  dropZone.addEventListener("drop", (e) => {
    e.preventDefault();
    dropZone.style.borderColor = "rgba(255, 255, 255, 0.15)";
    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      handleAudioFile(e.dataTransfer.files[0]);
    }
  });
}
async function startMicrophone() {
  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        sampleRate: 48e3,
        echoCancellation: true,
        noiseSuppression: true
      }
    });
    audioContext = new (window.AudioContext || window.webkitAudioContext)();
    const sourceNode = audioContext.createMediaStreamSource(mediaStream);
    analyser = audioContext.createAnalyser();
    analyser.fftSize = 256;
    sourceNode.connect(analyser);
    const processor = audioContext.createScriptProcessor(4096, 1, 1);
    let speechBuffer = [];
    let isSpeaking = false;
    let lastSpeechTime = 0;
    const vadThreshold = 0.015;
    const targetSampleRate = 16e3;
    processor.onaudioprocess = (e) => {
      const input = e.inputBuffer.getChannelData(0);
      const resampled = resampleTo16k(input, audioContext.sampleRate, targetSampleRate);
      let sumSq = 0;
      for (let i = 0; i < resampled.length; i++) sumSq += resampled[i] * resampled[i];
      const rms = Math.sqrt(sumSq / resampled.length);
      const now = performance.now();
      if (rms >= vadThreshold) {
        if (!isSpeaking) isSpeaking = true;
        lastSpeechTime = now;
        for (let i = 0; i < resampled.length; i++) speechBuffer.push(resampled[i]);
      } else {
        if (isSpeaking) {
          for (let i = 0; i < resampled.length; i++) speechBuffer.push(resampled[i]);
          if (now - lastSpeechTime > 450 || speechBuffer.length >= targetSampleRate * 3.5) {
            if (speechBuffer.length > targetSampleRate * 0.4) {
              const chunk = new Float32Array(speechBuffer);
              sendAudioChunk(chunk);
            }
            speechBuffer = [];
            isSpeaking = false;
          }
        }
      }
    };
    sourceNode.connect(processor);
    processor.connect(audioContext.destination);
    isMicActive = true;
    btnToggleMic.className = "btn-action start recording";
    btnToggleMic.innerHTML = "<span>\u23F9 Stop Microphone</span>";
    liveDot.className = "status-indicator active";
    liveStatusText.textContent = "Listening to Microphone...";
    startVisualizerLoop();
  } catch (err) {
    alert(`Could not start microphone: ${err.message}`);
    console.error(err);
  }
}
function stopMicrophone() {
  if (mediaStream) {
    mediaStream.getTracks().forEach((t) => t.stop());
    mediaStream = null;
  }
  if (audioContext && audioContext.state !== "closed") {
    audioContext.close();
    audioContext = null;
  }
  isMicActive = false;
  btnToggleMic.className = "btn-action start";
  btnToggleMic.innerHTML = "<span>\u{1F399}\uFE0F Start Microphone</span>";
  liveDot.className = "status-indicator";
  liveStatusText.textContent = "Microphone Idle";
  if (animFrameId) cancelAnimationFrame(animFrameId);
  drawIdleVisualizer();
}
async function sendAudioChunk(float32Chunk) {
  liveStatusText.textContent = "WebGPU Translating Russian \u2794 English...";
  try {
    const response = await webExt.runtime.sendMessage({
      type: MESSAGE_TYPES.PROCESS_AUDIO_CHUNK,
      audio: Array.from(float32Chunk)
    });
    if (response && response.success && response.result && response.result.text) {
      handleNewTranslation(response.result);
    }
  } catch (err) {
    console.warn("[Dashboard] Inference dispatch error:", err);
  } finally {
    if (isMicActive) {
      liveStatusText.textContent = "Listening to Microphone...";
    }
  }
}
function handleNewTranslation(result) {
  stagePrimary.textContent = result.text;
  if (result.russianText) {
    stageSecondary.textContent = result.russianText;
  } else {
    stageSecondary.textContent = "";
  }
  const segment = {
    id: Date.now(),
    time: (/* @__PURE__ */ new Date()).toLocaleTimeString(),
    enText: result.text,
    ruText: result.russianText || "",
    latencyMs: result.latencyMs || 0,
    device: result.device || "webgpu"
  };
  transcriptSegments.unshift(segment);
  renderFeed();
}
function renderFeed() {
  entryCount.textContent = `${transcriptSegments.length} segments`;
  if (transcriptSegments.length === 0) {
    transcriptFeed.textContent = "";
    const empty = document.createElement("div");
    empty.className = "empty-placeholder";
    const span = document.createElement("span");
    span.textContent = 'No translations recorded yet. Click "Start Microphone" or drop an audio file above to test the WebGPU model!';
    empty.appendChild(span);
    transcriptFeed.appendChild(empty);
    return;
  }
  transcriptFeed.textContent = "";
  for (const item of transcriptSegments) {
    const div = document.createElement("div");
    div.className = "transcript-item";
    const meta = document.createElement("div");
    meta.className = "item-meta";
    meta.textContent = `\u{1F552} ${item.time} (${item.latencyMs}ms on ${item.device.toUpperCase()})`;
    div.appendChild(meta);
    if (item.ruText) {
      const ru = document.createElement("div");
      ru.className = "item-ru";
      ru.textContent = `\u{1F1F7}\u{1F1FA} ${item.ruText}`;
      div.appendChild(ru);
    }
    const en = document.createElement("div");
    en.className = "item-en";
    en.textContent = `\u{1F1EC}\u{1F1E7} ${item.enText}`;
    div.appendChild(en);
    transcriptFeed.appendChild(div);
  }
}
async function handleAudioFile(file) {
  liveStatusText.textContent = `Decoding ${file.name}...`;
  liveDot.className = "status-indicator active";
  try {
    const arrayBuffer = await file.arrayBuffer();
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const audioBuffer = await ctx.decodeAudioData(arrayBuffer);
    const raw = audioBuffer.getChannelData(0);
    const resampled = resampleTo16k(raw, audioBuffer.sampleRate, 16e3);
    liveStatusText.textContent = `Translating file with WebGPU (${Math.round(audioBuffer.duration)}s)...`;
    const chunkSize = 16e3 * 3.5;
    for (let offset = 0; offset < resampled.length; offset += chunkSize) {
      const chunk = resampled.slice(offset, Math.min(offset + chunkSize, resampled.length));
      if (chunk.length < 16e3 * 0.4) continue;
      const response = await webExt.runtime.sendMessage({
        type: MESSAGE_TYPES.PROCESS_AUDIO_CHUNK,
        audio: Array.from(chunk)
      });
      if (response && response.success && response.result && response.result.text) {
        handleNewTranslation(response.result);
      }
    }
    liveStatusText.textContent = `Completed processing ${file.name}!`;
    liveDot.className = "status-indicator";
    ctx.close();
  } catch (err) {
    alert(`Error processing audio file: ${err.message}`);
    liveStatusText.textContent = "File processing failed";
    liveDot.className = "status-indicator";
  }
}
function resampleTo16k(inputData, inRate, outRate) {
  if (inRate === outRate) return inputData;
  const ratio = inRate / outRate;
  const newLen = Math.round(inputData.length / ratio);
  const out = new Float32Array(newLen);
  for (let i = 0; i < newLen; i++) {
    const orig = i * ratio;
    const floor = Math.floor(orig);
    const ceil = Math.min(floor + 1, inputData.length - 1);
    const frac = orig - floor;
    out[i] = inputData[floor] * (1 - frac) + inputData[ceil] * frac;
  }
  return out;
}
function startVisualizerLoop() {
  const dataArray = new Uint8Array(analyser.frequencyBinCount);
  function draw() {
    animFrameId = requestAnimationFrame(draw);
    analyser.getByteFrequencyData(dataArray);
    canvasCtx.fillStyle = "#090d16";
    canvasCtx.fillRect(0, 0, canvas.width, canvas.height);
    const barWidth = canvas.width / dataArray.length * 2.5;
    let x = 0;
    for (let i = 0; i < dataArray.length; i++) {
      const barHeight = dataArray[i] / 255 * canvas.height;
      const gradient = canvasCtx.createLinearGradient(0, canvas.height - barHeight, 0, canvas.height);
      gradient.addColorStop(0, "#38ef7d");
      gradient.addColorStop(1, "#4f46e5");
      canvasCtx.fillStyle = gradient;
      canvasCtx.fillRect(x, canvas.height - barHeight, barWidth, barHeight);
      x += barWidth + 1;
    }
  }
  draw();
}
function drawIdleVisualizer() {
  canvasCtx.fillStyle = "#090d16";
  canvasCtx.fillRect(0, 0, canvas.width, canvas.height);
  canvasCtx.strokeStyle = "rgba(255, 255, 255, 0.1)";
  canvasCtx.lineWidth = 1;
  canvasCtx.beginPath();
  canvasCtx.moveTo(0, canvas.height / 2);
  canvasCtx.lineTo(canvas.width, canvas.height / 2);
  canvasCtx.stroke();
}
function exportSRT() {
  if (transcriptSegments.length === 0) {
    alert("No transcript segments available to export.");
    return;
  }
  let srtContent = "";
  const sorted = [...transcriptSegments].reverse();
  sorted.forEach((item, index) => {
    const startSec = index * 3.5;
    const endSec = (index + 1) * 3.5;
    srtContent += `${index + 1}
${formatTimeSRT(startSec)} --> ${formatTimeSRT(endSec)}
${item.enText}

`;
  });
  const blob = new Blob([srtContent], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `Russian_to_English_Translation_${Date.now()}.srt`;
  a.click();
  URL.revokeObjectURL(url);
}
function formatTimeSRT(seconds) {
  const date = /* @__PURE__ */ new Date(0);
  date.setSeconds(seconds);
  const ms = Math.floor(seconds % 1 * 1e3);
  return date.toISOString().substr(11, 8) + "," + String(ms).padStart(3, "0");
}
function exportTXT() {
  if (transcriptSegments.length === 0) {
    alert("No transcript segments available to copy.");
    return;
  }
  const text = transcriptSegments.slice().reverse().map((i) => i.enText).join("\n");
  navigator.clipboard.writeText(text).then(() => {
    alert("English transcript copied to clipboard!");
  });
}
document.addEventListener("DOMContentLoaded", initDashboard);
