/**
 * Shared type definitions — runtime-environment-agnostic.
 * No external dependencies (no Pixi, no Socket.IO, no Discord SDK).
 */

// ── Primitives ───────────────────────────────────────────────────────────────

/** 2D vector used for positions, velocities, and accelerations. */
export interface Vec2 {
  readonly x: number;
  readonly y: number;
}

// ── Player slots ─────────────────────────────────────────────────────────────

/** Which end of the court a player occupies. */
export type PlayerSlot = 'top' | 'bottom';

// ── Match lifecycle ──────────────────────────────────────────────────────────

/** High-level phase of a match. */
export type MatchPhase = 'waiting' | 'countdown' | 'playing' | 'paused' | 'finished';

/**
 * Lobby state machine phases.
 *
 * Allowed transitions (documented here and enforced in LobbyStateMachine):
 *
 *   idle      → lobby       playerJoin (first player connects)
 *   lobby     → countdown   both slots filled via readyToggle
 *   lobby     → idle        last player leaves
 *   countdown → playing     countdownComplete (3 s elapsed)
 *   countdown → lobby       playerLeave during countdown (slots cleared)
 *   playing   → paused      pause event (PIP / tab hidden)
 *   paused    → playing     resume event
 *   playing   → ended       matchEnd (score reached or forfeit)
 *   paused    → ended       matchEnd
 *   ended     → idle        reset (prepare for next match)
 */
export type LobbyPhase = 'idle' | 'lobby' | 'countdown' | 'playing' | 'paused' | 'ended';

/**
 * Reason a match ended.
 *
 * - `score`: first to SCORE_TO_WIN
 * - `forfeit`: voluntary leave
 * - `forfeit_dc`: disconnect grace expired (T15). Distinct from `forfeit_afk` (T16).
 * - `disconnect`: legacy instant-disconnect (pre-T15)
 * - `afk`: idle timeout (T16 owns this path)
 * - `server_shutdown`: server process ending
 */
export type EndReason =
  | 'score'
  | 'forfeit'
  | 'forfeit_dc'
  | 'forfeit_afk'
  | 'forfeit_leave'
  | 'disconnect'
  | 'afk'
  | 'server_shutdown';

// ── Game state snapshots ─────────────────────────────────────────────────────

/** Full ball state including spin for Magnus effect. */
export interface BallState {
  readonly pos: Vec2;
  readonly vel: Vec2;
  readonly spin: number;
  readonly radius: number;
}

/** Paddle state for one player. */
export interface PaddleState {
  readonly pos: Vec2;
  readonly vel: Vec2;
  readonly width: number;
  readonly height: number;
}

/** Complete match state sent to clients each broadcast tick. */
export interface MatchState {
  readonly tick: number;
  readonly phase: MatchPhase;
  readonly ball: BallState;
  readonly paddles: Readonly<Record<PlayerSlot, PaddleState>>;
  readonly score: Readonly<Record<PlayerSlot, number>>;
  readonly serverTimeMs: number;
}

// ── Lobby / user ─────────────────────────────────────────────────────────────

/** Minimal user info shared across the wire. */
export interface UserSummary {
  readonly id: string;
  readonly username: string;
  readonly avatarUrl: string | null;
}

/** Lobby state snapshot. */
export interface LobbyState {
  readonly matchId: string;
  readonly phase: MatchPhase;
  readonly players: Readonly<Record<PlayerSlot, UserSummary | null>>;
  readonly spectators: readonly UserSummary[];
  readonly scoreToWin: number;
}

/** Post-match summary for display / history. */
export interface MatchSummary {
  readonly matchId: string;
  readonly winner: PlayerSlot;
  readonly reason: EndReason;
  readonly score: Readonly<Record<PlayerSlot, number>>;
  readonly durationMs: number;
  readonly players: Readonly<Record<PlayerSlot, UserSummary>>;
}

// ── Spectator state (slim — no prediction fields) ────────────────────────────

/** Slim ball position for spectators (no velocity, spin, radius). */
export interface SpectatorBallPos {
  readonly x: number;
  readonly y: number;
}

/** Slim paddle position for spectators (no vel, width, height). */
export interface SpectatorPaddlePos {
  readonly x: number;
}

/**
 * Read-only spectator state — sent at BROADCAST_HZ_SPECTATOR (15 Hz).
 *
 * Drops all prediction/reconciliation fields: no spin, no velocity,
 * no lastProcessedSeq, no paddle dimensions. Spectators don't predict.
 */
export interface SpectatorState {
  readonly tick: number;
  readonly ball: SpectatorBallPos;
  readonly paddles: Readonly<Record<PlayerSlot, SpectatorPaddlePos>>;
  readonly score: Readonly<Record<PlayerSlot, number>>;
  readonly phase: MatchPhase;
}
