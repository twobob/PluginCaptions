import fs from "fs";
import path from "path";
import esbuild from "esbuild";
function copyDir(src, dest) {
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDir(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}
function copyFile(src, dest) {
  if (fs.existsSync(src)) {
    const dir = path.dirname(dest);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(src, dest);
    console.log(`Copied ${path.basename(src)} -> ${dest}`);
  }
}
console.log("--- Step 1: Compiling Content Script (IIFE Bundle) ---");
try {
  esbuild.buildSync({
    entryPoints: ["src/content/content.js"],
    bundle: true,
    outfile: "dist/content.js",
    format: "iife",
    target: "es2020",
    minify: false
  });
  console.log("\u2713 Successfully bundled dist/content.js as standalone IIFE");
} catch (err) {
  console.error("Failed to bundle content.js:", err);
  process.exit(1);
}
console.log("--- Step 2: Copying Extension Assets ---");
copyFile("manifest.json", "dist/manifest.json");
copyDir("icons", "dist/icons");
const ortDist = "node_modules/onnxruntime-web/dist";
for (const f of ["ort-wasm-simd-threaded.asyncify.mjs", "ort-wasm-simd-threaded.asyncify.wasm"]) {
  const src = path.join(ortDist, f);
  if (!fs.existsSync(src)) {
    console.error(`ERROR: ${src} missing \u2014 ORT will fail to load.`);
    process.exit(1);
  }
  copyFile(src, path.join("dist/wasm", f));
}
fs.rmSync("dist/assets/ort-wasm-simd-threaded.asyncify.wasm", { force: true });
console.log("Build and asset pipeline completed successfully!");
