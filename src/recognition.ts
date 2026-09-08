import { clamp, DEFAULT_SETTINGS, DRUM_LINE, SCALE } from "./types.ts";
import { laneAt, laneRect } from "./play-area.ts";
import type {
  Action,
  HandId,
  HandSample,
  HandView,
  Recognition,
  Settings,
  Trace,
  Bounds,
} from "./types.ts";

type Memory = {
  last: HandSample;
  time: number;
  armed: boolean;
  lastHit: number;
  pinchSince: number | null;
  releaseSince: number | null;
  pinching: boolean;
  note: number;
  missing: boolean;
};
export function validBounds(b: Bounds): boolean {
  return (
    [b.left, b.top, b.right, b.bottom].every(Number.isFinite) &&
    b.left >= 0 &&
    b.top >= 0 &&
    b.right <= 1 &&
    b.bottom <= 1 &&
    b.right - b.left >= 0.25 &&
    b.bottom - b.top >= 0.25
  );
}
export function padAt(x: number): 0 | 1 | 2 | 3 | null {
  if (!Number.isFinite(x)) return null;
  return laneAt(x, 4) as 0 | 1 | 2 | 3;
}
export function noteAt(x: number) {
  return laneAt(x, SCALE.length);
}

/** Deterministic action recognizer. All times use camera capture milliseconds. */
export class Recognizer {
  settings: Settings = structuredClone(DEFAULT_SETTINGS);
  private memory = new Map<HandId, Memory>();
  private lastTime = -Infinity;
  configure(settings: Settings) {
    if (!validBounds(settings.bounds)) throw new Error("Invalid playing area.");
    this.settings = structuredClone(settings);
    this.reset();
  }
  reset() {
    this.memory.clear();
    this.lastTime = -Infinity;
  }
  update(
    samples: HandSample[],
    timestamp: number,
    inferenceMs = 0,
  ): Recognition {
    const actions: Action[] = [],
      hands: HandView[] = [];
    if (!Number.isFinite(timestamp) || timestamp <= this.lastTime)
      return { timestamp, hands, actions, samples: [], inferenceMs };
    this.lastTime = timestamp;
    const seen = new Set<HandId>();
    for (const raw of samples.slice(0, 2)) {
      if (
        ![raw.x, raw.y, raw.pinchRatio, raw.scale].every(Number.isFinite) ||
        raw.x < 0 ||
        raw.x > 1 ||
        raw.y < 0 ||
        raw.y > 1 ||
        seen.has(raw.id)
      )
        continue;
      if (
        this.settings.preferredHand !== "any" &&
        raw.handedness !== this.settings.preferredHand
      )
        continue;
      seen.add(raw.id);
      const b = this.settings.bounds;
      const sample = {
        ...raw,
        x: (raw.x - b.left) / (b.right - b.left),
        y: (raw.y - b.top) / (b.bottom - b.top),
        points: raw.points.map((p) => ({
          ...p,
          x: (p.x - b.left) / (b.right - b.left),
          y: (p.y - b.top) / (b.bottom - b.top),
        })),
      };
      let m = this.memory.get(raw.id);
      // A slow inference result is different from an explicit missing hand.
      // Allow continuous observations at low FPS. Missing frames below require
      // confirmed short-gap reacquisition for strikes and release held notes.
      if (!m || timestamp - m.time > 600) {
        if (m?.pinching)
          actions.push({ type: "note-off", hand: raw.id, at: timestamp });
        m = {
          last: sample,
          time: timestamp,
          armed: false,
          lastHit: -Infinity,
          pinchSince: null,
          releaseSince: null,
          pinching: false,
          note: noteAt(sample.x),
          missing: false,
        };
        this.memory.set(raw.id, m);
      }
      const dt = (timestamp - m.time) / 1000;
      const vy = dt > 0 ? (sample.y - m.last.y) / dt : 0;
      if (m.missing) {
        // Blur can begin on the very first moving frame. Preserve a ready
        // stroke briefly, but confirm it with a nearby actual hand before a hit.
        const continuesStroke =
          timestamp - m.time <= 120 &&
          sample.source !== "motion" &&
          sample.handedness === m.last.handedness &&
          sample.y >= m.last.y &&
          sample.y - m.last.y <= 0.5 &&
          Math.abs(sample.x - m.last.x) < 0.12 &&
          padAt(sample.x) === padAt(m.last.x);
        if (!continuesStroke) m.armed = false;
        m.missing = false;
      }
      // Calibration changes reach, not camera visibility. A real hand just
      // beyond calibrated reach still belongs to the nearest outside lane.
      const inside = raw.x >= 0 && raw.x <= 1 && raw.y >= 0 && raw.y <= 1;
      let phase: HandView["phase"] = "lift";
      if (this.settings.instrument === "drums") {
        if (
          inside &&
          sample.y < DRUM_LINE - 0.075 &&
          sample.source !== "motion"
        ) {
          // Returning above the separate rearm line is the excursion. There
          // is no stationary dwell: quick rebounds must work at camera FPS.
          m.armed = true;
        }
        if (m.armed && m.last.y < DRUM_LINE && sample.y >= DRUM_LINE) {
          const fraction = (DRUM_LINE - m.last.y) / (sample.y - m.last.y);
          const crossingX = m.last.x + (sample.x - m.last.x) * fraction;
          const at = m.time + (timestamp - m.time) * fraction;
          const pad = padAt(crossingX);
          if (inside && pad !== null && vy >= 0.32 && at - m.lastHit > 100) {
            actions.push({
              type: "hit",
              pad,
              velocity: clamp(vy / 2.7, 0.25, 1),
              at,
              hand: raw.id,
            });
            m.lastHit = at;
          }
          m.armed = false;
        }
        if (!inside) m.armed = false;
        phase =
          timestamp - m.lastHit < 130 ? "hit" : m.armed ? "ready" : "lift";
      } else {
        const wantsPinch =
          inside &&
          sample.source !== "motion" &&
          sample.pinchRatio < 0.42 &&
          sample.pose !== "Closed_Fist";
        const wantsRelease =
          !inside || sample.pinchRatio > 0.58 || sample.pose === "Closed_Fist";
        if (!m.pinching) {
          m.pinchSince = wantsPinch ? (m.pinchSince ?? timestamp) : null;
          if (m.pinchSince !== null && timestamp - m.pinchSince >= 40) {
            m.pinching = true;
            m.releaseSince = null;
            m.note = noteAt(sample.x);
            actions.push({
              type: "note-on",
              hand: raw.id,
              note: m.note,
              brightness: clamp(1 - sample.y),
              at: timestamp,
            });
          }
        } else {
          m.releaseSince = wantsRelease ? (m.releaseSince ?? timestamp) : null;
          if (m.releaseSince !== null && timestamp - m.releaseSince >= 45) {
            m.pinching = false;
            m.pinchSince = null;
            actions.push({ type: "note-off", hand: raw.id, at: timestamp });
          } else {
            const candidate = noteAt(sample.x);
            // Keep the current note near a lane boundary to avoid chatter.
            const beyond =
              candidate > m.note
                ? sample.x > laneRect(m.note, SCALE.length).right + 0.016
                : sample.x < laneRect(m.note, SCALE.length).left - 0.016;
            if (
              (candidate !== m.note && beyond) ||
              Math.abs(sample.y - m.last.y) > 0.015
            ) {
              if (beyond) m.note = candidate;
              actions.push({
                type: "note-change",
                hand: raw.id,
                note: m.note,
                brightness: clamp(1 - sample.y),
                at: timestamp,
              });
            }
          }
        }
        phase = m.pinching ? "holding" : "lift";
      }
      hands.push({ ...sample, phase, pinching: m.pinching, note: m.note });
      m.last = sample;
      m.time = timestamp;
    }
    for (const [id, m] of this.memory) {
      if (!seen.has(id)) {
        // Keep a short unobserved stroke hypothesis, never an action. Missing
        // hands expire even if the last position was armed and above the line.
        m.missing = true;
        if (timestamp - m.time > 120) {
          if (m.pinching)
            actions.push({ type: "note-off", hand: id, at: timestamp });
          this.memory.delete(id);
        }
      }
    }
    return { timestamp, hands, actions, samples, inferenceMs };
  }
}

export function replayTrace(trace: Trace): Recognition[] {
  const recognizer = new Recognizer();
  recognizer.configure(trace.settings);
  return trace.frames.map((frame) =>
    recognizer.update(frame.hands, frame.timestamp),
  );
}
