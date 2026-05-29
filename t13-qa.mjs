/**
 * T13 QA Scenarios — Playwright script.
 * Run with: node --experimental-vm-modules t13-qa.mjs
 */
import { chromium } from "/home/vibi/pioneer-bot/node_modules/playwright/index.mjs";
import { writeFileSync, mkdirSync } from "fs";
import { execSync } from "child_process";

const BASE = "http://localhost:5180";
const EVIDENCE = ".omo/evidence";
mkdirSync(EVIDENCE, { recursive: true });

async function run() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await context.newPage();
  let allPass = true;

  // ── Scenario 1: Default scene renders all elements ────────────
  console.log("\n=== Scenario 1: Default scene renders all elements ===");
  await page.goto(`${BASE}/?frame_id=mock&scene_test=1`, { waitUntil: "networkidle" });
  await page.waitForFunction(() => window.__pong_scene_ready === true, { timeout: 10000 });
  await page.waitForTimeout(500); // let a frame render
  await page.screenshot({ path: `${EVIDENCE}/task-13-default-scene.png` });

  const inspect = await page.evaluate(() => ({
    paddleTop: !!window.__pong_layers?.playLayer?.children.find(c => c.label === "paddleTop"),
    paddleBottom: !!window.__pong_layers?.playLayer?.children.find(c => c.label === "paddleBottom"),
    ball: !!window.__pong_layers?.playLayer?.children.find(c => c.label === "ball"),
    scoreText: !!window.__pong_layers?.uiLayer?.children.find(c => c.label === "score"),
  }));
  console.log("Inspect:", JSON.stringify(inspect));
  const s1 = Object.values(inspect).every(Boolean);
  console.log(`Scenario 1: ${s1 ? "PASS ✓" : "FAIL ✗"}`);
  if (!s1) allPass = false;

  // ── Scenario 2: 60fps render target ──────────────────────────
  console.log("\n=== Scenario 2: Frame time < 18ms ===");
  const samples = await page.evaluate(async () => {
    const out = [];
    let prev = performance.now();
    for (let i = 0; i < 60; i++) {
      await new Promise(r => requestAnimationFrame(r));
      const now = performance.now();
      out.push(now - prev);
      prev = now;
    }
    return out;
  });
  const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
  writeFileSync(`${EVIDENCE}/task-13-fps.txt`, `Mean frame time: ${mean.toFixed(2)}ms\nSamples: ${JSON.stringify(samples)}\n`);
  const s2 = mean < 18;
  console.log(`Mean frame time: ${mean.toFixed(2)}ms — ${s2 ? "PASS ✓" : "FAIL ✗"}`);
  if (!s2) allPass = false;

  // ── Scenario 3: Bundle < 500KB gzipped ────────────────────────
  console.log("\n=== Scenario 3: Bundle size ===");
  try {
    execSync("cd packages/client && npx vite build 2>&1", { encoding: "utf8" });
    const size = execSync(
      "cat packages/client/dist/assets/*.js | gzip -9 | wc -c",
      { encoding: "utf8" }
    ).trim();
    writeFileSync(`${EVIDENCE}/task-13-bundle.txt`, `${size} bytes gzipped\n`);
    const s3 = parseInt(size) < 512000;
    console.log(`Bundle: ${size} bytes — ${s3 ? "PASS ✓" : "FAIL ✗"}`);
    if (!s3) allPass = false;
  } catch (e) {
    console.log("Bundle check failed:", e.message);
    allPass = false;
  }

  // ── Scenario 4: Aspect ratio on resize ───────────────────────
  console.log("\n=== Scenario 4: Letterbox aspect ratio ===");
  await page.setViewportSize({ width: 1024, height: 600 });
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${EVIDENCE}/task-13-letterbox-wide.png` });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${EVIDENCE}/task-13-letterbox-mobile.png` });

  const ratio = await page.evaluate(() => {
    const c = document.querySelector("canvas");
    if (!c) return -1;
    return c.width / c.height;
  });
  const expected = 720 / 1280;
  const s4 = Math.abs(ratio - expected) < 0.05;
  console.log(`Canvas ratio: ${ratio.toFixed(4)} (expected ~${expected.toFixed(4)}) — ${s4 ? "PASS ✓" : "FAIL ✗"}`);
  if (!s4) allPass = false;

  // ── Scenario 5: No image assets ──────────────────────────────
  console.log("\n=== Scenario 5: No image assets ===");
  try {
    const count = execSync(
      "find packages/client/public packages/client/src/assets -type f 2>/dev/null | wc -l",
      { encoding: "utf8" }
    ).trim();
    writeFileSync(`${EVIDENCE}/task-13-no-assets.txt`, `${count}\n`);
    const s5 = count === "0";
    console.log(`Asset count: ${count} — ${s5 ? "PASS ✓" : "FAIL ✗"}`);
    if (!s5) allPass = false;
  } catch {
    console.log("No asset dirs (PASS)");
  }

  // ── Summary ──────────────────────────────────────────────────
  console.log(`\n${"=".repeat(50)}`);
  console.log(`OVERALL: ${allPass ? "ALL PASS ✓" : "SOME FAILED ✗"}`);

  await browser.close();
  process.exit(allPass ? 0 : 1);
}

run().catch(e => {
  console.error("QA script failed:", e);
  process.exit(1);
});
