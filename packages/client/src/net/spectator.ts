import { io, type Socket } from "socket.io-client";
import type {
  PlayerSlot,
  SpectatorState,
} from "@pingpong/shared";

export type SpectatorStateHandler = (state: SpectatorState) => void;
export type SpectatorScoreHandler = (
  score: Readonly<Record<PlayerSlot, number>>,
  scorer: PlayerSlot,
) => void;
export type SpectatorEndHandler = (
  winner: PlayerSlot,
  score: Readonly<Record<PlayerSlot, number>>,
) => void;
export type SpectatorErrorHandler = (code: string, message: string) => void;

export class SpectatorClient {
  private socket: Socket;
  private currentState: SpectatorState | null = null;
  private stateHandlers: SpectatorStateHandler[] = [];
  private scoreHandlers: SpectatorScoreHandler[] = [];
  private endHandlers: SpectatorEndHandler[] = [];
  private errorHandlers: SpectatorErrorHandler[] = [];

  constructor(serverUrl: string, testUserId?: string, preferPolling = false) {
    const query: Record<string, string> = {};
    if (testUserId) query.test_user_id = testUserId;

    this.socket = io(`${serverUrl}/spectate`, {
      path: '/ws',
      transports: preferPolling ? ["polling"] : ["websocket"],
      upgrade: !preferPolling,
      query,
    });

    this.socket.on("SpectatorState", (data: SpectatorState) => {
      this.currentState = data;
      for (const fn of this.stateHandlers) fn(data);
    });

    this.socket.on(
      "SpectatorScore",
      (data: { score: Readonly<Record<PlayerSlot, number>>; scorer: PlayerSlot }) => {
        for (const fn of this.scoreHandlers) fn(data.score, data.scorer);
      },
    );

    this.socket.on(
      "SpectatorEnd",
      (data: { winner: PlayerSlot; score: Readonly<Record<PlayerSlot, number>> }) => {
        for (const fn of this.endHandlers) fn(data.winner, data.score);
      },
    );

    this.socket.on("Error", (data: { code: string; message: string }) => {
      for (const fn of this.errorHandlers) fn(data.code, data.message);
    });
  }

  onState(fn: SpectatorStateHandler): void {
    this.stateHandlers.push(fn);
  }

  onScore(fn: SpectatorScoreHandler): void {
    this.scoreHandlers.push(fn);
  }

  onEnd(fn: SpectatorEndHandler): void {
    this.endHandlers.push(fn);
  }

  onError(fn: SpectatorErrorHandler): void {
    this.errorHandlers.push(fn);
  }

  getState(): SpectatorState | null {
    return this.currentState;
  }

  get connected(): boolean {
    return this.socket.connected;
  }

  get socketId(): string | undefined {
    return this.socket.id;
  }

  disconnect(): void {
    this.socket.disconnect();
  }
}
