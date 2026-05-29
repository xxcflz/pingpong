/**
 * Lobby state machine — single source of truth for match phase and slot assignment.
 *
 * All other modules call its public API; never read/write `phase` or `slots` directly.
 *
 * Transitions table (also documented on LobbyPhase in @pingpong/shared):
 *
 *   idle      → lobby       playerJoin
 *   lobby     → countdown   both slots filled via readyToggle
 *   lobby     → idle        last player leaves
 *   countdown → playing     countdownComplete (3 s elapsed)
 *   countdown → lobby       playerLeave during countdown (slots cleared)
 *   playing   → paused      pause
 *   paused    → playing     resume
 *   playing   → ended       matchEnd
 *   paused    → ended       matchEnd
 *   ended     → idle        reset
 */

import {
  COUNTDOWN_MS,
  type LobbyPhase,
  type PlayerSlot,
} from "@pingpong/shared";
import { log } from "../util/logger.js";
import { afkTracker } from "./afk.js";

export const AI_USER_ID = "ai:pingpong";
export const AI_USERNAME = "Pong AI";

// ── Types ───────────────────────────────────────────────────────────────────

export interface Slots {
  top?: string;
  bottom?: string;
}

export interface LobbySnapshot {
  phase: LobbyPhase;
  slots: Slots;
  paddleColors: Record<string, number>;
  countdownRemaining: number;
  readyUsers: string[];
}

export interface LobbyCallbacks {
  onLobbyUpdate: (snapshot: LobbySnapshot) => void;
  onCountdownTick: (remaining: number) => void;
  onCountdownComplete: (topUserId: string, bottomUserId: string) => void;
  onError: (socketId: string, code: string, message: string) => void;
}

// ── State Machine ───────────────────────────────────────────────────────────

export class LobbyStateMachine {
  private phase: LobbyPhase = "idle";
  private slots: Slots = {};
  private paddleColors: Record<string, number> = {};
  private countdownTimer: ReturnType<typeof setInterval> | null = null;
  private countdownRemaining = 0;
  private readyUsers: Set<string> = new Set();
  private lastHeartbeat: Map<string, number> = new Map();
  private socketToUser: Map<string, string> = new Map();
  private userToSocket: Map<string, string> = new Map();
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private rematchRequests: Set<string> = new Set();

  private callbacks: LobbyCallbacks = {
    onLobbyUpdate: () => {},
    onCountdownTick: () => {},
    onCountdownComplete: () => {},
    onError: () => {},
  };

  setCallbacks(callbacks: Partial<LobbyCallbacks>): void {
    this.callbacks = { ...this.callbacks, ...callbacks };
  }

  startHeartbeatCheck(): void {
    if (this.heartbeatTimer) return;
    this.heartbeatTimer = setInterval(() => this.checkHeartbeats(), 5000);
  }

  stopHeartbeatCheck(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  // ── Getters ─────────────────────────────────────────────────────────────

  getPhase(): LobbyPhase {
    return this.phase;
  }

  getSlots(): Readonly<Slots> {
    return this.slots;
  }

  getCountdownRemaining(): number {
    return this.countdownRemaining;
  }

  getReadyUsers(): readonly string[] {
    return [...this.readyUsers];
  }

  getSnapshot(): LobbySnapshot {
    return {
      phase: this.phase,
      slots: { ...this.slots },
      paddleColors: { ...this.paddleColors },
      countdownRemaining: this.countdownRemaining,
      readyUsers: [...this.readyUsers],
    };
  }

  setPaddleColor(userId: string, color: number): void {
    this.paddleColors[userId] = color;
    this.callbacks.onLobbyUpdate(this.getSnapshot());
  }

  getUserIdBySocket(socketId: string): string | undefined {
    return this.socketToUser.get(socketId);
  }

  getSlotForUser(discordId: string): PlayerSlot | undefined {
    if (this.slots.top === discordId) return "top";
    if (this.slots.bottom === discordId) return "bottom";
    return undefined;
  }

  getUserIdForSlot(slot: PlayerSlot): string | undefined {
    return this.slots[slot];
  }

  // ── Events ──────────────────────────────────────────────────────────────

  playerJoin(discordId: string, socketId: string): void {
    this.socketToUser.set(socketId, discordId);
    this.userToSocket.set(discordId, socketId);
    this.lastHeartbeat.set(discordId, Date.now());

    if (this.phase === "idle") {
      this.phase = "lobby";
    }

    log.info(`[lobby] player joined: ${discordId} (phase=${this.phase})`);
    this.broadcastLobbyUpdate();
  }

  playerLeave(discordId: string): void {
    const socketId = this.userToSocket.get(discordId);
    if (socketId) {
      this.socketToUser.delete(socketId);
    }
    this.userToSocket.delete(discordId);
    this.lastHeartbeat.delete(discordId);
    this.readyUsers.delete(discordId);
    delete this.paddleColors[discordId];

    const hadSlot = this.getSlotForUser(discordId);
    if (this.slots.top === discordId) this.slots.top = undefined;
    if (this.slots.bottom === discordId) this.slots.bottom = undefined;

    log.info(`[lobby] player left: ${discordId} (hadSlot=${hadSlot ?? "none"}, phase=${this.phase})`);

    if (this.phase === "countdown") {
      this.stopCountdown();
      this.phase = "lobby";
      this.slots = {};
      this.readyUsers.clear();
      this.broadcastLobbyUpdate();
      return;
    }

    if (this.socketToUser.size === 0) {
      this.phase = "idle";
      return;
    }

    this.broadcastLobbyUpdate();
  }

  /**
   * Atomic slot assignment.
   *
   * ATOMIC: this method is a synchronous block — no `await` between the read
   * and write of `this.slots`. Node's single-thread guarantees that no other
   * readyToggle can interleave here. If you add an `await` anywhere in this
   * method, the atomicity guarantee breaks.
   */
  readyToggle(discordId: string, socketId: string): PlayerSlot | Error {
    this.lastHeartbeat.set(discordId, Date.now());

    if (this.readyUsers.has(discordId)) {
      return new Error("ALREADY_READY");
    }

    if (this.slots.top && this.slots.bottom) {
      this.callbacks.onError(socketId, "LOBBY_FULL", "Both player slots are taken");
      return new Error("LOBBY_FULL");
    }

    if (discordId === AI_USER_ID) {
      this.callbacks.onError(socketId, "AI_USER", "AI user cannot readyToggle");
      return new Error("AI_USER");
    }

    let slot: PlayerSlot;
    if (!this.slots.bottom) {
      this.slots.bottom = discordId;
      slot = "bottom";
    } else {
      this.slots.top = discordId;
      slot = "top";
    }

    this.readyUsers.add(discordId);
    log.info(`[lobby] readyToggle: ${discordId} → ${slot} (ready=${this.readyUsers.size})`);
    this.broadcastLobbyUpdate();

    if (this.slots.top && this.slots.bottom) {
      this.startCountdown();
    }

    return slot;
  }

  startAiMatch(discordId: string, socketId: string): PlayerSlot | Error {
    this.socketToUser.set(socketId, discordId);
    this.userToSocket.set(discordId, socketId);
    this.lastHeartbeat.set(discordId, Date.now());

    if (this.phase !== "idle" && this.phase !== "lobby") {
      this.callbacks.onError(socketId, "MATCH_IN_PROGRESS", "Cannot start AI match while a match is active");
      return new Error("MATCH_IN_PROGRESS");
    }

    const occupiedByOtherUser = [this.slots.top, this.slots.bottom].some(
      (id) => id && id !== discordId && id !== AI_USER_ID,
    );
    if (occupiedByOtherUser) {
      this.callbacks.onError(socketId, "LOBBY_BUSY", "Another player is already in the lobby");
      return new Error("LOBBY_BUSY");
    }

    this.stopCountdown();
    this.slots = { top: AI_USER_ID, bottom: discordId };
    this.readyUsers.clear();
    this.readyUsers.add(AI_USER_ID);
    this.readyUsers.add(discordId);

    log.info(`[lobby] AI match requested: ${discordId} → bottom, ${AI_USER_ID} → top`);
    this.startCountdown();

    return "bottom";
  }

  playerHeartbeat(discordId: string): void {
    this.lastHeartbeat.set(discordId, Date.now());
  }

  /**
   * Pause the lobby — supports both 'playing' and 'countdown' phases.
   * During countdown the timer is stopped; on resume it must be restarted.
   */
  pause(): void {
    if (this.phase === "playing") {
      this.phase = "paused";
    } else if (this.phase === "countdown") {
      this.stopCountdown();
      this.phase = "paused";
    }
  }

  resume(): void {
    if (this.phase === "paused") {
      this.phase = "playing";
      afkTracker.resetAll();
    }
  }

  matchEnd(): void {
    if (this.phase === "playing" || this.phase === "paused") {
      this.phase = "ended";
    }
  }

  /**
   * Privileged slot restore for reconnecting players.
   * Bypasses readyToggle's race-safe checks — the caller guarantees
   * that `userId` owns `slot` (verified via reconnect module's connectionState).
   */
  autoClaimForReconnect(userId: string, socketId: string, slot: PlayerSlot): void {
    this.socketToUser.set(socketId, userId);
    this.userToSocket.set(userId, socketId);
    this.lastHeartbeat.set(userId, Date.now());
    this.readyUsers.add(userId);
    this.slots[slot] = userId;

    log.info(`[lobby] autoClaimForReconnect: ${userId} → ${slot}`);
  }

  reset(): void {
    this.stopCountdown();
    this.phase = "idle";
    this.slots = {};
    this.paddleColors = {};
    this.readyUsers.clear();
    this.rematchRequests.clear();
    this.socketToUser.clear();
    this.userToSocket.clear();
    this.lastHeartbeat.clear();
    this.broadcastLobbyUpdate();
  }

  addRematchRequest(userId: string): void {
    this.rematchRequests.add(userId);
  }

  getRematchRequests(): Set<string> {
    return this.rematchRequests;
  }

  clearRematchRequests(): void {
    this.rematchRequests.clear();
  }

  /**
   * Start a rematch countdown with the current slots.
   * Transitions from 'ended' back to 'countdown' phase.
   */
  startRematchCountdown(): void {
    if (this.phase !== "ended") {
      log.warn(`[lobby] startRematchCountdown ignored: phase=${this.phase}`);
      return;
    }

    if (!this.slots.top || !this.slots.bottom) {
      log.warn("[lobby] startRematchCountdown: missing slots");
      return;
    }

    this.rematchRequests.clear();
    this.readyUsers.clear();
    this.readyUsers.add(this.slots.top);
    this.readyUsers.add(this.slots.bottom);

    log.info(`[lobby] rematch countdown: ${this.slots.top} vs ${this.slots.bottom}`);
    this.startCountdown();
  }

  // ── Heartbeat check ─────────────────────────────────────────────────────

  checkHeartbeats(): void {
    const now = Date.now();
    const toRemove: string[] = [];

    for (const [discordId, lastBeat] of this.lastHeartbeat) {
      if (now - lastBeat > 10_000 && !this.readyUsers.has(discordId)) {
        toRemove.push(discordId);
      }
    }

    for (const discordId of toRemove) {
      log.info(`[lobby] heartbeat timeout: ${discordId}`);
      this.playerLeave(discordId);
    }
  }

  destroy(): void {
    this.stopCountdown();
    this.stopHeartbeatCheck();
  }

  // ── Internal ────────────────────────────────────────────────────────────

  private startCountdown(): void {
    this.phase = "countdown";
    this.countdownRemaining = Math.ceil(COUNTDOWN_MS / 1000);

    log.info(`[lobby] countdown started: ${this.countdownRemaining}s`);
    this.callbacks.onCountdownTick(this.countdownRemaining);

    this.countdownTimer = setInterval(() => {
      this.countdownRemaining--;

      if (this.countdownRemaining > 0) {
        this.callbacks.onCountdownTick(this.countdownRemaining);
      } else {
        this.stopCountdown();
        this.phase = "playing";

        if (this.slots.top && this.slots.bottom) {
          log.info("[lobby] countdown complete → playing");
          this.callbacks.onCountdownComplete(this.slots.top, this.slots.bottom);
        }
      }
    }, 1000);
  }

  private stopCountdown(): void {
    if (this.countdownTimer) {
      clearInterval(this.countdownTimer);
      this.countdownTimer = null;
    }
    this.countdownRemaining = 0;
  }

  private broadcastLobbyUpdate(): void {
    this.callbacks.onLobbyUpdate(this.getSnapshot());
  }
}

// ── Singleton ───────────────────────────────────────────────────────────────

export const lobby = new LobbyStateMachine();
