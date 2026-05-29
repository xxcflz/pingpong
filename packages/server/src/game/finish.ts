import type { PlayerSlot, UserSummary } from "@pingpong/shared";
import { getIO } from "../socket/index.js";
import { log } from "../util/logger.js";
import { lobby } from "../lobby/state.js";
import { reset as resetReconnect } from "../lobby/reconnect.js";
import { db } from "../db/index.js";
import { endMatch as endMatchRepo } from "../db/repos.js";
import { stopLoop } from "./loop.js";
import type { Room } from "./room.js";

const RESET_GRACE_MS = 5_000;

type MatchEndReason = "score" | "forfeit_dc" | "forfeit_afk" | "forfeit_leave";

interface FinishOptions {
  endReason: MatchEndReason;
  winnerSlot?: PlayerSlot;
}

let resetGeneration = 0;

export function cancelPendingResets(): void {
  resetGeneration++;
}

export function finishMatch(room: Room, opts: FinishOptions): void {
  const { endReason, winnerSlot } = opts;

  stopLoop(room);
  room.endMatch(endReason, winnerSlot);
  lobby.matchEnd();

  let winnerId: number | null = null;
  let winnerSummary: UserSummary | null = null;
  let loserSummary: UserSummary | null = null;

  if (winnerSlot && room.playerMeta) {
    winnerId = room.playerMeta[winnerSlot].dbId;
    winnerSummary = {
      id: room.players[winnerSlot] ?? "",
      username: room.playerMeta[winnerSlot].username,
      avatarUrl: room.playerMeta[winnerSlot].avatarUrl,
    };

    const loserSlot: PlayerSlot = winnerSlot === "top" ? "bottom" : "top";
    if (room.playerMeta[loserSlot]) {
      loserSummary = {
        id: room.players[loserSlot] ?? "",
        username: room.playerMeta[loserSlot].username,
        avatarUrl: room.playerMeta[loserSlot].avatarUrl,
      };
    }
  }

  if (room.currentMatchId != null) {
    try {
      endMatchRepo(db, room.currentMatchId, {
        scoreA: room.state.score.top,
        scoreB: room.state.score.bottom,
        winnerId,
        endReason,
        rallyCountMax: room.rallyCountMax,
      });
      log.info(`[finish] match ${room.currentMatchId} persisted: ${endReason} winner=${winnerSlot ?? "none"}`);
    } catch (err) {
      log.error(`[finish] failed to persist match ${room.currentMatchId}: ${err}`);
    }
  }

  const payload = {
    t: "matchEnd" as const,
    matchId: room.currentMatchId,
    end_reason: endReason,
    winnerSlot: winnerSlot ?? null,
    winner: winnerSummary,
    loser: loserSummary,
    scoreA: room.state.score.top,
    scoreB: room.state.score.bottom,
    rallyCountMax: room.rallyCountMax,
  };

  const io = getIO();
  io.emit("matchEnd", payload);
  io.of("/spectate").emit("matchEnd", payload);

  log.info(
    `[finish] matchEnd broadcast: ${endReason} ${winnerSummary?.username ?? "draw"} ` +
    `${room.state.score.top}-${room.state.score.bottom} rally_max=${room.rallyCountMax}`,
  );

  const gen = resetGeneration;
  setTimeout(() => {
    if (gen !== resetGeneration) {
      log.info("[finish] lobby reset skipped — superseded by explicit reset");
      return;
    }
    lobby.reset();
    resetReconnect();
    log.info("[finish] lobby reset after grace period");
  }, RESET_GRACE_MS);
}
