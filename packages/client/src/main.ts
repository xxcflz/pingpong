import type { MatchState } from '@pingpong/shared';
import {
  BALL_RADIUS,
  COURT_HEIGHT,
  COURT_WIDTH,
  PADDLE_HEIGHT,
  PADDLE_WIDTH,
} from '@pingpong/shared';
import type { Application, Container } from 'pixi.js';
import { SERVER_HOST } from './env';
import { MatchOrchestrator } from './match/orchestrator';
import { createApp } from './render/app';
import { LandingPage } from './scene/LandingPage';
import { PongScene } from './scene/PongScene';
/**
 * Client entry point — bootstraps MatchOrchestrator.
 *
 * Flow: DiscordContext.init() → createApp() → PongScene → MatchOrchestrator.boot()
 *
 * Test modes (via URL query params):
 *   ?frame_id=mock        — mock Discord SDK (no real Discord connection)
 *   ?test_user_id=<id>    — test user identity for TEST_AUTH_BYPASS mode
 */
import { DiscordContext } from './sdk/discord';

// Module-level refs for Vite HMR cleanup — prevents duplicate Pixi instances
// when source files are edited and hot-reloaded during development.
let hmrApp: Application | null = null;
let hmrScene: PongScene | null = null;
let hmrOrchestrator: MatchOrchestrator | null = null;

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    hmrOrchestrator?.destroy();
    hmrOrchestrator = null;
    hmrScene?.destroy();
    hmrScene = null;
    hmrApp?.destroy();
    hmrApp = null;
  });
}

declare global {
  interface Window {
    __pong_scene_ready?: boolean;
    __pong_layers?: {
      bgLayer: Container;
      playLayer: Container;
      uiLayer: Container;
    };
    __pong_scene?: PongScene;
    __orchestrator?: MatchOrchestrator;
  }
}

function createStubState(): MatchState {
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

async function main(): Promise<void> {
  const ctx = await DiscordContext.init(undefined, SERVER_HOST);

  const canvas = document.querySelector<HTMLCanvasElement>('#game');
  if (!canvas) throw new Error('Missing #game canvas element');
  hmrApp = await createApp(canvas);
  const app = hmrApp;

  const params = new URLSearchParams(window.location.search);
  const isTestMode =
    params.has('test_user_id') || params.has('test_input') || params.has('scene_test');

  const selection = isTestMode
    ? { color: 0x4dd2ff, mode: 'online' as const }
    : await new Promise<{ color: number; mode: 'online' | 'ai' }>((resolve) => {
        const landing = new LandingPage(app, {
          onPlayOnline: (color) => {
            landing.destroy();
            resolve({ color, mode: 'online' });
          },
          onPlayAi: (color) => {
            landing.destroy();
            resolve({ color, mode: 'ai' });
          },
        });
      });

  const stateRef: { current: MatchState } = { current: createStubState() };
  hmrScene = new PongScene(hmrApp, () => stateRef.current, selection.color);

  window.__pong_scene_ready = true;
  window.__pong_layers = hmrScene.getLayers();
  window.__pong_scene = hmrScene;

  hmrOrchestrator = new MatchOrchestrator({
    serverHost: SERVER_HOST,
    app: hmrApp,
    scene: hmrScene,
    ctx,
    stateRef,
    selectedMode: selection.mode,
    userColor: selection.color,
  });

  // Wire up leave button to show pause menu
  hmrScene.setLeaveButtonCallback(() => {
    hmrScene?.showPauseMenu();
  });

  // Wire up pause menu callbacks
  hmrScene.setPauseMenuCallbacks(
    () => {
      // Continue button: hide pause menu
      hmrScene?.hidePauseMenu();
    },
    () => {
      // Exit to lobby button: leave game and hide menu
      hmrOrchestrator?.leaveGame();
      hmrScene?.hidePauseMenu();
    },
  );

  await hmrOrchestrator.boot();
}

main().catch((err) => {
  console.error('Failed to start game:', err);
});
