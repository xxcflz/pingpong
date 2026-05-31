/**
 * Client-side paddle prediction + server reconciliation.
 *
 * - Immediate local response to player input (<16 ms).
 * - Tolerance-based reconciliation when server snapshot diverges.
 * - Exponential decay offset for micro-divergence — no frame counting,
 *   so overlapping snapshots don't cause micro-oscillation.
 * - Snap for macro-divergence (> tolerance).
 *
 * Pure data — no Pixi, no DOM, no Socket.IO import.
 */
import { type PaddleMoveEvent, RECONCILE_PADDLE_TOLERANCE_PX } from '@pingpong/shared';

/** Maximum pending inputs before we start dropping oldest (safety valve). */
const MAX_PENDING = 120;

/**
 * Offset decay time constant in seconds.
 * ~95% of the offset is absorbed in 3× this value.
 * 0.05s gives a fast but smooth correction (~150ms to 95%).
 */
const DECAY_TAU = 0.05;

export interface PredictionEngine {
  /** Apply a local paddle input — updates prediction immediately, emits to server. */
  applyInput(x: number, velX: number): void;

  /**
   * Feed an authoritative server snapshot.
   * @param authoritativePaddleX  Server's paddle X for the local player.
   * @param lastProcessedSeq      Highest input seq the server has acknowledged.
   */
  onSnapshot(authoritativePaddleX: number, lastProcessedSeq: number): void;

  /** Read the current predicted paddle X for rendering. */
  getPredictedPaddleX(): number;

  /** Read the raw predicted X (without offset correction). */
  getRawPredictedX(): number;

  /**
   * Advance the decay offset by one frame (dt seconds).
   * Must be called each frame from the ticker.
   */
  tick(dt: number): void;

  /** Number of inputs sent but not yet acknowledged by the server. */
  getPendingCount(): number;

  /** All pending inputs (for test inspection). */
  getPendingInputs(): readonly PaddleMoveEvent[];

  /** Mark the start of active user input (drag). */
  startDrag(): void;

  /** Mark the end of active user input (release). */
  endDrag(): void;
}

export interface PredictionDeps {
  /** Called each time a new input is ready to send to the server. */
  emit?: (msg: PaddleMoveEvent) => void;
}

export function createPredictionEngine(deps?: PredictionDeps): PredictionEngine {
  let seq = -1;
  let predictedX = 0;
  const pending: PaddleMoveEvent[] = [];

  // Correction offset — decays to zero each frame
  let offsetX = 0;

  // Track active drag state explicitly
  let isDragging = false;

  function startDrag(): void {
    isDragging = true;
  }

  function endDrag(): void {
    isDragging = false;
  }

  function applyInput(x: number, velX: number): void {
    seq++;
    predictedX = x;
    offsetX = 0; // user intent supersedes any pending correction

    const msg: PaddleMoveEvent = {
      t: 'paddle_move',
      pos: { x, y: 0 },
      vel: { x: velX, y: 0 },
      seq,
    };

    pending.push(msg);

    while (pending.length > MAX_PENDING) {
      pending.shift();
    }

    deps?.emit?.(msg);
  }

  function onSnapshot(authoritativePaddleX: number, lastProcessedSeq: number): void {
    while (
      pending.length > 0 &&
      (pending[0]?.seq ?? Number.POSITIVE_INFINITY) <= lastProcessedSeq
    ) {
      pending.shift();
    }

    // If user is actively dragging, trust local input fully — no reconciliation
    if (isDragging || pending.length > 0) {
      offsetX = 0;
      return;
    }

    // The rendered position right now is predictedX + offsetX.
    // Snap predictedX to the server and absorb the visual difference
    // into the offset so rendering stays smooth.
    const renderedX = predictedX + offsetX;
    const dx = renderedX - authoritativePaddleX;
    const diff = Math.abs(dx);

    if (diff > RECONCILE_PADDLE_TOLERANCE_PX) {
      predictedX = authoritativePaddleX;
      offsetX = 0;
    } else {
      predictedX = authoritativePaddleX;
      offsetX = dx;
    }
  }

  function tick(dt: number): void {
    if (dt <= 0 || dt > 0.1 || offsetX === 0) return;
    const decay = Math.exp(-dt / DECAY_TAU);
    offsetX *= decay;
    if (Math.abs(offsetX) < 0.1) offsetX = 0;
  }

  function getPredictedPaddleX(): number {
    return predictedX + offsetX;
  }

  function getRawPredictedX(): number {
    return predictedX;
  }

  function getPendingCount(): number {
    return pending.length;
  }

  function getPendingInputs(): readonly PaddleMoveEvent[] {
    return pending;
  }

  return {
    applyInput,
    onSnapshot,
    getPredictedPaddleX,
    getRawPredictedX,
    tick,
    getPendingCount,
    getPendingInputs,
    startDrag,
    endDrag,
  };
}
