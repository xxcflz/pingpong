import { defineConfig } from "vite";

export default defineConfig({
  envDir: "../..",
  server: {
    port: 5173,
    host: true,
    allowedHosts: true,
    hmr: {
      clientPort: 443,
    },
    proxy: {
      '/api':        'http://localhost:3001',
      '/socket.io':  { target: 'http://localhost:3001', ws: true },
      '/spectate':   { target: 'http://localhost:3001', ws: true },
    },
  },
  build: {
    target: "es2022",
    assetsInlineLimit: 0,
  },
});
