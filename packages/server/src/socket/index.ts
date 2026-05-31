import crypto from 'node:crypto';
import type { Server as HttpServer } from 'node:http';
import type {
  AiDifficulty,
  CountdownTickMessage,
  LobbyUpdateMessage,
  MatchStartMessage,
  PlayerSlot,
} from '@pingpong/shared';
import { Server, type Socket } from 'socket.io';
import { db } from '../db/index.js';
import { createMatch, upsertUserByDiscordId } from '../db/repos.js';
import { cancelPendingResets, finishMatch } from '../game/finish.js';
import { startLoop, stopLoop } from '../game/loop.js';
import { type PaddleInput, room } from '../game/room.js';
import { afkTracker } from '../lobby/afk.js';
import { type AuthenticatedUser, authenticateSocket } from '../lobby/auth.js';
import {
  attemptReconnect,
  getReservedSlotOwner,
  isSlotReserved,
  recordDisconnect,
  setReconnectCallbacks,
} from '../lobby/reconnect.js';
import { AI_USERNAME, AI_USER_ID, lobby } from '../lobby/state.js';
import { log } from '../util/logger.js';
import { attachSpectateNamespace } from './spectate.js';

let io: Server | undefined;

/**
 * Discord Activity instance id from the most recent connecting socket.
 * Persisted on the match row so history is keyed to the real Activity instance
 * rather than a random per-match UUID. The server still hosts one active match
 * at a time; this captures the correct identifier for the eventual multi-room
 * refactor without changing concurrency today.
 */
let currentInstanceId: string | null = null;

function readInstanceId(socket: Socket): void {
  const id = socket.handshake.auth?.instanceId as string | undefined;
  if (id) currentInstanceId = id;
}

export function attachSocket(httpServer: HttpServer, clientOrigin: string): Server {
  io = new Server(httpServer, {
    path: '/ws',
    cors: {
      origin: [clientOrigin, /\.discordsays\.com$/],
      credentials: true,
    },
  });

  attachSpectateNamespace(io);

  lobby.setCallbacks({
    onLobbyUpdate: (snapshot) => {
      io?.emit('lobbyUpdate', {
        t: 'lobbyUpdate',
        phase: snapshot.phase,
        slots: snapshot.slots,
        paddleColors: snapshot.paddleColors,
        countdownRemaining: snapshot.countdownRemaining,
        readyUsers: snapshot.readyUsers,
      } satisfies LobbyUpdateMessage);
    },
    onCountdownTick: (remaining) => {
      io?.emit('countdownTick', {
        t: 'countdownTick',
        remaining,
      } satisfies CountdownTickMessage);
    },
    onCountdownComplete: (topDiscordId, bottomDiscordId) => {
      cancelPendingResets();
      const topUser = upsertUserByDiscordId(db, {
        discordId: topDiscordId,
        username: topDiscordId === AI_USER_ID ? AI_USERNAME : `player_${topDiscordId.slice(0, 8)}`,
      });
      const bottomUser = upsertUserByDiscordId(db, {
        discordId: bottomDiscordId,
        username:
          bottomDiscordId === AI_USER_ID ? AI_USERNAME : `player_${bottomDiscordId.slice(0, 8)}`,
      });

      // Client-facing match identifier (emitted in matchStart). Distinct from
      // the Discord Activity instance id persisted below.
      const matchId = crypto.randomUUID();
      const matchRow = createMatch(db, {
        instanceId: currentInstanceId ?? matchId,
        playerAId: topUser.id,
        playerBId: bottomUser.id,
      });

      room.startMatch(topDiscordId, bottomDiscordId);
      room.setMatchContext(
        matchRow.id,
        {
          dbId: topUser.id,
          username: topUser.username,
          avatarUrl: topUser.avatar,
        },
        {
          dbId: bottomUser.id,
          username: bottomUser.username,
          avatarUrl: bottomUser.avatar,
        },
      );

      afkTracker.init(['top', 'bottom']);
      startLoop(room);

      io?.emit('matchStart', {
        t: 'matchStart',
        matchId,
        players: {
          top: { id: topDiscordId, username: topUser.username, avatarUrl: topUser.avatar },
          bottom: {
            id: bottomDiscordId,
            username: bottomUser.username,
            avatarUrl: bottomUser.avatar,
          },
        },
      } satisfies MatchStartMessage);

      log.info(`[ws] match started: ${matchId}`);
    },
    onError: (socketId, code, message) => {
      io?.to(socketId).emit('error', { t: 'error', code, message });
    },
  });

  lobby.startHeartbeatCheck();

  setReconnectCallbacks({
    onGraceExpiry: (info) => {
      log.info(`[ws] grace expired: userId=${info.userId} slot=${info.slot} → forfeit_dc`);
      finishMatch(room, { endReason: 'forfeit_dc', winnerSlot: info.opponentSlot });
    },
  });

  io.on('connection', async (socket) => {
    log.info(`[ws] client connected: ${socket.id}`);
    readInstanceId(socket);

    // T8 compatibility: keep claim shortcut when NODE_ENV === 'test'
    if (process.env.NODE_ENV === 'test') {
      const claim = socket.handshake.query.claim as string | undefined;
      if (claim === 'top' || claim === 'bottom') {
        const slot = claim as PlayerSlot;
        const user = await authenticateSocket(socket);
        const userId = user?.id ?? socket.id;

        // Reconnect check — takes priority over claim shortcut
        if (user) {
          const reconnectInfo = attemptReconnect(user.id, socket.id);
          if (reconnectInfo) {
            lobby.autoClaimForReconnect(user.id, socket.id, reconnectInfo.slot);
            room.registerPlayer(reconnectInfo.slot, socket.id);

            if (reconnectInfo.previousPhase === 'countdown') {
              const topId = lobby.getUserIdForSlot('top');
              const bottomId = lobby.getUserIdForSlot('bottom');
              if (topId && bottomId) {
                room.startMatch(topId, bottomId);
              }
            }

            lobby.resume();
            startLoop(room);
            emitResumeAndSnapshot(socket);
            broadcastLobbyUpdate();

            socket.on('paddleInput', (data: PaddleInput) => {
              if (room.state.phase === 'playing') {
                afkTracker.updateInput(reconnectInfo.slot);
                room.pushInput(reconnectInfo.slot, data);
              }
            });

            log.info(
              `[ws] reconnected (test mode): ${socket.id} userId=${user.id} slot=${reconnectInfo.slot}`,
            );
            return;
          }
        }

        room.registerPlayer(slot, socket.id);
        if (user) {
          lobby.playerJoin(user.id, socket.id);
          lobby.readyToggle(user.id, socket.id);
        }
        log.info(`[ws] player ${slot} registered (test mode): ${socket.id} userId=${userId}`);

        const topSocket = room.getPlayerSocketId('top');
        const bottomSocket = room.getPlayerSocketId('bottom');
        if (topSocket && bottomSocket) {
          if (room.state.phase === 'waiting') {
            const topSlot = lobby.getSlots().top;
            const bottomSlot = lobby.getSlots().bottom;
            if (!topSlot || !bottomSlot) return;

            room.startMatch(topSlot, bottomSlot);
            afkTracker.init(['top', 'bottom']);
            startLoop(room);
            log.info('[ws] match started (test mode)');
          }
        }

        socket.on('paddleInput', (data: PaddleInput) => {
          if (room.state.phase === 'playing') {
            afkTracker.updateInput(slot);
            room.pushInput(slot, data);
          }
        });

        socket.on('disconnect', (reason) => {
          log.info(`[ws] player ${slot} disconnected: ${socket.id} (${reason})`);
          handlePlayerDisconnect(socket, user, slot);
        });
        return;
      }
    }

    // Normal auth flow
    const user = await authenticateSocket(socket);
    if (!user) {
      socket.emit('error', { t: 'error', code: 'AUTH_FAILED', message: 'Authentication failed' });
      socket.disconnect(true);
      return;
    }

    log.info(`[ws] authenticated: ${user.username} (${user.id})`);

    upsertUserByDiscordId(db, {
      discordId: user.id,
      username: user.username,
      avatar: user.avatar,
    });

    // Reconnect check — takes priority over lobby join
    const reconnectInfo = attemptReconnect(user.id, socket.id);
    if (reconnectInfo) {
      lobby.autoClaimForReconnect(user.id, socket.id, reconnectInfo.slot);
      room.registerPlayer(reconnectInfo.slot, socket.id);

      if (reconnectInfo.previousPhase === 'countdown') {
        const topId = lobby.getUserIdForSlot('top');
        const bottomId = lobby.getUserIdForSlot('bottom');
        if (topId && bottomId) {
          room.startMatch(topId, bottomId);
        }
      }

      lobby.resume();
      startLoop(room);
      emitResumeAndSnapshot(socket);
      broadcastLobbyUpdate();

      socket.on('paddleInput', (data: PaddleInput) => {
        if (room.state.phase !== 'playing') return;
        afkTracker.updateInput(reconnectInfo.slot);
        room.pushInput(reconnectInfo.slot, data);
      });

      socket.on('disconnect', (reason) => {
        log.info(`[ws] reconnected player disconnected: ${user.username} (${reason})`);
        handlePlayerDisconnect(socket, user, reconnectInfo.slot);
      });

      return;
    }

    lobby.playerJoin(user.id, socket.id);

    socket.on('readyToggle', () => {
      // Reject if trying to claim a slot reserved for a reconnecting player
      if (isSlotReserved('top') || isSlotReserved('bottom')) {
        const topOwner = getReservedSlotOwner('top');
        const bottomOwner = getReservedSlotOwner('bottom');
        if (topOwner !== user.id && bottomOwner !== user.id) {
          socket.emit('error', {
            t: 'error',
            code: 'CANNOT_CLAIM_DISCONNECTED_SLOT',
            message: 'Cannot claim a slot reserved for a reconnecting player',
          });
          return;
        }
      }
      lobby.readyToggle(user.id, socket.id);
    });

    socket.on('playAi', (data?: { difficulty?: AiDifficulty }) => {
      const difficulty: AiDifficulty =
        data?.difficulty === 'easy' || data?.difficulty === 'hard' ? data.difficulty : 'medium';
      lobby.startAiMatch(user.id, socket.id, difficulty);
    });

    socket.on('setPaddleColor', (data: { color: number }) => {
      if (typeof data.color === 'number') {
        lobby.setPaddleColor(user.id, data.color);
      }
    });

    socket.on('leaveLobby', () => {
      lobby.playerLeave(user.id);
    });

    socket.on('leaveGame', () => {
      const phase = lobby.getPhase();
      if (phase !== 'playing' && phase !== 'paused') {
        log.warn(`[ws] leaveGame ignored: user=${user.id} phase=${phase}`);
        return;
      }

      const slot = lobby.getSlotForUser(user.id);
      if (!slot) {
        log.warn(`[ws] leaveGame: no slot for user=${user.id}`);
        return;
      }

      const winnerSlot: PlayerSlot = slot === 'top' ? 'bottom' : 'top';
      log.info(
        `[ws] leaveGame: user=${user.id} slot=${slot} → forfeit_leave, winner=${winnerSlot}`,
      );

      finishMatch(room, {
        endReason: 'forfeit_leave',
        winnerSlot,
      });
    });

    socket.on('requestRematch', () => {
      const phase = lobby.getPhase();
      if (phase !== 'ended') {
        log.warn(`[ws] requestRematch ignored: user=${user.id} phase=${phase}`);
        return;
      }

      lobby.addRematchRequest(user.id);
      log.info(`[ws] requestRematch: user=${user.id} (total=${lobby.getRematchRequests().size})`);

      const topUser = lobby.getUserIdForSlot('top');
      const bottomUser = lobby.getUserIdForSlot('bottom');
      const rematchRequests = lobby.getRematchRequests();

      // AI matches: auto-accept when human requests rematch
      const isAiMatch = topUser === AI_USER_ID || bottomUser === AI_USER_ID;
      const humanRequested = rematchRequests.has(user.id);

      if (isAiMatch && humanRequested) {
        log.info(`[ws] AI rematch accepted: ${user.id} → starting new match`);
        lobby.startRematchCountdown();
      } else if (
        !isAiMatch &&
        topUser &&
        bottomUser &&
        rematchRequests.has(topUser) &&
        rematchRequests.has(bottomUser)
      ) {
        log.info(`[ws] rematch accepted: ${topUser} + ${bottomUser} → starting new match`);
        lobby.startRematchCountdown();
      } else {
        socket.emit('rematchPending', { t: 'rematchPending', message: 'Waiting for opponent...' });
      }
    });

    socket.on('lobby_heartbeat', () => {
      lobby.playerHeartbeat(user.id);
    });

    socket.on('paddleInput', (data: PaddleInput) => {
      if (room.state.phase !== 'playing') return;
      const slot = lobby.getSlotForUser(user.id);
      if (slot) {
        afkTracker.updateInput(slot);
        room.pushInput(slot, data);
      }
    });

    socket.on('disconnect', (reason) => {
      log.info(`[ws] disconnected: ${user.username} (${reason})`);
      const slot = lobby.getSlotForUser(user.id);
      if (slot) {
        handlePlayerDisconnect(socket, user, slot);
      } else {
        lobby.playerLeave(user.id);
      }
    });
  });

  log.info('[ws] Socket.io attached');
  return io;
}

export function getIO(): Server {
  if (!io) throw new Error('Socket.io not initialized — call attachSocket first');
  return io;
}

function emitResumeAndSnapshot(socket: Socket): void {
  socket.emit('resume', { t: 'resume' });

  const ballSpeed = Math.sqrt(room.state.ball.vel.x ** 2 + room.state.ball.vel.y ** 2);
  socket.emit('stateSnapshot', {
    t: 'stateSnapshot',
    tick: room.state.tick,
    lastProcessedSeq: { top: 0, bottom: 0 },
    ball: room.state.ball,
    paddles: room.state.paddles,
    score: room.state.score,
    phase: room.state.phase,
    rallyCount: room.rallyCount,
    ballSpeed,
  });
}

function broadcastLobbyUpdate(): void {
  const snapshot = lobby.getSnapshot();
  io?.emit('lobbyUpdate', {
    t: 'lobbyUpdate',
    phase: lobby.getPhase(),
    slots: lobby.getSlots(),
    paddleColors: snapshot.paddleColors,
    countdownRemaining: lobby.getCountdownRemaining(),
    readyUsers: lobby.getReadyUsers(),
  } satisfies LobbyUpdateMessage);
}

function handlePlayerDisconnect(
  socket: Socket,
  user: AuthenticatedUser | null,
  slot: PlayerSlot,
): void {
  const phase = lobby.getPhase();

  if ((phase === 'playing' || phase === 'countdown') && user) {
    lobby.pause();
    stopLoop(room);

    const bothDisconnected = recordDisconnect(
      user.id,
      socket.id,
      slot,
      phase === 'countdown' ? 'countdown' : 'playing',
    );

    io?.emit('pause', { t: 'pause', reason: 'player_disconnect', userId: user.id });

    if (bothDisconnected) {
      finishMatch(room, { endReason: 'forfeit_dc' });
    }
  } else {
    if (user) lobby.playerLeave(user.id);
  }

  room.unregisterPlayer(socket.id);
}
