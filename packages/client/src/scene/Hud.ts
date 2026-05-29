/**
 * Hud — score numerals, rally counter, speed gauge, status banner, AFK overlay.
 *
 * All visuals via Pixi Text + Graphics — no @pixi/ui, no images.
 * Every dimension references shared constants; no magic numbers.
 */
import { Container, Graphics, Text, type TextOptions } from "pixi.js";
import {
  COURT_WIDTH,
  COURT_HEIGHT,
  BALL_SPEED_MAX,
  type PlayerSlot,
} from "@pingpong/shared";

/** Colors (design tokens). */
const TEXT_WHITE = 0xff_ff_ff;
const TEXT_DIM = 0x88_99_aa;
const ACCENT_BLUE = 0x4d_d2_ff;
const ACCENT_RED = 0xff_7a_7a;
const GAUGE_BG = 0x1a_2a_3a;
const GAUGE_FILL = 0x4d_d2_ff;

/** Speed gauge geometry. */
const GAUGE_WIDTH = 280;
const GAUGE_HEIGHT = 8;
const GAUGE_Y = COURT_HEIGHT - 40; // near bottom edge

/** Font stack — system monospace to avoid external font requests. */
const FONT = "'Courier New', Courier, monospace";

// ── Text helpers ─────────────────────────────────────────────────────────────

function makeText(
  opts: Pick<TextOptions, "text" | "style"> & { label?: string },
): Text {
  const t = new Text(opts);
  if (opts.label) t.label = opts.label;
  return t;
}

// ── Hud node ─────────────────────────────────────────────────────────────────

export interface HudNode {
  readonly layer: Container;
  readonly scoreTop: Text;
  readonly scoreBottom: Text;
  readonly rallyText: Text;
  readonly speedFill: Graphics;
  readonly speedLabel: Text;
  readonly banner: Text;
  readonly afkOverlay: Container;
  readonly leaveButton: Graphics;
  afkText: Text;
}

/**
 * Build the uiLayer with all HUD elements.
 * Returns a HudNode whose `layer` goes into the stage.
 */
export function buildHud(): HudNode {
  const layer = new Container();
  layer.label = "uiLayer";

  // ── Score — top (opponent) ────────────────────────────────────
  const scoreTop = makeText({
    text: "0",
    label: "score",
    style: {
      fontFamily: FONT,
      fontSize: 64,
      fill: ACCENT_RED,
      fontWeight: "bold",
    },
  });
  scoreTop.anchor.set(0.5);
  scoreTop.x = COURT_WIDTH / 2;
  scoreTop.y = COURT_HEIGHT / 2 - 60;
  layer.addChild(scoreTop);

  // ── Score — bottom (you) ─────────────────────────────────────
  const scoreBottom = makeText({
    text: "0",
    label: "score",
    style: {
      fontFamily: FONT,
      fontSize: 64,
      fill: ACCENT_BLUE,
      fontWeight: "bold",
    },
  });
  scoreBottom.anchor.set(0.5);
  scoreBottom.x = COURT_WIDTH / 2;
  scoreBottom.y = COURT_HEIGHT / 2 + 60;
  layer.addChild(scoreBottom);

  // ── Rally counter ────────────────────────────────────────────
  const rallyText = makeText({
    text: "Rally: 0",
    label: "rally",
    style: {
      fontFamily: FONT,
      fontSize: 20,
      fill: TEXT_DIM,
    },
  });
  rallyText.anchor.set(0.5);
  rallyText.x = COURT_WIDTH / 2;
  rallyText.y = COURT_HEIGHT / 2 + 24;
  layer.addChild(rallyText);

  // ── Speed gauge background ───────────────────────────────────
  const gaugeBg = new Graphics()
    .roundRect(0, 0, GAUGE_WIDTH, GAUGE_HEIGHT, 4)
    .fill(GAUGE_BG);
  gaugeBg.label = "speedGaugeBg";
  gaugeBg.x = (COURT_WIDTH - GAUGE_WIDTH) / 2;
  gaugeBg.y = GAUGE_Y;
  layer.addChild(gaugeBg);

  // ── Speed gauge fill ─────────────────────────────────────────
  const speedFill = new Graphics()
    .roundRect(0, 0, GAUGE_WIDTH, GAUGE_HEIGHT, 4)
    .fill(GAUGE_FILL);
  speedFill.label = "speedGaugeFill";
  speedFill.x = (COURT_WIDTH - GAUGE_WIDTH) / 2;
  speedFill.y = GAUGE_Y;
  speedFill.scale.x = 0; // starts empty
  layer.addChild(speedFill);

  // ── Speed label ──────────────────────────────────────────────
  const speedLabel = makeText({
    text: "Speed",
    label: "speedLabel",
    style: { fontFamily: FONT, fontSize: 14, fill: TEXT_DIM },
  });
  speedLabel.anchor.set(0.5);
  speedLabel.x = COURT_WIDTH / 2;
  speedLabel.y = GAUGE_Y - 14;
  layer.addChild(speedLabel);

  // ── Status banner (center of court) ──────────────────────────
  const banner = makeText({
    text: "",
    label: "statusBanner",
    style: {
      fontFamily: FONT,
      fontSize: 40,
      fill: TEXT_WHITE,
      fontWeight: "bold",
      align: "center",
    },
  });
  banner.anchor.set(0.5);
  banner.x = COURT_WIDTH / 2;
  banner.y = COURT_HEIGHT / 2 - 30;
  banner.visible = false;
  layer.addChild(banner);

  // ── Leave button (top-right corner) ───────────────────────────────────
  const leaveButton = new Graphics();
  leaveButton.roundRect(0, 0, 30, 30, 6);
  leaveButton.fill(0xff3333);
  leaveButton.stroke({ color: 0xffffff, width: 2 });
  leaveButton.x = 680;
  leaveButton.y = 20;
  leaveButton.label = "leaveButton";
  leaveButton.eventMode = "static";
  leaveButton.cursor = "pointer";
  layer.addChild(leaveButton);

  const leaveText = makeText({
    text: "×",
    label: "leaveText",
    style: {
      fontFamily: FONT,
      fontSize: 28,
      fontWeight: "bold",
      fill: 0xffffff,
      align: "center",
    },
  });
  leaveText.anchor.set(0.5);
  leaveText.x = 15;
  leaveText.y = 15;
  leaveButton.addChild(leaveText);

  // ── AFK overlay (hidden by default — populated by showAfk) ────────────
  const afkOverlay = new Container();
  afkOverlay.label = "afkOverlay";
  afkOverlay.visible = false;
  layer.addChild(afkOverlay);

  const afkText = new Text({ text: "" });
  afkText.visible = false;

  return {
    layer,
    scoreTop,
    scoreBottom,
    rallyText,
    speedFill,
    speedLabel,
    banner,
    leaveButton,
    afkOverlay,
    afkText,
  };
}

// ── Hud update helpers ───────────────────────────────────────────────────────

/**
 * Set displayed scores. Call once per frame (Text is cheap if unchanged).
 */
export function setScores(hud: HudNode, top: number, bottom: number): void {
  hud.scoreTop.text = String(top);
  hud.scoreBottom.text = String(bottom);
}

/** Set rally count display. */
export function setRally(hud: HudNode, count: number): void {
  hud.rallyText.text = `Rally: ${count}`;
}

/**
 * Update speed gauge from ball speed magnitude.
 * `ballSpeed` = sqrt(vx² + vy²), clamped 0..BALL_SPEED_MAX.
 */
export function setSpeedGauge(hud: HudNode, ballSpeed: number): void {
  const ratio = Math.min(Math.max(ballSpeed / BALL_SPEED_MAX, 0), 1);
  hud.speedFill.scale.x = ratio;
}

/**
 * Show / hide the status banner.
 * Pass empty string to hide.
 */
export function setBanner(hud: HudNode, text: string): void {
  if (text) {
    hud.banner.text = text;
    hud.banner.visible = true;
  } else {
    hud.banner.visible = false;
  }
}

/**
 * Show the AFK warning overlay on the given player's side (half-court).
 * Red tint covers only the AFK player's half; text centered in that half.
 * Call `setAfkPulse(hud, alpha)` each frame for 1 Hz pulsing.
 */
export function showAfk(hud: HudNode, slot: PlayerSlot, secondsRemaining: number): void {
  hud.afkOverlay.removeChildren().forEach(c => c.destroy());

  const halfH = COURT_HEIGHT / 2;
  const yOffset = slot === "top" ? 0 : halfH;

  const afkBg = new Graphics()
    .rect(0, yOffset, COURT_WIDTH, halfH)
    .fill({ color: ACCENT_RED, alpha: 0.35 });
  afkBg.label = "afkBgRect";
  hud.afkOverlay.addChild(afkBg);

  const afkText = makeText({
    text: `AFK Warning\n${secondsRemaining}s remaining`,
    label: "afkText",
    style: {
      fontFamily: FONT,
      fontSize: 32,
      fill: TEXT_WHITE,
      fontWeight: "bold",
      align: "center",
    },
  });
  afkText.anchor.set(0.5);
  afkText.x = COURT_WIDTH / 2;
  afkText.y = yOffset + halfH / 2;
  hud.afkOverlay.addChild(afkText);
  hud.afkText = afkText;

  hud.afkOverlay.visible = true;
}

/**
 * Update the AFK overlay pulse alpha (call from ticker for 1 Hz effect).
 * `alpha` should oscillate between ~0.2 and ~0.7.
 */
export function setAfkPulse(hud: HudNode, alpha: number): void {
  const bg = hud.afkOverlay.getChildByLabel?.("afkBgRect") as Graphics | undefined;
  if (bg) bg.alpha = alpha;
}

/** Hide the AFK overlay. */
export function hideAfk(hud: HudNode): void {
  hud.afkOverlay.visible = false;
}

/**
 * Flash a score numeral (scale bump animation).
 * `side` = 'top' | 'bottom'.
 */
export function flashScore(
  hud: HudNode,
  side: "top" | "bottom",
  elapsed: number,
): void {
  const target = side === "top" ? hud.scoreTop : hud.scoreBottom;
  // Simple scale pulse: 1.5 → 1.0 over 300ms
  const t = Math.min(elapsed / 300, 1);
  const scale = 1 + 0.5 * (1 - t);
  target.scale.set(scale);
}
