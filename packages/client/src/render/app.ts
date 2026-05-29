import { Application } from "pixi.js";

/**
 * Boot a Pixi v8 Application attached to the given canvas element.
 * Resolution defaults to device pixel ratio; background is transparent
 * so Discord's own background can show through.
 */
export async function createApp(canvas: HTMLCanvasElement): Promise<Application> {
  const app = new Application();

  await app.init({
    canvas,
    resolution: window.devicePixelRatio ?? 1,
    autoDensity: true,
    backgroundAlpha: 0,
    antialias: true,
    resizeTo: window,
  });

  return app;
}
