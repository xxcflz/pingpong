/**
 * Room — authoritative game state container for a single match.
 *
 * Owns MatchState, players, input buffers, tick tracking.
 * Physics math is delegated entirely to @pingpong/shared pure functions.
 */

import {
  stepBall,
  applyMagnus,
  decaySpin,
  clampPaddle,
  collidePaddleAabb,
  collideWalls,
  applySpinFromPaddle,
  accelerateOnRally,
  reflectOffPaddle,
  COURT_WIDTH,
  COURT_HEIGHT,
  PADDLE_WIDTH,
  PADDLE_HEIGHT,
  PADDLE_MAX_SPEED,
  BALL_RADIUS,
  BALL_SPEED_INITIAL,
  SCORE_TO_WIN,
  TICK_RATE_HZ,
  BROADCAST_HZ_PLAYER,
  BROADCAST_HZ_SPECTATOR,
  type PlayerSlot,
  type MatchState,
  type EndReason,
  type BallState,
  type PaddleState,
} from "@pingpong/shared";

const PLAYER_SNAPSHOT_INTERVAL_TICKS = Math.max(1, Math.round(TICK_RATE_HZ / BROADCAST_HZ_PLAYER));
const SPECTATOR_SNAPSHOT_INTERVAL_TICKS = Math.max(1, Math.round(TICK_RATE_HZ / BROADCAST_HZ_SPECTATOR));

// ── Interfaces ──────────────────────────────────────────────────────────────

export interface PaddleInput {
  paddleX: number;
  seq: number;
}

export interface PendingEvent {
  name: string;
  data: unknown;
  slot?: PlayerSlot;
}

// ── Room ────────────────────────────────────────────────────────────────────

export interface PlayerMeta {
  dbId: number;
  username: string;
  avatarUrl: string | null;
}

export class Room {
  /** Authoritative match state. */
  state: MatchState;

  /** Connected player user IDs by slot (Discord IDs). */
  players: { top?: string; bottom?: string };

  /** DB match row ID — set via setMatchContext when match starts. */
  currentMatchId: number | null;

  /** Per-slot player metadata — set via setMatchContext when match starts. */
  playerMeta: Record<PlayerSlot, PlayerMeta> | null;

  /** Per-slot input buffer drained each tick. */
  inputBuffer: Map<PlayerSlot, PaddleInput[]>;

  /** Monotonically increasing tick counter. */
  tickCount: number;

  /** Tick count of last StateSnapshot broadcast. */
  lastSnapshotAt: number;

  /** Current rally length (paddle hits since last score). */
  rallyCount: number;

  /** Maximum rally length observed in this match. */
  rallyCountMax: number;

  // ── Internal tracking ───────────────────────────────────────────────────

  /** Last processed input sequence per slot. */
  private lastProcessedSeq: Record<PlayerSlot, number>;

  /** Last accepted paddle X per slot (for Δx validation). */
  private lastPaddleX: Record<PlayerSlot, number>;

  /** Tick of last accepted input per slot, used to tolerate delayed polling batches. */
  private lastInputTick: Record<PlayerSlot, number>;

  /** Rolling window of tick timestamps (performance.now()) for Hz measurement. */
  private tickTimestamps: number[];

  /** Spectator state snapshot updated at 15 Hz. */
  private spectatorState: MatchState | null;

  /** Events collected during current tick, drained by the loop. */
  private pendingEvents: PendingEvent[];

  /** Slot → socket ID mapping for targeted emits. */
  private playerSockets: Map<PlayerSlot, string>;

  /** setInterval handle — owned by loop.ts, stored here for cleanup. */
  loopTimer: ReturnType<typeof setInterval> | null;

  constructor() {
    const topPaddle: PaddleState = {
      pos: { x: COURT_WIDTH / 2, y: PADDLE_HEIGHT / 2 + 20 },
      vel: { x: 0, y: 0 },
      width: PADDLE_WIDTH,
      height: PADDLE_HEIGHT,
    };
    const bottomPaddle: PaddleState = {
      pos: { x: COURT_WIDTH / 2, y: COURT_HEIGHT - PADDLE_HEIGHT / 2 - 20 },
      vel: { x: 0, y: 0 },
      width: PADDLE_WIDTH,
      height: PADDLE_HEIGHT,
    };

    this.state = {
      tick: 0,
      phase: "waiting",
      ball: {
        pos: { x: COURT_WIDTH / 2, y: COURT_HEIGHT / 2 },
        vel: { x: 0, y: BALL_SPEED_INITIAL },
        spin: 0,
        radius: BALL_RADIUS,
      },
      paddles: { top: topPaddle, bottom: bottomPaddle },
      score: { top: 0, bottom: 0 },
      serverTimeMs: Date.now(),
    };

    this.players = {};
    this.currentMatchId = null;
    this.playerMeta = null;
    this.inputBuffer = new Map();
    this.tickCount = 0;
    this.lastSnapshotAt = 0;
    this.rallyCount = 0;
    this.rallyCountMax = 0;
    this.lastProcessedSeq = { top: 0, bottom: 0 };
    this.lastPaddleX = { top: topPaddle.pos.x, bottom: bottomPaddle.pos.x };
    this.lastInputTick = { top: 0, bottom: 0 };
    this.tickTimestamps = [];
    this.spectatorState = null;
    this.pendingEvents = [];
    this.playerSockets = new Map();
    this.loopTimer = null;
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────

  /**
   * Transition to 'playing' phase and reset match state.
   * T9 will drive lobby/countdown before calling this.
   */
  startMatch(topUserId: string, bottomUserId: string): void {
    this.players.top = topUserId;
    this.players.bottom = bottomUserId;

    this.state = {
      tick: 0,
      phase: "playing",
      ball: this.freshBall(),
      paddles: this.state.paddles,
      score: { top: 0, bottom: 0 },
      serverTimeMs: Date.now(),
    };

    this.tickCount = 0;
    this.rallyCount = 0;
    this.rallyCountMax = 0;
    this.lastSnapshotAt = 0;
    this.lastProcessedSeq = { top: 0, bottom: 0 };
    this.lastPaddleX = {
      top: this.state.paddles.top.pos.x,
      bottom: this.state.paddles.bottom.pos.x,
    };
    this.lastInputTick = { top: 0, bottom: 0 };
    this.tickTimestamps = [];
    this.spectatorState = null;
    this.pendingEvents = [];
    this.currentMatchId = null;
    this.playerMeta = null;
  }

  /**
   * End the match and emit MatchEnd event.
   * Loop should be stopped by the caller before or after this.
   */
  endMatch(reason: EndReason, winner?: PlayerSlot): void {
    if (this.state.phase === "finished") return;

    this.state = { ...this.state, phase: "finished", serverTimeMs: Date.now() };

    const winnerSide = winner ?? "top";
    this.pendingEvents.push({
      name: "matchEnd",
      data: {
        t: "matchEnd",
        winnerSide,
        scoreA: this.state.score.top,
        scoreB: this.state.score.bottom,
        end_reason: reason,
        rallyCountMax: this.rallyCountMax,
      },
    });
  }

  /** Full reset to waiting state — used by debug endpoint for clean test isolation. */
  resetToWaiting(): void {
    const topPaddle: PaddleState = {
      pos: { x: COURT_WIDTH / 2, y: PADDLE_HEIGHT / 2 + 20 },
      vel: { x: 0, y: 0 },
      width: PADDLE_WIDTH,
      height: PADDLE_HEIGHT,
    };
    const bottomPaddle: PaddleState = {
      pos: { x: COURT_WIDTH / 2, y: COURT_HEIGHT - PADDLE_HEIGHT / 2 - 20 },
      vel: { x: 0, y: 0 },
      width: PADDLE_WIDTH,
      height: PADDLE_HEIGHT,
    };

    this.state = {
      tick: 0,
      phase: "waiting",
      ball: {
        pos: { x: COURT_WIDTH / 2, y: COURT_HEIGHT / 2 },
        vel: { x: 0, y: BALL_SPEED_INITIAL },
        spin: 0,
        radius: BALL_RADIUS,
      },
      paddles: { top: topPaddle, bottom: bottomPaddle },
      score: { top: 0, bottom: 0 },
      serverTimeMs: Date.now(),
    };

    this.players = {};
    this.currentMatchId = null;
    this.playerMeta = null;
    this.inputBuffer.clear();
    this.tickCount = 0;
    this.lastSnapshotAt = 0;
    this.rallyCount = 0;
    this.rallyCountMax = 0;
    this.lastProcessedSeq = { top: 0, bottom: 0 };
    this.lastPaddleX = { top: topPaddle.pos.x, bottom: bottomPaddle.pos.x };
    this.lastInputTick = { top: 0, bottom: 0 };
    this.tickTimestamps = [];
    this.spectatorState = null;
    this.pendingEvents = [];
    this.playerSockets.clear();
  }

  setMatchContext(
    matchId: number,
    top: PlayerMeta,
    bottom: PlayerMeta,
  ): void {
    this.currentMatchId = matchId;
    this.playerMeta = { top, bottom };
  }

  // ── Physics tick ─────────────────────────────────────────────────────────

  /**
   * Advance the simulation by one tick (dt seconds).
   * Collects events in pendingEvents — caller must drainEvents() after.
   */
  tick(dt: number): PlayerSlot | undefined {
    if (this.state.phase !== "playing") return undefined;

    // ── 1. Drain & validate inputs ──────────────────────────────────────
    for (const slot of ["top", "bottom"] as PlayerSlot[]) {
      const inputs = this.inputBuffer.get(slot);
      if (inputs && inputs.length > 0) {
        // Use the latest input
        const latest = inputs[inputs.length - 1]!;
        const prevX = this.state.paddles[slot]!.pos.x;
        const dx = latest.paddleX - prevX;
        const elapsedTicks = Math.max(1, this.tickCount - this.lastInputTick[slot]);
        const elapsedSeconds = elapsedTicks * dt;
        const maxDx = PADDLE_MAX_SPEED * elapsedSeconds;
        const nextX = Math.abs(dx) > maxDx
          ? prevX + Math.sign(dx) * maxDx
          : latest.paddleX;

        const updated = clampPaddle({
          ...this.state.paddles[slot]!,
          pos: { x: nextX, y: this.state.paddles[slot]!.pos.y },
          vel: { x: 0, y: 0 },
        });
        this.state = {
          ...this.state,
          paddles: { ...this.state.paddles, [slot]: updated },
        };
        this.lastProcessedSeq[slot] = latest.seq;
        this.lastInputTick[slot] = this.tickCount;
        inputs.length = 0;
      }
    }

    // ── 2. Physics: Magnus → step → decay ───────────────────────────────
    let ball = applyMagnus(this.state.ball, dt);
    ball = stepBall(ball, dt);
    ball = decaySpin(ball);

    // ── 3. Paddle collisions ────────────────────────────────────────────
    const topPaddle = this.state.paddles.top!;
    const bottomPaddle = this.state.paddles.bottom!;

    // Top paddle: only collide if ball is moving upward
    if (collidePaddleAabb(ball, topPaddle) && ball.vel.y < 0) {
      ball = reflectOffPaddle(ball, topPaddle, 1);
      ball = applySpinFromPaddle(ball, topPaddle);
      ball = accelerateOnRally(ball);
      this.rallyCount++;
    }

    // Bottom paddle: only collide if ball is moving downward
    if (collidePaddleAabb(ball, bottomPaddle) && ball.vel.y > 0) {
      ball = reflectOffPaddle(ball, bottomPaddle, -1);
      ball = applySpinFromPaddle(ball, bottomPaddle);
      ball = accelerateOnRally(ball);
      this.rallyCount++;
    }

    // ── 4. Wall collisions (left, right, top) ──────────────────────────
    ball = collideWalls(ball);

    // ── 5. Scoring ──────────────────────────────────────────────────────
    let scored = false;

    if (ball.pos.y - ball.radius > COURT_HEIGHT) {
      // Ball past bottom → top player scores
      scored = true;
      const newScore = { ...this.state.score, top: this.state.score.top + 1 };
      this.rallyCountMax = Math.max(this.rallyCountMax, this.rallyCount);
      this.rallyCount = 0;
      this.state = {
        ...this.state,
        score: newScore,
        ball: this.resetBall("bottom"),
        serverTimeMs: Date.now(),
      };
      this.pendingEvents.push({
        name: "scoreEvent",
        data: { t: "scoreEvent", side: "top", score: newScore, reason: "goal" },
      });
      if (newScore.top >= SCORE_TO_WIN) {
        return "top";
      }
    } else if (ball.pos.y + ball.radius < 0) {
      // Ball past top → bottom player scores
      scored = true;
      const newScore = { ...this.state.score, bottom: this.state.score.bottom + 1 };
      this.rallyCountMax = Math.max(this.rallyCountMax, this.rallyCount);
      this.rallyCount = 0;
      this.state = {
        ...this.state,
        score: newScore,
        ball: this.resetBall("top"),
        serverTimeMs: Date.now(),
      };
      this.pendingEvents.push({
        name: "scoreEvent",
        data: { t: "scoreEvent", side: "bottom", score: newScore, reason: "goal" },
      });
      if (newScore.bottom >= SCORE_TO_WIN) {
        return "bottom";
      }
    }

    if (!scored) {
      this.state = { ...this.state, ball, serverTimeMs: Date.now() };
    }

    // ── 6. Derive paddle velocities from actual position change ─────────
    // This avoids oscillation from zeroing velocity on ticks with no input.
    // Clients use vel.x to extrapolate paddle position between snapshots.
    const newPaddles = { ...this.state.paddles };
    for (const slot of ["top", "bottom"] as PlayerSlot[]) {
      const prevX = this.lastPaddleX[slot]!;
      const currX = newPaddles[slot]!.pos.x;
      const velX = (currX - prevX) / dt;
      newPaddles[slot] = { ...newPaddles[slot]!, vel: { x: velX, y: 0 } };
      this.lastPaddleX[slot] = currX;
    }
    this.state = { ...this.state, paddles: newPaddles };

    // ── 7. Advance tick counter ─────────────────────────────────────────
    this.tickCount++;
    this.state = { ...this.state, tick: this.tickCount };

    // ── 7. Track tick timestamp for Hz measurement ──────────────────────
    this.tickTimestamps.push(performance.now());

    // ── 8. StateSnapshot at configured player broadcast rate ────────────
    if (this.tickCount - this.lastSnapshotAt >= PLAYER_SNAPSHOT_INTERVAL_TICKS) {
      this.lastSnapshotAt = this.tickCount;
      const ballSpeed = Math.sqrt(
        this.state.ball.vel.x * this.state.ball.vel.x +
          this.state.ball.vel.y * this.state.ball.vel.y,
      );
      this.pendingEvents.push({
        name: "stateSnapshot",
        data: {
          t: "stateSnapshot",
          tick: this.state.tick,
          lastProcessedSeq: { ...this.lastProcessedSeq },
          ball: this.state.ball,
          paddles: this.state.paddles,
          score: this.state.score,
          phase: this.state.phase,
          rallyCount: this.rallyCount,
          ballSpeed,
        },
      });
    }

    // ── 9. Spectator state at configured spectator broadcast rate ───────
    if (this.tickCount % SPECTATOR_SNAPSHOT_INTERVAL_TICKS === 0) {
      this.spectatorState = { ...this.state };
    }

    return undefined;
  }

  // ── Input buffer ────────────────────────────────────────────────────────

  pushInput(slot: PlayerSlot, input: PaddleInput): void {
    if (!this.inputBuffer.has(slot)) {
      this.inputBuffer.set(slot, []);
    }
    this.inputBuffer.get(slot)!.push(input);
  }

  // ── Event drain (called by loop after each tick) ────────────────────────

  drainEvents(): PendingEvent[] {
    const events = this.pendingEvents;
    this.pendingEvents = [];
    return events;
  }

  // ── Player socket management ────────────────────────────────────────────

  registerPlayer(slot: PlayerSlot, socketId: string): void {
    this.playerSockets.set(slot, socketId);
  }

  unregisterPlayer(socketId: string): void {
    for (const [slot, id] of this.playerSockets) {
      if (id === socketId) {
        this.playerSockets.delete(slot);
        break;
      }
    }
  }

  getPlayerSocketId(slot: PlayerSlot): string | undefined {
    return this.playerSockets.get(slot);
  }

  // ── Tick rate measurement ───────────────────────────────────────────────

  /** Rolling tick rate in Hz over the last 1-second window. */
  getTickRateHz(): number {
    const now = performance.now();
    const cutoff = now - 1000;
    while (this.tickTimestamps.length > 0 && this.tickTimestamps[0]! < cutoff) {
      this.tickTimestamps.shift();
    }
    return this.tickTimestamps.length;
  }

  // ── Spectator getter (for T11) ──────────────────────────────────────────

  getSpectatorState(): MatchState | null {
    return this.spectatorState;
  }

  // ── Helpers ─────────────────────────────────────────────────────────────

  /** Fresh ball at center, served toward the given slot with random angle. */
  private freshBall(): BallState {
    const maxAngle = Math.PI / 6; // ±30°
    const angle = (Math.random() * 2 - 1) * maxAngle;
    return {
      pos: { x: COURT_WIDTH / 2, y: COURT_HEIGHT / 2 },
      vel: {
        x: Math.sin(angle) * BALL_SPEED_INITIAL,
        y: Math.cos(angle) * BALL_SPEED_INITIAL,
      },
      spin: 0,
      radius: BALL_RADIUS,
    };
  }

  /** Reset ball to center, served toward the player who just lost the point with random angle. */
  private resetBall(toward: PlayerSlot): BallState {
    const maxAngle = Math.PI / 6; // ±30°
    const angle = (Math.random() * 2 - 1) * maxAngle;
    const dirY = toward === "bottom" ? 1 : -1;
    return {
      pos: { x: COURT_WIDTH / 2, y: COURT_HEIGHT / 2 },
      vel: {
        x: Math.sin(angle) * BALL_SPEED_INITIAL,
        y: dirY * Math.cos(angle) * BALL_SPEED_INITIAL,
      },
      spin: 0,
      radius: BALL_RADIUS,
    };
  }
}

// ── Singleton ────────────────────────────────────────────────────────────────

/** Single room instance for this server (1-match concurrency). */
export const room = new Room();
