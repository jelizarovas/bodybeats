import test from "node:test";
import assert from "node:assert/strict";
import { parseProject, parseTrace, Calibration } from "../src/storage.ts";
import { DEFAULT_SETTINGS } from "../src/types.ts";
test("project round trip preserves notes without accepting invalid values", () => {
  const p = {
    version: 3,
    bpm: 108,
    layers: [
      {
        id: "x",
        name: "Test",
        instrument: "melody",
        muted: false,
        notes: [
          {
            instrument: "melody",
            beat: 0,
            duration: 2,
            pitch: 3,
            velocity: 0.5,
            brightness: 0.7,
          },
        ],
      },
    ],
  };
  assert.deepEqual(parseProject(p), p);
  assert.throws(() => parseProject({ ...p, bpm: Infinity }));
  const bad = structuredClone(p);
  bad.layers[0].notes[0].pitch = 99;
  assert.throws(() => parseProject(bad));
  assert.throws(() =>
    parseProject({ ...p, layers: [p.layers[0], p.layers[0]] }),
  );
});
test("gesture traces reject excessive size and invalid timestamps", () => {
  const good = {
    version: 1,
    settings: DEFAULT_SETTINGS,
    frames: [
      { timestamp: 0, hands: [] },
      { timestamp: 30, hands: [] },
    ],
  };
  assert.deepEqual(parseTrace(good), good);
  assert.throws(() =>
    parseTrace({
      ...good,
      frames: [
        { timestamp: 10, hands: [] },
        { timestamp: 5, hands: [] },
      ],
    }),
  );
  assert.throws(() =>
    parseTrace({
      ...good,
      frames: Array(1001).fill({ timestamp: 0, hands: [] }),
    }),
  );
});
test("calibration requires a steady hold and sufficient reach", () => {
  const c = new Calibration(),
    h = {
      id: "hand-0" as const,
      handedness: "Right",
      x: 0.15,
      y: 0.15,
      scale: 0.1,
      pinchRatio: 1,
      pose: "Open_Palm",
      score: 0.9,
      points: [],
    };
  assert.equal(c.feed(h, 0).progress, 0);
  assert.equal(c.feed(h, 1300).next, true);
  assert.equal(c.feed({ ...h, x: 0.25, y: 0.25 }, 1400).progress, 0);
  assert.ok(c.feed({ ...h, x: 0.25, y: 0.25 }, 2700).error);
  c.feed({ ...h, x: 0.8, y: 0.8 }, 2800);
  assert.deepEqual(c.feed({ ...h, x: 0.8, y: 0.8 }, 4100).bounds, {
    left: 0.15,
    top: 0.15,
    right: 0.8,
    bottom: 0.8,
  });
});
test("calibration locks one real hand and ignores motion recovery", () => {
  const c = new Calibration();
  const hand = {
    id: "hand-0" as const,
    handedness: "Right",
    x: 0.2,
    y: 0.2,
    scale: 0.1,
    pinchRatio: 1,
    pose: "Open_Palm",
    score: 0.9,
    points: [],
  };
  assert.equal(c.feed({ ...hand, source: "motion" }, 0).progress, 0);
  assert.equal(c.handId, null);
  c.feed(hand, 100);
  assert.equal(c.handId, "hand-0");
  assert.equal(c.feed({ ...hand, id: "hand-1" }, 1400).progress, 0);
  assert.equal(c.first, null);
  c.feed(hand, 1500);
  assert.equal(c.feed(hand, 2800).next, true);
});
