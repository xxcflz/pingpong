/**
 * Pure physics functions — deterministic, no I/O, no Date.now().
 *
 * Every function takes explicit dt (seconds) and returns a NEW object
 * (never mutates inputs). Safe for server hot-path and replay.
 */

import {
  BALL_SPEED_MAX,
  BALL_SPEED_RALLY_FACTOR,
  COURT_HEIGHT,
  COURT_WIDTH,
  MAGNUS_K,
  PADDLE_HEIGHT,
  SPIN_DECAY,
  SPIN_FROM_PADDLE_VELOCITY,
} from "./constants.js";
import type { BallState, PaddleState, Vec2 } from "./types.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

function vec2(x: number, y: number): Vec2 {
  return { x, y };
}

function vecLen(v: Vec2): number {
  return Math.sqrt(v.x * v.x + v.y * v.y);
}

function clamp(val: number, min: number, max: number): number {
  return Math.min(Math.max(val, min), max);
}

// ── Core physics ─────────────────────────────────────────────────────────────

/**
 * Advance ball position by one tick.
 * `pos += vel * dt`
 */
export function stepBall(ball: BallState, dt: number): BallState {
  return {
    ...ball,
    pos: vec2(ball.pos.x + ball.vel.x * dt, ball.pos.y + ball.vel.y * dt),
  };
}

/**
 * Apply Magnus effect acceleration to ball velocity.
 * `a = (k·ω·v_y, −k·ω·v_x)`
 * `vel += a * dt`
 */
export function applyMagnus(ball: BallState, dt: number): BallState {
  const ax = MAGNUS_K * ball.spin * ball.vel.y;
  const ay = -MAGNUS_K * ball.spin * ball.vel.x;
  return {
    ...ball,
    vel: vec2(ball.vel.x + ax * dt, ball.vel.y + ay * dt),
  };
}

/**
 * Decay spin multiplicatively each physics tick.
 * `spin *= SPIN_DECAY`
 */
export function decaySpin(ball: BallState): BallState {
  return {
    ...ball,
    spin: ball.spin * SPIN_DECAY,
  };
}

/**
 * Clamp paddle position so it stays fully within the court bounds.
 * Paddle origin is its center.
 */
export function clampPaddle(paddle: PaddleState): PaddleState {
  const halfW = paddle.width / 2;
  const halfH = paddle.height / 2;
  const clampedX = clamp(paddle.pos.x, halfW, COURT_WIDTH - halfW);
  const clampedY = clamp(paddle.pos.y, halfH, COURT_HEIGHT - halfH);
  return {
    ...paddle,
    pos: vec2(clampedX, clampedY),
  };
}

/**
 * AABB collision between ball and paddle.
 * Returns `true` if the ball overlaps the paddle rectangle.
 */
export function collidePaddleAabb(
  ball: BallState,
  paddle: PaddleState,
): boolean {
  const halfW = paddle.width / 2;
  const halfH = paddle.height / 2;

  const closestX = clamp(ball.pos.x, paddle.pos.x - halfW, paddle.pos.x + halfW);
  const closestY = clamp(ball.pos.y, paddle.pos.y - halfH, paddle.pos.y + halfH);

  const dx = ball.pos.x - closestX;
  const dy = ball.pos.y - closestY;
  return dx * dx + dy * dy <= ball.radius * ball.radius;
}

/**
 * Reflect ball off court walls (left, right, top).
 * Bottom wall is not checked — that's a scoring event handled by the server.
 * Returns a NEW ball with velocity reflected where appropriate.
 */
export function collideWalls(ball: BallState): BallState {
  let { x, y } = ball.vel;

  // Left wall
  if (ball.pos.x - ball.radius <= 0) {
    x = Math.abs(x);
  }
  // Right wall
  if (ball.pos.x + ball.radius >= COURT_WIDTH) {
    x = -Math.abs(x);
  }
  // Top wall
  if (ball.pos.y - ball.radius <= 0) {
    y = Math.abs(y);
  }

  return { ...ball, vel: vec2(x, y) };
}

/**
 * Transfer paddle tangential velocity to ball spin on contact.
 * Spin is imparted based on paddle's horizontal velocity component.
 */
export function applySpinFromPaddle(
  ball: BallState,
  paddle: PaddleState,
): BallState {
  // Paddle horizontal velocity → spin (positive vel.x → positive spin)
  const newSpin = ball.spin + paddle.vel.x * SPIN_FROM_PADDLE_VELOCITY;
  return { ...ball, spin: newSpin };
}

/**
 * Reflect ball off a paddle, computing angle from the hit offset.
 * `offset` is normalized: −1 (left edge) to +1 (right edge) of the paddle.
 * Max deflection angle is 60° from vertical.
 * Returns a NEW ball with updated velocity.
 */
export function reflectOffPaddle(
  ball: BallState,
  paddle: PaddleState,
  dirY: number,
): BallState {
  const offset = (ball.pos.x - paddle.pos.x) / (paddle.width / 2);
  const clampedOffset = clamp(offset, -1, 1);
  const maxAngle = Math.PI / 3;
  const angle = clampedOffset * maxAngle;
  const speed = vecLen(ball.vel);
  if (speed === 0) return ball;
  return {
    ...ball,
    vel: vec2(
      Math.sin(angle) * speed,
      dirY * Math.cos(angle) * speed,
    ),
  };
}

/**
 * Accelerate ball on rally (each paddle hit).
 * Speed increases by BALL_SPEED_RALLY_FACTOR, capped at BALL_SPEED_MAX.
 * Direction is preserved.
 */
export function accelerateOnRally(ball: BallState): BallState {
  const speed = vecLen(ball.vel);
  const newSpeed = Math.min(speed * BALL_SPEED_RALLY_FACTOR, BALL_SPEED_MAX);
  if (speed === 0) return ball;
  const scale = newSpeed / speed;
  return {
    ...ball,
    vel: vec2(ball.vel.x * scale, ball.vel.y * scale),
  };
}

// ── Derived constants (exported for QA) ──────────────────────────────────────

/** Maximum ball displacement per tick in pixels. */
export const MAX_BALL_DISPLACEMENT_PER_TICK = BALL_SPEED_MAX / 60; // uses default TICK_RATE_HZ

/** Safety margin: PADDLE_HEIGHT - max_displacement_per_tick. */
export const ANTI_TUNNELING_MARGIN_PX =
  PADDLE_HEIGHT - BALL_SPEED_MAX / 60;
