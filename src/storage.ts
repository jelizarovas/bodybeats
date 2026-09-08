import { DEFAULT_SETTINGS } from "./types.ts";
import type { Bounds, Project, Settings, Trace, HandSample } from "./types.ts";
import { validBounds } from "./recognition.ts";
const PROJECT_KEY = "bodybeats.studio.v3.project";
const SPACE_KEY = "bodybeats.studio.v3.space";
function number(value: unknown, min: number, max: number): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= min &&
    value <= max
  );
}
function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object";
}
export function parseProject(value: unknown): Project {
  if (
    !object(value) ||
    value.version !== 3 ||
    !number(value.bpm, 60, 160) ||
    !Array.isArray(value.layers) ||
    value.layers.length > 4
  )
    throw new Error("This is not a supported BodyBeats project.");
  const ids = new Set();
  for (const layer of value.layers) {
    if (
      !object(layer) ||
      typeof layer.id !== "string" ||
      layer.id.length > 100 ||
      ids.has(layer.id) ||
      typeof layer.name !== "string" ||
      layer.name.length > 80 ||
      !["drums", "melody"].includes(String(layer.instrument)) ||
      typeof layer.muted !== "boolean" ||
      !Array.isArray(layer.notes) ||
      layer.notes.length > 512
    )
      throw new Error("The project contains an invalid layer.");
    ids.add(layer.id);
    for (const note of layer.notes)
      if (
        !object(note) ||
        note.instrument !== layer.instrument ||
        !number(note.beat, 0, 7.999999) ||
        !number(note.duration, 0.000001, 8) ||
        note.beat + note.duration > 8.201 ||
        !number(note.pitch, 0, layer.instrument === "drums" ? 3 : 6) ||
        !Number.isInteger(note.pitch) ||
        !number(note.velocity, 0, 1) ||
        !number(note.brightness, 0, 1)
      )
        throw new Error("The project contains an invalid note.");
  }
  return structuredClone(value) as Project;
}
export function readProject(): Project | null {
  try {
    const text = localStorage.getItem(PROJECT_KEY);
    return text ? parseProject(JSON.parse(text)) : null;
  } catch {
    return null;
  }
}
export function saveProject(project: Project): boolean {
  try {
    localStorage.setItem(PROJECT_KEY, JSON.stringify(project));
    return true;
  } catch {
    return false;
  }
}
export function readSettings(): Settings {
  try {
    const parsed = JSON.parse(localStorage.getItem(SPACE_KEY) || "null");
    if (
      parsed &&
      validBounds(parsed.bounds) &&
      ["any", "Left", "Right"].includes(parsed.preferredHand)
    )
      return {
        ...structuredClone(DEFAULT_SETTINGS),
        bounds: parsed.bounds,
        preferredHand: parsed.preferredHand,
      };
  } catch {}
  return structuredClone(DEFAULT_SETTINGS);
}
export function saveSettings(settings: Settings) {
  try {
    localStorage.setItem(SPACE_KEY, JSON.stringify(settings));
  } catch {}
}
export function parseTrace(value: unknown): Trace {
  if (
    !object(value) ||
    value.version !== 1 ||
    !object(value.settings) ||
    !validBounds(value.settings.bounds as Bounds) ||
    !["drums", "melody"].includes(String(value.settings.instrument)) ||
    !["any", "Left", "Right"].includes(String(value.settings.preferredHand)) ||
    !Array.isArray(value.frames) ||
    value.frames.length > 1000
  )
    throw new Error("Invalid gesture trace.");
  let last = -1,
    first = 0;
  for (const [i, frame] of value.frames.entries()) {
    if (
      !object(frame) ||
      !number(frame.timestamp, 0, Number.MAX_SAFE_INTEGER) ||
      frame.timestamp <= last ||
      !Array.isArray(frame.hands) ||
      frame.hands.length > 2
    )
      throw new Error("Invalid trace frame.");
    last = frame.timestamp;
    if (i === 0) first = last;
    if (last - first > 16000) throw new Error("Trace exceeds 16 seconds.");
    for (const h of frame.hands) {
      if (
        !object(h) ||
        !["hand-0", "hand-1"].includes(String(h.id)) ||
        (h.source !== undefined &&
          !["landmarks", "motion"].includes(String(h.source))) ||
        !number(h.x, -2, 3) ||
        !number(h.y, -2, 3) ||
        !number(h.pinchRatio, 0, 100) ||
        !number(h.scale, 0, 3) ||
        typeof h.pose !== "string" ||
        h.pose.length > 40 ||
        typeof h.handedness !== "string" ||
        h.handedness.length > 10 ||
        !number(h.score, 0, 1) ||
        !Array.isArray(h.points) ||
        h.points.length > 21
      )
        throw new Error("Invalid hand sample.");
      for (const p of h.points) {
        if (
          !object(p) ||
          !number(p.x, -3, 4) ||
          !number(p.y, -3, 4) ||
          (p.z !== undefined && !number(p.z, -10, 10))
        )
          throw new Error("Invalid hand point.");
      }
    }
  }
  return structuredClone(value) as Trace;
}
export class Calibration {
  first: { x: number; y: number } | null = null;
  handId: HandSample["id"] | null = null;
  private anchor: { x: number; y: number; at: number } | null = null;
  feed(
    hand: HandSample | undefined,
    time: number,
  ): { progress: number; bounds?: Bounds; next?: boolean; error?: string } {
    if (
      !hand ||
      hand.source === "motion" ||
      (this.handId !== null && hand.id !== this.handId)
    ) {
      this.anchor = null;
      return { progress: 0 };
    }
    this.handId ??= hand.id;
    if (
      !this.anchor ||
      Math.hypot(hand.x - this.anchor.x, hand.y - this.anchor.y) > 0.045
    )
      this.anchor = { x: hand.x, y: hand.y, at: time };
    const progress = Math.min(1, (time - this.anchor.at) / 1200);
    if (progress < 1) return { progress };
    if (!this.first) {
      this.first = { x: hand.x, y: hand.y };
      this.anchor = null;
      return { progress: 0, next: true };
    }
    const bounds = {
      left: this.first.x,
      top: this.first.y,
      right: hand.x,
      bottom: hand.y,
    };
    if (!validBounds(bounds)) {
      this.anchor = null;
      return {
        progress: 0,
        error:
          "Reach farther down and right. Leave at least a quarter of the frame between corners.",
      };
    }
    return { progress: 1, bounds };
  }
}
