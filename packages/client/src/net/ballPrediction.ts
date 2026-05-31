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

/**
 * Time constant (seconds) for visual error decay. The rendered ball converges
 * to the authoritative position over roughly 2–3× this duration. Time-based
 * (not frame-based) so the convergence speed is identical at 60 fps or 250 fps.
 */
const ERROR_DECAY_TAU = 0.05;

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
  // Authoritative simulation track. Always advanced by physics and snapped to
  // the server on every snapshot, so it never diverges into a competing ball.
  let predicted: BallState = {
    pos: { x: COURT_WIDTH / 2, y: COURT_HEIGHT / 2 },
    vel: { x: 0, y: BALL_SPEED_INITIAL },
    spin: 0,
    radius: BALL_RADIUS,
  };

  // Visual error: renderedPos = predicted.pos + posError. Seeded on each
  // snapshot to preserve on-screen continuity, then decayed toward zero. This
  // replaces the old 2-frame output blend, which left `predicted` on its own
  // track and caused the ball to oscillate between the predicted (leading) and
  // server (trailing) positions every snapshot — the "ghost that follows".
  let posError: Vec2 = { x: 0, y: 0 };

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

    // Decay the visual error toward zero (frame-rate independent).
    const decay = Math.exp(-dt / ERROR_DECAY_TAU);
    posError = { x: posError.x * decay, y: posError.y * decay };
  }

  function onSnapshot(serverBall: BallState): void {
    // Current on-screen position = authoritative track + visual error.
    const renderedX = predicted.pos.x + posError.x;
    const renderedY = predicted.pos.y + posError.y;

    const dx = renderedX - serverBall.pos.x;
    const dy = renderedY - serverBall.pos.y;
    const distance = Math.sqrt(dx * dx + dy * dy);

    if (distance > MAX_CORRECTION_PX) {
      // Large divergence: snap immediately, no visual carry-over.
      predicted = { ...serverBall };
      posError = { x: 0, y: 0 };
      return;
    }

    // Adopt the server's authoritative pos/vel/spin as the simulation track,
    // and carry the (small) on-screen discrepancy as a decaying offset so the
    // rendered ball stays continuous instead of snapping.
    predicted = { ...serverBall };
    posError = { x: renderedX - serverBall.pos.x, y: renderedY - serverBall.pos.y };
  }

  function getPredictedBall(): BallState {
    if (posError.x === 0 && posError.y === 0) {
      return predicted;
    }
    return {
      ...predicted,
      pos: { x: predicted.pos.x + posError.x, y: predicted.pos.y + posError.y },
    };
  }

  function reset(ball: BallState): void {
    predicted = { ...ball };
    posError = { x: 0, y: 0 };
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
