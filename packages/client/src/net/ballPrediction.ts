/**
 * Client-side ball prediction with server reconciliation.
 *
 * Runs the same physics as the server locally for immediate ball rendering.
 * When a server snapshot arrives, corrects the predicted position with smooth blending.
 *
 * Pure data — no Pixi, no DOM.
 */
import {
  BALL_RADIUS,
  BALL_SPEED_INITIAL,
  type BallState,
  COURT_HEIGHT,
  COURT_WIDTH,
  type PaddleState,
  type Vec2,
  accelerateOnRally,
  applyMagnus,
  applySpinFromPaddle,
  collidePaddleAabb,
  collideWalls,
  decaySpin,
  stepBall,
} from '@pingpong/shared';

/** Maximum correction distance before snapping (instead of blending). */
const MAX_CORRECTION_PX = 80;

/** Frames over which to blend a correction. */
const CORRECTION_BLEND_FRAMES = 2;

export interface BallPredictionEngine {
  /** Advance the prediction by one frame (dt seconds). */
  tick(dt: number, paddles: { top: PaddleState; bottom: PaddleState }): void;

  /** Feed an authoritative server snapshot to correct the prediction. */
  onSnapshot(serverBall: BallState): void;

  /** Read the current predicted ball state for rendering. */
  getPredictedBall(): BallState;

  /** Reset prediction to a specific ball state. */
  reset(ball: BallState): void;

  /** Check if a score event should have occurred (ball out of bounds). */
  checkScore(): 'top' | 'bottom' | null;
}

export function createBallPredictionEngine(): BallPredictionEngine {
  let predicted: BallState = {
    pos: { x: COURT_WIDTH / 2, y: COURT_HEIGHT / 2 },
    vel: { x: 0, y: BALL_SPEED_INITIAL },
    spin: 0,
    radius: BALL_RADIUS,
  };

  // Correction blending state
  let correctionActive = false;
  let correctionFrom: Vec2 = { x: 0, y: 0 };
  let correctionTo: Vec2 = { x: 0, y: 0 };
  let correctionFrame = 0;

  function tick(dt: number, paddles: { top: PaddleState; bottom: PaddleState }): void {
    // 1. Apply Magnus effect
    let ball = applyMagnus(predicted, dt);

    // 2. Step position
    ball = stepBall(ball, dt);

    // 3. Decay spin
    ball = decaySpin(ball);

    // 4. Paddle collisions — predict ALL bounces for instant feedback
    // Server will correct if there's divergence (e.g., cheating)
    const topPaddle = paddles.top;
    const bottomPaddle = paddles.bottom;

    // Top paddle: only collide if ball is moving upward
    if (collidePaddleAabb(ball, topPaddle) && ball.vel.y < 0) {
      ball = { ...ball, vel: { x: ball.vel.x, y: Math.abs(ball.vel.y) } };
      ball = applySpinFromPaddle(ball, topPaddle);
      ball = accelerateOnRally(ball);
    }

    // Bottom paddle: only collide if ball is moving downward
    if (collidePaddleAabb(ball, bottomPaddle) && ball.vel.y > 0) {
      ball = { ...ball, vel: { x: ball.vel.x, y: -Math.abs(ball.vel.y) } };
      ball = applySpinFromPaddle(ball, bottomPaddle);
      ball = accelerateOnRally(ball);
    }

    // 5. Wall collisions
    ball = collideWalls(ball);

    predicted = ball;
  }

  function onSnapshot(serverBall: BallState): void {
    const dx = predicted.pos.x - serverBall.pos.x;
    const dy = predicted.pos.y - serverBall.pos.y;
    const distance = Math.sqrt(dx * dx + dy * dy);

    if (distance > MAX_CORRECTION_PX) {
      // Large divergence: snap immediately
      predicted = { ...serverBall };
      correctionActive = false;
    } else if (distance > 1) {
      // Small divergence: blend over several frames
      correctionFrom = { ...predicted.pos };
      correctionTo = { ...serverBall.pos };
      correctionFrame = 0;
      correctionActive = true;

      // Also update velocity and spin from server (these are harder to predict)
      predicted = {
        ...serverBall,
        pos: predicted.pos, // Keep current position, blend it below
      };
    } else {
      // Perfect match
      predicted = { ...serverBall };
      correctionActive = false;
    }
  }

  function getPredictedBall(): BallState {
    if (!correctionActive) {
      return predicted;
    }

    correctionFrame++;
    const t = Math.min(correctionFrame / CORRECTION_BLEND_FRAMES, 1);

    if (t >= 1) {
      correctionActive = false;
      return {
        ...predicted,
        pos: correctionTo,
      };
    }

    // Cubic ease-out for smooth correction
    const eased = 1 - (1 - t) * (1 - t) * (1 - t);
    const blendedX = correctionFrom.x + (correctionTo.x - correctionFrom.x) * eased;
    const blendedY = correctionFrom.y + (correctionTo.y - correctionFrom.y) * eased;

    return {
      ...predicted,
      pos: { x: blendedX, y: blendedY },
    };
  }

  function reset(ball: BallState): void {
    predicted = { ...ball };
    correctionActive = false;
  }

  function checkScore(): 'top' | 'bottom' | null {
    if (predicted.pos.y - predicted.radius > COURT_HEIGHT) {
      return 'top';
    }
    if (predicted.pos.y + predicted.radius < 0) {
      return 'bottom';
    }
    return null;
  }

  return { tick, onSnapshot, getPredictedBall, reset, checkScore };
}
