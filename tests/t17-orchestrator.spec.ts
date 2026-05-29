import { test, expect } from "@playwright/test";
import { existsSync } from "node:fs";

const CLIENT_URL = "http://localhost:5173";
const SERVER_URL = "http://localhost:3001";

async function resetLobby() {
  await fetch(`${SERVER_URL}/api/_debug/reset`, { method: "POST" }).catch(() => {});
}

test.describe("MatchOrchestrator (T17)", () => {
  test("happy path: 2-player match with Ready → countdown → match", async ({ browser }) => {
    await resetLobby();

    const ctx1 = await browser.newContext();
    const ctx2 = await browser.newContext();
    const page1 = await ctx1.newPage();
    const page2 = await ctx2.newPage();

    await page1.goto(`${CLIENT_URL}/?frame_id=mock&test_user_id=alice`);
    await page2.goto(`${CLIENT_URL}/?frame_id=mock&test_user_id=bob`);

    await page1.waitForFunction(() => !!window.__orchestrator, { timeout: 10000 });
    await page2.waitForFunction(() => !!window.__orchestrator, { timeout: 10000 });

    await page1.waitForFunction(
      () => window.__orchestrator?.currentRole === "player",
      { timeout: 5000 },
    );
    await page2.waitForFunction(
      () => window.__orchestrator?.currentRole === "player",
      { timeout: 5000 },
    );

    await page1.evaluate(() => { (window.__orchestrator as any)?.socket?.emit("readyToggle"); });
    await page2.evaluate(() => { (window.__orchestrator as any)?.socket?.emit("readyToggle"); });

    await page1.waitForFunction(
      () => window.__orchestrator?.phase === "countdown",
      { timeout: 10000 },
    );

    await page1.waitForFunction(
      () => window.__orchestrator?.phase === "playing",
      { timeout: 10000 },
    );
    await page2.waitForFunction(
      () => window.__orchestrator?.phase === "playing",
      { timeout: 10000 },
    );

    const slot1 = await page1.evaluate(() => window.__orchestrator?.playerSlot);
    const slot2 = await page2.evaluate(() => window.__orchestrator?.playerSlot);
    expect(slot1).toBeTruthy();
    expect(slot2).toBeTruthy();
    expect(slot1).not.toBe(slot2);

    await page1.evaluate(() => { (window.__orchestrator as any)?.prediction?.applyInput(360, 0); });
    await page2.evaluate(() => { (window.__orchestrator as any)?.prediction?.applyInput(360, 0); });

    await page1.waitForTimeout(1000);

    await page1.screenshot({ path: ".omo/evidence/task-17-happy-path-p1.png" });
    await page2.screenshot({ path: ".omo/evidence/task-17-happy-path-p2.png" });

    await ctx1.close();
    await ctx2.close();
  });

  test("spectator auto-attach: 3rd context sees 'Spectating'", async ({ browser }) => {
    await resetLobby();
    await new Promise(r => setTimeout(r, 500));

    const ctx1 = await browser.newContext();
    const ctx2 = await browser.newContext();
    const ctx3 = await browser.newContext();
    const page1 = await ctx1.newPage();
    const page2 = await ctx2.newPage();
    const page3 = await ctx3.newPage();

    await page1.goto(`${CLIENT_URL}/?frame_id=mock&test_user_id=player1`);
    await page2.goto(`${CLIENT_URL}/?frame_id=mock&test_user_id=player2`);
    await page1.waitForFunction(() => !!window.__orchestrator, { timeout: 10000 });
    await page2.waitForFunction(() => !!window.__orchestrator, { timeout: 10000 });

    await page1.waitForFunction(
      () => window.__orchestrator?.currentRole === "player",
      { timeout: 5000 },
    );
    await page2.waitForFunction(
      () => window.__orchestrator?.currentRole === "player",
      { timeout: 5000 },
    );

    await page1.evaluate(() => { (window.__orchestrator as any)?.socket?.emit("readyToggle"); });
    await page2.evaluate(() => { (window.__orchestrator as any)?.socket?.emit("readyToggle"); });

    await page1.waitForFunction(
      () => window.__orchestrator?.phase === "playing",
      { timeout: 15000 },
    );

    await page3.goto(`${CLIENT_URL}/?frame_id=mock&test_user_id=charlie`);
    await page3.waitForFunction(() => !!window.__orchestrator, { timeout: 10000 });

    await page3.waitForFunction(
      () => window.__orchestrator?.currentRole === "spectator",
      { timeout: 10000 },
    );

    const role3 = await page3.evaluate(() => window.__orchestrator?.currentRole);
    expect(role3).toBe("spectator");

    await page3.screenshot({ path: ".omo/evidence/task-17-spectator.png" });

    await ctx1.close();
    await ctx2.close();
    await ctx3.close();
  });

  test("spike directory removed", async () => {
    const spikeDir = "/home/vibi/ProjectAI/PingPongDiscord/packages/client/src/spike";
    expect(existsSync(spikeDir)).toBe(false);

    const fs = await import("node:fs");
    fs.writeFileSync(
      "/home/vibi/ProjectAI/PingPongDiscord/.omo/evidence/task-17-no-spike.txt",
      `spike directory exists: ${existsSync(spikeDir)}\n`,
    );
  });

  test("reconnect banner on transient socket loss", async ({ browser }) => {
    await resetLobby();

    const ctx = await browser.newContext();
    const page = await ctx.newPage();

    await page.goto(`${CLIENT_URL}/?frame_id=mock&test_user_id=reconnect_test`);
    await page.waitForFunction(() => !!window.__orchestrator, { timeout: 10000 });
    await page.waitForTimeout(1500);

    const connected = await page.evaluate(
      () => (window.__orchestrator as any)?.socket?.connected ?? false,
    );
    expect(connected).toBe(true);

    await page.evaluate(() => { window.__test_dropSocket?.(); });
    await page.waitForTimeout(500);

    const isReconnecting = await page.evaluate(
      () => window.__orchestrator?.reconnecting ?? false,
    );
    expect(isReconnecting).toBe(true);

    const hasBanner = await page.evaluate(() => {
      const scene = window.__pong_scene;
      if (!scene) return false;
      const layers = scene.getLayers();
      const findLabel = (container: any, label: string): boolean => {
        for (const child of container.children ?? []) {
          if (child.label === label) return true;
          if (findLabel(child, label)) return true;
        }
        return false;
      };
      return findLabel(layers.uiLayer, "reconnectBanner");
    });

    await page.screenshot({ path: ".omo/evidence/task-17-reconnect-banner.png" });
    expect(hasBanner).toBe(true);

    await ctx.close();
  });
});
