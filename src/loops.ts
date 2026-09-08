import { LOOP_BEATS, clamp } from "./types.ts";
import type { Instrument, Layer, LoopNote, Project } from "./types.ts";

export class LoopStation {
  bpm = 108;
  layers: Layer[] = [];
  playing = false;
  origin = 0;
  recording: {
    startBeat: number;
    instrument: Instrument;
    notes: LoopNote[];
  } | null = null;
  private scheduledUntil = 0;
  private held = new Map<
    string,
    { start: number; note: number; brightness: number }
  >();
  private nextId = 1;
  private scheduled = new Map<string, number>();
  get secondsPerBeat() {
    return 60 / this.bpm;
  }
  beat(time: number) {
    return (time - this.origin) / this.secondsPerBeat;
  }
  phase(time: number) {
    return ((this.beat(time) % LOOP_BEATS) + LOOP_BEATS) % LOOP_BEATS;
  }
  play(time: number) {
    this.playing = true;
    this.origin = time + 0.06;
    this.scheduledUntil = time;
    this.scheduled.clear();
  }
  stop() {
    this.playing = false;
    this.recording = null;
    this.held.clear();
    this.scheduled.clear();
  }
  setTempo(bpm: number) {
    if (this.playing) throw new Error("Pause the loop before changing tempo.");
    if (!Number.isFinite(bpm)) throw new Error("Tempo must be a number.");
    this.bpm = Math.round(clamp(bpm, 60, 160));
  }
  beginRecord(instrument: Instrument, time: number) {
    if (this.recording)
      throw new Error("Finish or cancel the current layer first.");
    if (this.layers.length >= 4)
      throw new Error("Four layers are full. Remove one to record again.");
    let startBeat: number;
    if (!this.playing) {
      this.playing = true;
      this.origin = time + this.secondsPerBeat * 4 + 0.06;
      this.scheduledUntil = time;
      this.scheduled.clear();
      startBeat = 0;
    } else
      startBeat = Math.ceil((this.beat(time) + 4) / LOOP_BEATS) * LOOP_BEATS;
    this.recording = { startBeat, instrument, notes: [] };
    this.held.clear();
  }
  cancelRecord() {
    this.recording = null;
    this.held.clear();
    if (!this.layers.length) this.playing = false;
  }
  recordHit(pad: number, velocity: number, time: number) {
    if (!this.recording || this.recording.instrument !== "drums") return;
    const rawBeat = this.beat(time) - this.recording.startBeat;
    const beat = rawBeat > -1e-8 ? Math.max(0, rawBeat) : rawBeat;
    if (beat >= 0 && beat < LOOP_BEATS && this.recording.notes.length < 512)
      this.recording.notes.push({
        instrument: "drums",
        beat,
        duration: 0.2,
        pitch: pad,
        velocity,
        brightness: 0.5,
      });
  }
  noteOn(id: string, note: number, brightness: number, time: number) {
    if (this.recording?.instrument !== "melody") return;
    if (this.held.has(id)) this.noteOff(id, time);
    this.held.set(id, { start: this.beat(time), note, brightness });
  }
  noteChange(id: string, note: number, brightness: number, time: number) {
    const old = this.held.get(id);
    if (!old) return;
    if (old.note !== note) {
      this.noteOff(id, time);
      this.noteOn(id, note, brightness, time);
    } else old.brightness = brightness;
  }
  noteOff(id: string, time: number) {
    const old = this.held.get(id);
    this.held.delete(id);
    if (!old || !this.recording) return;
    const start = Math.max(this.recording.startBeat, old.start),
      end = Math.min(this.recording.startBeat + LOOP_BEATS, this.beat(time));
    if (end > start && this.recording.notes.length < 512)
      this.recording.notes.push({
        instrument: "melody",
        beat: start - this.recording.startBeat,
        duration: end - start,
        pitch: old.note,
        velocity: 0.6,
        brightness: old.brightness,
      });
  }
  /** Called against AudioContext.currentTime. Returns a committed layer. */
  advance(time: number): Layer | null {
    if (
      !this.recording ||
      this.beat(time) < this.recording.startBeat + LOOP_BEATS
    )
      return null;
    for (const id of [...this.held.keys()]) this.noteOff(id, time);
    const recording = this.recording;
    this.recording = null;
    if (!recording.notes.length) {
      if (!this.layers.length) this.playing = false;
      return null;
    }
    const layer: Layer = {
      id: `layer-${Date.now()}-${this.nextId++}`,
      name: recording.instrument === "drums" ? "Drum layer" : "Melody layer",
      instrument: recording.instrument,
      muted: false,
      notes: recording.notes.sort((a, b) => a.beat - b.beat),
    };
    this.layers.push(layer);
    // The first playback cycle starts at this boundary, even if the previous
    // scheduler pass had already looked beyond it while recording.
    this.scheduledUntil = Math.min(
      this.scheduledUntil,
      this.origin + (recording.startBeat + LOOP_BEATS) * this.secondsPerBeat,
    );
    return layer;
  }
  schedule(
    time: number,
    ahead: number,
    emit: (note: LoopNote, at: number, layer: Layer) => void,
  ) {
    if (!this.playing) return;
    const from = Math.max(this.scheduledUntil, time - 0.02),
      until = time + ahead;
    if (until <= from) return;
    for (const layer of this.layers) {
      if (layer.muted) continue;
      for (const [index, note] of layer.notes.entries()) {
        const startCycle = Math.max(
          0,
          Math.ceil((this.beat(from) - note.beat) / LOOP_BEATS - 1e-9),
        );
        const endCycle = Math.floor(
          (this.beat(until) - note.beat) / LOOP_BEATS,
        );
        for (let cycle = startCycle; cycle <= endCycle; cycle++) {
          const at =
            this.origin +
            (cycle * LOOP_BEATS + note.beat) * this.secondsPerBeat;
          const key = `${layer.id}:${cycle}:${index}`;
          if (at >= from - 1e-8 && at < until && !this.scheduled.has(key)) {
            emit(note, Math.max(time, at), layer);
            this.scheduled.set(key, at);
          }
        }
      }
    }
    this.scheduledUntil = until;
    for (const [key, at] of this.scheduled)
      if (at < time - 2 * this.secondsPerBeat) this.scheduled.delete(key);
  }
  snapshot(): Project {
    return { version: 3, bpm: this.bpm, layers: structuredClone(this.layers) };
  }
  load(project: Project) {
    this.stop();
    this.bpm = project.bpm;
    this.layers = structuredClone(project.layers);
  }
}
