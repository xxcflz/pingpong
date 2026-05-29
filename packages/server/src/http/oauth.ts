import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { log } from '../util/logger.js';

const tokenBodySchema = z.object({
  code: z.string().min(1, 'code is required'),
});

const DISCORD_API = 'https://discord.com/api/v10';

/** POST /api/token — Discord OAuth code → access_token exchange */
const oauthRoutes: FastifyPluginAsync = async (app) => {
  app.post('/api/token', async (req, reply) => {
    const parsed = tokenBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'invalid_request',
        details: parsed.error.flatten().fieldErrors,
      });
    }

    const { code } = parsed.data;
    const clientId = process.env.DISCORD_CLIENT_ID!;
    const clientSecret = process.env.DISCORD_CLIENT_SECRET!;
    const clientOrigin = process.env.CLIENT_ORIGIN || 'http://localhost:5173';

    try {
      const res = await fetch(`${DISCORD_API}/oauth2/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          redirect_uri: clientOrigin,
          client_id: clientId,
          client_secret: clientSecret,
        }),
      });

      if (!res.ok) {
        const errBody = await res.text();
        log.warn('Discord token exchange failed', res.status, errBody);
        return reply.code(401).send({ error: 'token_exchange_failed' });
      }

      const data = (await res.json()) as { access_token: string; token_type: string };
      return reply.code(200).send({
        access_token: data.access_token,
        token_type: data.token_type,
      });
    } catch (err) {
      log.error('OAuth token exchange error', err);
      return reply.code(500).send({ error: 'internal_error' });
    }
  });
};

export default oauthRoutes;
