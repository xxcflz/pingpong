/** Environment variables from Vite (import.meta.env). */

export const DISCORD_CLIENT_ID: string = import.meta.env.VITE_DISCORD_CLIENT_ID ?? '';

export const SERVER_HOST: string = import.meta.env.VITE_SERVER_HOST ?? 'http://localhost:3001';

export const SOCKET_TRANSPORT: 'polling' | 'websocket' =
  import.meta.env.VITE_SOCKET_TRANSPORT === 'websocket' ? 'websocket' : 'polling';
