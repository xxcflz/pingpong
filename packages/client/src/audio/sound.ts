/**
 * SoundEngine — synthesized game SFX via the Web Audio API.
 *
 * No asset files: every sound is generated from oscillators + gain envelopes,
 * so there is nothing to download and nothing to bundle. Three cues:
 *   - paddleHit(speedRatio): pitch rises with rally speed for mounting tension
 *   - wallBounce():          short low blip
 *   - score(mine):           two-tone arpeggio, ascending if you scored
 *
 * The AudioContext can only start after a user gesture (browser autoplay
 * policy), so call `unlock()` from a real tap (the landing-page Play button).
 * Mute state persists to localStorage so it survives the page reloads the
 * orchestrator performs on return-to-lobby.
 */

const MUTE_STORAGE_KEY = 'pingpong:muted';

function loadMuted(): boolean {
  try {
    return localStorage.getItem(MUTE_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

export class SoundEngine {
  private ctx: AudioContext | null = null;
  private muted: boolean = loadMuted();

  /**
   * Create or resume the AudioContext. Must be called from a user-gesture
   * handler the first time, or the context stays suspended on most browsers.
   */
  unlock(): void {
    if (!this.ctx) {
      const Ctor =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return; // No Web Audio support — degrade silently.
      this.ctx = new Ctor();
    }
    if (this.ctx.state === 'suspended') {
      void this.ctx.resume();
    }
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    try {
      localStorage.setItem(MUTE_STORAGE_KEY, muted ? '1' : '0');
    } catch {
      // Ignore storage failures — muting still works for this session.
    }
  }

  toggleMuted(): boolean {
    this.setMuted(!this.muted);
    return this.muted;
  }

  isMuted(): boolean {
    return this.muted;
  }

  /**
   * Paddle hit. `speedRatio` (0..1) raises the pitch so faster rallies sound
   * more urgent. Caller passes ballSpeed / BALL_SPEED_MAX.
   */
  paddleHit(speedRatio: number): void {
    const ratio = Math.min(Math.max(speedRatio, 0), 1);
    const freq = 220 + ratio * 440; // 220Hz → 660Hz
    this.blip(freq, 'square', 0.09, 0.18);
  }

  wallBounce(): void {
    this.blip(150, 'triangle', 0.06, 0.12);
  }

  /** Score cue. Ascending if `mine`, descending otherwise. */
  score(mine: boolean): void {
    const notes = mine ? [392, 523, 659] : [330, 247, 196];
    notes.forEach((f, i) => this.blip(f, 'sine', 0.12, 0.2, i * 0.08));
  }

  // ── Internals ──────────────────────────────────────────────────────────

  /** One enveloped oscillator note. No-op when muted or context unavailable. */
  private blip(
    freq: number,
    type: OscillatorType,
    duration: number,
    peakGain: number,
    delay = 0,
  ): void {
    if (this.muted || !this.ctx || this.ctx.state !== 'running') return;

    const start = this.ctx.currentTime + delay;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();

    osc.type = type;
    osc.frequency.setValueAtTime(freq, start);

    // Fast attack, exponential decay — a clean "pock" with no click.
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(peakGain, start + 0.005);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);

    osc.connect(gain).connect(this.ctx.destination);
    osc.start(start);
    osc.stop(start + duration + 0.02);
  }
}

/** Single shared engine — imported wherever a cue needs to fire. */
export const sound = new SoundEngine();
