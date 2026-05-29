/**
 * Reconnection logic — 30s grace, keyed on Discord user ID.
 *
 * When a player disconnects mid-match (playing or countdown phase),
 * the room is paused and a 30-second grace timer starts. If the SAME
 * Discord userId reconnects within the window, the slot is restored
 * and the match resumes. If the timer expires, the match ends with
 * `forfeit_dc` and the opponent wins.
 *
 * Spectators are NOT affected — they just stop receiving frames;
 * reconnect = re-subscribe with no resume penalty.
 *
 * `forfeit_dc` is a distinct end_reason from `forfeit_afk` (T16 owns the AFK path).
 */

import { RECONNECT_GRACE_MS } from "@pingpong/shared";
import type { PlayerSlot, LobbyPhase } from "@pingpong/shared";
import { log } from "../util/logger.js";

// ── Types ───────────────────────────────────────────────────────────────────

export interface DisconnectedPlayer {
  slot: PlayerSlot;
  lastSocketId: string;
  disconnectedAt: number;
  timer: ReturnType<typeof setTimeout>;
  /** Phase at the moment of disconnect — needed to know whether to restart the match on reconnect. */
  previousPhase: "playing" | "countdown";
}

export interface GraceExpiryInfo {
  userId: string;
  slot: PlayerSlot;
  opponentUserId: string;
  opponentSlot: PlayerSlot;
}

export interface ReconnectInfo {
  userId: string;
  slot: PlayerSlot;
  previousPhase: "playing" | "countdown";
}

// ── Callbacks ───────────────────────────────────────────────────────────────

export interface ReconnectCallbacks {
  /** Called when grace timer fires — caller should endMatch + cleanup. */
  onGraceExpiry: (info: GraceExpiryInfo) => void;
}

let callbacks: ReconnectCallbacks = {
  onGraceExpiry: () => {},
};

export function setReconnectCallbacks(cbs: Partial<ReconnectCallbacks>): void {
  callbacks = { ...callbacks, ...cbs };
}

// ── Connection state ────────────────────────────────────────────────────────

/** userId → disconnected player state. Only populated during grace window. */
const connectionState = new Map<string, DisconnectedPlayer>();

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Record a player disconnect during 'playing' or 'countdown' phase.
 * Caller is responsible for pausing the lobby/match BEFORE calling this.
 *
 * Returns true if this disconnect caused BOTH players to be disconnected
 * (caller should endMatch with winner_id=null).
 */
export function recordDisconnect(
  userId: string,
  socketId: string,
  slot: PlayerSlot,
  previousPhase: "playing" | "countdown",
): boolean {
  const existing = connectionState.get(userId);
  if (existing) {
    // Already tracking this user — cancel old timer before setting new one
    clearTimeout(existing.timer);
  }

  const timer = setTimeout(() => {
    handleTimerExpiry(userId);
  }, RECONNECT_GRACE_MS);

  connectionState.set(userId, {
    slot,
    lastSocketId: socketId,
    disconnectedAt: Date.now(),
    timer,
    previousPhase,
  });

  log.info(
    `[reconnect] recorded disconnect: userId=${userId} slot=${slot} phase=${previousPhase} grace=${RECONNECT_GRACE_MS}ms`,
  );

  // Check if both players are now disconnected
  return connectionState.size >= 2;
}

/**
 * Attempt to reconnect a userId. If the userId has an active grace timer,
 * cancel it and return the reconnect info. Otherwise returns null.
 */
export function attemptReconnect(userId: string, newSocketId: string): ReconnectInfo | null {
  const entry = connectionState.get(userId);
  if (!entry) return null;

  // Cancel the grace timer — always cancel before any state mutation
  clearTimeout(entry.timer);
  connectionState.delete(userId);

  log.info(
    `[reconnect] reconnect accepted: userId=${userId} slot=${entry.slot} previousPhase=${entry.previousPhase}`,
  );

  return {
    userId,
    slot: entry.slot,
    previousPhase: entry.previousPhase,
  };
}

/**
 * Check if a slot is reserved for a disconnected player with an active grace timer.
 * Used by readyToggle to reject impostors.
 */
export function isSlotReserved(slot: PlayerSlot): boolean {
  for (const entry of connectionState.values()) {
    if (entry.slot === slot) return true;
  }
  return false;
}

/**
 * Get the userId that owns a reserved slot. Returns undefined if the slot is free.
 */
export function getReservedSlotOwner(slot: PlayerSlot): string | undefined {
  for (const [userId, entry] of connectionState) {
    if (entry.slot === slot) return userId;
  }
  return undefined;
}

/**
 * Check if a userId is currently in the grace window (disconnected but not yet timed out).
 */
export function isInGraceWindow(userId: string): boolean {
  return connectionState.has(userId);
}

/**
 * Get all currently disconnected user IDs (for debugging).
 */
export function getDisconnectedUserIds(): string[] {
  return [...connectionState.keys()];
}

/**
 * Cancel all timers and clear state. Called on match end / reset.
 */
export function reset(): void {
  for (const entry of connectionState.values()) {
    clearTimeout(entry.timer);
  }
  connectionState.clear();
  log.info("[reconnect] reset — all grace timers cleared");
}

// ── Internal ────────────────────────────────────────────────────────────────

function handleTimerExpiry(userId: string): void {
  const entry = connectionState.get(userId);
  if (!entry) return; // Already cleaned up (e.g. both-disconnect path)

  // Find the opponent — the other entry in connectionState, or derive from slot
  let opponentUserId: string | undefined;
  let opponentSlot: PlayerSlot | undefined;

  // Check if opponent is also disconnected
  for (const [uid, e] of connectionState) {
    if (uid !== userId) {
      opponentUserId = uid;
      opponentSlot = e.slot;
      // Cancel opponent's timer too — match is ending
      clearTimeout(e.timer);
      connectionState.delete(uid);
    }
  }

  // If opponent is not in connectionState, derive from slot
  if (!opponentUserId) {
    opponentSlot = entry.slot === "top" ? "bottom" : "top";
    // We don't know the opponent's userId from connectionState alone;
    // the caller (socket handler) will need to resolve it from the lobby.
    opponentUserId = "__UNKNOWN__";
  }

  connectionState.delete(userId);

  log.info(
    `[reconnect] grace expired: userId=${userId} slot=${entry.slot} → forfeit_dc`,
  );

  callbacks.onGraceExpiry({
    userId,
    slot: entry.slot,
    opponentUserId,
    opponentSlot: opponentSlot!,
  });
}
