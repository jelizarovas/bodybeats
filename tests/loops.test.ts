import test from "node:test";
import assert from "node:assert/strict";
import { LoopStation } from "../src/loops.ts";
import type { Layer } from "../src/types.ts";
const layer = (): Layer => ({
  id: "a",
  name: "Drums",
  instrument: "drums",
  muted: false,
  notes: [
    {
      instrument: "drums",
      beat: 0,
      duration: 0.2,
      pitch: 0,
      velocity: 0.7,
      brightness: 0.5,
    },
    {
      instrument: "drums",
      beat: 4,
      duration: 0.2,
      pitch: 1,
      velocity: 0.7,
      brightness: 0.5,
    },
  ],
});
test("first recording gives four count-in beats and records exactly eight beats", () => {
  const l = new LoopStation();
  l.bpm = 120;
  l.beginRecord("drums", 10);
  assert.equal(l.origin, 12.06);
  l.recordHit(0, 0.7, 11);
  l.recordHit(0, 0.7, 12.06);
  l.recordHit(1, 0.7, 14.06);
  assert.equal(l.advance(16), null);
  const saved = l.advance(16.061);
  assert.equal(saved?.notes.length, 2);
  assert.equal(saved?.notes[0].beat, 0);
  assert.equal(l.layers.length, 1);
});
test("scheduler emits each note once across overlapping windows and loop boundaries", () => {
  const l = new LoopStation();
  l.bpm = 120;
  l.layers = [layer()];
  l.play(0);
  const times: number[] = [];
  for (let t = 0; t < 9; t += 0.025)
    l.schedule(t, 0.1, (_, at) => times.push(at));
  assert.equal(times.length, 5);
  assert.ok(Math.abs(times[2] - 4.06) < 0.001);
});
test("committing a new layer does not duplicate an already scheduled existing layer", () => {
  const l = new LoopStation();
  l.bpm = 120;
  l.layers = [layer()];
  l.play(0);
  l.beginRecord("drums", 0);
  const start = l.recording!.startBeat;
  l.recordHit(2, 0.5, l.origin + start * 0.5);
  const boundary = l.origin + (start + 8) * 0.5;
  const emitted: string[] = [];
  l.schedule(boundary - 0.04, 0.1, (_, at, track) =>
    emitted.push(`${track.id}:${at.toFixed(3)}`),
  );
  l.advance(boundary + 0.001);
  l.schedule(boundary + 0.001, 0.1, (_, at, track) =>
    emitted.push(`${track.id}:${at.toFixed(3)}`),
  );
  assert.equal(emitted.filter((k) => k.startsWith("a:")).length, 1);
  assert.equal(emitted.length, 2);
});
test("held melody is clipped to recording boundaries and split on pitch changes", () => {
  const l = new LoopStation();
  l.bpm = 120;
  l.beginRecord("melody", 0);
  l.noteOn("hand", 1, 0.5, l.origin - 0.2);
  l.noteChange("hand", 3, 0.6, l.origin + 1);
  const saved = l.advance(l.origin + 4.01)!;
  assert.equal(saved.notes.length, 2);
  assert.equal(saved.notes[0].beat, 0);
  assert.equal(saved.notes[0].duration, 2);
  assert.equal(saved.notes[1].duration, 6);
});
test("pause cancels unfinished recording; mute stops scheduling; tempo requires pause", () => {
  const l = new LoopStation();
  l.layers = [{ ...layer(), muted: true }];
  l.play(0);
  assert.throws(() => l.setTempo(140));
  let count = 0;
  l.schedule(0, 8, () => count++);
  assert.equal(count, 0);
  l.beginRecord("drums", 1);
  l.stop();
  assert.equal(l.recording, null);
  l.setTempo(140);
  assert.equal(l.bpm, 140);
});
test("empty layers are discarded and a fifth layer is refused", () => {
  const l = new LoopStation();
  l.beginRecord("drums", 0);
  assert.equal(l.advance(20), null);
  assert.equal(l.layers.length, 0);
  assert.equal(l.playing, false);
  l.layers = Array.from({ length: 4 }, (_, i) => ({
    ...layer(),
    id: String(i),
  }));
  assert.throws(() => l.beginRecord("drums", 20));
});
