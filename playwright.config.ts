import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  timeout: 30_000,
  retries: 0,
  use: {
    baseURL: "http://localhost:5173",
    headless: true,
  },
  webServer: {
    command: "npx vite --port 5173",
    cwd: "./packages/client",
    port: 5173,
    reuseExistingServer: true,
    timeout: 15_000,
  },
  projects: [
    {
      name: "mouse",
      use: { browserName: "chromium" },
    },
    {
      name: "touch",
      use: {
        browserName: "chromium",
        hasTouch: true,
      },
    },
  ],
});
