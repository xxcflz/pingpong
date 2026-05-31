/**
 * Interpolation buffer — smooth playback of server-authoritative state.
 *
 * Maintains a 3-snapshot rolling buffer and renders at
 * `now - INTERPOLATION_BUFFER_MS` to hide network jitter.
 *
 * On large position jumps (> RECONCILE_BALL_TOLERANCE_PX × 8):
 * blends over several frames instead of snapping.
 *
 * Pure data — no Pixi, no DOM.
 */
import { INTERPOLATION_BUFFER_MS, RECONCILE_BALL_TOLERANCE_PX } from '@pingpong/shared';

/** Distance threshold (px) above which we blend instead of snapping. */
const BLEND_DISTANCE_THRESHOLD = RECONCILE_BALL_TOLERANCE_PX * 8; // 80 px

/** Number of frames over which to blend a large-distance jump. */
const BLEND_FRAMES = 3;

/** Maximum snapshots in the rolling buffer. */
const MAX_BUFFER_SIZE = 3;

interface TimedEntry<T> {
  arrivalTimeMs: number;
  data: T;
}

/** Result of interpolation — generic so callers pick their own shape. */
export interface InterpolationResult<T> {
  value: T;
  /** True when the result was blended from a large-distance jump. */
  blended: boolean;
}

export interface InterpolationBuffer<T> {
  /** Push a new snapshot. Timestamp is `performance.now()` at arrival. */
  addSnapshot(data: T, arrivalTimeMs?: number): void;

  /**
   * Interpolate at the given render time.
   * Returns null if fewer than 2 snapshots are buffered.
   */
  interpolateAt(now: number): InterpolationResult<T> | null;

  /** Number of snapshots currently buffered. */
  size(): number;

  /** All buffered entries (for test inspection). */
  entries(): readonly TimedEntry<T>[];
}

export interface InterpolationDeps<T> {
  /** Linearly interpolate between two values. t ∈ [0, 1]. */
  lerp: (a: T, b: T, t: number) => T;

  /** Euclidean distance between two values (for blend detection). */
  distance: (a: T, b: T) => number;
}

export function createInterpolationBuffer<T>(deps: InterpolationDeps<T>): InterpolationBuffer<T> {
  const buffer: TimedEntry<T>[] = [];

  // Blend state — activated when a large-distance jump is detected
  let blendActive = false;
  let blendFrom: T | null = null;
  let blendTo: T | null = null;
  let blendFrameCount = 0;

  function addSnapshot(data: T, arrivalTimeMs?: number): void {
    const ts = arrivalTimeMs ?? performance.now();

    // Check for large-distance jump before pushing
    if (buffer.length > 0) {
      const last = buffer[buffer.length - 1];
      if (last) {
        const dist = deps.distance(last.data, data);
        if (dist > BLEND_DISTANCE_THRESHOLD) {
          blendActive = true;
          blendFrom = last.data;
          blendTo = data;
          blendFrameCount = 0;
        }
      }
    }

    buffer.push({ arrivalTimeMs: ts, data });

    // Keep only the most recent MAX_BUFFER_SIZE entries
    while (buffer.length > MAX_BUFFER_SIZE) {
      buffer.shift();
    }
  }

  function interpolateAt(now: number): InterpolationResult<T> | null {
    if (buffer.length < 2) return null;

    const targetTime = now - INTERPOLATION_BUFFER_MS;

    // Find the two entries that bracket targetTime
    let lo = 0;
    for (let i = 0; i < buffer.length - 1; i++) {
      const next = buffer[i + 1];
      if (next && next.arrivalTimeMs <= targetTime) {
        lo = i + 1;
      }
    }
    const hi = Math.min(lo + 1, buffer.length - 1);

    const entryA = buffer[lo];
    const entryB = buffer[hi];
    if (!entryA || !entryB) return null;

    const dt = entryB.arrivalTimeMs - entryA.arrivalTimeMs;
    let t: number;
    if (dt <= 0) {
      t = 0;
    } else {
      t = Math.max(0, Math.min(1, (targetTime - entryA.arrivalTimeMs) / dt));
    }

    let value = deps.lerp(entryA.data, entryB.data, t);
    let blended = false;

    // If blend is active, override with blended value
    if (blendActive && blendFrom !== null && blendTo !== null) {
      blendFrameCount++;
      const blendT = Math.min(blendFrameCount / BLEND_FRAMES, 1);
      value = deps.lerp(blendFrom, blendTo, blendT);
      blended = true;

      if (blendT >= 1) {
        blendActive = false;
        blendFrom = null;
        blendTo = null;
      }
    }

    return { value, blended };
  }

  function size(): number {
    return buffer.length;
  }

  function entries(): readonly TimedEntry<T>[] {
    return buffer;
  }

  return { addSnapshot, interpolateAt, size, entries };
}
