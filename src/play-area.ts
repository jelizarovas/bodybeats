import { clamp } from "./types.ts";
import type { Bounds, Point } from "./types.ts";

// Leave room for the whole hand beyond the outside instrument lanes.
export const PLAY_LEFT = 0.18;
export const PLAY_RIGHT = 0.82;

export function laneAt(x: number, count: number): number {
  return clamp(
    Math.floor(((x - PLAY_LEFT) / (PLAY_RIGHT - PLAY_LEFT)) * count + 1e-12),
    0,
    count - 1,
  );
}

export function laneRect(index: number, count: number) {
  const width = (PLAY_RIGHT - PLAY_LEFT) / count;
  return {
    left: PLAY_LEFT + index * width,
    right: PLAY_LEFT + (index + 1) * width,
  };
}

/** Camera coordinates are normalized and mirrored exactly once by vision. */
export function cameraToPlay(point: Point, bounds: Bounds): Point {
  return {
    ...point,
    x: (point.x - bounds.left) / (bounds.right - bounds.left),
    y: (point.y - bounds.top) / (bounds.bottom - bounds.top),
  };
}

/** Preserve off-area positions so callers can distinguish exit from a lane. */
export function playToCamera(point: Point, bounds: Bounds): Point {
  return {
    ...point,
    x: bounds.left + point.x * (bounds.right - bounds.left),
    y: bounds.top + point.y * (bounds.bottom - bounds.top),
  };
}
