export type Instrument = "drums" | "melody";
export type HandId = "hand-0" | "hand-1";
export type Pad = 0 | 1 | 2 | 3;
export type Point = { x: number; y: number; z?: number };
export type Bounds = {
  left: number;
  top: number;
  right: number;
  bottom: number;
};
export type Settings = {
  instrument: Instrument;
  bounds: Bounds;
  preferredHand: "any" | "Left" | "Right";
};
export type HandSample = {
  source?: "landmarks" | "motion";
  id: HandId;
  handedness: string;
  x: number;
  y: number;
  scale: number;
  pinchRatio: number;
  pose: string;
  score: number;
  points: Point[];
};
export type HandView = HandSample & {
  phase: "ready" | "lift" | "hit" | "holding";
  note: number;
  pinching: boolean;
};
export type Action =
  | { type: "hit"; pad: Pad; velocity: number; at: number; hand?: HandId }
  | {
      type: "note-on" | "note-change";
      hand: string;
      note: number;
      brightness: number;
      at: number;
    }
  | { type: "note-off"; hand: string; at: number };
export type Recognition = {
  timings?: {
    modelMs: number;
    readbackMs: number;
    motionMs: number;
    comparisonMs: number;
  };
  backend?: {
    delegate: "GPU" | "CPU";
    status: "warming" | "watching" | "loading" | "comparing" | "selected";
    reason?: string;
  };
  timestamp: number;
  hands: HandView[];
  actions: Action[];
  inferenceMs: number;
  samples: HandSample[];
};
export type WorkerRequest =
  | { type: "init" }
  | { type: "settings"; settings: Settings }
  | {
      type: "frame";
      bitmap: ImageBitmap;
      timestamp: number;
      timeOrigin?: number;
    };
export type WorkerReply =
  | {
      type: "backend";
      delegate: "GPU" | "CPU";
      status: "loading" | "comparing" | "selected";
      reason?: string;
    }
  | { type: "ready"; delegate: string }
  | { type: "result"; state: Recognition }
  | { type: "error"; message: string };
export type LoopNote = {
  beat: number;
  duration: number;
  instrument: Instrument;
  pitch: number;
  velocity: number;
  brightness: number;
};
export type Layer = {
  id: string;
  name: string;
  instrument: Instrument;
  muted: boolean;
  notes: LoopNote[];
};
export type Project = { version: 3; bpm: number; layers: Layer[] };
export type TraceFrame = { timestamp: number; hands: HandSample[] };
export type Trace = { version: 1; settings: Settings; frames: TraceFrame[] };
export const SCALE = [60, 62, 64, 67, 69, 72, 74];
export const NOTE_NAMES = ["C", "D", "E", "G", "A", "C", "D"];
export const PAD_NAMES = ["Kick", "Snare", "Hi-hat", "Tom"];
export const COLORS = ["#d8fc71", "#ee9b81", "#b7a1e5", "#88c6c3"];
export const DRUM_LINE = 0.61;
export const LOOP_BEATS = 8;
export const DEFAULT_SETTINGS: Settings = {
  instrument: "drums",
  bounds: { left: 0, top: 0, right: 1, bottom: 1 },
  preferredHand: "any",
};
export const clamp = (x: number, low = 0, high = 1) =>
  Math.max(low, Math.min(high, x));
