import test from "node:test";
import assert from "node:assert/strict";
import { MotionTracker, type GrayFrame } from "../src/motion-tracker.ts";
import type { HandSample } from "../src/types.ts";
const sample: HandSample = {
  id: "hand-0",
  handedness: "Left",
  x: 0.5,
  y: 35 / 120,
  scale: 0.08,
  pinchRatio: 0.2,
  pose: "Open_Palm",
  score: 0.95,
  points: [{ x: 0.5, y: 35 / 120 }],
};
function frame(dx = 0, dy = 0, present = true): GrayFrame {
  const pixels = new Uint8Array(160 * 120).fill(30);
  if (present)
    for (let y = -18; y <= 18; y++)
      for (let x = -18; x <= 18; x++) {
        const px = 80 + x + dx,
          py = 35 + y + dy;
        if (px >= 0 && px < 160 && py >= 0 && py < 120)
          pixels[py * 160 + px] =
            130 +
            35 * Math.sin(x * 0.17) +
            35 * Math.cos(y * 0.23) +
            30 * Math.sin(x * 0.12 + y * 0.13);
      }
  return { width: 160, height: 120, pixels };
}
test("measured image displacement recovers a brief landmark dropout", () => {
  const tracker = new MotionTracker();
  tracker.observe([sample], frame(), 0);
  const recovered = tracker.recover(frame(6, 24), 100, []);
  assert.equal(recovered.length, 1);
  assert.ok(Math.abs(recovered[0].x - (0.5 - 6 / 160)) < 0.01);
  assert.ok(Math.abs(recovered[0].y - (35 + 24) / 120) < 0.01);
  assert.equal(recovered[0].source, "motion");
  assert.equal(recovered[0].pose, "None");
  assert.equal(recovered[0].pinchRatio, 1);
});
test("motion expires without fresh model evidence and never matches an empty frame", () => {
  const tracker = new MotionTracker();
  tracker.observe([sample], frame(), 0);
  assert.equal(tracker.recover(frame(0, 25), 221, []).length, 0);
  tracker.observe([sample], frame(), 300);
  assert.equal(tracker.recover(frame(0, 0, false), 350, []).length, 0);
  assert.equal(
    tracker.recover(frame(), 350, []).length,
    0,
    "stationary background is not motion",
  );
  tracker.clear();
  assert.equal(tracker.recover(frame(0, 25), 400, []).length, 0);
});
test("flat textures and collisions with visible hands are rejected", () => {
  const tracker = new MotionTracker();
  tracker.observe([sample], frame(0, 0, false), 0);
  assert.equal(tracker.recover(frame(0, 24), 100, []).length, 0);
  tracker.observe([sample], frame(), 200);
  assert.equal(tracker.recover(frame(0, 24), 250, [sample]).length, 0);
  assert.equal(
    tracker.recover(frame(0, 24), 250, [
      { ...sample, id: "hand-1", y: (35 + 24) / 120 },
    ]).length,
    0,
  );
});
