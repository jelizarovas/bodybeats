import test from "node:test";
import assert from "node:assert/strict";
import { FrameScheduler } from "../src/frame-scheduler.ts";

test("only the newest waiting frame is captured immediately when inference finishes", () => {
  const frames = new FrameScheduler();
  frames.offer(0);
  assert.equal(frames.start(0), true);
  frames.offer(1 / 60);
  frames.offer(2 / 60);
  frames.offer(3 / 60);
  assert.equal(frames.delay(50), null);
  assert.equal(frames.start(50), false, "never starts a second inference");
  frames.complete();
  assert.equal(
    frames.start(56),
    true,
    "does not wait until the next camera tick",
  );
  frames.complete();
  assert.equal(
    frames.delay(80),
    null,
    "older waiting frames were replaced, not queued",
  );
});

test("fast inference cannot capture more frequently than60Hz", () => {
  const frames = new FrameScheduler();
  frames.offer(0);
  frames.start(100);
  frames.complete();
  frames.offer(1 / 120);
  assert.equal(frames.start(105), false);
  assert.ok(Math.abs(frames.delay(105)! - (1000 / 60 - 5)) < 0.000001);
  assert.equal(frames.start(100 + 1000 / 60), true);
});

test("duplicate callbacks and fast polling never invent new camera frames", () => {
  const frames = new FrameScheduler();
  frames.offer(2);
  frames.start(0);
  frames.complete();
  frames.offer(2);
  frames.offer(1.9);
  assert.equal(frames.start(100), false);
  frames.offer(2 + 1 / 30);
  assert.equal(frames.start(101), true);
});

test("60Hz ceiling remains bounded under a120Hz source and jittery completions", () => {
  const frames = new FrameScheduler();
  const captures: number[] = [];
  let completeAt = Infinity;
  for (let now = 0; now < 1000; now += 0.5) {
    frames.offer(Math.floor(now / (1000 / 120)) / 120);
    if (now >= completeAt) {
      frames.complete();
      completeAt = Infinity;
    }
    if (frames.start(now)) {
      captures.push(now);
      completeAt = now + 2;
    }
  }
  assert.ok(captures.length <= 60);
  assert.ok(captures.length >= 58);
  for (let i = 1; i < captures.length; i++)
    assert.ok(captures[i] - captures[i - 1] >= 1000 / 60);
});

test("stopping cancels pending and late completion cannot restart capture", () => {
  const frames = new FrameScheduler();
  frames.offer(0);
  frames.start(0);
  frames.offer(1);
  frames.stop();
  frames.complete();
  frames.offer(2);
  assert.equal(frames.busy, false);
  assert.equal(frames.delay(500), null);
  assert.equal(frames.start(500), false);
});
