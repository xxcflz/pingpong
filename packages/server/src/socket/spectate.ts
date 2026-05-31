import type {
  MatchPhase,
  MatchState,
  PlayerSlot,
  SpectatorEndMessage,
  SpectatorScoreMessage,
  SpectatorState,
} from '@pingpong/shared';
import type { Socket, Server as SocketServer } from 'socket.io';
import { room } from '../game/room.js';
import { authenticateSocket } from '../lobby/auth.js';
import { lobby } from '../lobby/state.js';
import { log } from '../util/logger.js';

const SPECTATOR_HZ = 15;
const SPECTATOR_INTERVAL_MS = Math.round(1000 / SPECTATOR_HZ);
const INSTANCE_ROOM = 'instance:default';

let spectatorNsp: ReturnType<SocketServer['of']> | undefined;
let broadcasterTimer: ReturnType<typeof setInterval> | null = null;
let lastScoreTop = 0;
let lastScoreBottom = 0;
let lastPhase: MatchPhase = 'waiting';

function projectToSpectatorState(s: MatchState): SpectatorState {
  return {
    tick: s.tick,
    ball: { x: s.ball.pos.x, y: s.ball.pos.y },
    paddles: {
      top: { x: s.paddles.top.pos.x },
      bottom: { x: s.paddles.bottom.pos.x },
    },
    score: s.score,
    phase: s.phase,
  };
}

function broadcastSpectatorState(): void {
  if (!spectatorNsp) return;

  // Skip all work when no spectators are connected. The 15 Hz timer would
  // otherwise project + emit state forever even on an idle "waiting" lobby.
  // When a spectator joins, the connection handler sends an immediate snapshot
  // and subsequent ticks resume here.
  const audience = spectatorNsp.adapter.rooms.get(INSTANCE_ROOM);
  if (!audience || audience.size === 0) return;

  const state = room.state;
  const payload = projectToSpectatorState(state);
  spectatorNsp.to(INSTANCE_ROOM).emit('SpectatorState', payload);

  if (state.score.top !== lastScoreTop || state.score.bottom !== lastScoreBottom) {
    const scorer: PlayerSlot = state.score.top > lastScoreTop ? 'top' : 'bottom';
    lastScoreTop = state.score.top;
    lastScoreBottom = state.score.bottom;
    spectatorNsp.to(INSTANCE_ROOM).emit('SpectatorScore', {
      t: 'SpectatorScore',
      score: state.score,
      scorer,
    } satisfies SpectatorScoreMessage);
  }

  if (state.phase === 'finished' && lastPhase !== 'finished') {
    lastPhase = state.phase;
    spectatorNsp.to(INSTANCE_ROOM).emit('SpectatorEnd', {
      t: 'SpectatorEnd',
      winner: state.score.top > state.score.bottom ? 'top' : 'bottom',
      score: state.score,
    } satisfies SpectatorEndMessage);
  }
}

export function attachSpectateNamespace(io: SocketServer): void {
  spectatorNsp = io.of('/spectate');

  spectatorNsp.on('connection', async (socket: Socket) => {
    const user = await authenticateSocket(socket);

    if (!user) {
      socket.emit('Error', { t: 'error', code: 'AUTH_FAILED', message: 'Authentication required' });
      socket.disconnect(true);
      return;
    }

    const activeSlot = lobby.getSlotForUser(user.id);
    const matchActive = room.state.phase === 'playing' || room.state.phase === 'paused';
    if (activeSlot && matchActive) {
      log.info(`[spectate] rejected player ${user.id} from spectating`);
      socket.emit('Error', {
        t: 'error',
        code: 'PLAYER_CANNOT_SPECTATE',
        message: 'Active players cannot spectate their own match',
      });
      socket.disconnect(true);
      return;
    }

    socket.join(INSTANCE_ROOM);
    log.info(`[spectate] spectator connected: ${socket.id} (user=${user.id})`);

    const snapshot = projectToSpectatorState(room.state);
    socket.emit('SpectatorState', snapshot);

    socket.on('disconnect', (reason: string) => {
      log.info(`[spectate] spectator disconnected: ${socket.id} (${reason})`);
    });
  });

  startBroadcaster();
  log.info('[spectate] /spectate namespace attached');
}

function startBroadcaster(): void {
  if (broadcasterTimer) return;
  lastScoreTop = room.state.score.top;
  lastScoreBottom = room.state.score.bottom;
  lastPhase = room.state.phase;
  broadcasterTimer = setInterval(broadcastSpectatorState, SPECTATOR_INTERVAL_MS);
}

export function stopBroadcaster(): void {
  if (broadcasterTimer) {
    clearInterval(broadcasterTimer);
    broadcasterTimer = null;
  }
}
