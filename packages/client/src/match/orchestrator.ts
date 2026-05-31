import {
  BALL_RADIUS,
  COURT_HEIGHT,
  COURT_WIDTH,
  type MatchState,
  PADDLE_HEIGHT,
  PADDLE_WIDTH,
  type PaddleMoveEvent,
  type PlayerSlot,
  type SpectatorState,
} from '@pingpong/shared';
import type {
  AfkWarningMessage as ServerAfkWarning,
  CountdownTickMessage as ServerCountdownTick,
  LobbyUpdateMessage as ServerLobbyUpdate,
  MatchEndMessage as ServerMatchEnd,
  MatchStartMessage as ServerMatchStart,
  PauseMessage as ServerPause,
  ScoreMessage as ServerScoreEvent,
  StateSnapshotMessage as ServerStateSnapshot,
} from '@pingpong/shared';
import { type Application, Container, Graphics, Text } from 'pixi.js';
/**
 * MatchOrchestrator — top-level state machine for the client.
 *
 * Wires together: DiscordContext, Socket.IO, PongScene, PredictionEngine,
 * InterpolationBuffer, LifecycleObserver, DragHandler, SpectatorClient.
 *
 * Server is the source of truth for phase transitions — this orchestrator
 * reacts to server events, never invents phases.
 */
import { type Socket, io } from 'socket.io-client';
import { SOCKET_TRANSPORT } from '../env';
import { type DragController, createDragHandler } from '../input/drag';
import { type BallPredictionEngine, createBallPredictionEngine } from '../net/ballPrediction';
import {
  type OpponentPredictionEngine,
  createOpponentPredictionEngine,
} from '../net/opponentPrediction';
import { type PredictionEngine, createPredictionEngine } from '../net/prediction';
import { SpectatorClient } from '../net/spectator';
import type { PongScene } from '../scene/PongScene';
import type { DiscordContext } from '../sdk/discord';
import { LifecycleObserver } from '../sdk/lifecycle';

// ── Types ───────────────────────────────────────────────────────────────────

export type ClientRole = 'player' | 'spectator' | 'pending';

export interface MatchOrchestratorDeps {
  serverHost: string;
  app: Application;
  scene: PongScene;
  ctx: DiscordContext;
  /** Shared mutable ref — scene's getState reads from this, orchestrator writes to it. */
  stateRef: { current: MatchState };
  /** Mode pre-selected on the landing page; skips the in-game "Choose Mode" overlay. */
  selectedMode?: 'online' | 'ai';
  /** Paddle color chosen on the landing page. */
  userColor: number;
}

declare global {
  interface Window {
    __test_dropSocket?: () => void;
    __orchestrator?: MatchOrchestrator;
  }
}

// ── Constants ───────────────────────────────────────────────────────────────

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30_000;
const POLLING_INPUT_INTERVAL_MS = 16;

/**
 * Dev-only debug log. `import.meta.env.DEV` is statically replaced by Vite,
 * so these calls are dead-code-eliminated from production builds and never
 * spam the Discord client console.
 */
function dlog(...args: unknown[]): void {
  if (import.meta.env.DEV) console.log(...args);
}

// ── Orchestrator ────────────────────────────────────────────────────────────

export class MatchOrchestrator {
  private readonly serverHost: string;
  private readonly app: Application;
  private readonly scene: PongScene;
  private readonly ctx: DiscordContext;
  private readonly stateRef: { current: MatchState };
  private selectedMode?: 'online' | 'ai';
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
  private role: ClientRole = 'pending';
  private mySlot: PlayerSlot | null = null;
  private myUserId: string | null = null;
  private currentPhase = 'idle';
  private matchState!: MatchState;

  // Reconnection
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private isReconnecting = false;

  // Leave game flag (to skip end screen when user initiates leave)
  private isLeaving = false;
  private leaveTimeout: ReturnType<typeof setTimeout> | null = null;

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
      phase: 'waiting',
      ball: {
        pos: { x: COURT_WIDTH / 2, y: COURT_HEIGHT / 2 },
        vel: { x: 0, y: 0 },
        spin: 0,
        radius: BALL_RADIUS,
      },
      paddles: {
        top: {
          pos: { x: COURT_WIDTH / 2, y: PADDLE_HEIGHT / 2 + 40 },
          vel: { x: 0, y: 0 },
          width: PADDLE_WIDTH,
          height: PADDLE_HEIGHT,
        },
        bottom: {
          pos: { x: COURT_WIDTH / 2, y: COURT_HEIGHT - PADDLE_HEIGHT / 2 - 40 },
          vel: { x: 0, y: 0 },
          width: PADDLE_WIDTH,
          height: PADDLE_HEIGHT,
        },
      },
      score: { top: 0, bottom: 0 },
      serverTimeMs: Date.now(),
    };
  }

  // ── Boot sequence ─────────────────────────────────────────────────────────

  async boot(): Promise<void> {
    dlog('[orchestrator] ===== BOOT STARTING =====');

    const params = new URLSearchParams(window.location.search);
    this.myUserId =
      params.get('test_user_id') ?? (this.ctx.isMock ? `mock_user_${Date.now()}` : null);

    dlog('[orchestrator] myUserId:', this.myUserId, 'isMock:', this.ctx.isMock);

    this.scene.setPhase('waiting');

    if (!this.ctx.isMock) {
      dlog('[orchestrator] Authorizing with Discord...');
      await this.ctx.authorize(this.serverHost);
      this.myUserId = this.ctx.userId;
      dlog('[orchestrator] Discord authorized, userId:', this.myUserId);
    }

    dlog('[orchestrator] Creating socket...');
    this.createSocket();
    dlog('[orchestrator] Subscribing to events...');
    this.subscribeToEvents();

    dlog('[orchestrator] Waiting for connection...');
    await this.waitForConnection();
    dlog('[orchestrator] Connected! Socket ID:', this.socket?.id);

    if (this.socket) {
      dlog('[orchestrator] Emitting setPaddleColor:', this.userColor);
      this.socket.emit('setPaddleColor', { color: this.userColor });
    }

    dlog('[orchestrator] Starting lobby heartbeat...');
    this.startLobbyHeartbeat();

    dlog('[orchestrator] Starting lifecycle observer...');
    this.lifecycle = new LifecycleObserver(this.ctx);
    await this.lifecycle.start({
      onPause: () => {
        if (this.role === 'player' && this.socket?.connected) {
          this.socket.emit('pause');
        }
      },
      onResume: () => {
        if (this.role === 'player' && this.socket?.connected) {
          this.socket.emit('resume');
          this.socket.emit('request_resync');
        }
      },
    });

    this.exposeTestHooks();
    dlog('[orchestrator] ===== BOOT COMPLETE =====');
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
    // Discord Activity instance id — stable across all participants in this
    // launch. The server persists it on the match row so history is keyed to
    // the real instance instead of a random per-match UUID.
    auth.instanceId = this.ctx.instanceId;

    const forcePolling = !this.ctx.isMock && SOCKET_TRANSPORT === 'polling';
    this.socket = io(this.serverHost, {
      path: '/ws',
      transports: forcePolling ? ['polling'] : ['websocket', 'polling'],
      upgrade: !forcePolling,
      auth,
      reconnection: false,
    });

    this.socket.on('connect', () => {
      if (this.isReconnecting) {
        this.onReconnected();
      }
    });

    this.socket.on('disconnect', () => {
      this.onDisconnected();
    });
  }

  private async waitForConnection(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Socket connection timeout')), 10000);
      this.socket?.on('connect', () => {
        clearTimeout(timeout);
        resolve();
      });
      this.socket?.on('connect_error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });
  }

  // ── Event subscriptions ───────────────────────────────────────────────────

  private subscribeToEvents(): void {
    if (!this.socket) return;

    // Lobby updates — drives role determination and phase
    this.socket.on('lobbyUpdate', (data: ServerLobbyUpdate) => {
      this.onLobbyUpdate(data);
    });

    // Countdown ticks
    this.socket.on('countdownTick', (data: ServerCountdownTick) => {
      this.onCountdownTick(data);
    });

    // Match started
    this.socket.on('matchStart', (data: ServerMatchStart) => {
      this.onMatchStart(data);
    });

    // State snapshots (playing phase) — server emits "stateSnapshot"
    this.socket.on('stateSnapshot', (data: ServerStateSnapshot) => {
      this.onStateSnapshot(data);
    });

    // Score updates — server emits "scoreEvent"
    this.socket.on('scoreEvent', (data: ServerScoreEvent) => {
      this.onScore(data);
    });

    // Match end
    this.socket.on('matchEnd', (data: ServerMatchEnd) => {
      this.onMatchEnd(data);
    });

    // Pause broadcasts
    this.socket.on('pause', (data: ServerPause) => {
      this.onPause(data);
    });

    // Resume broadcasts
    this.socket.on('resume', () => {
      this.onResume();
    });

    // AFK warnings
    this.socket.on('afkWarning', (data: ServerAfkWarning) => {
      this.onAfkWarning(data);
    });

    // Server errors
    this.socket.on('error', (_data: { code: string; message: string }) => {});
  }

  // ── Role determination ────────────────────────────────────────────────────

  private onLobbyUpdate(data: ServerLobbyUpdate): void {
    dlog('[orchestrator] onLobbyUpdate:', data);
    const { phase, slots, paddleColors } = data;

    // Don't override phase to 'idle' during active match
    if (phase === 'idle' && this.currentPhase === 'playing') {
      dlog('[orchestrator] Ignoring idle phase during active match');
      return;
    }

    this.currentPhase = phase;

    // Detect our slot from slots data
    if (!this.mySlot && this.myUserId) {
      if (slots.top === this.myUserId) {
        this.mySlot = 'top';
        this.scene.setUserSlot('top');
      } else if (slots.bottom === this.myUserId) {
        this.mySlot = 'bottom';
        this.scene.setUserSlot('bottom');
      }
    }

    // Apply opponent's paddle color if available
    if (this.mySlot && this.myUserId && paddleColors) {
      const opponentId = slots.top === this.myUserId ? slots.bottom : slots.top;
      if (opponentId && paddleColors[opponentId] !== undefined) {
        this.scene.setOpponentColor(paddleColors[opponentId]);
      }
    }

    if (this.role === 'pending') {
      const occupiedSlots = [slots.top, slots.bottom].filter(Boolean).length;
      dlog('[orchestrator] role=pending, occupiedSlots:', occupiedSlots, 'phase:', phase);
      if (
        occupiedSlots >= 2 &&
        (phase === 'playing' || phase === 'countdown' || phase === 'paused')
      ) {
        dlog('[orchestrator] becoming spectator');
        this.becomeSpectator();
      } else {
        dlog('[orchestrator] becoming player candidate');
        this.becomePlayerCandidate();
      }
    }

    if (phase === 'lobby') {
      if (this.selectedMode !== 'ai') {
        this.scene.setPhase('waiting');
        this.scene.showLeaveButton();
      }
      this.loadHistory();
      if (this.role === 'player' && !this.mySlot && !this.selectedMode) this.showReadyButton();
    } else if (phase === 'countdown') {
      this.scene.setPhase('countdown');
      this.scene.showLeaveButton();
      this.hideReadyButton();
    } else if (phase === 'playing') {
      this.scene.setPhase('playing');
      this.scene.showLeaveButton();
      this.hideReadyButton();
    }
  }

  private becomePlayerCandidate(): void {
    dlog('[orchestrator] becomePlayerCandidate called, selectedMode:', this.selectedMode);
    this.role = 'player';
    this.scene.setRole('player');
    if (this.selectedMode !== 'ai') {
      this.scene.setPhase('waiting');
    }
    this.loadHistory();

    // Setup prediction engines BEFORE emitting mode, since AI matches
    // start immediately and onMatchStart needs these engines to exist
    this.prediction = createPredictionEngine({
      emit: (msg) => {
        this.emitPaddleInput(msg);
      },
    });
    this.ballPrediction = createBallPredictionEngine();
    this.opponentPrediction = createOpponentPredictionEngine(COURT_WIDTH / 2);
    dlog('[orchestrator] prediction engines created:', {
      prediction: !!this.prediction,
      ballPrediction: !!this.ballPrediction,
      opponentPrediction: !!this.opponentPrediction,
    });

    if (this.selectedMode) {
      dlog('[orchestrator] emitting selected mode:', this.selectedMode);
      this.emitSelectedMode();
    } else {
      dlog('[orchestrator] showing ready button');
      this.showReadyButton();
    }
  }

  private emitPaddleInput(msg: PaddleMoveEvent): void {
    if (!this.socket?.connected) return;

    if (this.ctx.isMock) {
      this.socket.emit('paddleInput', { paddleX: msg.pos.x, seq: msg.seq });
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

    this.socket.emit('paddleInput', { paddleX: msg.pos.x, seq: msg.seq });
    this.lastPaddleInputSentAt = performance.now();
  }

  private becomeSpectator(): void {
    this.role = 'spectator';
    this.scene.setRole('spectator');
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
      !this.ctx.isMock && SOCKET_TRANSPORT !== 'websocket',
    );

    this.spectatorClient.onState((state: SpectatorState) => {
      this.onSpectatorState(state);
    });

    this.spectatorClient.onScore((_score, scorer) => {
      this.scene.flashScore(scorer);
    });

    this.spectatorClient.onEnd((winner) => {
      this.scene.showEndScreen({
        end_reason: 'score',
        winnerName: winner === 'top' ? 'Top Player' : 'Bottom Player',
        loserName: winner === 'top' ? 'Bottom Player' : 'Top Player',
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
        top: {
          pos: { x: state.paddles.top.x, y: PADDLE_HEIGHT / 2 + 40 },
          vel: { x: 0, y: 0 },
          width: PADDLE_WIDTH,
          height: PADDLE_HEIGHT,
        },
        bottom: {
          pos: { x: state.paddles.bottom.x, y: COURT_HEIGHT - PADDLE_HEIGHT / 2 - 40 },
          vel: { x: 0, y: 0 },
          width: PADDLE_WIDTH,
          height: PADDLE_HEIGHT,
        },
      },
      score: state.score,
      serverTimeMs: Date.now(),
    });
  }

  // ── Ready button overlay ──────────────────────────────────────────────────

  private showReadyButton(): void {
    if (this.readyOverlay || this.role !== 'player') return;

    const overlay = new Container();
    overlay.label = 'readyOverlay';

    // Dim background
    const bg = new Graphics()
      .rect(0, 0, COURT_WIDTH, COURT_HEIGHT)
      .fill({ color: 0x00_00_00, alpha: 0.5 });
    overlay.addChild(bg);

    const title = new Text({
      text: 'Choose Mode',
      style: {
        fontFamily: "'Courier New', Courier, monospace",
        fontSize: 34,
        fill: 0xff_ff_ff,
        fontWeight: 'bold',
      },
    });
    title.anchor.set(0.5);
    title.x = COURT_WIDTH / 2;
    title.y = COURT_HEIGHT / 2 - 115;
    overlay.addChild(title);

    const online = this.createMenuButton({
      label: 'Play Online',
      y: COURT_HEIGHT / 2 - 45,
      color: 0x4d_d2_ff,
      onTap: () => {
        if (!this.socket?.connected) return;
        this.socket.emit('readyToggle');
        this.hideReadyButton();
      },
    });
    overlay.addChild(online);

    const ai = this.createMenuButton({
      label: 'Play AI',
      y: COURT_HEIGHT / 2 + 45,
      color: 0x5e_ea_8a,
      onTap: () => {
        if (!this.socket?.connected) return;
        this.socket.emit('playAi');
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

    const bg = new Graphics().roundRect(btnX, opts.y, btnW, btnH, 12).fill(opts.color);
    bg.label = opts.label.replace(/\s+/g, '').toLowerCase();
    bg.eventMode = 'static';
    bg.cursor = 'pointer';
    container.addChild(bg);

    const label = new Text({
      text: opts.label,
      style: {
        fontFamily: "'Courier New', Courier, monospace",
        fontSize: 28,
        fill: 0xff_ff_ff,
        fontWeight: 'bold',
      },
    });
    label.anchor.set(0.5);
    label.x = COURT_WIDTH / 2;
    label.y = opts.y + btnH / 2;
    container.addChild(label);

    bg.on('pointertap', () => opts.onTap(label, bg));

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
    if (this.selectedMode === 'online') {
      this.socket.emit('readyToggle');
    } else {
      this.socket.emit('playAi');
      this.scene.setPhase('countdown');
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
      text: 'Spectating',
      style: {
        fontFamily: "'Courier New', Courier, monospace",
        fontSize: 28,
        fill: 0x88_99_aa,
        fontWeight: 'bold',
      },
    });
    banner.anchor.set(0.5);
    banner.x = COURT_WIDTH / 2;
    banner.y = 60;
    banner.label = 'spectatingBanner';
    this.scene.getLayers().uiLayer.addChild(banner);
  }

  // ── Countdown ─────────────────────────────────────────────────────────────

  private onCountdownTick(data: ServerCountdownTick): void {
    this.currentPhase = 'countdown';
    this.scene.setPhase('countdown');
    this.scene.setCountdown(data.remaining ?? 0);
  }

  // ── Match start ───────────────────────────────────────────────────────────

  private onMatchStart(data: ServerMatchStart): void {
    dlog('[orchestrator] matchStart received:', data);
    this.currentPhase = 'playing';
    this.scene.setPhase('playing');
    this.scene.setCountdown(0);

    // Determine my slot from match start data
    if (this.myUserId) {
      if (data.players.top.id === this.myUserId) {
        this.mySlot = 'top';
        this.scene.setUserSlot('top');
        dlog('[orchestrator] assigned to top slot');
      } else if (data.players.bottom.id === this.myUserId) {
        this.mySlot = 'bottom';
        this.scene.setUserSlot('bottom');
        dlog('[orchestrator] assigned to bottom slot');
      } else {
        console.warn(
          '[orchestrator] myUserId not found in matchStart players:',
          this.myUserId,
          data.players,
        );
      }
    } else {
      console.warn('[orchestrator] myUserId is null when matchStart received');
    }

    // Reset ball prediction to fresh serve
    if (this.ballPrediction) {
      this.ballPrediction.reset({
        pos: { x: COURT_WIDTH / 2, y: COURT_HEIGHT / 2 },
        vel: { x: 0, y: 420 },
        spin: 0,
        radius: BALL_RADIUS,
      });
      dlog('[orchestrator] ball prediction reset');
    }

    // Wire drag handler
    this.setupDragHandler();
    dlog('[orchestrator] drag handler setup');

    // Start Pixi ticker for prediction+interpolation
    this.app.ticker.add(this.boundTick);
    dlog('[orchestrator] ticker added, prediction engines:', {
      prediction: !!this.prediction,
      ballPrediction: !!this.ballPrediction,
      opponentPrediction: !!this.opponentPrediction,
      mySlot: this.mySlot,
    });
  }

  private setupDragHandler(): void {
    if (!this.prediction) return;

    const canvas = this.app.canvas as HTMLCanvasElement;

    this.drag = createDragHandler(
      canvas,
      {
        onDragStart: () => {
          this.prediction?.startDrag();
        },
        onPaddleX: (courtX) => {
          this.prediction?.applyInput(courtX, 0);
        },
        onDragEnd: () => {
          this.prediction?.endDrag();
        },
        onRelease: (velX) => {
          this.prediction?.applyInput(this.prediction?.getPredictedPaddleX(), velX);
        },
      },
      (screenX) => this.scene.screenToCourtX(screenX),
      () => this.prediction?.getPredictedPaddleX() ?? this.scene.screenToCourtX(0),
    );

    this.drag.enable();
  }

  // ── State snapshots ───────────────────────────────────────────────────────

  private onStateSnapshot(data: ServerStateSnapshot): void {
    if (this.role !== 'player') return;

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
      const opponentSlot: PlayerSlot = this.mySlot === 'top' ? 'bottom' : 'top';
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

  private tickCount = 0;

  private onTick(ticker: { deltaMS: number }): void {
    if (this.role !== 'player' || this.currentPhase !== 'playing') {
      if (this.tickCount === 0) {
        dlog('[orchestrator] onTick skipped - role:', this.role, 'phase:', this.currentPhase);
      }
      return;
    }

    if (!this.prediction || !this.opponentPrediction || !this.mySlot || !this.ballPrediction) {
      if (this.tickCount === 0) {
        dlog('[orchestrator] onTick skipped - missing engines:', {
          prediction: !!this.prediction,
          opponentPrediction: !!this.opponentPrediction,
          mySlot: this.mySlot,
          ballPrediction: !!this.ballPrediction,
        });
      }
      return;
    }

    this.tickCount++;
    if (this.tickCount <= 3 || this.tickCount % 60 === 0) {
      dlog(`[orchestrator] onTick #${this.tickCount}, dt=${ticker.deltaMS.toFixed(2)}ms`);
    }

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
    const myPaddleY =
      this.mySlot === 'top' ? PADDLE_HEIGHT / 2 + 40 : COURT_HEIGHT - PADDLE_HEIGHT / 2 - 40;
    const opponentPaddleY =
      this.mySlot === 'top' ? COURT_HEIGHT - PADDLE_HEIGHT / 2 - 40 : PADDLE_HEIGHT / 2 + 40;

    const opponentSlot: PlayerSlot = this.mySlot === 'top' ? 'bottom' : 'top';

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
      const toward = data.side === 'top' ? 'bottom' : 'top';
      this.ballPrediction.reset({
        pos: { x: COURT_WIDTH / 2, y: COURT_HEIGHT / 2 },
        vel: { x: 0, y: toward === 'bottom' ? 420 : -420 },
        spin: 0,
        radius: BALL_RADIUS,
      });
    }
  }

  // ── Match end ─────────────────────────────────────────────────────────────

  private onMatchEnd(data: ServerMatchEnd): void {
    // If user initiated leave, skip showing the end screen and go to lobby
    if (this.isLeaving) {
      this.isLeaving = false;
      if (this.leaveTimeout) {
        clearTimeout(this.leaveTimeout);
        this.leaveTimeout = null;
      }
      this.resetToLobby();
      return;
    }

    this.currentPhase = 'ended';
    this.scene.setPhase('finished');
    this.scene.hideLeaveButton();

    this.scene.hideAfkWarning();

    const winnerName = data.winner?.username ?? 'Unknown';
    const loserName = data.loser?.username ?? 'Unknown';

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
    if (!this.socket || this.role !== 'player') return;

    this.scene.hideEndScreen();
    this.scene.setPhase('waiting');

    // Reset state for new match
    this.currentPhase = 'waiting';
    this.setState(this.createStubState());

    // Server will handle rematch logic (keep players, reset scores, restart countdown)
    this.socket.emit('requestRematch');
  }

  public leaveGame(): void {
    if (!this.socket) return;

    if (this.currentPhase === 'playing' || this.currentPhase === 'paused') {
      // Server accepts leaveGame during 'playing' or 'paused' — it will broadcast
      // matchEnd, and our onMatchEnd handler checks isLeaving to skip the
      // end screen and call resetToLobby().
      this.isLeaving = true;
      this.socket.emit('leaveGame');

      // Fallback: if matchEnd doesn't arrive within 2s, force lobby transition
      if (this.leaveTimeout) clearTimeout(this.leaveTimeout);
      this.leaveTimeout = setTimeout(() => {
        if (this.isLeaving) {
          this.isLeaving = false;
          this.resetToLobby();
        }
      }, 2000);
    } else if (this.currentPhase === 'countdown') {
      // Server ignores leaveGame during countdown (phase !== 'playing'),
      // so we go straight to lobby — no matchEnd will be broadcast.
      this.resetToLobby();
    }
  }

  private resetToLobby(): void {
    this.role = 'pending';
    this.mySlot = null;
    this.currentPhase = 'idle';
    this.selectedMode = undefined;
    this.prediction = null;
    this.ballPrediction = null;
    this.opponentPrediction = null;

    this.scene.hideEndScreen();
    this.hideReadyButton();
    this.scene.showWinner('');
    this.scene.setCountdown(0);
    this.scene.setPhase('waiting');
    this.setState(this.createStubState());

    // Always reload the page to return to the landing page.
    // This ensures a clean state and shows the full landing page experience
    // with color picker and play mode selection, rather than just the
    // in-game "Choose Mode" overlay.
    //
    // In Discord iframe mode, socket reconnect through cloudflared + Vite
    // proxy layer is unreliable (WebSocket upgrade on reconnect can silently
    // fail). A full page reload is faster and more robust — it re-runs the
    // entire boot() sequence (DiscordContext.init → patchUrlMappings →
    // socket connect → authorize) from a clean slate. Discord's iframe
    // tolerates self-reload without losing Activity session.
    window.location.reload();
  }

  // ── Pause / Resume ────────────────────────────────────────────────────────

  private onPause(_data: ServerPause): void {
    this.currentPhase = 'paused';
    this.scene.setPhase('paused');
    this.scene.hideLeaveButton();
    this.drag?.disable();
  }

  private onResume(): void {
    if (this.currentPhase === 'paused') {
      this.currentPhase = 'playing';
      this.scene.setPhase('playing');
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
    if (this.role === 'spectator') return;
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
    const delay = Math.min(RECONNECT_BASE_MS * 2 ** this.reconnectAttempts, RECONNECT_MAX_MS);
    this.reconnectAttempts++;

    this.reconnectTimer = setTimeout(() => {
      if (this.socket) {
        this.socket.connect();
      }
    }, delay);
  }

  private showReconnectBanner(): void {
    const banner = new Text({
      text: 'Reconnecting…',
      style: {
        fontFamily: "'Courier New', Courier, monospace",
        fontSize: 32,
        fill: 0xff_aa_00,
        fontWeight: 'bold',
      },
    });
    banner.anchor.set(0.5);
    banner.x = COURT_WIDTH / 2;
    banner.y = COURT_HEIGHT / 2;
    banner.label = 'reconnectBanner';
    banner.zIndex = 9999;
    this.scene.getLayers().uiLayer.addChild(banner);
  }

  private hideReconnectBanner(): void {
    const banner = this.scene.getLayers().uiLayer.getChildByLabel('reconnectBanner');
    if (banner) banner.destroy();
  }

  // ── Lobby heartbeat ───────────────────────────────────────────────────────

  private startLobbyHeartbeat(): void {
    this.stopLobbyHeartbeat();
    this.lobbyHeartbeatTimer = setInterval(() => {
      if (this.socket?.connected) {
        this.socket.emit('lobby_heartbeat');
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
    if (this.leaveTimeout) {
      clearTimeout(this.leaveTimeout);
      this.leaveTimeout = null;
    }
  }

  // ── Public getters for testing ────────────────────────────────────────────

  get currentRole(): ClientRole {
    return this.role;
  }
  get playerSlot(): PlayerSlot | null {
    return this.mySlot;
  }
  get phase(): string {
    return this.currentPhase;
  }
  get state(): MatchState {
    return this.matchState;
  }
  get reconnecting(): boolean {
    return this.isReconnecting;
  }

  private setState(s: MatchState): void {
    this.matchState = s;
    this.stateRef.current = s;
  }
}
