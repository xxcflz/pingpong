/**
 * Event schemas — discriminated unions for all wire messages.
 *
 * Every event carries a `t` discriminant field for exhaustive switch handling.
 * These are plain data contracts; no Socket.IO or Discord types leak here.
 */

import type {
  LobbyPhase,
  LobbyState,
  MatchPhase,
  MatchState,
  MatchSummary,
  PlayerSlot,
  UserSummary,
  Vec2,
} from './types.js';

// ── Client → Server ─────────────────────────────────────────────────────────

/** Paddle position update from a player client. */
export interface PaddleMoveEvent {
  readonly t: 'paddle_move';
  readonly pos: Vec2;
  readonly vel: Vec2;
  readonly seq: number;
}

/** Player requests to join the match lobby. */
export interface JoinEvent {
  readonly t: 'join';
  readonly matchId: string;
}

/** Player requests to spectate. */
export interface SpectateEvent {
  readonly t: 'spectate';
  readonly matchId: string;
}

/** Player signals they are still active (anti-AFK heartbeat). */
export interface HeartbeatEvent {
  readonly t: 'heartbeat';
}

/** Player acknowledges a server reconciliation correction. */
export interface ReconcileAckEvent {
  readonly t: 'reconcile_ack';
  readonly ackTick: number;
}

/** Player signals they are pausing (tab hidden / PIP entered). */
export interface PauseEvent {
  readonly t: 'pause';
}

/** Player signals they are resuming (tab visible / PIP exited). */
export interface ResumeEvent {
  readonly t: 'resume';
}

/** Player requests a fresh state snapshot after resuming. */
export interface RequestResyncEvent {
  readonly t: 'request_resync';
}

/** Player toggles ready — claims first empty slot or receives LOBBY_FULL. */
export interface ReadyToggleEvent {
  readonly t: 'readyToggle';
}

/** Player starts a solo match against the server-controlled AI. */
export interface PlayAiEvent {
  readonly t: 'playAi';
}

/** Player voluntarily leaves the lobby. */
export interface LeaveLobbyEvent {
  readonly t: 'leaveLobby';
}

/** Player heartbeat to prove they are still connected. */
export interface LobbyHeartbeatEvent {
  readonly t: 'lobby_heartbeat';
}

/** Union of all client-to-server events. */
export type ClientToServerEvent =
  | PaddleMoveEvent
  | JoinEvent
  | SpectateEvent
  | HeartbeatEvent
  | ReconcileAckEvent
  | PauseEvent
  | ResumeEvent
  | RequestResyncEvent
  | ReadyToggleEvent
  | PlayAiEvent
  | LeaveLobbyEvent
  | LobbyHeartbeatEvent;

// ── Server → Player ─────────────────────────────────────────────────────────

/** Full state snapshot sent at BROADCAST_HZ_PLAYER. */
export interface StateSnapshotEvent {
  readonly t: 'state';
  readonly state: MatchState;
  /** Highest input seq the server has processed for this player. */
  readonly lastProcessedSeq: number;
}

/** Server reconciliation: authoritative paddle correction. */
export interface PaddleCorrectionEvent {
  readonly t: 'paddle_correction';
  readonly slot: PlayerSlot;
  readonly pos: Vec2;
  readonly ackTick: number;
}

/** Match phase transition. */
export interface PhaseChangeEvent {
  readonly t: 'phase';
  readonly phase: MatchPhase;
  readonly countdownMs?: number;
}

/** Score update after a point. */
export interface ScoreEvent {
  readonly t: 'score';
  readonly scorer: PlayerSlot;
  readonly score: Readonly<Record<PlayerSlot, number>>;
}

/** Match ended. */
export interface MatchEndEvent {
  readonly t: 'match_end';
  readonly summary: MatchSummary;
}

/** Lobby state update (player join/leave, spectator changes). */
export interface LobbyUpdateEvent {
  readonly t: 'lobby';
  readonly lobby: LobbyState;
}

/** Server error / rejection. */
export interface ErrorEvent {
  readonly t: 'error';
  readonly code: string;
  readonly message: string;
}

/** Server confirms match paused (player disconnect or client-side pause). */
export interface PauseBroadcastEvent {
  readonly t: 'pause';
  readonly reason: 'player_disconnect' | 'pip' | 'visibility';
  readonly userId?: string;
}

/** Server confirms match resumed after pause. */
export interface ResumeBroadcastEvent {
  readonly t: 'resume';
}

/** Lobby state broadcast — emitted on every phase/slot/ready change. */
export interface LobbyUpdateBroadcastEvent {
  readonly t: 'lobbyUpdate';
  readonly phase: LobbyPhase;
  readonly slots: { readonly top?: string; readonly bottom?: string };
  readonly countdownRemaining: number;
  readonly readyUsers: readonly string[];
}

/** Countdown tick — emitted at 1 Hz during the 3-second countdown. */
export interface CountdownTickEvent {
  readonly t: 'countdownTick';
  readonly remaining: number;
}

/** Match started — broadcast when countdown completes. */
export interface MatchStartEvent {
  readonly t: 'matchStart';
  readonly matchId: string;
  readonly players: Readonly<Record<PlayerSlot, UserSummary>>;
}

/** AFK warning — emitted at 1 Hz when a player exceeds AFK_WARN_MS idle. */
export interface AfkWarningEvent {
  readonly t: 'afkWarning';
  readonly slot: PlayerSlot;
  readonly secondsRemaining: number;
}

/** Union of all server-to-player events. */
export type ServerToPlayerEvent =
  | StateSnapshotEvent
  | PaddleCorrectionEvent
  | PhaseChangeEvent
  | ScoreEvent
  | MatchEndEvent
  | LobbyUpdateEvent
  | ErrorEvent
  | PauseBroadcastEvent
  | ResumeBroadcastEvent
  | LobbyUpdateBroadcastEvent
  | CountdownTickEvent
  | MatchStartEvent
  | AfkWarningEvent;

// ── Server → Spectator ──────────────────────────────────────────────────────

export interface SpectatorStateEvent {
  readonly t: 'SpectatorState';
  readonly state: MatchState;
}

export interface SpectatorScoreEvent {
  readonly t: 'SpectatorScore';
  readonly score: Readonly<Record<PlayerSlot, number>>;
  readonly scorer: PlayerSlot;
}

export interface SpectatorEndEvent {
  readonly t: 'SpectatorEnd';
  readonly winner: PlayerSlot;
  readonly score: Readonly<Record<PlayerSlot, number>>;
}

export type ServerToSpectatorEvent = SpectatorStateEvent | SpectatorScoreEvent | SpectatorEndEvent;
