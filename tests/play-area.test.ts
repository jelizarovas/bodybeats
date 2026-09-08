import test from "node:test";
import assert from "node:assert/strict";
import {
  cameraToPlay,
  playToCamera,
  laneAt,
  laneRect,
  PLAY_LEFT,
  PLAY_RIGHT,
} from "../src/play-area.ts";
import type { Bounds } from "../src/types.ts";

const bounds: Bounds = { left: 0.12, right: 0.84, top: 0.2, bottom: 0.9 };
const near = (actual: number, expected: number) =>
  assert.ok(Math.abs(actual - expected) < 1e-10, `${actual} != ${expected}`);

test("drawn lane centers and boundaries use the same hit mapping", () => {
  for (const count of [4, 7]) {
    for (let i = 0; i < count; i++) {
      const lane = laneRect(i, count);
      assert.equal(laneAt((lane.left + lane.right) / 2, count), i);
      assert.equal(laneAt(lane.left, count), i);
      assert.equal(laneAt(lane.right - 1e-8, count), i);
      assert.equal(laneAt(lane.right, count), Math.min(i + 1, count - 1));
    }
    near(laneRect(0, count).left, PLAY_LEFT);
    near(laneRect(count - 1, count).right, PLAY_RIGHT);
    assert.equal(laneAt(-0.1, count), 0);
    assert.equal(laneAt(1.1, count), count - 1);
  }
});

test("calibrated coordinates preserve full-camera hand and lane alignment", () => {
  for (const point of [
    { x: 0.1, y: 0.4, z: 0.2 },
    { x: 0.8, y: 0.95 },
  ]) {
    const mapped = playToCamera(cameraToPlay(point, bounds), bounds);
    near(mapped.x, point.x);
    near(mapped.y, point.y);
    assert.equal(mapped.z, point.z);
  }
  for (let i = 0; i < 7; i++) {
    const lane = laneRect(i, 7);
    const center = { x: (lane.left + lane.right) / 2, y: 0.61 };
    const camera = playToCamera(center, bounds);
    assert.equal(laneAt(cameraToPlay(camera, bounds).x, 7), i);
    near(camera.y, bounds.top + 0.61 * (bounds.bottom - bounds.top));
  }
});

test("playing bounds do not crop or clamp observed camera positions", () => {
  const outside = cameraToPlay({ x: 0, y: 1 }, bounds);
  assert.ok(outside.x < 0);
  assert.ok(outside.y > 1);
  const restored = playToCamera(outside, bounds);
  near(restored.x, 0);
  near(restored.y, 1);
});
