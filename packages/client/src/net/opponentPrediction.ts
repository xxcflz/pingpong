/**
 * Opponent paddle prediction with velocity extrapolation.
 *
 * Between server snapshots, extrapolates position using last known velocity.
 * When a snapshot arrives, divergence is absorbed into a decaying offset
 * that smooths out over time — no frame-counting, no micro-oscillation.
 *
 * Pure data — no Pixi, no DOM.
 */
import { COURT_WIDTH, PADDLE_WIDTH } from '@pingpong/shared';

/** Maximum correction distance before snapping (px). */
const MAX_CORRECTION_PX = 60;

/** Velocity smoothing factor (0-1, higher = more responsive). */
const VELOCITY_SMOOTH = 0.3;

/**
 * Offset decay time constant in seconds.
 * ~95% of the offset is absorbed in 3× this value.
 * 0.06s gives a fast but smooth correction (~180ms to 95%).
 */
const DECAY_TAU = 0.06;

export interface OpponentPredictionEngine {
  /** Advance the prediction by one frame (dt seconds). */
  tick(dt: number): void;

  /** Feed an authoritative server snapshot. */
  onSnapshot(posX: number, velX: number): void;

  /** Read the current predicted paddle X position. */
  getPredictedX(): number;

  /** Reset prediction to a specific position. */
  reset(posX: number): void;
}

export function createOpponentPredictionEngine(initialX: number): OpponentPredictionEngine {
  let currentX = initialX;
  let velocityX = 0;

  // Correction offset — added to currentX for rendering, decays toward zero
  let offsetX = 0;

  function tick(dt: number): void {
    if (dt <= 0 || dt > 0.1) return;

    // Extrapolate position using velocity
    const extrapolatedX = currentX + velocityX * dt;

    // Clamp to court bounds
    const minX = PADDLE_WIDTH / 2;
    const maxX = COURT_WIDTH - PADDLE_WIDTH / 2;
    currentX = Math.max(minX, Math.min(maxX, extrapolatedX));

    // Decay the correction offset exponentially
    if (offsetX !== 0) {
      const decay = Math.exp(-dt / DECAY_TAU);
      offsetX *= decay;
      if (Math.abs(offsetX) < 0.1) offsetX = 0;
    }
  }

  function onSnapshot(serverX: number, serverVelX: number): void {
    const minX = PADDLE_WIDTH / 2;
    const maxX = COURT_WIDTH - PADDLE_WIDTH / 2;
    const clampedServerX = Math.max(minX, Math.min(maxX, serverX));

    // The rendered position right now is currentX + offsetX.
    // We want to snap currentX to the server value and absorb the
    // old rendered-position difference into the offset so there's
    // no visual jump.
    const renderedX = currentX + offsetX;
    const dx = renderedX - clampedServerX;
    const distance = Math.abs(dx);

    if (distance > MAX_CORRECTION_PX) {
      // Large divergence: snap immediately, clear offset
      currentX = clampedServerX;
      offsetX = 0;
      velocityX = serverVelX;
    } else {
      // Absorb divergence into offset — currentX snaps to server,
      // offset carries the visual position so rendering stays smooth
      currentX = clampedServerX;
      offsetX = dx; // will decay to zero over time
      velocityX = velocityX * (1 - VELOCITY_SMOOTH) + serverVelX * VELOCITY_SMOOTH;
    }
  }

  function getPredictedX(): number {
    return currentX + offsetX;
  }

  function reset(posX: number): void {
    currentX = posX;
    velocityX = 0;
    offsetX = 0;
  }

  return { tick, onSnapshot, getPredictedX, reset };
}
