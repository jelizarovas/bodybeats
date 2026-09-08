import test from "node:test";
import assert from "node:assert/strict";
import { TrackingView } from "../src/tracking-view.ts";
import type { HandView } from "../src/types.ts";
const hand: HandView = {
  id: "hand-0",
  handedness: "Left",
  x: 0.2,
  y: 0.4,
  scale: 0.1,
  pinchRatio: 1,
  pose: "Open_Palm",
  score: 0.9,
  points: [],
  phase: "ready",
  pinching: false,
  note: 0,
};
test("missing observations remove their skeleton immediately", () => {
  const view = new TrackingView();
  view.update([hand], 0);
  view.update([], 33);
  assert.equal(view.frames(66).length, 0);
  view.update([hand], 120);
  assert.equal(view.frames(120)[0].hand, hand);
  view.update([], 150);
  assert.equal(view.frames(501).length, 0);
});
test("observations expire after 250ms without a fading ghost", () => {
  const view = new TrackingView();
  view.update([hand], 0);
  assert.equal(view.frames(250)[0].hand, hand);
  assert.equal(view.frames(251).length, 0);
  view.update([hand], 1000);
  view.clear();
  assert.equal(view.frames(1001).length, 0);
});
test("losing one of two hands does not retain its previous skeleton", () => {
  const view = new TrackingView();
  const other: HandView = { ...hand, id: "hand-1", x: 0.8 };
  view.update([hand, other], 0);
  view.update([other], 50);
  assert.deepEqual(
    view.frames(60).map((frame) => frame.hand.id),
    ["hand-1"],
  );
});
