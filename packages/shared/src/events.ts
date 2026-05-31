/**
 * Wire protocol — the ACTUAL event names and payload shapes exchanged over
 * Socket.IO between client and server.
 *
 * This file is the single source of truth for the protocol. Both ends are
 * checked against it:
 *   - the client imports these payload types instead of re-declaring them
 *   - the server annotates its emit literals with `satisfies <Message>`
 * so any drift between the three breaks the build.
 *
 * Event-name → payload mapping (Socket.IO event name in quotes):
 *
 *   Client → Server
 *     'paddleInput'      PaddleInputMessage
 *     'setPaddleColor'   SetPaddleColorMessage
 *     'readyToggle'      (no payload)
 *     'playAi'           (no payload)
 *     'leaveLobby'       (no payload)
 *     'leaveGame'        (no payload)
 *     'requestRematch'   (no payload)
 *     'lobby_heartbeat'  (no payload)
 *     'pause'            (no payload)
 *     'resume'           (no payload)
 *     'request_resync'   (no payload)
 *
 *   Server → Player
 *     'lobbyUpdate'      LobbyUpdateMessage
 *     'countdownTick'    CountdownTickMessage
 *     'matchStart'       MatchStartMessage
 *     'stateSnapshot'    StateSnapshotMessage
 *     'scoreEvent'       ScoreMessage
 *     'matchEnd'         MatchEndMessage
 *     'pause'            PauseMessage
 *     'resume'           ResumeMessage
 *     'afkWarning'       AfkWarningMessage
 *     'rematchPending'   RematchPendingMessage
 *     'error'            ErrorMessage
 *
 *   Server → Spectator (/spectate namespace)
 *     'SpectatorState'   SpectatorState (slim, see types.ts)
 *     'SpectatorScore'   SpectatorScoreMessage
 *     'SpectatorEnd'     SpectatorEndMessage
 *     'Error'            ErrorMessage
 */

import type {
  BallState,
  LobbyPhase,
  MatchPhase,
  PaddleState,
  PlayerSlot,
  UserSummary,
  Vec2,
} from './types.js';

// ── Client → Server ─────────────────────────────────────────────────────────

/**
 * Client-internal paddle input representation produced by the prediction
 * engine. Flattened to {@link PaddleInputMessage} before it goes on the wire.
 */
export interface PaddleMoveEvent {
  readonly t: 'paddle_move';
  readonly pos: Vec2;
  readonly vel: Vec2;
  readonly seq: number;
}

/** Wire payload for the 'paddleInput' event. */
export interface PaddleInputMessage {
  readonly paddleX: number;
  readonly seq: number;
}

/** Wire payload for the 'setPaddleColor' event. */
export interface SetPaddleColorMessage {
  readonly color: number;
}

// ── Server → Player ─────────────────────────────────────────────────────────

/** Slot → occupying user's Discord id (absent when empty). */
export interface SlotOccupancy {
  readonly top?: string;
  readonly bottom?: string;
}

/** Lobby state broadcast — emitted on every phase/slot/ready/color change. */
export interface LobbyUpdateMessage {
  readonly t: 'lobbyUpdate';
  readonly phase: LobbyPhase | string;
  readonly slots: SlotOccupancy;
  readonly paddleColors: Readonly<Record<string, number>>;
  readonly countdownRemaining: number;
  readonly readyUsers: readonly string[];
}

/** Countdown tick — emitted at 1 Hz during the pre-match countdown. */
export interface CountdownTickMessage {
  readonly t: 'countdownTick';
  readonly remaining: number;
}

/** Match started — broadcast when the countdown completes. */
export interface MatchStartMessage {
  readonly t: 'matchStart';
  readonly matchId: string;
  readonly players: Readonly<Record<PlayerSlot, UserSummary>>;
}

/** Authoritative state snapshot — emitted at the player broadcast rate. */
export interface StateSnapshotMessage {
  readonly t: 'stateSnapshot';
  readonly tick: number;
  readonly lastProcessedSeq: Readonly<Record<PlayerSlot, number>>;
  readonly ball: BallState;
  readonly paddles: Readonly<Record<PlayerSlot, PaddleState>>;
  readonly score: Readonly<Record<PlayerSlot, number>>;
  readonly phase: MatchPhase;
  readonly rallyCount: number;
  readonly ballSpeed: number;
}

/** Score update after a point. */
export interface ScoreMessage {
  readonly t: 'scoreEvent';
  readonly side: PlayerSlot;
  readonly score: Readonly<Record<PlayerSlot, number>>;
  readonly reason: string;
}

/** Match ended — carries persisted summary fields for the end screen. */
export interface MatchEndMessage {
  readonly t: 'matchEnd';
  readonly matchId: number | null;
  readonly end_reason: string;
  readonly winnerSlot: PlayerSlot | null;
  readonly winner: UserSummary | null;
  readonly loser: UserSummary | null;
  readonly scoreA: number;
  readonly scoreB: number;
  readonly rallyCountMax: number;
}

/** Server confirms match paused (player disconnect or client-side pause). */
export interface PauseMessage {
  readonly t: 'pause';
  readonly reason: string;
  readonly userId?: string;
}

/** Server confirms match resumed after pause. */
export interface ResumeMessage {
  readonly t: 'resume';
}

/** AFK warning — emitted at 1 Hz when a player exceeds the idle warn threshold. */
export interface AfkWarningMessage {
  readonly t: 'afkWarning';
  readonly slot: PlayerSlot;
  readonly secondsRemaining: number;
}

/** Rematch acknowledgement while waiting for the opponent to accept. */
export interface RematchPendingMessage {
  readonly t: 'rematchPending';
  readonly message: string;
}

/** Server error / rejection. */
export interface ErrorMessage {
  readonly t: 'error';
  readonly code: string;
  readonly message: string;
}

/** Discriminated union of every server→player message (exhaustive `t` switch). */
export type ServerToPlayerMessage =
  | LobbyUpdateMessage
  | CountdownTickMessage
  | MatchStartMessage
  | StateSnapshotMessage
  | ScoreMessage
  | MatchEndMessage
  | PauseMessage
  | ResumeMessage
  | AfkWarningMessage
  | RematchPendingMessage
  | ErrorMessage;

// ── Server → Spectator (/spectate namespace) ─────────────────────────────────

/** Spectator score update. */
export interface SpectatorScoreMessage {
  readonly t: 'SpectatorScore';
  readonly score: Readonly<Record<PlayerSlot, number>>;
  readonly scorer: PlayerSlot;
}

/** Spectator match-end notification. */
export interface SpectatorEndMessage {
  readonly t: 'SpectatorEnd';
  readonly winner: PlayerSlot;
  readonly score: Readonly<Record<PlayerSlot, number>>;
}
