/**
 * MatchOrchestrator — top-level state machine for the client.
 *
 * Wires together: DiscordContext, Socket.IO, PongScene, PredictionEngine,
 * InterpolationBuffer, LifecycleObserver, DragHandler, SpectatorClient.
 *
 * Server is the source of truth for phase transitions — this orchestrator
 * reacts to server events, never invents phases.
 */
import { io, type Socket } from "socket.io-client";
import { Application, Container, Graphics, Text } from "pixi.js";
import {
  COURT_WIDTH,
  COURT_HEIGHT,
  PADDLE_WIDTH,
  PADDLE_HEIGHT,
  BALL_RADIUS,
  type MatchState,
  type MatchPhase,
  type PlayerSlot,
  type SpectatorState,
  type PaddleMoveEvent,
} from "@pingpong/shared";
import { DiscordContext } from "../sdk/discord";
import { LifecycleObserver } from "../sdk/lifecycle";
import { PongScene } from "../scene/PongScene";
import { createPredictionEngine, type PredictionEngine } from "../net/prediction";
import { createBallPredictionEngine, type BallPredictionEngine } from "../net/ballPrediction";
import { createOpponentPredictionEngine, type OpponentPredictionEngine } from "../net/opponentPrediction";
import { createDragHandler, type DragController } from "../input/drag";
import { SpectatorClient } from "../net/spectator";
import { SOCKET_TRANSPORT } from "../env";

// ── Types ───────────────────────────────────────────────────────────────────

export type ClientRole = "player" | "spectator" | "pending";

export interface MatchOrchestratorDeps {
  serverHost: string;
  app: Application;
  scene: PongScene;
  ctx: DiscordContext;
  /** Shared mutable ref — scene's getState reads from this, orchestrator writes to it. */
  stateRef: { current: MatchState };
  /** Mode pre-selected on the landing page; skips the in-game "Choose Mode" overlay. */
  selectedMode?: "online" | "ai";
  /** Paddle color chosen on the landing page. */
  userColor: number;
}

declare global {
  interface Window {
    __test_dropSocket?: () => void;
    __orchestrator?: MatchOrchestrator;
  }
}

// ── Wire protocol types (matching actual server payloads) ───────────────────

interface ServerLobbyUpdate {
  t: "lobbyUpdate";
  phase: string;
  slots: { top?: string; bottom?: string };
  paddleColors: Record<string, number>;
  countdownRemaining: number;
  readyUsers: string[];
}

interface ServerCountdownTick {
  t: "countdownTick";
  remaining?: number;
  number?: number;
}

interface ServerMatchStart {
  t: "matchStart";
  matchId: string;
  players: Record<PlayerSlot, { id: string; username: string; avatarUrl: string | null }>;
}

interface ServerStateSnapshot {
  t: "stateSnapshot";
  tick: number;
  lastProcessedSeq: Record<PlayerSlot, number>;
  ball: MatchState["ball"];
  paddles: MatchState["paddles"];
  score: MatchState["score"];
  phase: MatchPhase;
  rallyCount: number;
  ballSpeed: number;
}

interface ServerScoreEvent {
  t: "scoreEvent";
  side: PlayerSlot;
  score: Record<PlayerSlot, number>;
  reason: string;
}

interface ServerMatchEnd {
  t: "matchEnd";
  matchId: number | null;
  end_reason: string;
  winnerSlot: PlayerSlot | null;
  winner: { id: string; username: string; avatarUrl: string | null } | null;
  loser: { id: string; username: string; avatarUrl: string | null } | null;
  scoreA: number;
  scoreB: number;
  rallyCountMax: number;
}

interface ServerPause {
  t: "pause";
  reason: string;
  userId?: string;
}

interface ServerAfkWarning {
  t: "afkWarning";
  slot: PlayerSlot;
  secondsRemaining: number;
}

// ── Constants ───────────────────────────────────────────────────────────────

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30_000;
const POLLING_INPUT_INTERVAL_MS = 16;

// ── Orchestrator ────────────────────────────────────────────────────────────

export class MatchOrchestrator {
  private readonly serverHost: string;
  private readonly app: Application;
  private readonly scene: PongScene;
  private readonly ctx: DiscordContext;
  private readonly stateRef: { current: MatchState };
  private readonly selectedMode?: "online" | "ai";
  private readonly userColor: number;

  // Network
  private socket: Socket | null = null;
  private spectatorClient: SpectatorClient | null = null;

  // Prediction & interpolation (player mode)
  private prediction: PredictionEngine | null = null;
  private ballPrediction: BallPredictionEngine | null = null;
  private opponentPrediction: OpponentPredictionEngine | null = null;

  // Lifecycle & input
  private lifecycle: LifecycleObserver | null = null;
  private drag: DragController | null = null;

  // State
  private role: ClientRole = "pending";
  private mySlot: PlayerSlot | null = null;
  private myUserId: string | null = null;
  private currentPhase = "idle";
  private matchState!: MatchState;

  // Reconnection
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private isReconnecting = false;

  // Ready button (Pixi overlay)
  private readyOverlay: Container | null = null;

  // Lobby heartbeat
  private lobbyHeartbeatTimer: ReturnType<typeof setInterval> | null = null;

  // Polling transport input batching
  private pendingPaddleInput: PaddleMoveEvent | null = null;
  private paddleInputTimer: ReturnType<typeof setTimeout> | null = null;
  private lastPaddleInputSentAt = 0;

  // Ticker binding ref
  private readonly boundTick: (ticker: { deltaMS: number }) => void;

  constructor(deps: MatchOrchestratorDeps) {
    this.serverHost = deps.serverHost;
    this.app = deps.app;
    this.scene = deps.scene;
    this.ctx = deps.ctx;
    this.stateRef = deps.stateRef;
    this.selectedMode = deps.selectedMode;
    this.userColor = deps.userColor;

    this.setState(this.createStubState());
    this.boundTick = this.onTick.bind(this);
  }

  private createStubState(): MatchState {
    return {
      tick: 0,
      phase: "waiting",
      ball: {
        pos: { x: COURT_WIDTH / 2, y: COURT_HEIGHT / 2 },
        vel: { x: 0, y: 0 },
        spin: 0,
        radius: BALL_RADIUS,
      },
      paddles: {
        top: { pos: { x: COURT_WIDTH / 2, y: PADDLE_HEIGHT / 2 + 40 }, vel: { x: 0, y: 0 }, width: PADDLE_WIDTH, height: PADDLE_HEIGHT },
        bottom: { pos: { x: COURT_WIDTH / 2, y: COURT_HEIGHT - PADDLE_HEIGHT / 2 - 40 }, vel: { x: 0, y: 0 }, width: PADDLE_WIDTH, height: PADDLE_HEIGHT },
      },
      score: { top: 0, bottom: 0 },
      serverTimeMs: Date.now(),
    };
  }

  // ── Boot sequence ─────────────────────────────────────────────────────────

  async boot(): Promise<void> {
    const params = new URLSearchParams(window.location.search);
    this.myUserId = params.get("test_user_id") ?? (this.ctx.isMock ? `mock_user_${Date.now()}` : null);

    this.scene.setPhase("waiting");

    if (!this.ctx.isMock) {
      try {
        await this.ctx.authorize(this.serverHost);
        this.myUserId = this.ctx.userId;
      } catch (err) {
        throw err;
      }
    }

    this.createSocket();
    this.subscribeToEvents();

    await this.waitForConnection();

    if (this.socket) {
      this.socket.emit("setPaddleColor", { color: this.userColor });
    }

    this.startLobbyHeartbeat();

    this.lifecycle = new LifecycleObserver(this.ctx);
    await this.lifecycle.start({
      onPause: () => {
        if (this.role === "player" && this.socket?.connected) {
          this.socket.emit("pause");
        }
      },
      onResume: () => {
        if (this.role === "player" && this.socket?.connected) {
          this.socket.emit("resume");
          this.socket.emit("request_resync");
        }
      },
    });

    this.exposeTestHooks();
  }

  // ── Socket connection ─────────────────────────────────────────────────────

  private createSocket(): void {
    const auth: Record<string, string> = {};
    if (this.myUserId) {
      auth.test_user_id = this.myUserId;
      auth.test_username = this.myUserId;
    }
    if (this.ctx.accessToken) {
      auth.token = this.ctx.accessToken;
    }

    const forcePolling = !this.ctx.isMock && SOCKET_TRANSPORT === "polling";
    this.socket = io(this.serverHost, {
      path: '/ws',
      transports: forcePolling ? ["polling"] : ["websocket", "polling"],
      upgrade: !forcePolling,
      auth,
      reconnection: false,
    });

    this.socket.on("connect", () => {
      if (this.isReconnecting) {
        this.onReconnected();
      }
    });

    this.socket.on("disconnect", () => {
      this.onDisconnected();
    });
  }

  private async waitForConnection(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Socket connection timeout")), 10000);
      this.socket!.on("connect", () => {
        clearTimeout(timeout);
        resolve();
      });
      this.socket!.on("connect_error", (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });
  }

  /** Used by resetToLobby after match end. */
  private async reconnectSocket(): Promise<void> {
    this.createSocket();
    this.subscribeToEvents();
    await this.waitForConnection();
  }

  // ── Event subscriptions ───────────────────────────────────────────────────

  private subscribeToEvents(): void {
    if (!this.socket) return;

    // Lobby updates — drives role determination and phase
    this.socket.on("lobbyUpdate", (data: ServerLobbyUpdate) => {
      this.onLobbyUpdate(data);
    });

    // Countdown ticks
    this.socket.on("countdownTick", (data: ServerCountdownTick) => {
      this.onCountdownTick(data);
    });

    // Match started
    this.socket.on("matchStart", (data: ServerMatchStart) => {
      this.onMatchStart(data);
    });

    // State snapshots (playing phase) — server emits "stateSnapshot"
    this.socket.on("stateSnapshot", (data: ServerStateSnapshot) => {
      this.onStateSnapshot(data);
    });

    // Score updates — server emits "scoreEvent"
    this.socket.on("scoreEvent", (data: ServerScoreEvent) => {
      this.onScore(data);
    });

    // Match end
    this.socket.on("matchEnd", (data: ServerMatchEnd) => {
      this.onMatchEnd(data);
    });

    // Pause broadcasts
    this.socket.on("pause", (data: ServerPause) => {
      this.onPause(data);
    });

    // Resume broadcasts
    this.socket.on("resume", () => {
      this.onResume();
    });

    // AFK warnings
    this.socket.on("afkWarning", (data: ServerAfkWarning) => {
      this.onAfkWarning(data);
    });

    // Server errors
    this.socket.on("error", (_data: { code: string; message: string }) => {
    });
  }

  // ── Role determination ────────────────────────────────────────────────────

  private onLobbyUpdate(data: ServerLobbyUpdate): void {
    const { phase, slots, paddleColors } = data;
    this.currentPhase = phase;

    // Detect our slot from slots data
    if (!this.mySlot && this.myUserId) {
      if (slots.top === this.myUserId) {
        this.mySlot = "top";
        this.scene.setUserSlot("top");
      } else if (slots.bottom === this.myUserId) {
        this.mySlot = "bottom";
        this.scene.setUserSlot("bottom");
      }
    }

    // Apply opponent's paddle color if available
    if (this.mySlot && this.myUserId && paddleColors) {
      const opponentId = slots.top === this.myUserId ? slots.bottom : slots.top;
      if (opponentId && paddleColors[opponentId] !== undefined) {
        this.scene.setOpponentColor(paddleColors[opponentId]);
      }
    }

    if (this.role === "pending") {
      const occupiedSlots = [slots.top, slots.bottom].filter(Boolean).length;
      if (occupiedSlots >= 2 && (phase === "playing" || phase === "countdown" || phase === "paused")) {
        this.becomeSpectator();
      } else {
        this.becomePlayerCandidate();
      }
    }

    if (phase === "lobby") {
      if (this.selectedMode !== "ai") {
        this.scene.setPhase("waiting");
        this.scene.hideLeaveButton();
      }
      this.loadHistory();
      if (this.role === "player" && !this.mySlot && !this.selectedMode) this.showReadyButton();
    } else if (phase === "countdown") {
      this.scene.setPhase("countdown");
      this.scene.hideLeaveButton();
      this.hideReadyButton();
    } else if (phase === "playing") {
      this.scene.setPhase("playing");
      this.scene.showLeaveButton();
      this.hideReadyButton();
    }
  }

  private becomePlayerCandidate(): void {
    this.role = "player";
    this.scene.setRole("player");
    if (this.selectedMode !== "ai") {
      this.scene.setPhase("waiting");
    }
    this.loadHistory();

    if (this.selectedMode) {
      this.emitSelectedMode();
    } else {
      this.showReadyButton();
    }

    // Setup paddle prediction — emit paddleInput (server-expected format)
    this.prediction = createPredictionEngine({
      emit: (msg) => {
        this.emitPaddleInput(msg);
      },
    });

    // Setup ball prediction — runs physics locally for immediate rendering
    this.ballPrediction = createBallPredictionEngine();

    // Setup opponent paddle prediction — velocity-based extrapolation
    this.opponentPrediction = createOpponentPredictionEngine(COURT_WIDTH / 2);

  }

  private emitPaddleInput(msg: PaddleMoveEvent): void {
    if (!this.socket?.connected) return;

    if (this.ctx.isMock) {
      this.socket.emit("paddleInput", { paddleX: msg.pos.x, seq: msg.seq });
      return;
    }

    this.pendingPaddleInput = msg;

    const now = performance.now();
    const elapsed = now - this.lastPaddleInputSentAt;
    if (elapsed >= POLLING_INPUT_INTERVAL_MS) {
      this.flushPaddleInput();
      return;
    }

    if (!this.paddleInputTimer) {
      this.paddleInputTimer = setTimeout(() => {
        this.flushPaddleInput();
      }, POLLING_INPUT_INTERVAL_MS - elapsed);
    }
  }

  private flushPaddleInput(): void {
    if (this.paddleInputTimer) {
      clearTimeout(this.paddleInputTimer);
      this.paddleInputTimer = null;
    }

    const msg = this.pendingPaddleInput;
    this.pendingPaddleInput = null;
    if (!msg || !this.socket?.connected) return;

    this.socket.emit("paddleInput", { paddleX: msg.pos.x, seq: msg.seq });
    this.lastPaddleInputSentAt = performance.now();
  }

  private becomeSpectator(): void {
    this.role = "spectator";
    this.scene.setRole("spectator");
    this.hideReadyButton();

    // Close player socket — not needed for spectating
    if (this.socket) {
      this.socket.disconnect();
      this.socket = null;
    }
    this.stopLobbyHeartbeat();

    // Open spectator client
    this.spectatorClient = new SpectatorClient(
      this.serverHost,
      this.myUserId ?? undefined,
      !this.ctx.isMock && SOCKET_TRANSPORT !== "websocket",
    );

    this.spectatorClient.onState((state: SpectatorState) => {
      this.onSpectatorState(state);
    });

    this.spectatorClient.onScore((_score, scorer) => {
      this.scene.flashScore(scorer);
    });

    this.spectatorClient.onEnd((winner) => {
      this.scene.showEndScreen({
        end_reason: "score",
        winnerName: winner === "top" ? "Top Player" : "Bottom Player",
        loserName: winner === "top" ? "Bottom Player" : "Top Player",
        scoreA: this.matchState.score.top,
        scoreB: this.matchState.score.bottom,
        rallyCountMax: 0,
        winnerSlot: winner,
        onRematch: () => {
          this.scene.hideEndScreen();
        },
        onReturnToLobby: () => {
          this.scene.hideEndScreen();
        },
      });
    });

    // Show spectating banner
    this.showSpectatingBanner();

  }

  private onSpectatorState(state: SpectatorState): void {
    this.setState({
      tick: state.tick,
      phase: state.phase,
      ball: {
        pos: { x: state.ball.x, y: state.ball.y },
        vel: { x: 0, y: 0 },
        spin: 0,
        radius: BALL_RADIUS,
      },
      paddles: {
        top: { pos: { x: state.paddles.top.x, y: PADDLE_HEIGHT / 2 + 40 }, vel: { x: 0, y: 0 }, width: PADDLE_WIDTH, height: PADDLE_HEIGHT },
        bottom: { pos: { x: state.paddles.bottom.x, y: COURT_HEIGHT - PADDLE_HEIGHT / 2 - 40 }, vel: { x: 0, y: 0 }, width: PADDLE_WIDTH, height: PADDLE_HEIGHT },
      },
      score: state.score,
      serverTimeMs: Date.now(),
    });
  }

  // ── Ready button overlay ──────────────────────────────────────────────────

  private showReadyButton(): void {
    if (this.readyOverlay || this.role !== "player") return;

    const overlay = new Container();
    overlay.label = "readyOverlay";

    // Dim background
    const bg = new Graphics()
      .rect(0, 0, COURT_WIDTH, COURT_HEIGHT)
      .fill({ color: 0x00_00_00, alpha: 0.5 });
    overlay.addChild(bg);

    const title = new Text({
      text: "Choose Mode",
      style: {
        fontFamily: "'Courier New', Courier, monospace",
        fontSize: 34,
        fill: 0xff_ff_ff,
        fontWeight: "bold",
      },
    });
    title.anchor.set(0.5);
    title.x = COURT_WIDTH / 2;
    title.y = COURT_HEIGHT / 2 - 115;
    overlay.addChild(title);

    const online = this.createMenuButton({
      label: "Play Online",
      y: COURT_HEIGHT / 2 - 45,
      color: 0x4d_d2_ff,
      onTap: () => {
        if (!this.socket?.connected) return;
        this.socket.emit("readyToggle");
        this.hideReadyButton();
      },
    });
    overlay.addChild(online);

    const ai = this.createMenuButton({
      label: "Play AI",
      y: COURT_HEIGHT / 2 + 45,
      color: 0x5e_ea_8a,
      onTap: () => {
        if (!this.socket?.connected) return;
        this.socket.emit("playAi");
        this.hideReadyButton();
      },
    });
    overlay.addChild(ai);

    this.scene.getLayers().uiLayer.addChild(overlay);
    this.readyOverlay = overlay;
  }

  private createMenuButton(opts: {
    label: string;
    y: number;
    color: number;
    onTap: (label: Text, bg: Graphics) => void;
  }): Container {
    const container = new Container();
    const btnW = 300;
    const btnH = 68;
    const btnX = (COURT_WIDTH - btnW) / 2;

    const bg = new Graphics()
      .roundRect(btnX, opts.y, btnW, btnH, 12)
      .fill(opts.color);
    bg.label = opts.label.replace(/\s+/g, "").toLowerCase();
    bg.eventMode = "static";
    bg.cursor = "pointer";
    container.addChild(bg);

    const label = new Text({
      text: opts.label,
      style: {
        fontFamily: "'Courier New', Courier, monospace",
        fontSize: 28,
        fill: 0xff_ff_ff,
        fontWeight: "bold",
      },
    });
    label.anchor.set(0.5);
    label.x = COURT_WIDTH / 2;
    label.y = opts.y + btnH / 2;
    container.addChild(label);

    bg.on("pointertap", () => opts.onTap(label, bg));

    return container;
  }

  private hideReadyButton(): void {
    if (this.readyOverlay) {
      this.readyOverlay.destroy({ children: true });
      this.readyOverlay = null;
    }
  }

  /** Auto-emit the mode chosen on the landing page, skipping the in-game overlay. */
  private emitSelectedMode(): void {
    if (!this.socket?.connected || !this.selectedMode) return;
    if (this.selectedMode === "online") {
      this.socket.emit("readyToggle");
    } else {
      this.socket.emit("playAi");
      this.scene.setPhase("countdown");
      this.scene.setCountdown(3);
    }
  }

  private loadHistory(): void {
    if (!this.myUserId) return;
    const token = this.ctx.accessToken ?? `test:${this.myUserId}:${this.myUserId}`;
    this.scene.loadMatchHistory(token, this.myUserId);
  }

  // ── Spectating banner ─────────────────────────────────────────────────────

  private showSpectatingBanner(): void {
    const banner = new Text({
      text: "Spectating",
      style: {
        fontFamily: "'Courier New', Courier, monospace",
        fontSize: 28,
        fill: 0x88_99_aa,
        fontWeight: "bold",
      },
    });
    banner.anchor.set(0.5);
    banner.x = COURT_WIDTH / 2;
    banner.y = 60;
    banner.label = "spectatingBanner";
    this.scene.getLayers().uiLayer.addChild(banner);
  }

  // ── Countdown ─────────────────────────────────────────────────────────────

  private onCountdownTick(data: ServerCountdownTick): void {
    this.currentPhase = "countdown";
    this.scene.setPhase("countdown");
    this.scene.setCountdown(data.remaining ?? data.number ?? 0);
  }

  // ── Match start ───────────────────────────────────────────────────────────

  private onMatchStart(data: ServerMatchStart): void {
    this.currentPhase = "playing";
    this.scene.setPhase("playing");
    this.scene.setCountdown(0);

    // Determine my slot from match start data
    if (this.myUserId) {
      if (data.players.top.id === this.myUserId) {
        this.mySlot = "top";
        this.scene.setUserSlot("top");
      } else if (data.players.bottom.id === this.myUserId) {
        this.mySlot = "bottom";
        this.scene.setUserSlot("bottom");
      }
    }

    // Reset ball prediction to fresh serve
    if (this.ballPrediction) {
      this.ballPrediction.reset({
        pos: { x: COURT_WIDTH / 2, y: COURT_HEIGHT / 2 },
        vel: { x: 0, y: 420 },
        spin: 0,
        radius: BALL_RADIUS,
      });
    }

    // Wire drag handler
    this.setupDragHandler();

    // Start Pixi ticker for prediction+interpolation
    this.app.ticker.add(this.boundTick);

  }

  private setupDragHandler(): void {
    if (!this.prediction) return;

    const canvas = this.app.canvas as HTMLCanvasElement;

    this.drag = createDragHandler(
      canvas,
      {
        onDragStart: () => {
          this.prediction!.startDrag();
        },
        onPaddleX: (courtX) => {
          this.prediction!.applyInput(courtX, 0);
        },
        onDragEnd: () => {
          this.prediction!.endDrag();
        },
        onRelease: (velX) => {
          this.prediction!.applyInput(this.prediction!.getPredictedPaddleX(), velX);
        },
      },
      (screenX) => this.scene.screenToCourtX(screenX),
      () => this.prediction!.getPredictedPaddleX(),
    );

    this.drag.enable();
  }

  // ── State snapshots ───────────────────────────────────────────────────────

  private onStateSnapshot(data: ServerStateSnapshot): void {
    if (this.role !== "player") return;

    // Store server-authoritative state for prediction engines
    // (don't write to stateRef.current - that causes race condition with onTick)
    const serverState = {
      tick: data.tick,
      phase: data.phase,
      ball: data.ball,
      paddles: data.paddles,
      score: data.score,
      serverTimeMs: Date.now(),
    };

    // Feed paddle prediction engine with server reconciliation
    if (this.prediction && this.mySlot) {
      const myPaddle = serverState.paddles[this.mySlot];
      const lastSeq = data.lastProcessedSeq[this.mySlot] ?? 0;
      this.prediction.onSnapshot(myPaddle.pos.x, lastSeq);
    }

    // Feed ball prediction engine with server snapshot (for correction)
    if (this.ballPrediction) {
      this.ballPrediction.onSnapshot(data.ball);
    }

    // Feed opponent paddle prediction with server snapshot
    if (this.opponentPrediction && this.mySlot) {
      const opponentSlot: PlayerSlot = this.mySlot === "top" ? "bottom" : "top";
      const opponentPaddle = serverState.paddles[opponentSlot];
      this.opponentPrediction.onSnapshot(opponentPaddle.pos.x, opponentPaddle.vel.x);
    }

    // Update metadata only (not positions - onTick handles that)
    this.matchState = {
      ...this.matchState,
      tick: data.tick,
      phase: data.phase,
      score: data.score,
      serverTimeMs: Date.now(),
    };

    // Update rally count
    this.scene.setRallyCount(data.rallyCount);
  }

  // ── Tick (Pixi ticker) ────────────────────────────────────────────────────

  private onTick(ticker: { deltaMS: number }): void {
    if (this.role !== "player" || this.currentPhase !== "playing") return;
    if (!this.prediction || !this.opponentPrediction || !this.mySlot || !this.ballPrediction) return;

    // Advance predictions using frame dt
    const dt = ticker.deltaMS / 1000;
    this.ballPrediction.tick(dt, this.matchState.paddles);
    this.opponentPrediction.tick(dt);
    this.prediction.tick(dt);

    // Read predicted paddle position
    const predictedX = this.prediction.getPredictedPaddleX();

    // Read predicted ball position (no interpolation delay!)
    const predictedBall = this.ballPrediction.getPredictedBall();

    // Read predicted opponent paddle position
    const opponentX = this.opponentPrediction.getPredictedX();

    // Build composite state for scene
    const myPaddleY = this.mySlot === "top"
      ? PADDLE_HEIGHT / 2 + 40
      : COURT_HEIGHT - PADDLE_HEIGHT / 2 - 40;
    const opponentPaddleY = this.mySlot === "top"
      ? COURT_HEIGHT - PADDLE_HEIGHT / 2 - 40
      : PADDLE_HEIGHT / 2 + 40;

    const opponentSlot: PlayerSlot = this.mySlot === "top" ? "bottom" : "top";

    this.setState({
      ...this.matchState,
      ball: predictedBall,
      paddles: {
        [this.mySlot]: {
          ...this.matchState.paddles[this.mySlot],
          pos: { x: predictedX, y: myPaddleY },
        },
        [opponentSlot]: {
          ...this.matchState.paddles[opponentSlot],
          pos: { x: opponentX, y: opponentPaddleY },
        },
      },
    } as MatchState);
  }

  // ── Score ─────────────────────────────────────────────────────────────────

  private onScore(data: ServerScoreEvent): void {
    this.scene.flashScore(data.side);
    this.scene.setRallyCount(0);

    // Reset ball prediction — server will send the new ball state in the next snapshot
    if (this.ballPrediction) {
      // Reset to center with initial velocity toward the loser
      const toward = data.side === "top" ? "bottom" : "top";
      this.ballPrediction.reset({
        pos: { x: COURT_WIDTH / 2, y: COURT_HEIGHT / 2 },
        vel: { x: 0, y: toward === "bottom" ? 420 : -420 },
        spin: 0,
        radius: BALL_RADIUS,
      });
    }
  }

  // ── Match end ─────────────────────────────────────────────────────────────

  private onMatchEnd(data: ServerMatchEnd): void {
    this.currentPhase = "ended";
    this.scene.setPhase("finished");
    this.scene.hideLeaveButton();

    this.scene.hideAfkWarning();

    const winnerName = data.winner?.username ?? "Unknown";
    const loserName = data.loser?.username ?? "Unknown";

    this.scene.showEndScreen({
      end_reason: data.end_reason,
      winnerName,
      loserName,
      scoreA: data.scoreA,
      scoreB: data.scoreB,
      rallyCountMax: data.rallyCountMax,
      winnerSlot: data.winnerSlot,
      onRematch: () => this.handleRematch(),
      onReturnToLobby: () => this.resetToLobby(),
    });

    this.drag?.disable();
    this.drag = null;
    this.app.ticker.remove(this.boundTick);
  }

  private handleRematch(): void {
    if (!this.socket || this.role !== "player") return;

    this.scene.hideEndScreen();
    this.scene.setPhase("waiting");

    // Reset state for new match
    this.currentPhase = "waiting";
    this.setState(this.createStubState());

    // Server will handle rematch logic (keep players, reset scores, restart countdown)
    this.socket.emit("requestRematch");
  }

  public leaveGame(): void {
    if (!this.socket) return;

    // Only allow leaving during active gameplay
    if (this.currentPhase === "playing" || this.currentPhase === "countdown") {
      this.socket.emit("leaveGame");
      // Server will handle forfeit and send matchEnd event
    }
  }

  private resetToLobby(): void {
    this.role = "pending";
    this.mySlot = null;
    this.currentPhase = "idle";
    this.prediction = null;
    this.ballPrediction = null;
    this.opponentPrediction = null;

    this.scene.hideEndScreen();
    this.hideReadyButton();
    this.scene.showWinner("");
    this.scene.setCountdown(0);
    this.scene.setPhase("waiting");
    this.setState(this.createStubState());

    // In mock/browser mode, we can safely reconnect the socket — direct path
    // to Fastify, no proxy layers, works reliably.
    //
    // In Discord iframe mode, socket reconnect through cloudflared + Vite
    // proxy layer is unreliable (WebSocket upgrade on reconnect can silently
    // fail). A full page reload is faster and more robust — it re-runs the
    // entire boot() sequence (DiscordContext.init → patchUrlMappings →
    // socket connect → authorize) from a clean slate. Discord's iframe
    // tolerates self-reload without losing Activity session.
    if (this.ctx.isMock) {
      // Set reconnecting flag BEFORE disconnecting to prevent onDisconnected()
      // from showing the reconnect banner and scheduling another reconnect
      this.isReconnecting = true;

      if (this.socket) {
        this.socket.removeAllListeners();
        this.socket.disconnect();
        this.socket = null;
      }
      this.reconnectSocket().then(() => {
        this.isReconnecting = false;
        this.startLobbyHeartbeat();
      }).catch(() => {
        this.isReconnecting = false;
      });
    } else {
      window.location.reload();
    }
  }

  // ── Pause / Resume ────────────────────────────────────────────────────────

  private onPause(_data: ServerPause): void {
    this.currentPhase = "paused";
    this.scene.setPhase("paused");
    this.scene.hideLeaveButton();
    this.drag?.disable();
  }

  private onResume(): void {
    if (this.currentPhase === "paused") {
      this.currentPhase = "playing";
      this.scene.setPhase("playing");
      this.scene.showLeaveButton();
      this.drag?.enable();
    }
  }

  // ── AFK warning ───────────────────────────────────────────────────────────

  private onAfkWarning(data: ServerAfkWarning): void {
    this.scene.showAfkWarning(data.slot, data.secondsRemaining);
  }

  // ── Reconnection ──────────────────────────────────────────────────────────

  private onDisconnected(): void {
    if (this.role === "spectator") return;
    if (this.isReconnecting) return;

    this.isReconnecting = true;
    this.reconnectAttempts = 0;
    this.showReconnectBanner();
    this.scheduleReconnect();
  }

  private onReconnected(): void {
    this.isReconnecting = false;
    this.reconnectAttempts = 0;
    this.hideReconnectBanner();

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

  }

  private scheduleReconnect(): void {
    const delay = Math.min(
      RECONNECT_BASE_MS * Math.pow(2, this.reconnectAttempts),
      RECONNECT_MAX_MS,
    );
    this.reconnectAttempts++;


    this.reconnectTimer = setTimeout(() => {
      if (this.socket) {
        this.socket.connect();
      }
    }, delay);
  }

  private showReconnectBanner(): void {
    const banner = new Text({
      text: "Reconnecting…",
      style: {
        fontFamily: "'Courier New', Courier, monospace",
        fontSize: 32,
        fill: 0xff_aa_00,
        fontWeight: "bold",
      },
    });
    banner.anchor.set(0.5);
    banner.x = COURT_WIDTH / 2;
    banner.y = COURT_HEIGHT / 2;
    banner.label = "reconnectBanner";
    banner.zIndex = 9999;
    this.scene.getLayers().uiLayer.addChild(banner);
  }

  private hideReconnectBanner(): void {
    const banner = this.scene.getLayers().uiLayer.getChildByLabel("reconnectBanner");
    if (banner) banner.destroy();
  }

  // ── Lobby heartbeat ───────────────────────────────────────────────────────

  private startLobbyHeartbeat(): void {
    this.stopLobbyHeartbeat();
    this.lobbyHeartbeatTimer = setInterval(() => {
      if (this.socket?.connected) {
        this.socket.emit("lobby_heartbeat");
      }
    }, 5000);
  }

  private stopLobbyHeartbeat(): void {
    if (this.lobbyHeartbeatTimer) {
      clearInterval(this.lobbyHeartbeatTimer);
      this.lobbyHeartbeatTimer = null;
    }
  }

  // ── Test hooks ────────────────────────────────────────────────────────────

  private exposeTestHooks(): void {
    window.__test_dropSocket = () => {
      if (this.socket) {
        this.socket.disconnect();
      }
    };
    window.__orchestrator = this;
  }

  // ── Cleanup ───────────────────────────────────────────────────────────────

  destroy(): void {
    this.hideReadyButton();
    this.stopLobbyHeartbeat();
    this.drag?.disable();
    this.app.ticker.remove(this.boundTick);
    this.lifecycle?.destroy();
    this.socket?.disconnect();
    this.spectatorClient?.disconnect();

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
    }
    if (this.paddleInputTimer) {
      clearTimeout(this.paddleInputTimer);
      this.paddleInputTimer = null;
    }
  }

  // ── Public getters for testing ────────────────────────────────────────────

  get currentRole(): ClientRole { return this.role; }
  get playerSlot(): PlayerSlot | null { return this.mySlot; }
  get phase(): string { return this.currentPhase; }
  get state(): MatchState { return this.matchState; }
  get reconnecting(): boolean { return this.isReconnecting; }

  private setState(s: MatchState): void {
    this.matchState = s;
    this.stateRef.current = s;
  }
}
