import { COURT_WIDTH, PADDLE_MAX_SPEED, PADDLE_WIDTH } from '@pingpong/shared';

export interface DragCallbacks {
  onPaddleX: (x: number) => void;
  onRelease: (velX: number) => void;
  onDragStart?: () => void;
  onDragEnd?: () => void;
}

export interface DragController {
  enable(): void;
  disable(): void;
}

/** Converts screen clientX to court-space X. */
export type ScreenToCourtFn = (screenX: number) => number;

/** Returns the current paddle X position in court space. */
export type GetPaddleXFn = () => number;

interface Sample {
  t: number;
  x: number;
}

interface TestEvent {
  type: 'paddleX' | 'release';
  x?: number;
  velX?: number;
  t: number;
}

declare global {
  interface Window {
    __test_dragEvents?: TestEvent[];
    __test_dragHandler?: DragController;
  }
}

const MIN_X = PADDLE_WIDTH / 2;
const MAX_X = COURT_WIDTH - PADDLE_WIDTH / 2;
const VELOCITY_WINDOW_MS = 100;
const MAX_SAMPLES = 60;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function computeVelocity(samples: Sample[]): number {
  if (samples.length < 2) return 0;
  const first = samples[0];
  const last = samples[samples.length - 1];
  if (!first || !last) return 0;
  const dt = last.t - first.t;
  if (dt <= 0) return 0;
  return (last.x - first.x) / (dt / 1000);
}

export function createDragHandler(
  target: HTMLElement,
  callbacks: DragCallbacks,
  screenToCourt: ScreenToCourtFn,
  getPaddleX: GetPaddleXFn,
): DragController {
  let active = false;
  let dragStartOffset = 0;
  let enabled = false;
  const samples: Sample[] = [];

  const params = new URLSearchParams(window.location.search);
  const testMode = params.get('test_input') === '1';
  if (testMode) {
    window.__test_dragEvents = [];
  }

  function recordTestEvent(event: TestEvent): void {
    if (testMode) {
      window.__test_dragEvents?.push(event);
    }
  }

  // screenToCourt is now injected via the third argument
  // to properly handle letterbox scaling

  function onPointerDown(e: PointerEvent): void {
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    if (active) return;

    active = true;
    target.setPointerCapture(e.pointerId);

    const courtX = screenToCourt(e.clientX);
    const currentPaddleX = getPaddleX();
    dragStartOffset = courtX - currentPaddleX;

    samples.length = 0;
    samples.push({ t: performance.now(), x: courtX });

    callbacks.onDragStart?.();

    const x = clamp(courtX - dragStartOffset, MIN_X, MAX_X);
    callbacks.onPaddleX(x);
    recordTestEvent({ type: 'paddleX', x, t: performance.now() });
  }

  function onPointerMove(e: PointerEvent): void {
    if (!active) return;

    const now = performance.now();
    const courtX = screenToCourt(e.clientX);
    const rawX = courtX - dragStartOffset;
    const x = clamp(rawX, MIN_X, MAX_X);

    samples.push({ t: now, x: courtX });
    while (samples.length > MAX_SAMPLES) {
      samples.shift();
    }
    const cutoff = now - VELOCITY_WINDOW_MS;
    while (samples.length > 1) {
      const first = samples[0];
      if (!first || first.t >= cutoff) break;
      samples.shift();
    }

    callbacks.onPaddleX(x);
    recordTestEvent({ type: 'paddleX', x, t: now });
  }

  function onPointerUpOrCancel(e: PointerEvent): void {
    if (!active) return;

    const now = performance.now();
    const courtX = screenToCourt(e.clientX);

    samples.push({ t: now, x: courtX });
    const cutoff = now - VELOCITY_WINDOW_MS;
    while (samples.length > 1) {
      const first = samples[0];
      if (!first || first.t >= cutoff) break;
      samples.shift();
    }

    const rawVel = computeVelocity(samples);
    const velX = clamp(rawVel, -PADDLE_MAX_SPEED, PADDLE_MAX_SPEED);

    callbacks.onDragEnd?.();
    callbacks.onRelease(velX);
    recordTestEvent({ type: 'release', velX, t: now });

    try {
      target.releasePointerCapture(e.pointerId);
    } catch {
      // already released
    }
    active = false;
    samples.length = 0;
  }

  function onPointerDownWrapper(e: PointerEvent): void {
    e.preventDefault();
    onPointerDown(e);
  }

  function onTouchMove(e: TouchEvent): void {
    if (active) e.preventDefault();
  }

  const downOpts: AddEventListenerOptions = { passive: false };
  const moveOpts: AddEventListenerOptions = { passive: true };
  const upOpts: AddEventListenerOptions = { passive: true };

  function enable(): void {
    if (enabled) return;
    enabled = true;

    target.addEventListener('pointerdown', onPointerDownWrapper, downOpts);
    target.addEventListener('pointermove', onPointerMove, moveOpts);
    target.addEventListener('pointerup', onPointerUpOrCancel, upOpts);
    target.addEventListener('pointercancel', onPointerUpOrCancel, upOpts);
    target.addEventListener('touchmove', onTouchMove, { passive: false });

    if (testMode) {
      window.__test_dragHandler = controller;
    }
  }

  function disable(): void {
    if (!enabled) return;
    enabled = false;

    target.removeEventListener('pointerdown', onPointerDownWrapper, downOpts);
    target.removeEventListener('pointermove', onPointerMove, moveOpts);
    target.removeEventListener('pointerup', onPointerUpOrCancel, upOpts);
    target.removeEventListener('pointercancel', onPointerUpOrCancel, upOpts);
    target.removeEventListener('touchmove', onTouchMove);

    active = false;
    samples.length = 0;
  }

  const controller: DragController = { enable, disable };
  return controller;
}
