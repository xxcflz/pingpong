import type { ClientToServerEvent, ServerToPlayerEvent } from '@pingpong/shared';
/**
 * Thin typed wrapper around socket.io-client.
 *
 * Uses the `t` discriminant field from shared event unions as the
 * Socket.IO event name.  Zero rendering / DOM deps — pure data layer.
 */
import { type Socket, io } from 'socket.io-client';

/** Narrow a discriminated union to the member whose `t` matches K. */
type ExtractByT<TUnion extends { readonly t: string }, K extends string> = Extract<
  TUnion,
  { readonly t: K }
>;

export interface TypedSocket {
  /** Send a client→server event. `msg.t` becomes the Socket.IO event name. */
  emit<T extends ClientToServerEvent>(msg: T): void;

  /** Register a handler for a specific server→player event type. */
  on<K extends ServerToPlayerEvent['t']>(
    t: K,
    handler: (msg: ExtractByT<ServerToPlayerEvent, K>) => void,
  ): void;

  /** Remove all handlers for a specific event type. */
  off<K extends ServerToPlayerEvent['t']>(t: K): void;

  disconnect(): void;

  /** Escape hatch — raw socket.io Socket when you need low-level access. */
  readonly raw: Socket;
}

export interface SocketOpts {
  path?: string;
  transports?: string[];
}

export function createSocket(url: string, opts?: SocketOpts): TypedSocket {
  const socket: Socket = io(url, {
    path: opts?.path ?? '/ws',
    transports: opts?.transports ?? ['websocket'],
  });

  return {
    emit<T extends ClientToServerEvent>(msg: T): void {
      socket.emit(msg.t, msg);
    },

    on<K extends ServerToPlayerEvent['t']>(
      t: K,
      handler: (msg: ExtractByT<ServerToPlayerEvent, K>) => void,
    ): void {
      socket.on(t as string, (data: unknown) => {
        handler(data as ExtractByT<ServerToPlayerEvent, K>);
      });
    },

    off<K extends ServerToPlayerEvent['t']>(t: K): void {
      socket.off(t as string);
    },

    disconnect(): void {
      socket.disconnect();
    },

    raw: socket,
  };
}
