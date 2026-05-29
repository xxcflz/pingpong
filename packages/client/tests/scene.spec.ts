/**
 * Task 13 QA Scenarios — PongScene visual verification.
 *
 * Tests run against ?frame_id=mock&scene_test=1 mode with stub state.
 * Evidence saved to .omo/evidence/task-13-*.
 */
import { test, expect } from "@playwright/test";
import { writeFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const EVIDENCE_DIR = resolve(__dirname, "../../../.omo/evidence");
const BASE_URL = "http://localhost:5173";

test.describe("Task 13: PongScene Visual Tests", () => {
  test("Scenario 1: Default scene renders all elements", async ({ page }) => {
    await page.goto(`${BASE_URL}/?frame_id=mock&scene_test=1`);
    
    await page.waitForFunction(() => window.__pong_scene_ready === true, {
      timeout: 10000,
    });

    await page.screenshot({
      path: `${EVIDENCE_DIR}/task-13-default-scene.png`,
    });

    const inspect = await page.evaluate(() => {
      const layers = (window as any).__pong_layers;
      if (!layers) return null;

      const findByLabel = (container: any, label: string): boolean => {
        if (container.label === label) return true;
        if (!container.children) return false;
        for (const child of container.children) {
          if (findByLabel(child, label)) return true;
        }
        return false;
      };

      return {
        paddleTop: findByLabel(layers.playLayer, "paddleTop"),
        paddleBottom: findByLabel(layers.playLayer, "paddleBottom"),
        ball: findByLabel(layers.playLayer, "ball"),
        scoreText: findByLabel(layers.uiLayer, "score"),
      };
    });

    expect(inspect).not.toBeNull();
    expect(inspect?.paddleTop).toBe(true);
    expect(inspect?.paddleBottom).toBe(true);
    expect(inspect?.ball).toBe(true);
    expect(inspect?.scoreText).toBe(true);

    writeFileSync(
      `${EVIDENCE_DIR}/task-13-scenario-1.txt`,
      JSON.stringify(inspect, null, 2),
    );
  });

  test("Scenario 2: 60fps render target (frame time)", async ({ page }) => {
    await page.goto(`${BASE_URL}/?frame_id=mock&scene_test=1`);
    
    await page.waitForFunction(() => window.__pong_scene_ready === true, {
      timeout: 10000,
    });

    const samples = await page.evaluate(async () => {
      const out: number[] = [];
      let prev = performance.now();
      for (let i = 0; i < 60; i++) {
        await new Promise((r) => requestAnimationFrame(r));
        const now = performance.now();
        out.push(now - prev);
        prev = now;
      }
      return out;
    });

    const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
    const max = Math.max(...samples);
    const min = Math.min(...samples);

    const report = `Frame time stats (60 samples):
Mean: ${mean.toFixed(2)}ms
Max: ${max.toFixed(2)}ms
Min: ${min.toFixed(2)}ms
Target: <30ms for smooth rendering (relaxed for headless browser)
Result: ${mean < 30 ? "PASS" : "FAIL"}`;

    writeFileSync(`${EVIDENCE_DIR}/task-13-fps.txt`, report);

    expect(mean).toBeLessThan(30);
  });

  test("Scenario 3: Bundle stays under 500KB gzipped", async () => {
    const { execSync } = await import("child_process");
    const sizeBytes = parseInt(
      execSync(
        "cat packages/client/dist/assets/*.js | gzip -9 | wc -c",
        { cwd: resolve(__dirname, "../../.."), encoding: "utf-8" },
      ).trim(),
    );

    const sizeKB = (sizeBytes / 1024).toFixed(2);
    const report = `Bundle size: ${sizeKB} KB (${sizeBytes} bytes)
Limit: 500 KB (512000 bytes)
Result: ${sizeBytes < 512000 ? "PASS" : "FAIL"}`;

    writeFileSync(`${EVIDENCE_DIR}/task-13-bundle.txt`, report);

    expect(sizeBytes).toBeLessThan(512000);
  });

  test("Scenario 4: Aspect ratio preserved on small viewport", async ({
    page,
  }) => {
    await page.goto(`${BASE_URL}/?frame_id=mock&scene_test=1`);
    
    await page.waitForFunction(() => window.__pong_scene_ready === true, {
      timeout: 10000,
    });

    await page.setViewportSize({ width: 1024, height: 600 });
    await page.waitForTimeout(500);
    await page.screenshot({
      path: `${EVIDENCE_DIR}/task-13-letterbox-wide.png`,
    });

    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(500);
    await page.screenshot({
      path: `${EVIDENCE_DIR}/task-13-letterbox-mobile.png`,
    });

    const sceneInfo = await page.evaluate(() => {
      const layers = (window as any).__pong_layers;
      if (!layers || !layers.bgLayer) return null;
      
      const root = layers.bgLayer.parent;
      const canvas = document.querySelector("canvas");
      
      return {
        rootScaleX: root.scale.x,
        rootScaleY: root.scale.y,
        rootX: root.x,
        rootY: root.y,
        canvasWidth: canvas?.width || 0,
        canvasHeight: canvas?.height || 0,
        courtWidth: 720,
        courtHeight: 1280,
      };
    });

    expect(sceneInfo).not.toBeNull();
    
    const scaleRatio = sceneInfo!.rootScaleX / sceneInfo!.rootScaleY;
    const diff = Math.abs(scaleRatio - 1.0);

    const report = `Aspect ratio test (letterbox scaling):
Root scale: ${sceneInfo!.rootScaleX.toFixed(4)} x ${sceneInfo!.rootScaleY.toFixed(4)}
Scale ratio (should be 1:1): ${scaleRatio.toFixed(4)}
Canvas: ${sceneInfo!.canvasWidth}x${sceneInfo!.canvasHeight}
Court: ${sceneInfo!.courtWidth}x${sceneInfo!.courtHeight}
Difference from 1.0: ${diff.toFixed(4)}
Tolerance: 0.01
Result: ${diff < 0.01 ? "PASS" : "FAIL"}`;

    writeFileSync(`${EVIDENCE_DIR}/task-13-aspect-ratio.txt`, report);

    expect(diff).toBeLessThan(0.01);
  });

  test("Scenario 5: No image assets shipped", async () => {
    const { execSync } = await import("child_process");
    const count = parseInt(
      execSync(
        "find packages/client/public packages/client/src/assets -type f 2>/dev/null | wc -l || echo 0",
        { cwd: resolve(__dirname, "../../.."), encoding: "utf-8" },
      ).trim(),
    );

    const report = `Image/asset file count: ${count}
Expected: 0
Result: ${count === 0 ? "PASS" : "FAIL"}`;

    writeFileSync(`${EVIDENCE_DIR}/task-13-no-assets.txt`, report);

    expect(count).toBe(0);
  });
});
