import {
  type AiDifficulty,
  COURT_HEIGHT,
  COURT_WIDTH,
  PADDLE_HEIGHT,
  PADDLE_WIDTH,
} from '@pingpong/shared';
import { type Application, Container, Graphics, Text } from 'pixi.js';
import { sound } from '../audio/sound';

export const PADDLE_COLORS = [
  { color: 0x4dd2ff, name: 'Cyan' },
  { color: 0xff7a7a, name: 'Rose' },
  { color: 0x5eea8a, name: 'Lime' },
  { color: 0xffd700, name: 'Gold' },
  { color: 0xc77dff, name: 'Violet' },
] as const;

const FONT = "'Courier New', Courier, monospace";
const BG_DARK = 0x0b0f17;
const TEXT_WHITE = 0xffffff;
const TEXT_DIM = 0x8899aa;
const TEXT_SUBTLE = 0x556677;
const ACCENT_BLUE = 0x4dd2ff;
const ACCENT_GREEN = 0x5eea8a;

export interface LandingPageCallbacks {
  onPlayOnline: (color: number) => void;
  onPlayAi: (color: number, difficulty: AiDifficulty) => void;
}

const AI_DIFFICULTIES: ReadonlyArray<{ value: AiDifficulty; label: string }> = [
  { value: 'easy', label: 'EASY' },
  { value: 'medium', label: 'MEDIUM' },
  { value: 'hard', label: 'HARD' },
];

export class LandingPage {
  private readonly app: Application;
  private readonly root: Container;
  private readonly container: Container;
  private selectedColor: number = PADDLE_COLORS[0]?.color;
  private selectedIndex = 0;
  private selectedDifficulty: AiDifficulty = 'medium';
  private readonly difficultyChips: { bg: Graphics; label: Text; value: AiDifficulty }[] = [];
  private readonly swatches: { bg: Graphics; ring: Graphics }[] = [];
  private readonly previewPaddle: Graphics;
  private readonly previewGlow: Graphics;
  private readonly previewBall: Graphics;
  private readonly onResize: () => void;
  private animElapsed = 0;
  private readonly tickFn: (t: { deltaMS: number }) => void;
  private destroyed = false;

  constructor(app: Application, callbacks: LandingPageCallbacks) {
    this.app = app;
    this.root = new Container();
    this.container = new Container();
    this.container.label = 'landingPage';

    this.buildBackdrop();
    this.buildTitle();
    this.buildColorPicker();
    const preview = this.buildCourtPreview();
    this.previewPaddle = preview.paddle;
    this.previewGlow = preview.glow;
    this.previewBall = preview.ball;
    this.buildDifficultySelector();
    this.buildPlayButtons(callbacks);
    this.buildMuteToggle();

    this.root.addChild(this.container);
    app.stage.addChild(this.root);

    this.onResize = () => this.applyLetterbox();
    window.addEventListener('resize', this.onResize);
    this.applyLetterbox();

    this.tickFn = (t) => this.onTick(t);
    app.ticker.add(this.tickFn);
    this.updateSelection(0);
  }

  private applyLetterbox(): void {
    const vw = this.app.screen.width;
    const vh = this.app.screen.height;
    const scale = Math.min(vw / COURT_WIDTH, vh / COURT_HEIGHT);
    this.root.scale.set(scale);
    this.root.x = (vw - COURT_WIDTH * scale) / 2;
    this.root.y = (vh - COURT_HEIGHT * scale) / 2;
  }

  private onTick(t: { deltaMS: number }): void {
    if (this.destroyed) return;
    this.animElapsed += t.deltaMS;

    // Ball bouncing in preview court
    const period = 2200;
    const phase = (this.animElapsed % period) / period;
    const ballY = Math.sin(phase * Math.PI * 2) * 40;
    this.previewBall.y = 100 + ballY;

    // Paddle subtle sway
    const sway = Math.sin(this.animElapsed / 600) * 6;
    this.previewPaddle.x = COURT_WIDTH / 2 + sway;

    // Selected ring pulse
    const ring = this.swatches[this.selectedIndex]?.ring;
    if (ring) {
      const pulse = 0.5 + 0.5 * Math.sin(this.animElapsed / 400);
      ring.alpha = 0.4 + pulse * 0.6;
    }
  }

  // ── Backdrop ────────────────────────────────────────────────────────────

  private buildBackdrop(): void {
    const bg = new Graphics().rect(0, 0, COURT_WIDTH, COURT_HEIGHT).fill(BG_DARK);
    this.container.addChild(bg);

    // Top radial glow with mask to prevent overflow
    const glow = new Graphics();
    for (let i = 8; i > 0; i--) {
      const r = 80 + i * 25;
      const alpha = (8 - i) * 0.04;
      glow.circle(COURT_WIDTH / 2, 155, r).fill({ color: ACCENT_BLUE, alpha });
    }

    const glowMask = new Graphics().rect(0, 0, COURT_WIDTH, COURT_HEIGHT).fill(0xffffff);
    glow.mask = glowMask;

    this.container.addChild(glowMask);
    this.container.addChild(glow);

    // Faint grid
    const grid = new Graphics();
    for (let x = 0; x <= COURT_WIDTH; x += 40) {
      grid.moveTo(x, 0).lineTo(x, COURT_HEIGHT).stroke({ color: 0xffffff, alpha: 0.02, width: 1 });
    }
    for (let y = 0; y <= COURT_HEIGHT; y += 40) {
      grid.moveTo(0, y).lineTo(COURT_WIDTH, y).stroke({ color: 0xffffff, alpha: 0.02, width: 1 });
    }
    this.container.addChild(grid);
  }

  // ── Title ───────────────────────────────────────────────────────────────

  private buildTitle(): void {
    // Shadow layer
    const shadow = new Text({
      text: 'PING',
      style: {
        fontFamily: FONT,
        fontSize: 96,
        fill: 0x000000,
        fontWeight: '900',
        letterSpacing: 4,
      },
    });
    shadow.anchor.set(0.5);
    shadow.x = COURT_WIDTH / 2 + 4;
    shadow.y = 114;
    shadow.alpha = 0.5;
    this.container.addChild(shadow);

    const title = new Text({
      text: 'PING',
      style: {
        fontFamily: FONT,
        fontSize: 96,
        fill: ACCENT_BLUE,
        fontWeight: '900',
        letterSpacing: 4,
      },
    });
    title.anchor.set(0.5);
    title.x = COURT_WIDTH / 2;
    title.y = 110;
    this.container.addChild(title);

    const pong = new Text({
      text: 'PONG',
      style: {
        fontFamily: FONT,
        fontSize: 96,
        fill: TEXT_WHITE,
        fontWeight: '900',
        letterSpacing: 4,
      },
    });
    pong.anchor.set(0.5);
    pong.x = COURT_WIDTH / 2;
    pong.y = 200;
    this.container.addChild(pong);

    // Divider with dots
    const divider = new Graphics();
    const divY = 260;
    divider
      .circle(COURT_WIDTH / 2 - 30, divY, 3)
      .fill(ACCENT_BLUE)
      .circle(COURT_WIDTH / 2, divY, 4)
      .fill(TEXT_WHITE)
      .circle(COURT_WIDTH / 2 + 30, divY, 3)
      .fill(ACCENT_BLUE);
    this.container.addChild(divider);
  }

  // ── Color picker ────────────────────────────────────────────────────────

  private buildColorPicker(): void {
    const header = new Text({
      text: 'PICK YOUR PADDLE',
      style: {
        fontFamily: FONT,
        fontSize: 18,
        fill: TEXT_DIM,
        letterSpacing: 4,
        fontWeight: 'bold',
      },
    });
    header.anchor.set(0.5);
    header.x = COURT_WIDTH / 2;
    header.y = 470;
    this.container.addChild(header);

    // Paddle-shaped swatches (horizontal, like real paddles)
    const swatchW = 110;
    const swatchH = 28;
    const gap = 14;
    const total = PADDLE_COLORS.length * swatchW + (PADDLE_COLORS.length - 1) * gap;
    const startX = (COURT_WIDTH - total) / 2;
    const y = 510;

    PADDLE_COLORS.forEach((opt, i) => {
      const cx = startX + i * (swatchW + gap);
      const hitBg = new Graphics()
        .roundRect(cx, y, swatchW, swatchH, 8)
        .fill({ color: 0xffffff, alpha: 0.01 });
      hitBg.eventMode = 'static';
      hitBg.cursor = 'pointer';
      hitBg.on('pointertap', () => this.updateSelection(i));
      this.container.addChild(hitBg);

      const ring = new Graphics()
        .roundRect(cx - 3, y - 3, swatchW + 6, swatchH + 6, 10)
        .stroke({ color: opt.color, width: 2 });
      ring.alpha = 0;
      this.container.addChild(ring);

      const bg = new Graphics().roundRect(cx, y, swatchW, swatchH, 8).fill(opt.color);
      bg.alpha = 0.5;
      this.container.addChild(bg);

      this.swatches.push({ bg, ring });
    });
  }

  private updateSelection(index: number): void {
    this.selectedIndex = index;
    const paddleColor = PADDLE_COLORS[index];
    if (paddleColor) {
      this.selectedColor = paddleColor.color;
    }

    this.swatches.forEach((s, i) => {
      const selected = i === index;
      s.bg.alpha = selected ? 1 : 0.35;
      s.ring.alpha = selected ? 1 : 0;
      s.bg.scale.set(selected ? 1.05 : 1);
      s.ring.scale.set(selected ? 1.05 : 1);
    });

    // Update preview paddle
    this.previewPaddle
      .clear()
      .roundRect(-PADDLE_WIDTH / 2, -PADDLE_HEIGHT / 2, PADDLE_WIDTH, PADDLE_HEIGHT, 6)
      .fill(this.selectedColor);

    this.previewGlow.clear();
    for (let i = 5; i > 0; i--) {
      this.previewGlow
        .roundRect(
          -PADDLE_WIDTH / 2 - i * 3,
          -PADDLE_HEIGHT / 2 - i * 3,
          PADDLE_WIDTH + i * 6,
          PADDLE_HEIGHT + i * 6,
          6 + i,
        )
        .fill({ color: this.selectedColor, alpha: (5 - i) * 0.08 });
    }
  }

  // ── Court preview ───────────────────────────────────────────────────────

  private buildCourtPreview(): { paddle: Graphics; glow: Graphics; ball: Graphics } {
    const cx = COURT_WIDTH / 2;
    const cy = 560;
    const courtW = 340;
    const courtH = 260;

    // Center dashed line (no opaque box — backdrop shows through)
    const dashed = new Graphics();
    for (let x = cx - courtW / 2 + 20; x < cx + courtW / 2 - 20; x += 14) {
      dashed.rect(x, cy - 1, 8, 2).fill({ color: 0xffffff, alpha: 0.15 });
    }
    this.container.addChild(dashed);

    // Glow (behind paddle)
    const glow = new Graphics();
    glow.x = cx;
    glow.y = cy + courtH / 2 - 30;
    this.container.addChild(glow);

    // Player paddle (bottom, user color)
    const paddle = new Graphics();
    paddle.x = cx;
    paddle.y = cy + courtH / 2 - 30;
    this.container.addChild(paddle);

    // Bouncing ball
    const ball = new Graphics().circle(0, 0, 7).fill(TEXT_WHITE);
    ball.x = cx;
    ball.y = cy;
    this.container.addChild(ball);

    return { paddle, glow, ball };
  }

  // ── Difficulty selector (AI bot) ──────────────────────────────────────────

  private buildDifficultySelector(): void {
    const cy = 940;

    const header = new Text({
      text: 'AI DIFFICULTY',
      style: {
        fontFamily: FONT,
        fontSize: 14,
        fill: TEXT_DIM,
        letterSpacing: 3,
        fontWeight: 'bold',
      },
    });
    header.anchor.set(0.5);
    header.x = COURT_WIDTH / 2;
    header.y = cy;
    this.container.addChild(header);

    const chipW = 96;
    const chipH = 32;
    const gap = 12;
    const total = AI_DIFFICULTIES.length * chipW + (AI_DIFFICULTIES.length - 1) * gap;
    const startX = (COURT_WIDTH - total) / 2;
    const y = cy + 20;

    AI_DIFFICULTIES.forEach((d, i) => {
      const cx = startX + i * (chipW + gap);
      const bg = new Graphics().roundRect(cx, y, chipW, chipH, 8).fill(ACCENT_GREEN);
      bg.eventMode = 'static';
      bg.cursor = 'pointer';
      bg.on('pointertap', () => this.updateDifficulty(d.value));
      this.container.addChild(bg);

      const label = new Text({
        text: d.label,
        style: {
          fontFamily: FONT,
          fontSize: 14,
          fill: BG_DARK,
          fontWeight: 'bold',
          letterSpacing: 1,
        },
      });
      label.anchor.set(0.5);
      label.x = cx + chipW / 2;
      label.y = y + chipH / 2;
      this.container.addChild(label);

      this.difficultyChips.push({ bg, label, value: d.value });
    });

    this.updateDifficulty(this.selectedDifficulty);
  }

  private updateDifficulty(value: AiDifficulty): void {
    this.selectedDifficulty = value;
    for (const chip of this.difficultyChips) {
      const selected = chip.value === value;
      chip.bg.alpha = selected ? 1 : 0.3;
    }
  }

  // ── Mute toggle ───────────────────────────────────────────────────────────

  private buildMuteToggle(): void {
    const size = 40;
    const x = COURT_WIDTH - size - 20;
    const y = 20;

    const bg = new Graphics().roundRect(x, y, size, size, 8).fill({ color: 0xffffff, alpha: 0.06 });
    bg.eventMode = 'static';
    bg.cursor = 'pointer';
    this.container.addChild(bg);

    const icon = new Text({
      text: sound.isMuted() ? '🔇' : '🔊',
      style: { fontFamily: FONT, fontSize: 20, fill: TEXT_WHITE },
    });
    icon.anchor.set(0.5);
    icon.x = x + size / 2;
    icon.y = y + size / 2;
    this.container.addChild(icon);

    bg.on('pointertap', () => {
      // Tapping is a user gesture — safe to unlock the AudioContext here too.
      sound.unlock();
      const muted = sound.toggleMuted();
      icon.text = muted ? '🔇' : '🔊';
    });
  }

  // ── Play buttons ────────────────────────────────────────────────────────

  private buildPlayButtons(callbacks: LandingPageCallbacks): void {
    const btnW = 320;
    const btnH = 64;
    const y1 = 1010;
    const y2 = 1090;

    this.container.addChild(
      this.buildButton({
        label: 'PLAY ONLINE',
        sublabel: 'Match with other players',
        y: y1,
        w: btnW,
        h: btnH,
        color: ACCENT_BLUE,
        onTap: () => callbacks.onPlayOnline(this.selectedColor),
      }),
    );

    this.container.addChild(
      this.buildButton({
        label: 'PLAY VS AI',
        sublabel: 'Practice against the bot',
        y: y2,
        w: btnW,
        h: btnH,
        color: ACCENT_GREEN,
        onTap: () => callbacks.onPlayAi(this.selectedColor, this.selectedDifficulty),
      }),
    );

    // Footer hint
    const hint = new Text({
      text: 'First to 11 points wins',
      style: { fontFamily: FONT, fontSize: 13, fill: TEXT_SUBTLE, letterSpacing: 2 },
    });
    hint.anchor.set(0.5);
    hint.x = COURT_WIDTH / 2;
    hint.y = 1180;
    this.container.addChild(hint);
  }

  private buildButton(opts: {
    label: string;
    sublabel: string;
    y: number;
    w: number;
    h: number;
    color: number;
    onTap: () => void;
  }): Container {
    const btn = new Container();
    const bx = (COURT_WIDTH - opts.w) / 2;

    const bg = new Graphics().roundRect(bx, opts.y, opts.w, opts.h, 14).fill(opts.color);
    bg.eventMode = 'static';
    bg.cursor = 'pointer';
    bg.on('pointertap', opts.onTap);
    btn.addChild(bg);

    const label = new Text({
      text: opts.label,
      style: {
        fontFamily: FONT,
        fontSize: 22,
        fill: BG_DARK,
        fontWeight: '900',
        letterSpacing: 3,
      },
    });
    label.anchor.set(0.5);
    label.x = COURT_WIDTH / 2;
    label.y = opts.y + opts.h / 2 - 8;
    btn.addChild(label);

    const sub = new Text({
      text: opts.sublabel,
      style: {
        fontFamily: FONT,
        fontSize: 11,
        fill: BG_DARK,
        letterSpacing: 2,
      },
    });
    sub.alpha = 0.7;
    sub.anchor.set(0.5);
    sub.x = COURT_WIDTH / 2;
    sub.y = opts.y + opts.h / 2 + 12;
    btn.addChild(sub);

    return btn;
  }

  // ── Cleanup ─────────────────────────────────────────────────────────────

  destroy(): void {
    this.destroyed = true;
    this.app.ticker.remove(this.tickFn);
    window.removeEventListener('resize', this.onResize);
    this.root.destroy({ children: true });
  }

  getSelectedColor(): number {
    return this.selectedColor;
  }
}
