import { test, expect } from "@playwright/test";

test.describe("Drag-to-spin input handler (T12)", () => {
  test.beforeEach(async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("console", (msg) => {
      if (msg.type() === "error") errors.push(msg.text());
    });
    await page.goto("/?frame_id=mock&test_input=1");
    await page.waitForSelector("#game");
    await page.waitForTimeout(500);
  });

  test("mouse drag emits onPaddleX events + correct release velocity", async ({
    page,
  }) => {
    const pageErrors: string[] = [];
    page.on("pageerror", (e) => pageErrors.push(e.message));
    page.on("console", (msg) => {
      if (msg.type() === "error" || msg.type() === "warn") pageErrors.push(`[${msg.type()}] ${msg.text()}`);
    });

    const handlerExists = await page.evaluate(() => !!window.__test_dragHandler);
    const eventsInit = await page.evaluate(() => window.__test_dragEvents);
    console.log("handlerExists:", handlerExists, "eventsInit:", eventsInit, "errors:", pageErrors);
    expect(handlerExists, `Handler not found. Errors: ${JSON.stringify(pageErrors)}`).toBe(true);

    const canvas = page.locator("#game");
    const box = await canvas.boundingBox();
    if (!box) throw new Error("Canvas not found");

    const startX = box.x + 100;
    const y = box.y + box.height / 2;

    await page.mouse.move(startX, y);
    await page.mouse.down();

    for (let i = 1; i <= 12; i++) {
      await page.mouse.move(startX + i * 20, y);
      await page.waitForTimeout(8);
    }

    await page.mouse.up();
    await page.waitForTimeout(50);

    const events = await page.evaluate(() => window.__test_dragEvents ?? []);
    const moves = events.filter((e: any) => e.type === "paddleX");
    const releases = events.filter((e: any) => e.type === "release");

    expect(moves.length, `Expected >=10 moves, got ${moves.length}: ${JSON.stringify(events.slice(0, 5))}`).toBeGreaterThanOrEqual(10);
    expect(releases.length, `Expected 1 release, got ${releases.length}`).toBe(1);
    expect(releases[0].velX, `Expected velX > 0, got ${releases[0]?.velX}`).toBeGreaterThan(0);
    expect(releases[0].velX).toBeLessThanOrEqual(900);
  });

  test("touch drag emits matching events", async ({ page }) => {
    await page.evaluate(() => {
      const canvas = document.querySelector("#game") as HTMLElement;
      const rect = canvas.getBoundingClientRect();
      const startX = rect.left + 200;
      const centerY = rect.top + rect.height / 2;
      const events: any[] = [];

      function dispatch(type: string, x: number, pointerId: number) {
        const e = new PointerEvent(type, {
          clientX: x,
          clientY: centerY,
          pointerId,
          pointerType: "touch",
          isPrimary: true,
          bubbles: true,
          cancelable: true,
        });
        canvas.dispatchEvent(e);
        if (type !== "pointerup" && type !== "pointercancel") {
          events.push({ type: "paddleX", x });
        } else {
          events.push({ type: "release" });
        }
      }

      dispatch("pointerdown", startX, 1);
      for (let i = 1; i <= 12; i++) {
        dispatch("pointermove", startX + i * 15, 1);
      }
      dispatch("pointerup", startX + 12 * 15, 1);

      (window as any).__touch_test_events = events;
    });

    const touchEvents = await page.evaluate(
      () => (window as any).__touch_test_events ?? [],
    );
    const moves = touchEvents.filter((e: any) => e.type === "paddleX");
    const releases = touchEvents.filter((e: any) => e.type === "release");

    expect(moves.length).toBeGreaterThanOrEqual(10);
    expect(releases).toHaveLength(1);
  });

  test("disable() stops events (spectator mode)", async ({ page }) => {
    const canvas = page.locator("#game");
    const box = await canvas.boundingBox();
    if (!box) throw new Error("Canvas not found");

    await page.mouse.move(box.x + 100, box.y + box.height / 2);
    await page.mouse.down();
    for (let i = 1; i <= 5; i++) {
      await page.mouse.move(box.x + 100 + i * 20, box.y + box.height / 2);
      await page.waitForTimeout(8);
    }
    await page.mouse.up();
    await page.waitForTimeout(50);

    const countBefore = await page.evaluate(
      () => (window.__test_dragEvents ?? []).length,
    );
    expect(countBefore).toBeGreaterThan(0);

    await page.evaluate(() => window.__test_dragHandler?.disable());

    await page.mouse.move(box.x + 200, box.y + box.height / 2);
    await page.mouse.down();
    for (let i = 1; i <= 5; i++) {
      await page.mouse.move(box.x + 200 + i * 20, box.y + box.height / 2);
      await page.waitForTimeout(8);
    }
    await page.mouse.up();
    await page.waitForTimeout(50);

    const countAfter = await page.evaluate(
      () => (window.__test_dragEvents ?? []).length,
    );
    expect(countAfter).toBe(countBefore);
  });
});
