import { Events } from '@discord/embedded-app-sdk';
import type { DiscordContext } from './discord.js';

/** Discord SDK layout_mode enum values. */
const LAYOUT_MODE_PIP = 1;

export interface LifecycleCallbacks {
  onPause: () => void;
  onResume: () => void;
}

/**
 * Ref-counted pause coalescer.
 *
 * Two independent pause sources (PIP layout-mode + tab visibility) each
 * contribute +1 to `pauseCount`. `onPause` fires only on 0→1 transition;
 * `onResume` fires only on 1→0.
 */
export class LifecycleObserver {
  private pauseCount = 0;
  private pipActive = false;
  private tabHidden = false;
  private callbacks: LifecycleCallbacks | null = null;
  private cleanup: Array<() => void> = [];
  private started = false;

  constructor(private readonly ctx: DiscordContext) {}

  async start(callbacks: LifecycleCallbacks): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.callbacks = callbacks;

    await this.subscribeLayoutMode();
    this.subscribeVisibility();
  }

  destroy(): void {
    for (const fn of this.cleanup) fn();
    this.cleanup = [];
    this.started = false;
    this.callbacks = null;
  }

  /** Exposed for test hooks — directly set pip flag. */
  setPip(active: boolean): void {
    this.pipActive = active;
    this.reconcile();
  }

  /** Exposed for test hooks — directly set tab-hidden flag. */
  setHidden(hidden: boolean): void {
    this.tabHidden = hidden;
    this.reconcile();
  }

  get isPaused(): boolean {
    return this.pauseCount > 0;
  }

  // ── Internals ────────────────────────────────────────────────────────

  private reconcile(): void {
    const desired = (this.pipActive ? 1 : 0) + (this.tabHidden ? 1 : 0);

    if (desired === this.pauseCount) return;

    const wasPaused = this.pauseCount > 0;
    this.pauseCount = desired;
    const isPaused = this.pauseCount > 0;

    if (!wasPaused && isPaused) {
      this.callbacks?.onPause();
    } else if (wasPaused && !isPaused) {
      this.callbacks?.onResume();
    }
  }

  private async subscribeLayoutMode(): Promise<void> {
    const handler = (data: { layout_mode: number }) => {
      const isPip = data.layout_mode === LAYOUT_MODE_PIP;
      this.pipActive = isPip;
      this.reconcile();
    };

    await this.ctx.sdk.subscribe(
      Events.ACTIVITY_LAYOUT_MODE_UPDATE,
      handler as (e: unknown) => unknown,
    );

    this.cleanup.push(() => {
      this.ctx.sdk
        .unsubscribe(Events.ACTIVITY_LAYOUT_MODE_UPDATE, handler as (e: unknown) => unknown)
        .catch(() => {});
    });
  }

  private subscribeVisibility(): void {
    const handler = () => {
      this.tabHidden = document.hidden;
      this.reconcile();
    };

    document.addEventListener('visibilitychange', handler);
    this.cleanup.push(() => document.removeEventListener('visibilitychange', handler));
  }
}
