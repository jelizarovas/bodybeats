import test from "node:test";
import assert from "node:assert/strict";
import { Recognizer, replayTrace, padAt, noteAt } from "../src/recognition.ts";
import { laneRect } from "../src/play-area.ts";
import { DEFAULT_SETTINGS } from "../src/types.ts";
import type { HandSample, Action } from "../src/types.ts";
const hand = (x = 0.2, y = 0.35, ratio = 1): HandSample => ({
  id: "hand-0",
  handedness: "Right",
  x,
  y,
  scale: 0.12,
  pinchRatio: ratio,
  pose: "Open_Palm",
  score: 0.95,
  points: [],
});
test("continuous observations at 5 FPS retain arming and held notes", () => {
  const r = new Recognizer();
  r.update([hand(0.2, 0.3)], 0);
  assert.equal(r.update([hand(0.2, 0.3)], 200).hands[0].phase, "ready");
  assert.equal(
    r.update([hand(0.2, 0.75)], 400).actions.filter((a) => a.type === "hit")
      .length,
    1,
  );
  r.configure({ ...DEFAULT_SETTINGS, instrument: "melody" });
  r.update([hand(0.2, 0.3, 0.2)], 0);
  assert.equal(
    r.update([hand(0.2, 0.3, 0.2)], 200).actions[0]?.type,
    "note-on",
  );
  assert.equal(r.update([hand(0.2, 0.3, 0.2)], 400).actions.length, 0);
  assert.equal(r.update([hand(0.2, 0.3, 0.2)], 600).hands[0].pinching, true);
});
test("ten deliberate strokes produce exactly ten hits at 15, 30 and 60 FPS", () => {
  for (const fps of [15, 30, 60]) {
    const r = new Recognizer(),
      events: Action[] = [];
    for (let i = 0; i < fps * 10; i++) {
      const t = i / fps,
        phase = t % 1;
      const y =
        phase < 0.25
          ? 0.32
          : phase < 0.45
            ? 0.32 + ((phase - 0.25) / 0.2) * 0.43
            : phase < 0.7
              ? 0.75
              : 0.32;
      events.push(...r.update([hand(0.2, y)], 1000 + t * 1000).actions);
    }
    assert.equal(
      events.filter((e) => e.type === "hit").length,
      10,
      `fps ${fps}`,
    );
  }
});
test("one hit per downward stroke, no repeat while resting below line", () => {
  const r = new Recognizer(),
    events: Action[] = [];
  [0.3, 0.3, 0.3, 0.4, 0.58, 0.7, ...Array(30).fill(0.75)].forEach((y, i) =>
    events.push(...r.update([hand(0.5, y)], i * 33).actions),
  );
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "hit");
  if (events[0].type === "hit") assert.equal(events[0].pad, 2);
});
test("slow repositioning, first appearance below line, and large reacquisition jumps produce no hits", () => {
  for (const values of [
    [0.8, 0.8, 0.82],
    Array.from({ length: 90 }, (_, i) => 0.35 + i * 0.004),
  ]) {
    const r = new Recognizer();
    assert.equal(
      values.flatMap((y, i) => r.update([hand(0.2, y)], i * 33).actions).length,
      0,
    );
  }
  const r = new Recognizer();
  r.update([hand(0.2, 0.3)], 0);
  r.update([hand(0.2, 0.3)], 60);
  r.update([], 90);
  assert.equal(r.update([hand(0.2, 0.95)], 120).actions.length, 0);
});
test("two hands can strike independently and positions outside the camera are ignored", () => {
  const r = new Recognizer();
  const frames = [0.3, 0.3, 0.3, 0.5, 0.7];
  const events = frames.flatMap(
    (y, i) =>
      r.update(
        [hand(0.15, y), { ...hand(0.85, y), id: "hand-1", handedness: "Left" }],
        i * 33,
      ).actions,
  );
  assert.deepEqual(
    events.filter((e) => e.type === "hit").map((e) => e.pad),
    [0, 3],
  );
  const off = new Recognizer();
  assert.equal(
    frames.flatMap((y, i) => off.update([hand(1.01, y)], i * 33).actions)
      .length,
    0,
  );
});
test("pinch has stable onset, pitch hysteresis and explicit release", () => {
  const r = new Recognizer();
  r.configure({ ...DEFAULT_SETTINGS, instrument: "melody" });
  let events: Action[] = [];
  for (let i = 0; i < 8; i++)
    events.push(...r.update([hand(0.2, 0.4, 0.2)], i * 30).actions);
  assert.equal(events.filter((e) => e.type === "note-on").length, 1);
  assert.equal(events.filter((e) => e.type === "note-off").length, 0);
  for (let i = 8; i < 12; i++)
    events.push(...r.update([hand(0.8, 0.4, 0.2)], i * 30).actions);
  assert.ok(events.some((e) => e.type === "note-change"));
  for (let i = 12; i < 17; i++)
    events.push(...r.update([hand(0.8, 0.4, 0.9)], i * 30).actions);
  assert.equal(events.filter((e) => e.type === "note-off").length, 1);
});
test("lost tracking releases held note and does not retrigger on a stale timestamp", () => {
  const r = new Recognizer();
  r.configure({ ...DEFAULT_SETTINGS, instrument: "melody" });
  r.update([hand(0.2, 0.4, 0.2)], 1000);
  r.update([hand(0.2, 0.4, 0.2)], 1050);
  assert.equal(r.update([], 1100).actions.length, 0);
  assert.equal(r.update([], 1200).actions[0].type, "note-off");
  assert.equal(r.update([hand(0.2, 0.4, 0.2)], 1000).actions.length, 0);
});
test("closed fists never start melody notes", () => {
  const r = new Recognizer();
  r.configure({ ...DEFAULT_SETTINGS, instrument: "melody" });
  for (let i = 0; i < 20; i++)
    assert.equal(
      r.update([{ ...hand(0.2, 0.4, 0.1), pose: "Closed_Fist" }], i * 33)
        .actions.length,
      0,
    );
});
test("calibrated reach and preferred hand apply before hit detection", () => {
  const r = new Recognizer();
  r.configure({
    ...DEFAULT_SETTINGS,
    bounds: { left: 0.2, top: 0.2, right: 0.8, bottom: 0.8 },
    preferredHand: "Right",
  });
  const events = [0.35, 0.35, 0.35, 0.48, 0.65].flatMap(
    (y, i) =>
      r.update(
        [hand(0.3, y), { ...hand(0.7, y), id: "hand-1", handedness: "Left" }],
        i * 33,
      ).actions,
  );
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "hit");
});
test("replay reproduces the same action sequence", () => {
  const trace = {
    version: 1 as const,
    settings: DEFAULT_SETTINGS,
    frames: [0.3, 0.3, 0.3, 0.5, 0.72, 0.3, 0.3, 0.3, 0.55, 0.75].map(
      (y, i) => ({ timestamp: i * 40, hands: [hand(0.5, y)] }),
    ),
  };
  const a = replayTrace(trace),
    b = replayTrace(trace);
  assert.deepEqual(a, b);
  assert.equal(a.flatMap((s) => s.actions).length, 2);
});
test("shallow repeated taps need no stationary dwell at 30 and 60 FPS", () => {
  for (const fps of [30, 60]) {
    for (const hz of [2, 3, 4]) {
      const r = new Recognizer(),
        events: Action[] = [];
      for (let i = 0; i < fps * 4; i++) {
        const t = i / fps;
        const y = 0.585 - 0.065 * Math.cos(2 * Math.PI * hz * t);
        events.push(...r.update([hand(0.2, y)], t * 1000).actions);
      }
      assert.equal(
        events.filter((a) => a.type === "hit").length,
        hz * 4,
        `${hz} Hz at ${fps} FPS`,
      );
    }
  }
});

test("a crossing uses the pad and time where the movement meets the line", () => {
  const r = new Recognizer();
  r.update([hand(0.46, 0.3)], 0);
  r.update([hand(0.46, 0.5)], 90);
  const event = r.update([hand(0.53, 0.75)], 130).actions[0];
  assert.equal(event?.type, "hit");
  if (event?.type !== "hit") return;
  assert.equal(
    event.pad,
    1,
    "crossing is in the snare even though endpoint is in hi-hat",
  );
  assert.ok(Math.abs(event.at - 107.6) < 1e-8);
  assert.equal(r.update([hand(0.53, 0.8)], 160).actions.length, 0);
});

test("camera edges and hands beyond calibrated reach keep the outer pads playable", () => {
  for (const [x, pad] of [
    [0.01, 0],
    [0.99, 3],
  ] as const) {
    const r = new Recognizer();
    r.configure({
      ...DEFAULT_SETTINGS,
      bounds: { left: 0.2, top: 0.2, right: 0.8, bottom: 0.8 },
    });
    r.update([hand(x, 0.35)], 0);
    const event = r.update([hand(x, 0.7)], 100).actions[0];
    assert.equal(event?.type, "hit");
    if (event?.type === "hit") assert.equal(event.pad, pad);
  }
  const r = new Recognizer();
  r.update([hand(0.94, 0.3)], 0);
  r.update([hand(0.94, 0.5)], 90);
  assert.equal(r.update([hand(0.96, 0.75)], 130).actions[0]?.type, "hit");
  assert.equal(padAt(0), 0);
  assert.equal(padAt(1), 3);
});

test("a dropout at stroke onset is confirmed only by a nearby matching real hand", () => {
  for (const scenario of [
    "continue",
    "late",
    "sideways",
    "changed-hand",
    "jump",
    "motion",
    "other-pad",
  ] as const) {
    const r = new Recognizer();
    r.update([hand(0.33, 0.3)], 0);
    r.update([hand(0.33, 0.3)], 50);
    assert.equal(r.update([], 80).actions.length, 0);
    const returned = hand(
      scenario === "sideways" ? 0.75 : scenario === "other-pad" ? 0.35 : 0.33,
      scenario === "jump" ? 0.95 : 0.75,
    );
    if (scenario === "changed-hand") returned.handedness = "Left";
    if (scenario === "motion") returned.source = "motion";
    const t = scenario === "late" ? 180 : 110;
    const events = r.update([returned], t).actions;
    assert.equal(
      events.filter((a) => a.type === "hit").length,
      scenario === "continue" ? 1 : 0,
      scenario,
    );
    assert.equal(r.update([returned], t + 40).actions.length, 0);
  }
});

test("melody lane hysteresis uses the same inset boundaries as the pads", () => {
  const r = new Recognizer();
  r.configure({ ...DEFAULT_SETTINGS, instrument: "melody" });
  const border = laneRect(2, 7).right;
  r.update([hand(border - 0.02, 0.4, 0.2)], 0);
  assert.equal(
    r.update([hand(border - 0.02, 0.4, 0.2)], 50).actions[0]?.type,
    "note-on",
  );
  assert.equal(noteAt(border + 0.005), 3);
  assert.equal(
    r.update([hand(border + 0.005, 0.4, 0.2)], 90).actions.length,
    0,
  );
  const event = r.update([hand(border + 0.025, 0.4, 0.2)], 130).actions[0];
  assert.equal(event?.type, "note-change");
  if (event?.type === "note-change") assert.equal(event.note, 3);
});

test("pixel motion can complete one armed strike but cannot rearm or invent pinch", () => {
  const r = new Recognizer();
  r.update([hand(0.2, 0.3)], 0);
  r.update([hand(0.2, 0.3)], 50);
  const flow = (y: number) => ({
    ...hand(0.2, y, 0.1),
    source: "motion" as const,
  });
  assert.equal(
    r.update([flow(0.7)], 100).actions.filter((a) => a.type === "hit").length,
    1,
  );
  const next = [0.3, 0.3, 0.3, 0.7, 0.8].flatMap(
    (y, i) => r.update([flow(y)], 150 + i * 40).actions,
  );
  assert.equal(next.length, 0);
  r.configure({ ...DEFAULT_SETTINGS, instrument: "melody" });
  assert.equal(
    [0, 50, 100, 150].flatMap((t) => r.update([flow(0.4)], t).actions).length,
    0,
  );
});
test("a brief dropout during an observed descent requires consistent reacquisition", () => {
  for (const scenario of ["continue", "late", "sideways", "reverse"] as const) {
    const r = new Recognizer();
    r.update([hand(0.2, 0.3)], 0);
    r.update([hand(0.2, 0.3)], 50);
    r.update([hand(0.2, 0.5)], 90);
    assert.equal(r.update([], 120).actions.length, 0);
    const t = scenario === "late" ? 300 : 160;
    const sample =
      scenario === "sideways"
        ? hand(0.7, 0.75)
        : scenario === "reverse"
          ? hand(0.2, 0.35)
          : hand(0.2, 0.75);
    const events = r.update([sample], t).actions;
    assert.equal(
      events.filter((e) => e.type === "hit").length,
      scenario === "continue" ? 1 : 0,
      scenario,
    );
    // A real return above the rearm line starts a new stroke; the following
    // downstroke is distinct from the rejected interrupted descent.
    assert.equal(
      r.update([hand(0.2, 0.8)], t + 40).actions.length,
      scenario === "reverse" ? 1 : 0,
    );
  }
});
