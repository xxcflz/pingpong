/**
 * Game loop — drift-corrected setInterval at 60 Hz.
 *
 * Each tick: drain inputs → validate → physics → collisions → scoring → broadcast.
 * All physics math is delegated to @pingpong/shared pure functions.
 */

import { performance } from "node:perf_hooks";
import {
  COURT_WIDTH,
  PADDLE_MAX_SPEED,
  PADDLE_WIDTH,
  TICK_RATE_HZ,
  SCORE_TO_WIN,
} from "@pingpong/shared";
import { getIO } from "../socket/index.js";
import { log } from "../util/logger.js";
import { AI_USER_ID, lobby } from "../lobby/state.js";
import { afkTracker } from "../lobby/afk.js";
import { finishMatch } from "./finish.js";
import type { Room, PendingEvent } from "./room.js";
import type { PlayerSlot } from "@pingpong/shared";

const INTERVAL_MS = 1000 / TICK_RATE_HZ;
const MAX_CATCH_UP = 5;

/**
 * Start the simulation loop for the given room.
 * Uses drift-corrected setInterval — no recursive setTimeout.
 */
export function startLoop(room: Room): void {
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
        finishMatch(room, { endReason: "score", winnerSlot: scoreWinner });
        return;
      }

      const phase = lobby.getPhase();
      const afkResult = afkTracker.tick(phase);
      if (afkResult) {
        const io = getIO();
        if (afkResult.type === "warning") {
          const payload = { t: "afkWarning", slot: afkResult.slot, secondsRemaining: afkResult.secondsRemaining };
          io.emit("afkWarning", payload);
          io.of("/spectate").emit("afkWarning", payload);
        } else if (afkResult.type === "forfeit") {
          log.info(`[loop] AFK forfeit: ${afkResult.afkSlot} idle → ${afkResult.winnerSlot} wins`);
          finishMatch(room, { endReason: "forfeit_afk", winnerSlot: afkResult.winnerSlot });
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

function driveAiPaddle(room: Room, dt: number): void {
  if (room.state.phase !== "playing") return;

  const slots = lobby.getSlots();
  const aiSlot: PlayerSlot | null =
    slots.top === AI_USER_ID ? "top" :
    slots.bottom === AI_USER_ID ? "bottom" :
    null;
  if (!aiSlot) return;

  const paddle = room.state.paddles[aiSlot];
  const leadX = room.state.ball.pos.x + room.state.ball.vel.x * 0.18;
  const minX = PADDLE_WIDTH / 2;
  const maxX = COURT_WIDTH - PADDLE_WIDTH / 2;
  const targetX = Math.max(minX, Math.min(maxX, leadX));
  const dx = targetX - paddle.pos.x;
  const maxStep = PADDLE_MAX_SPEED * dt * 0.72;
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
    log.info("[loop] stopped");
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
