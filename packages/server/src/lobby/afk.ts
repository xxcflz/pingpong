import { performance } from "node:perf_hooks";
import { AFK_TIMEOUT_MS, AFK_WARN_MS } from "@pingpong/shared";
import type { PlayerSlot } from "@pingpong/shared";

interface AfkEvent {
  type: "warning";
  slot: PlayerSlot;
  secondsRemaining: number;
}

interface AfkForfeitEvent {
  type: "forfeit";
  afkSlot: PlayerSlot;
  winnerSlot: PlayerSlot;
}

export type AfkTickResult = AfkEvent | AfkForfeitEvent | null;

const WARN_INTERVAL_MS = 1000;

export class AfkTracker {
  private lastInputAt: Map<PlayerSlot, number> = new Map();
  private lastWarningAt: Map<PlayerSlot, number> = new Map();
  private warningActive: Map<PlayerSlot, boolean> = new Map();

  init(slots: PlayerSlot[], now?: number): void {
    const t = now ?? performance.now();
    for (const slot of slots) {
      this.lastInputAt.set(slot, t);
      this.lastWarningAt.set(slot, 0);
      this.warningActive.set(slot, false);
    }
  }

  updateInput(slot: PlayerSlot): void {
    this.lastInputAt.set(slot, performance.now());
    if (this.warningActive.get(slot)) {
      this.warningActive.set(slot, false);
      this.lastWarningAt.set(slot, 0);
    }
  }

  resetAll(now?: number): void {
    const t = now ?? performance.now();
    for (const [slot] of this.lastInputAt) {
      this.lastInputAt.set(slot, t);
      this.lastWarningAt.set(slot, 0);
      this.warningActive.set(slot, false);
    }
  }

  clearWarning(slot: PlayerSlot): void {
    this.warningActive.set(slot, false);
    this.lastWarningAt.set(slot, 0);
  }

  tick(phase: string, now?: number): AfkTickResult {
    if (phase !== "playing") return null;

    const t = now ?? performance.now();

    for (const [slot, lastInput] of this.lastInputAt) {
      const idleMs = t - lastInput;

      if (idleMs >= AFK_TIMEOUT_MS) {
        const opponent: PlayerSlot = slot === "top" ? "bottom" : "top";
        this.warningActive.set(slot, false);
        return { type: "forfeit", afkSlot: slot, winnerSlot: opponent };
      }

      if (idleMs >= AFK_WARN_MS) {
        const secondsRemaining = Math.ceil((AFK_TIMEOUT_MS - idleMs) / 1000);
        const lastWarn = this.lastWarningAt.get(slot) ?? 0;

        if (t - lastWarn >= WARN_INTERVAL_MS || !this.warningActive.get(slot)) {
          this.lastWarningAt.set(slot, t);
          this.warningActive.set(slot, true);
          return { type: "warning", slot, secondsRemaining };
        }
      }
    }

    return null;
  }

  isWarningActive(slot: PlayerSlot): boolean {
    return this.warningActive.get(slot) ?? false;
  }
}

export const afkTracker = new AfkTracker();
