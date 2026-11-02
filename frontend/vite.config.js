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

/** Last time each proxy failure was printed, so a dead backend prints one line, not one per request. */
const reportedAt = new Map();

/**
 * A reset or refusal from the API used to reach the terminal as a five-line
 * stack trace about `TCP.onStreamRead`, which says nothing about the actual
 * situation: the backend is not running, is still starting, or restarted while
 * the request was in flight. Print the target and the command, once every few
 * seconds, and answer the browser with JSON instead of a broken socket.
 */
function reportProxyFailure(error, req, res) {
  const key = error?.code || error?.message || "error";
  const now = Date.now();
  if (!reportedAt.has(key) || now - reportedAt.get(key) > 5000) {
    reportedAt.set(key, now);
    console.error(
      `\n[vite] cannot reach the API at ${proxyTarget} (${key}) - ${req.method} ${req.url}\n` +
        `       start it with:  cd backend && npm run dev\n` +
        `       backend elsewhere?  VITE_API_PROXY_TARGET=http://host:3001 npm run dev\n`,
    );
  }
  if (res && !res.headersSent && !res.writableEnded && typeof res.writeHead === "function") {
    res.writeHead(502, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        error: { code: "API_UNREACHABLE", message: `The dev server could not reach the API at ${proxyTarget}.` },
      }),
    );
  }
}

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
        configure: (proxy) => proxy.on("error", reportProxyFailure),
      },
    },
  },
  build: {
    outDir: "dist",
    sourcemap: false,
  },
});
