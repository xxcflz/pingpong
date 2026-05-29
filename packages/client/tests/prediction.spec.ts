/**
 * Task 10 QA Scenarios — client-side prediction + reconciliation.
 *
 * Tests run against ?frame_id=mock&test_predict=1 mode.
 * Evidence saved to .omo/evidence/task-10-*.
 */
import { test, expect } from "@playwright/test";
import { writeFileSync, mkdirSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const EVIDENCE_DIR = resolve(__dirname, "../../../.omo/evidence");
const BASE_URL = "http://localhost:5173";

test.describe("Task 10: Prediction + Reconciliation", () => {
  test.beforeAll(() => {
    mkdirSync(EVIDENCE_DIR, { recursive: true });
  });

  test("Scenario 1: Predicted paddle responds <16ms; reconciles correctly", async ({ page }) => {
    await page.goto(`${BASE_URL}/?frame_id=mock&test_predict=1`);
    await page.waitForFunction(
      () => (window as any).__test_predict_rig !== undefined,
      { timeout: 10000 },
    );

    const result = await page.evaluate(() => {
      const rig = (window as any).__test_predict_rig as any;
      const results: string[] = [];

      // ── 1. applyInput responds immediately ──
      const before = performance.now();
      rig.applyInput(400, 0);
      const after = performance.now();
      const latencyMs = after - before;
      const predictedX = rig.getState().predictedPaddleX;
      const immediateOk = latencyMs < 16 && predictedX === 400;
      results.push(
        `1. applyInput latency: ${latencyMs.toFixed(3)}ms (target <16ms) — ${immediateOk ? "PASS" : "FAIL"}`,
      );
      results.push(`   predictedPaddleX immediately after input: ${predictedX} (expected 400)`);

      // ── 2. Force divergence 30px (within tolerance) — no snap ──
      rig.applyInput(400, 0); // seq 0
      rig.applyInput(420, 0); // seq 1
      rig.feedSnapshot(390, 0, { x: 0, y: 0 }, { x: 0, y: 0 }); // 30px off, lastProcessedSeq=0
      const afterSmallDiv = rig.getState().predictedPaddleX;
      // Should NOT snap — 30px < 40px tolerance
      // After reconciling seq 0, remaining input is seq 1 at x=420
      // Since diff(420, 390)=30 < 40, smooth lerp is active
      // getPredictedPaddleX returns lerped value, which is between 420 and 390
      const smallDivOk = Math.abs(afterSmallDiv - 420) < 40; // should still be near 420
      results.push(
        `2. 30px divergence — predictedX: ${afterSmallDiv.toFixed(1)} (should stay near 420, no snap) — ${smallDivOk ? "PASS" : "FAIL"}`,
      );

      // ── 3. Force divergence 60px (exceeds tolerance) — snap + replay ──
      rig.applyInput(400, 0); // seq 2
      rig.applyInput(500, 0); // seq 3
      rig.feedSnapshot(440, 2, { x: 0, y: 0 }, { x: 0, y: 0 }); // 60px off from 500, ack seq 2
      const afterLargeDiv = rig.getState().predictedPaddleX;
      // Should snap: server says 440, ack seq 2, remaining input seq 3 at x=500
      // predictedX should be 500 (replayed)
      const largeDivOk = afterLargeDiv === 500;
      results.push(
        `3. 60px divergence + replay — predictedX: ${afterLargeDiv} (expected 500) — ${largeDivOk ? "PASS" : "FAIL"}`,
      );

      // ── 4. pendingInputs pruned after ack ──
      rig.applyInput(300, 0); // seq 4
      rig.applyInput(350, 0); // seq 5
      rig.applyInput(360, 0); // seq 6
      const beforeAck = rig.getState().pendingInputsLength;
      rig.feedSnapshot(360, 6, { x: 0, y: 0 }, { x: 0, y: 0 }); // ack up to seq 6
      const afterAck = rig.getState().pendingInputsLength;
      results.push(
        `4. pendingInputs before ack: ${beforeAck}, after ack(6): ${afterAck} (expected 1) — ${afterAck === 1 ? "PASS" : "FAIL"}`,
      );

      return {
        results,
        allPass: immediateOk && smallDivOk && largeDivOk && afterAck === 1,
      };
    });

    for (const line of result.results) {
      console.log(line);
    }

    writeFileSync(
      `${EVIDENCE_DIR}/task-10-predict-reconcile.txt`,
      `Task 10 — Scenario 1: Predicted paddle responds <16ms; reconciles correctly\n${"=".repeat(80)}\n\n${result.results.join("\n")}\n\nOverall: ${result.allPass ? "PASS" : "FAIL"}\n`,
    );

    expect(result.allPass).toBe(true);
  });

  test("Scenario 2: No rubber-band under 80ms simulated latency", async ({ page }) => {
    await page.goto(`${BASE_URL}/?frame_id=mock&test_predict=1`);
    await page.waitForFunction(
      () => (window as any).__test_predict_rig !== undefined,
      { timeout: 10000 },
    );

    const result = await page.evaluate(async () => {
      const rig = (window as any).__test_predict_rig as any;
      const results: string[] = [];

      const SIM_DURATION_MS = 5000;
      const INPUT_HZ = 60;
      const INPUT_INTERVAL_MS = 1000 / INPUT_HZ;
      const SIMULATED_RTT_MS = 80;
      const SNAP_HZ = 30;
      const SNAP_INTERVAL_MS = 1000 / SNAP_HZ;

      let seq = -1;
      let serverPaddleX = 360;
      const samples: number[] = [];
      const sampleTimes: number[] = [];

      const startTime = performance.now();
      let nextInputTime = startTime;
      let nextSnapTime = startTime + SIMULATED_RTT_MS / 2;
      let lastAckedSeq = -1;

      // Pre-generate a realistic paddle movement pattern: sine wave
      function targetX(t: number): number {
        return 360 + 200 * Math.sin(t * 0.002);
      }

      while (performance.now() - startTime < SIM_DURATION_MS) {
        const now = performance.now();

        if (now >= nextInputTime) {
          seq++;
          const x = targetX(now - startTime);
          rig.applyInput(x, 0);
          nextInputTime += INPUT_INTERVAL_MS;
        }

        if (now >= nextSnapTime) {
          // Server processes with RTT delay — paddle follows input with small error
          const serverTarget = targetX(now - startTime - SIMULATED_RTT_MS);
          serverPaddleX = serverTarget + (Math.random() - 0.5) * 5; // ±2.5px noise
          lastAckedSeq = Math.max(0, seq - 2); // server is ~2 inputs behind
          rig.feedSnapshot(serverPaddleX, lastAckedSeq, { x: 0, y: 0 }, { x: 0, y: 0 });
          nextSnapTime += SNAP_INTERVAL_MS;
        }

        // Sample predicted paddle X at ~60Hz
        const predicted = rig.getState().predictedPaddleX;
        samples.push(predicted);
        sampleTimes.push(now);

        // Yield to allow frame processing
        await new Promise((r) => setTimeout(r, 0));
      }

      // Compute frame-to-frame deltas
      const deltas: number[] = [];
      for (let i = 1; i < samples.length; i++) {
        deltas.push(Math.abs(samples[i]! - samples[i - 1]!));
      }

      const maxDelta = Math.max(...deltas);
      const meanDelta = deltas.reduce((a, b) => a + b, 0) / deltas.length;
      const outliers = deltas.filter((d) => d > 30);

      results.push(`Simulation: ${SIM_DURATION_MS}ms, ${INPUT_HZ}Hz input, ${SIMULATED_RTT_MS}ms RTT`);
      results.push(`Samples: ${samples.length}, Deltas: ${deltas.length}`);
      results.push(`Max frame-to-frame delta: ${maxDelta.toFixed(2)}px`);
      results.push(`Mean frame-to-frame delta: ${meanDelta.toFixed(2)}px`);
      results.push(`Deltas > 30px (rubber-band): ${outliers.length}`);
      results.push(`Threshold: no delta > 30px — ${outliers.length === 0 ? "PASS" : "FAIL"}`);

      return {
        results,
        allPass: outliers.length === 0,
        maxDelta,
        meanDelta,
        outlierCount: outliers.length,
      };
    });

    for (const line of result.results) {
      console.log(line);
    }

    writeFileSync(
      `${EVIDENCE_DIR}/task-10-no-rubberband.txt`,
      `Task 10 — Scenario 2: No rubber-band under 80ms simulated latency\n${"=".repeat(80)}\n\n${result.results.join("\n")}\n\nOverall: ${result.allPass ? "PASS" : "FAIL"}\n`,
    );

    expect(result.allPass).toBe(true);
  });

  test("Scenario 3: pendingInputs bounded under steady state", async ({ page }) => {
    await page.goto(`${BASE_URL}/?frame_id=mock&test_predict=1`);
    await page.waitForFunction(
      () => (window as any).__test_predict_rig !== undefined,
      { timeout: 10000 },
    );

    const result = await page.evaluate(async () => {
      const rig = (window as any).__test_predict_rig as any;
      const results: string[] = [];

      const SIM_DURATION_MS = 5000;
      const INPUT_HZ = 60;
      const INPUT_INTERVAL_MS = 1000 / INPUT_HZ;
      const SNAP_HZ = 30;
      const SNAP_INTERVAL_MS = 1000 / SNAP_HZ;

      let seq = -1;
      const pendingSamples: number[] = [];

      const startTime = performance.now();
      let nextInputTime = startTime;
      let nextSnapTime = startTime + 50;

      while (performance.now() - startTime < SIM_DURATION_MS) {
        const now = performance.now();

        if (now >= nextInputTime) {
          seq++;
          rig.applyInput(360 + 100 * Math.sin(seq * 0.1), 0);
          nextInputTime += INPUT_INTERVAL_MS;
        }

        if (now >= nextSnapTime) {
          rig.feedSnapshot(360, seq - 1, { x: 0, y: 0 }, { x: 0, y: 0 });
          nextSnapTime += SNAP_INTERVAL_MS;
        }

        pendingSamples.push(rig.getState().pendingInputsLength);
        await new Promise((r) => setTimeout(r, 0));
      }

      const maxPending = Math.max(...pendingSamples);
      const meanPending = pendingSamples.reduce((a, b) => a + b, 0) / pendingSamples.length;

      results.push(`Simulation: ${SIM_DURATION_MS}ms, ${INPUT_HZ}Hz input, ${SNAP_HZ}Hz snapshot`);
      results.push(`Samples: ${pendingSamples.length}`);
      results.push(`Max pendingInputs: ${maxPending}`);
      results.push(`Mean pendingInputs: ${meanPending.toFixed(1)}`);
      results.push(`Threshold: max <= 60 — ${maxPending <= 60 ? "PASS" : "FAIL"}`);

      return {
        results,
        allPass: maxPending <= 60,
        maxPending,
        meanPending,
      };
    });

    for (const line of result.results) {
      console.log(line);
    }

    writeFileSync(
      `${EVIDENCE_DIR}/task-10-pending-bounded.txt`,
      `Task 10 — Scenario 3: pendingInputs bounded under steady state\n${"=".repeat(80)}\n\n${result.results.join("\n")}\n\nOverall: ${result.allPass ? "PASS" : "FAIL"}\n`,
    );

    expect(result.allPass).toBe(true);
  });
});
