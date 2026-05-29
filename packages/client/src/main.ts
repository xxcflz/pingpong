/**
 * Client entry point — bootstraps MatchOrchestrator.
 *
 * Flow: DiscordContext.init() → createApp() → PongScene → MatchOrchestrator.boot()
 *
 * Test modes (via URL query params):
 *   ?frame_id=mock        — mock Discord SDK (no real Discord connection)
 *   ?test_user_id=<id>    — test user identity for TEST_AUTH_BYPASS mode
 */
import { DiscordContext } from "./sdk/discord";
import { createApp } from "./render/app";
import { PongScene } from "./scene/PongScene";
import { MatchOrchestrator } from "./match/orchestrator";
import { LandingPage } from "./scene/LandingPage";
import { SERVER_HOST } from "./env";
import type { MatchState } from "@pingpong/shared";
import { BALL_RADIUS, COURT_WIDTH, COURT_HEIGHT, PADDLE_WIDTH, PADDLE_HEIGHT } from "@pingpong/shared";
import type { Container } from "pixi.js";

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

async function main(): Promise<void> {
  const ctx = await DiscordContext.init(undefined, SERVER_HOST);

  const canvas = document.querySelector<HTMLCanvasElement>("#game");
  if (!canvas) throw new Error("Missing #game canvas element");
  const app = await createApp(canvas);

  const selection = await new Promise<{ color: number; mode: "online" | "ai" }>((resolve) => {
    const landing = new LandingPage(app, {
      onPlayOnline: (color) => {
        landing.destroy();
        resolve({ color, mode: "online" });
      },
      onPlayAi: (color) => {
        landing.destroy();
        resolve({ color, mode: "ai" });
      },
    });
  });

  const stateRef: { current: MatchState } = { current: createStubState() };
  const scene = new PongScene(app, () => stateRef.current, selection.color);

  window.__pong_scene_ready = true;
  window.__pong_layers = scene.getLayers();
  window.__pong_scene = scene;

  const orchestrator = new MatchOrchestrator({ serverHost: SERVER_HOST, app, scene, ctx, stateRef, selectedMode: selection.mode, userColor: selection.color });

  // Wire up leave button
  scene.setLeaveButtonCallback(() => {
    orchestrator.leaveGame();
  });

  await orchestrator.boot();
}

main().catch((err) => {
});
