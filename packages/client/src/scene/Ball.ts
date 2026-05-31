import { BALL_RADIUS } from '@pingpong/shared';
/**
 * Ball — clean white circle, no trail.
 *
 * Pixi v8 chained Graphics API.
 */
import { Container, Graphics } from 'pixi.js';

/** White ball color. */
const BALL_COLOR = 0xff_ff_ff;

/**
 * Holds the ball Graphics inside a container.
 */
export interface BallNode {
  readonly container: Container;
  readonly ball: Graphics;
}

/**
 * Build the ball assembly.
 * Returns a BallNode; add `container` to the playLayer.
 */
export function createBall(): BallNode {
  const container = new Container();
  container.label = 'ball';

  const ball = new Graphics().circle(0, 0, BALL_RADIUS).fill(BALL_COLOR);
  ball.label = 'ballGfx';
  container.addChild(ball);

  return { container, ball };
}

/**
 * Update ball position from current state.
 * Call once per frame.
 */
export function updateBall(node: BallNode, x: number, y: number): void {
  node.ball.x = x;
  node.ball.y = y;
  node.container.x = 0;
  node.container.y = 0;
}
