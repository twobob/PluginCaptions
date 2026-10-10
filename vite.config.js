import { defineConfig } from "vite";
import { resolve } from "path";
export default defineConfig({
  base: "./",
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "esnext",
    rollupOptions: {
      input: {
        background: resolve(__dirname, "background.html"),
        popup: resolve(__dirname, "popup.html"),
        dashboard: resolve(__dirname, "dashboard.html")
      },
      output: {
        entryFileNames: "assets/[name].js",
        chunkFileNames: "assets/[name].js",
        assetFileNames: "assets/[name].[ext]"
      }
    }
  }
});
