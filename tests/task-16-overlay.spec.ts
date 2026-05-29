import { test } from "@playwright/test";

const EVIDENCE_DIR = "/home/vibi/ProjectAI/PingPongDiscord/.omo/evidence";
const BASE_URL = "http://localhost:5173";

test("AFK overlay screenshot — red tint on top half with secondsRemaining", async ({ page }) => {
  await page.goto(`${BASE_URL}/?frame_id=mock&scene_test=1`);

  await page.waitForFunction(() => (window as any).__pong_scene_ready === true, {
    timeout: 10000,
  });

  await page.evaluate(() => {
    const scene = (window as any).__pong_scene;
    if (scene) {
      scene.showAfkWarning("top", 7);
    }
  });

  await page.waitForTimeout(500);

  await page.screenshot({
    path: `${EVIDENCE_DIR}/task-16-afk-overlay.png`,
  });
});
