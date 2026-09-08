import test from "node:test";
import assert from "node:assert/strict";
import {
  BackendSelection,
  BackendTrial,
  type BackendReading,
} from "../src/backend-selection.ts";

const hand = { x: 0.3, y: 0.4, handedness: "Left" };
const reading = (ms: number, hands = [hand]): BackendReading => ({ ms, hands });
const warm = (trial: BackendTrial) => {
  assert.equal(trial.compare(reading(50), reading(200)), "pending");
  assert.equal(trial.compare(reading(50), reading(80)), "pending");
};

test("backend trial triggers once after warmup and repeated slow hand frames", () => {
  const selection = new BackendSelection();
  for (let i = 0; i < 8; i++) assert.equal(selection.observeGpu(100, 2), false);
  assert.equal(selection.observeGpu(50, 1), false);
  assert.equal(selection.observeGpu(50, 1), false);
  assert.equal(selection.observeGpu(15, 1), false);
  assert.equal(selection.observeGpu(100, 0), false);
  assert.equal(selection.observeGpu(19, 1), false);
  assert.equal(selection.observeGpu(19, 1), false);
  assert.equal(selection.observeGpu(19, 1), true);
  for (let i = 0; i < 20; i++)
    assert.equal(selection.observeGpu(100, 2), false);
});

test("six fresh compatible hand pairs with consistent savings select CPU", () => {
  const trial = new BackendTrial();
  warm(trial);
  for (let i = 0; i < 5; i++)
    assert.equal(trial.compare(reading(55), reading(19)), "pending");
  assert.equal(trial.compare(reading(55), reading(22)), "CPU");
  assert.equal(
    trial.compare(reading(10), reading(50, [])),
    "CPU",
    "decision is final",
  );
});

test("a fast candidate with a missing or displaced hand keeps GPU", () => {
  for (const hands of [
    [],
    [{ ...hand, x: 0.8 }],
    [{ ...hand, handedness: "Right" }],
  ]) {
    const trial = new BackendTrial();
    warm(trial);
    assert.equal(trial.compare(reading(55), reading(10, hands)), "GPU");
  }
});

test("two-hand comparison accepts output order changes but preserves both hands", () => {
  const trial = new BackendTrial();
  warm(trial);
  const other = { x: 0.7, y: 0.5, handedness: "Right" };
  for (let i = 0; i < 6; i++)
    assert.equal(
      trial.compare(reading(55, [hand, other]), reading(20, [other, hand])),
      i === 5 ? "CPU" : "pending",
    );
});

test("small gains and inconsistent wins cannot replace GPU", () => {
  for (const times of [
    [46, 46, 46, 46, 46, 46],
    [20, 20, 20, 20, 60, 60],
  ]) {
    const trial = new BackendTrial();
    warm(trial);
    for (let i = 0; i < 6; i++)
      assert.equal(
        trial.compare(reading(55), reading(times[i])),
        i === 5 ? "GPU" : "pending",
      );
  }
});

test("empty scenes expire the comparison without selecting a backend on no-hand speed", () => {
  const trial = new BackendTrial();
  warm(trial);
  for (let i = 0; i < 12; i++)
    assert.equal(
      trial.compare(reading(55, []), reading(5, [])),
      i === 11 ? "GPU" : "pending",
    );
});
