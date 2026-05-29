/**
 * Physics & gameplay constants — single source of truth for all tunables.
 *
 * Every value here is a compile-time literal so the bundler can inline them.
 * No mutable objects are exported; all are `const` primitives or readonly tuples.
 */

// ── Court geometry ───────────────────────────────────────────────────────────

/** Court width in pixels (portrait orientation, vertical play axis). */
export const COURT_WIDTH = 720;

/** Court height in pixels. */
export const COURT_HEIGHT = 1280;

// ── Paddle ───────────────────────────────────────────────────────────────────

/** Paddle width in pixels. */
export const PADDLE_WIDTH = 140;

/** Paddle height (thickness) in pixels. */
export const PADDLE_HEIGHT = 18;

/** Maximum paddle speed in px/s. */
export const PADDLE_MAX_SPEED = 900;

// ── Ball ─────────────────────────────────────────────────────────────────────

/** Ball radius in pixels. */
export const BALL_RADIUS = 10;

/** Ball speed at serve / reset in px/s. */
export const BALL_SPEED_INITIAL = 420;

/**
 * Hard speed cap in px/s.
 *
 * **Anti-tunneling guarantee:**
 * At TICK_RATE_HZ the ball moves at most `BALL_SPEED_MAX / TICK_RATE_HZ` px per tick.
 * With PADDLE_HEIGHT = 18 and TICK_RATE_HZ = 60:
 *   max displacement per tick = 1050 / 60 = 17.5 px
 *   paddle thickness          = 18 px
 *   safety margin             = 0.5 px
 *
 * General invariant: `PADDLE_HEIGHT * TICK_RATE_HZ > BALL_SPEED_MAX`.
 * Current margin: (18 × 60) − 1050 = 30 px/s.
 */
export const BALL_SPEED_MAX = 1050;

/** Per-rally speed multiplier applied after each paddle hit. */
export const BALL_SPEED_RALLY_FACTOR = 1.04;

// ── Magnus effect ────────────────────────────────────────────────────────────

/**
 * Magnus coefficient (dimensionless, tuned for px/s² acceleration).
 * Acceleration: `a = (k·ω·v_y, −k·ω·v_x)` where ω = ball.spin.
 */
export const MAGNUS_K = 0.0008;

/** Spin decay factor per physics tick (applied multiplicatively each step). */
export const SPIN_DECAY = 0.985;

/** Fraction of paddle tangential velocity transferred as spin on contact. */
export const SPIN_FROM_PADDLE_VELOCITY = 0.6;

// ── Match rules ──────────────────────────────────────────────────────────────

/** Points needed to win a game. */
export const SCORE_TO_WIN = 11;

/** Grace period (ms) for a disconnected player to rejoin before forfeit. */
export const RECONNECT_GRACE_MS = 30_000;

/** Idle timeout (ms) before a player is kicked for being AFK. */
export const AFK_TIMEOUT_MS = 30_000;

/** Warning starts after this many ms of idle (10 s before timeout). */
export const AFK_WARN_MS = 20_000;

/** Pre-serve countdown duration in ms. */
export const COUNTDOWN_MS = 3000;

/** Lobby heartbeat ping interval in ms. */
export const LOBBY_HEARTBEAT_INTERVAL_MS = 5000;

/** Lobby heartbeat timeout in ms — non-readied users removed after this. */
export const LOBBY_HEARTBEAT_TIMEOUT_MS = 10_000;

// ── Tick & broadcast rates ───────────────────────────────────────────────────

/** Server physics tick rate in Hz. */
export const TICK_RATE_HZ = 60;

/** State broadcast rate to players in Hz. */
export const BROADCAST_HZ_PLAYER = 60;

/** State broadcast rate to spectators in Hz. */
export const BROADCAST_HZ_SPECTATOR = 15;

// ── Reconciliation tolerances ────────────────────────────────────────────────

/** Allowed paddle position drift (px) before server correction. */
export const RECONCILE_PADDLE_TOLERANCE_PX = 80;

/** Allowed ball position drift (px) before server correction. */
export const RECONCILE_BALL_TOLERANCE_PX = 10;

// ── Client-side interpolation ────────────────────────────────────────────────

/** Buffer duration (ms) for client interpolation / extrapolation. */
export const INTERPOLATION_BUFFER_MS = 50;
