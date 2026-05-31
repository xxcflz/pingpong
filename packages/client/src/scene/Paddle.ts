import { PADDLE_HEIGHT, PADDLE_WIDTH } from '@pingpong/shared';
/**
 * Paddle — rounded-rect paddle Graphics helper.
 *
 * Each paddle is a child of the playLayer. Position is set each frame
 * via `updatePaddle()` from the MatchState snapshot.
 *
 * Pixi v8 chained Graphics API.
 */
import { Graphics } from 'pixi.js';

/** Corner radius for the rounded rectangle. */
const CORNER_RADIUS = 6;

/** Default colors. */
export const PADDLE_COLOR_BOTTOM = 0x4d_d2_ff; // local player (you)
export const PADDLE_COLOR_TOP = 0xff_7a_7a; // opponent

/**
 * Create a single paddle Graphics, centred at (0, 0).
 * Caller positions it via `.x` / `.y`.
 */
export function createPaddle(label: string, color: number): Graphics {
  const paddle = new Graphics()
    .roundRect(-PADDLE_WIDTH / 2, -PADDLE_HEIGHT / 2, PADDLE_WIDTH, PADDLE_HEIGHT, CORNER_RADIUS)
    .fill(color);
  paddle.label = label;
  return paddle;
}

/** Recolor a paddle in-place without changing its label or geometry. */
export function recolorPaddle(paddle: Graphics, color: number): void {
  paddle
    .clear()
    .roundRect(-PADDLE_WIDTH / 2, -PADDLE_HEIGHT / 2, PADDLE_WIDTH, PADDLE_HEIGHT, CORNER_RADIUS)
    .fill(color);
}
