/**
 * Game loop — drift-corrected setInterval at 60 Hz.
 *
 * Each tick: drain inputs → validate → physics → collisions → scoring → broadcast.
 * All physics math is delegated to @pingpong/shared pure functions.
 */

import { performance } from 'node:perf_hooks';
import {
  COURT_WIDTH,
  PADDLE_MAX_SPEED,
  PADDLE_WIDTH,
  SCORE_TO_WIN,
  TICK_RATE_HZ,
} from '@pingpong/shared';
import type { AiDifficulty, PlayerSlot } from '@pingpong/shared';
import { afkTracker } from '../lobby/afk.js';
import { AI_USER_ID, lobby } from '../lobby/state.js';
import { getIO } from '../socket/index.js';
import { log } from '../util/logger.js';
import { finishMatch } from './finish.js';
import type { PendingEvent, Room } from './room.js';

const INTERVAL_MS = 1000 / TICK_RATE_HZ;
const MAX_CATCH_UP = 5;

/**
 * Start the simulation loop for the given room.
 * Uses drift-corrected setInterval — no recursive setTimeout.
 */
export function startLoop(room: Room): void {
  // Guard against duplicate loops — clear any existing timer before starting
  if (room.loopTimer) {
    clearInterval(room.loopTimer);
    room.loopTimer = null;
    log.info('[loop] cleared stale timer before restart');
  }

  resetAiState();

  let expectedTickAt = performance.now() + INTERVAL_MS;

  room.loopTimer = setInterval(() => {
    const now = performance.now();
    let catchUp = 0;

    while (now >= expectedTickAt && catchUp < MAX_CATCH_UP) {
      const dt = 1 / TICK_RATE_HZ;
      driveAiPaddle(room, dt);
      const scoreWinner = room.tick(dt);

      const events = room.drainEvents();
      for (const event of events) {
        broadcastEvent(room, event);
      }

      if (scoreWinner) {
        log.info(`[loop] score win: ${scoreWinner} reaches ${SCORE_TO_WIN}`);
        finishMatch(room, { endReason: 'score', winnerSlot: scoreWinner });
        return;
      }

      const phase = lobby.getPhase();
      const afkResult = afkTracker.tick(phase);
      if (afkResult) {
        const io = getIO();
        if (afkResult.type === 'warning') {
          const payload = {
            t: 'afkWarning',
            slot: afkResult.slot,
            secondsRemaining: afkResult.secondsRemaining,
          };
          io.emit('afkWarning', payload);
          io.of('/spectate').emit('afkWarning', payload);
        } else if (afkResult.type === 'forfeit') {
          log.info(`[loop] AFK forfeit: ${afkResult.afkSlot} idle → ${afkResult.winnerSlot} wins`);
          finishMatch(room, { endReason: 'forfeit_afk', winnerSlot: afkResult.winnerSlot });
          return;
        }
      }

      expectedTickAt += INTERVAL_MS;
      catchUp++;
    }

    // Reset on permanent catch-up spiral
    if (now > expectedTickAt + INTERVAL_MS * MAX_CATCH_UP) {
      expectedTickAt = now + INTERVAL_MS;
    }
  }, INTERVAL_MS);

  log.info(`[loop] started at ${TICK_RATE_HZ} Hz (interval=${INTERVAL_MS.toFixed(3)}ms)`);
}

/**
 * Per-difficulty AI bot tuning.
 *   lead   — seconds of ball-velocity lookahead (higher = better anticipation)
 *   speed  — fraction of PADDLE_MAX_SPEED the bot may move per tick
 *   error  — peak persistent aim offset in px, rolled once per approach.
 *            Must exceed the catch radius (PADDLE_WIDTH/2 + ball radius ≈ 80px)
 *            often enough that easier bots genuinely miss. A whiff needs
 *            |error| > ~80px, so easy rolls in a wide band, hard never errs.
 */
const AI_TUNING: Record<AiDifficulty, { lead: number; speed: number; error: number }> = {
  easy: { lead: 0.05, speed: 0.55, error: 160 },
  medium: { lead: 0.16, speed: 0.78, error: 70 },
  hard: { lead: 0.26, speed: 0.96, error: 0 },
};

// ── AI per-approach state ─────────────────────────────────────────────────
// A single global room means a single AI; module-level state matches the
// existing singleton pattern. resetAiState() is called from startLoop.
let aiAimError = 0;
let aiApproaching = false;

/** Reset AI aiming state at the start of each match. */
export function resetAiState(): void {
  aiAimError = 0;
  aiApproaching = false;
}

function driveAiPaddle(room: Room, dt: number): void {
  if (room.state.phase !== 'playing') return;

  const slots = lobby.getSlots();
  const aiSlot: PlayerSlot | null =
    slots.top === AI_USER_ID ? 'top' : slots.bottom === AI_USER_ID ? 'bottom' : null;
  if (!aiSlot) return;

  const tuning = AI_TUNING[lobby.getAiDifficulty()];
  const paddle = room.state.paddles[aiSlot];
  const ball = room.state.ball;
  const minX = PADDLE_WIDTH / 2;
  const maxX = COURT_WIDTH - PADDLE_WIDTH / 2;
  const maxStep = PADDLE_MAX_SPEED * dt * tuning.speed;

  // Is the ball heading toward the AI's end?
  const approaching = aiSlot === 'top' ? ball.vel.y < 0 : ball.vel.y > 0;

  // Roll ONE aim error when a fresh approach begins. Holding it for the whole
  // approach is what makes the paddle actually arrive at the wrong spot —
  // re-rolling every tick averaged out to a perfect interception.
  if (approaching && !aiApproaching) {
    aiAimError = tuning.error > 0 ? (Math.random() * 2 - 1) * tuning.error : 0;
  }
  aiApproaching = approaching;

  // Target: intercept with persistent error while the ball approaches;
  // otherwise drift back toward center so the bot isn't permanently camped on
  // the ball (gives the player an opening on slower difficulties).
  const target = approaching ? ball.pos.x + ball.vel.x * tuning.lead + aiAimError : COURT_WIDTH / 2;
  const targetX = Math.max(minX, Math.min(maxX, target));
  const dx = targetX - paddle.pos.x;
  const nextX = paddle.pos.x + Math.max(-maxStep, Math.min(maxStep, dx));

  room.pushInput(aiSlot, { paddleX: nextX, seq: room.state.tick });
  afkTracker.updateInput(aiSlot);
}

/**
 * Stop the simulation loop for the given room.
 */
export function stopLoop(room: Room): void {
  if (room.loopTimer) {
    clearInterval(room.loopTimer);
    room.loopTimer = null;
    log.info('[loop] stopped');
  }
}

/**
 * Broadcast a pending event via Socket.io.
 * If slot is set, emit only to that player's socket.
 * Otherwise broadcast to all connected clients.
 */
function broadcastEvent(room: Room, event: PendingEvent): void {
  const io = getIO();

  if (event.slot) {
    const socketId = room.getPlayerSocketId(event.slot);
    if (socketId) {
      io.to(socketId).emit(event.name, event.data);
    }
  } else {
    io.emit(event.name, event.data);
  }
}
