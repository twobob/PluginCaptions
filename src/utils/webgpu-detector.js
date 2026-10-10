export async function detectWebGPUSupport() {
  const result = {
    supported: false,
    hasNavigatorGPU: false,
    adapterAvailable: false,
    gpuInfo: null,
    isFirefox: false,
    error: null,
    recommendation: ""
  };
  const userAgent = navigator.userAgent.toLowerCase();
  result.isFirefox = userAgent.includes("firefox");
  if (!navigator.gpu) {
    result.error = "navigator.gpu is not available in this browser context.";
    if (result.isFirefox) {
      result.recommendation = 'In Firefox, open about:config and set "dom.webgpu.enabled" to true. On Windows, you may also need "gfx.webgpu.force-enabled" set to true.';
    } else {
      result.recommendation = "Please ensure you are using a browser version with WebGPU support enabled.";
    }
    return result;
  }
  result.hasNavigatorGPU = true;
  try {
    const adapter = await navigator.gpu.requestAdapter({
      powerPreference: "high-performance"
    });
    if (!adapter) {
      result.error = "WebGPU adapter could not be initialized.";
      if (result.isFirefox) {
        result.recommendation = 'Firefox found navigator.gpu, but no compatible adapter was returned. Check about:config for "dom.webgpu.enabled" and ensure your graphics drivers are up to date.';
      }
      return result;
    }
    result.adapterAvailable = true;
    result.supported = true;
    let info = {
      vendor: "Unknown GPU Vendor",
      architecture: "Unknown Architecture",
      device: "GPU Acceleration Active",
      description: "WebGPU Compatible Hardware"
    };
    if (adapter.info) {
      info = {
        vendor: adapter.info.vendor || info.vendor,
        architecture: adapter.info.architecture || info.architecture,
        device: adapter.info.device || info.device,
        description: adapter.info.description || `${adapter.info.vendor || "GPU"} ${adapter.info.architecture || ""}`.trim()
      };
    } else if (typeof adapter.requestAdapterInfo === "function") {
      try {
        const adapterInfo = await adapter.requestAdapterInfo();
        info = {
          vendor: adapterInfo.vendor || info.vendor,
          architecture: adapterInfo.architecture || info.architecture,
          device: adapterInfo.device || info.device,
          description: adapterInfo.description || `${adapterInfo.vendor || "GPU"} ${adapterInfo.architecture || ""}`.trim()
        };
      } catch (e) {
        console.warn("Could not read requestAdapterInfo:", e);
      }
    }
    result.gpuInfo = info;
    return result;
  } catch (err) {
    result.error = err.message || "Error initializing WebGPU adapter";
    if (result.isFirefox) {
      result.recommendation = 'Ensure "dom.webgpu.enabled" is set to true in about:config.';
    }
    return result;
  }
}
