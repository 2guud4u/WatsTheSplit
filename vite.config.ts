import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// VITE_BASE sets the deploy subpath (e.g. "/watsthesplit/" on jiathe.dev).
// Dev defaults to "/" so localhost URLs stay short.
export default defineConfig({
  base: process.env.VITE_BASE ?? "/",
  plugins: [react()],
  server: {
    proxy: { "/api": "http://localhost:8081" },
  },
  build: {
    outDir: "dist",
  },
});
