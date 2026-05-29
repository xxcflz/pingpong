/**
 * Court — background layer: solid fill, dashed center net, boundary outline.
 *
 * Pixi v8 chained Graphics API only.
 * All dimensions/colors from @pingpong/shared constants — zero magic numbers.
 */
import { Container, Graphics } from "pixi.js";
import { COURT_WIDTH, COURT_HEIGHT } from "@pingpong/shared";

/** Dashed line segment length and gap (px). */
const DASH_LEN = 12;
const GAP_LEN = 8;

/** Colors (design tokens). */
const COURT_BG = 0x0b_0f_17;
const NET_COLOR = 0x2a_3a_4f;
const BOUNDARY_COLOR = 0x1a_2a_3a;

/**
 * Build the background layer (bgLayer).
 * Returns a labelled Container ready to be added to the stage.
 */
export function buildCourt(): Container {
  const layer = new Container();
  layer.label = "bgLayer";

  // ── Court fill ──────────────────────────────────────────────────
  const bg = new Graphics()
    .rect(0, 0, COURT_WIDTH, COURT_HEIGHT)
    .fill(COURT_BG);
  bg.label = "courtBg";
  layer.addChild(bg);

  // ── Dashed center net ──────────────────────────────────────────
  const net = new Graphics();
  net.label = "centerNet";
  const midY = COURT_HEIGHT / 2;
  let x = 0;
  while (x < COURT_WIDTH) {
    const segEnd = Math.min(x + DASH_LEN, COURT_WIDTH);
    net.moveTo(x, midY).lineTo(segEnd, midY);
    x = segEnd + GAP_LEN;
  }
  net.stroke({ width: 3, color: NET_COLOR });
  layer.addChild(net);

  // ── Boundary outline ──────────────────────────────────────────
  const border = new Graphics()
    .rect(0, 0, COURT_WIDTH, COURT_HEIGHT)
    .stroke({ width: 4, color: BOUNDARY_COLOR });
  border.label = "boundary";
  layer.addChild(border);

  return layer;
}
