import {
  COURT_HEIGHT,
  COURT_WIDTH,
  type MatchPhase,
  type MatchState,
  PADDLE_HEIGHT,
  type PlayerSlot,
} from '@pingpong/shared';
/**
 * PongScene — orchestrator for the full visual scene.
 *
 * Constructed with a Pixi Application and a state reader function.
 * Builds bgLayer → playLayer → uiLayer, hooks into the app ticker,
 * handles letterbox resize, and exposes a clean public API for
 * game-loop integration (T17) and test fixtures (?scene_test=1).
 *
 * All dimensions/colors from @pingpong/shared — zero magic numbers.
 */
import { type Application, Container, type Graphics } from 'pixi.js';
import { type BallNode, createBall, updateBall } from './Ball';
import { buildCourt } from './Court';
import { type EndScreenData, type EndScreenNode, buildEndScreen } from './EndScreen';
import { type HistoryWidgetNode, buildHistoryWidget } from './HistoryWidget';
import {
  type HudNode,
  buildHud,
  flashScore,
  hideAfk,
  setAfkPulse,
  setBanner,
  setRally,
  setScores,
  setSpeedGauge,
  showAfk,
} from './Hud';
import { PADDLE_COLOR_BOTTOM, PADDLE_COLOR_TOP, createPaddle, recolorPaddle } from './Paddle';

/** Internal role tracking. */
type Role = 'player' | 'spectator';

/** Status banner text per match phase. */
const PHASE_BANNERS: Partial<Record<MatchPhase, string>> = {
  waiting: 'Waiting for opponent…',
  paused: 'Paused…',
};

/**
 * PongScene — main entry point.
 *
 * @param app  Pixi v8 Application (already init'd via createApp)
 * @param getState  Reader returning the latest MatchState snapshot
 * @param paddleColor  Optional hex color for the bottom (player) paddle
 */
export class PongScene {
  private readonly app: Application;
  private readonly getState: () => MatchState;
  private readonly userColor: number;

  // Layers (back → front)
  private readonly bgLayer: Container;
  private readonly playLayer: Container;
  private readonly uiLayer: Container;

  // Root container for letterbox scaling
  private readonly root: Container;

  // Play elements
  private readonly paddleTop: Container;
  private readonly paddleBottom: Container;
  private readonly ballNode: BallNode;
  private readonly hud: HudNode;
  private readonly historyWidget: HistoryWidgetNode;

  // Internal state
  private role: Role = 'player';
  private rally = 0;
  private flashSide: 'top' | 'bottom' | null = null;
  private flashStart = 0;
  private countdownN = 0;
  private winnerName = '';
  private endScreen: EndScreenNode | null = null;
  private afkSlot: PlayerSlot | null = null;
  private afkStartTime = 0;
  private userSlot: PlayerSlot = 'bottom';

  // Resize handler ref for cleanup
  private readonly onResize: () => void;

  constructor(app: Application, getState: () => MatchState, paddleColor?: number) {
    this.app = app;
    this.getState = getState;
    this.userColor = paddleColor ?? PADDLE_COLOR_BOTTOM;

    // ── Build layers ──────────────────────────────────────────
    this.bgLayer = buildCourt();
    this.playLayer = new Container();
    this.playLayer.label = 'playLayer';
    this.hud = buildHud();
    this.uiLayer = this.hud.layer;
    this.historyWidget = buildHistoryWidget();
    this.historyWidget.setVisible(false);
    this.uiLayer.addChild(this.historyWidget.container);

    // ── Paddles ───────────────────────────────────────────────
    const pTop = createPaddle('paddleTop', PADDLE_COLOR_TOP);
    pTop.x = COURT_WIDTH / 2;
    pTop.y = PADDLE_HEIGHT / 2 + 40;
    this.paddleTop = pTop;
    this.playLayer.addChild(pTop);

    const pBot = createPaddle('paddleBottom', this.userColor);
    pBot.x = COURT_WIDTH / 2;
    pBot.y = COURT_HEIGHT - PADDLE_HEIGHT / 2 - 40;
    this.paddleBottom = pBot;
    this.playLayer.addChild(pBot);

    // ── Ball ──────────────────────────────────────────────────
    this.ballNode = createBall();
    this.playLayer.addChild(this.ballNode.container);

    // ── Root container ────────────────────────────────────────
    this.root = new Container();
    this.root.label = 'root';
    this.root.addChild(this.bgLayer);
    this.root.addChild(this.playLayer);
    this.root.addChild(this.uiLayer);
    this.app.stage.addChild(this.root);

    // ── Letterbox resize ──────────────────────────────────────
    this.onResize = () => this.applyLetterbox();
    window.addEventListener('resize', this.onResize);
    this.applyLetterbox();

    // ── Ticker ────────────────────────────────────────────────
    this.app.ticker.add(this.tick, this);

    // ── Initial UI state ─────────────────────────────────────
    this.showLeaveButton();
  }

  // ── Render loop ─────────────────────────────────────────────────────────

  private tick(ticker: { deltaMS: number }): void {
    const state = this.getState();

    // Paddles
    this.paddleTop.x = state.paddles.top.pos.x;
    this.paddleTop.y = state.paddles.top.pos.y;
    this.paddleBottom.x = state.paddles.bottom.pos.x;
    this.paddleBottom.y = state.paddles.bottom.pos.y;

    // Spectator dim
    if (this.role === 'spectator') {
      this.paddleTop.alpha = 0.5;
      this.paddleBottom.alpha = 0.5;
    } else {
      this.paddleTop.alpha = 1;
      this.paddleBottom.alpha = 1;
    }

    // Ball
    updateBall(this.ballNode, state.ball.pos.x, state.ball.pos.y);

    // HUD
    setScores(this.hud, state.score.top, state.score.bottom);
    setRally(this.hud, this.rally);
    const ballSpeed = Math.hypot(state.ball.vel.x, state.ball.vel.y);
    setSpeedGauge(this.hud, ballSpeed);

    // Phase banner
    const banner = PHASE_BANNERS[state.phase] ?? '';
    if (this.countdownN > 0) {
      setBanner(this.hud, String(this.countdownN));
    } else if (this.winnerName) {
      setBanner(this.hud, `${this.winnerName} wins!`);
    } else {
      setBanner(this.hud, banner);
    }

    // Score flash
    if (this.flashSide) {
      const elapsed = performance.now() - this.flashStart;
      flashScore(this.hud, this.flashSide, elapsed);
      if (elapsed > 300) {
        this.flashSide = null;
        this.hud.scoreTop.scale.set(1);
        this.hud.scoreBottom.scale.set(1);
      }
    }

    // End screen update
    if (this.endScreen) {
      this.endScreen.update(ticker.deltaMS);
    }

    // AFK pulse — 1 Hz sine wave
    if (this.afkSlot) {
      const elapsed = performance.now() - this.afkStartTime;
      const alpha = 0.35 + 0.35 * Math.sin((elapsed * 2 * Math.PI) / 1000);
      setAfkPulse(this.hud, alpha);
    }
  }

  // ── Letterbox ───────────────────────────────────────────────────────────

  private applyLetterbox(): void {
    const vw = this.app.screen.width;
    const vh = this.app.screen.height;
    this.currentScale = Math.min(vw / COURT_WIDTH, vh / COURT_HEIGHT);
    this.root.scale.set(this.currentScale);
    this.letterboxX = (vw - COURT_WIDTH * this.currentScale) / 2;
    this.root.x = this.letterboxX;
    this.root.y = (vh - COURT_HEIGHT * this.currentScale) / 2;
  }

  // ── Coordinate transform ──────────────────────────────────────────────────

  private currentScale = 1;
  private letterboxX = 0;

  /** Convert screen X (clientX) to court X, accounting for letterbox scaling. */
  public screenToCourtX(screenX: number): number {
    const canvasRect = this.app.canvas.getBoundingClientRect();
    const canvasX = screenX - canvasRect.left;
    return (canvasX - this.letterboxX) / this.currentScale;
  }

  // ── Public API ──────────────────────────────────────────────────────────

  /** Set viewer role. Spectator paddles are dimmed. */
  setRole(role: Role): void {
    this.role = role;
  }

  /**
   * Swap paddle colors when user is assigned to top slot (online match).
   * User paddle = userColor, opponent paddle = red.
   */
  setUserSlot(slot: PlayerSlot): void {
    if (this.userSlot === slot) return;
    this.userSlot = slot;

    if (slot === 'top') {
      // User is at top: top paddle gets user color, bottom gets red
      recolorPaddle(this.paddleTop as Graphics, this.userColor);
      recolorPaddle(this.paddleBottom as Graphics, PADDLE_COLOR_TOP);
    } else {
      // User is at bottom: bottom paddle gets user color, top gets red
      recolorPaddle(this.paddleBottom as Graphics, this.userColor);
      recolorPaddle(this.paddleTop as Graphics, PADDLE_COLOR_TOP);
    }
  }

  /**
   * Set the opponent's paddle color based on their chosen color.
   * Updates the paddle that is NOT the user's paddle.
   */
  setOpponentColor(color: number): void {
    if (this.userSlot === 'top') {
      recolorPaddle(this.paddleBottom as Graphics, color);
    } else {
      recolorPaddle(this.paddleTop as Graphics, color);
    }
  }

  setPhase(phase: MatchPhase): void {
    const isLobby = phase === 'waiting';
    this.historyWidget.setVisible(isLobby);
  }

  /** Set pre-serve countdown number (3, 2, 1). Pass 0 to clear. */
  setCountdown(n: number): void {
    this.countdownN = n;
  }

  /** Set rally count (consecutive hits without score). */
  setRallyCount(n: number): void {
    this.rally = n;
  }

  /** Trigger a score flash on the given side. */
  flashScore(side: 'top' | 'bottom'): void {
    this.flashSide = side;
    this.flashStart = performance.now();
  }

  /** Show winner banner. */
  showWinner(name: string): void {
    this.winnerName = name;
  }

  showEndScreen(data: EndScreenData): void {
    this.hideEndScreen();
    this.endScreen = buildEndScreen(data);
    this.uiLayer.addChild(this.endScreen.container);
  }

  hideEndScreen(): void {
    if (this.endScreen) {
      this.uiLayer.removeChild(this.endScreen.container);
      this.endScreen.container.destroy({ children: true });
      this.endScreen = null;
    }
  }

  /** Show AFK warning overlay on the given slot's side with countdown seconds. */
  showAfkWarning(slot: PlayerSlot, secondsRemaining: number): void {
    this.afkSlot = slot;
    this.afkStartTime = performance.now();
    showAfk(this.hud, slot, secondsRemaining);
  }

  /** Hide AFK warning overlay. */
  hideAfkWarning(): void {
    hideAfk(this.hud);
  }

  /** Wire the leave button click handler. */
  setLeaveButtonCallback(callback: () => void): void {
    this.hud.leaveButton.eventMode = 'static';
    this.hud.leaveButton.on('pointertap', callback);
  }

  /** Show the leave button (during gameplay). */
  showLeaveButton(): void {
    this.hud.leaveButton.alpha = 1;
    this.hud.leaveButton.eventMode = 'static';
  }

  /** Hide the leave button (during non-gameplay phases). */
  hideLeaveButton(): void {
    this.hud.leaveButton.alpha = 0;
    this.hud.leaveButton.eventMode = 'none';
  }

  /** Wire the pause menu Continue and Exit buttons. */
  setPauseMenuCallbacks(onContinue: () => void, onExit: () => void): void {
    this.hud.continueBtn.on('pointertap', onContinue);
    this.hud.exitBtn.on('pointertap', onExit);
  }

  /** Show the pause menu overlay. */
  showPauseMenu(): void {
    this.hud.pauseMenu.visible = true;
  }

  /** Hide the pause menu overlay. */
  hidePauseMenu(): void {
    this.hud.pauseMenu.visible = false;
  }

  /** Check if pause menu is currently visible. */
  isPaused(): boolean {
    return this.hud.pauseMenu.visible;
  }

  loadMatchHistory(accessToken: string, userId: string): Promise<void> {
    return this.historyWidget.load(accessToken, userId);
  }

  /** Expose layers for test assertions. */
  getLayers(): { bgLayer: Container; playLayer: Container; uiLayer: Container } {
    return { bgLayer: this.bgLayer, playLayer: this.playLayer, uiLayer: this.uiLayer };
  }

  /** Clean up: remove ticker, resize listener, destroy stage. */
  destroy(): void {
    this.app.ticker.remove(this.tick, this);
    window.removeEventListener('resize', this.onResize);
    this.root.destroy({ children: true });
  }
}
