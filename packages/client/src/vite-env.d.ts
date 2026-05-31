/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_DISCORD_CLIENT_ID: string;
  readonly VITE_SERVER_HOST: string;
  readonly VITE_SOCKET_TRANSPORT?: 'polling' | 'websocket';
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
