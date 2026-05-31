import type { FastifyPluginAsync } from 'fastify';
import { cancelPendingResets } from '../game/finish.js';
import { stopLoop } from '../game/loop.js';
import { room } from '../game/room.js';
import {
  getDisconnectedUserIds,
  isInGraceWindow,
  reset as resetReconnect,
} from '../lobby/reconnect.js';
import { lobby } from '../lobby/state.js';

const debugRoutes: FastifyPluginAsync = async (app) => {
  app.get('/api/_debug/tick', async (_req, reply) => {
    return reply.code(200).send({ tickRateHz: room.getTickRateHz() });
  });

  app.get('/api/_debug/lobby', async (_req, reply) => {
    const snapshot = lobby.getSnapshot();
    return reply.code(200).send({
      phase: snapshot.phase,
      slots: snapshot.slots,
      countdownRemaining: snapshot.countdownRemaining,
      readyUsers: snapshot.readyUsers,
      roomPhase: room.state.phase,
      score: room.state.score,
      disconnectedUsers: getDisconnectedUserIds(),
    });
  });

  app.get('/api/_debug/reconnect/:userId', async (req, reply) => {
    const { userId } = req.params as { userId: string };
    return reply.code(200).send({ userId, inGraceWindow: isInGraceWindow(userId) });
  });

  app.post('/api/_debug/reset', async (_req, reply) => {
    cancelPendingResets();
    stopLoop(room);
    room.resetToWaiting();
    lobby.reset();
    resetReconnect();
    return reply.code(200).send({ ok: true });
  });
};

export default debugRoutes;
