import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/**
 * `VITE_API_PROXY_TARGET` exists for WSL users.
 *
 * In WSL2 the API usually runs inside the distribution, so `localhost:3001`
 * resolves as usual. When the backend runs on the Windows side instead, the
 * browser needs the other direction, and being able to point the proxy without
 * editing a tracked file is the difference between "works" and "why is every
 * request 500".
 *
 * `VITE_HOST` is the same idea for the dev server: 0.0.0.0 makes it reachable
 * from a Windows browser and from a phone on the same network.
 */
const proxyTarget = process.env.VITE_API_PROXY_TARGET || "http://localhost:3001";
const host = process.env.VITE_HOST || "127.0.0.1";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    host,
    port: 5173,
    // Same-origin in development, so cookies behave exactly as they do in
    // production behind the Vercel rewrite.
    proxy: {
      "/api": {
        target: proxyTarget,
        changeOrigin: false,
      },
    },
  },
  build: {
    outDir: "dist",
    sourcemap: false,
  },
});
